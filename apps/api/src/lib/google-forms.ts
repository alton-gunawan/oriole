import { and, eq, isNull } from 'drizzle-orm';
import { contacts as contactsTable, workspaceIntegrations, workspaces } from '@oriole/database';

import { db } from '../db/index.ts';
import { GoogleApiError, googleFetch, parseServiceAccount, type GoogleServiceAccount } from './google-auth.ts';
import { normalizePhone } from './phone.ts';

/* ────────────────────────────────────────────────────────────
 * Google Forms integration — form submission menjadi kontak
 * project. Polling terjadwal (Inngest cron) mengambil response
 * baru setelah kursor (lastSubmittedAt) dan menciptakan kontak
 * (find-or-create per nomor telepon, unik per workspace).
 * ──────────────────────────────────────────────────────────── */

export const GOOGLE_FORMS_SCOPES = [
  'https://www.googleapis.com/auth/forms.body.readonly',
  'https://www.googleapis.com/auth/forms.responses.readonly',
];

/** Base URL API Forms — DOMAIN KHUSUS (bukan www.googleapis.com). */
export const GOOGLE_FORMS_API_BASE = 'https://forms.googleapis.com';

/** URL absolut endpoint Forms API (googleFetch menerima path absolut). */
function formsUrl(path: string): string {
  return `${GOOGLE_FORMS_API_BASE}${path}`;
}

/** Konfigurasi privat integrasi Google Forms (disimpan di providerConfig). */
export interface GoogleFormsConfig {
  serviceAccountJson: string;
  serviceAccountEmail: string;
  formId: string;
  formName?: string | null;
  /** Kursor polling: response terbaru yang sudah diproses (ISO string). */
  lastSubmittedAt?: string | null;
}

/** Pertanyaan dalam form — id + judul (dipakai untuk mapping field). */
export interface GoogleFormQuestion {
  id: string;
  title: string;
}

export interface GoogleFormMetadata {
  formId: string;
  title: string;
  questions: GoogleFormQuestion[];
}

interface FormsApiItem {
  title?: string;
  questionItem?: { question?: { questionId?: string; title?: string } };
  pageBreakItem?: unknown;
  sectionHeaderItem?: unknown;
}

/** Metadata form (judul + daftar pertanyaan) via GET /forms/v1/forms/{id}. */
export async function getFormMetadata(
  serviceAccount: GoogleServiceAccount,
  formId: string,
): Promise<GoogleFormMetadata> {
  const form = await googleFetch<{ formId?: string; info?: { title?: string }; items?: FormsApiItem[] }>(
    serviceAccount,
    GOOGLE_FORMS_SCOPES,
    formsUrl(`/v1/forms/${encodeURIComponent(formId)}`),
  );
  const questions: GoogleFormQuestion[] = [];
  for (const item of form.items ?? []) {
    const question = item.questionItem?.question;
    if (question?.questionId) {
      questions.push({ id: question.questionId, title: question.title?.trim() || item.title?.trim() || 'Untitled' });
    }
  }
  return {
    formId: form.formId ?? formId,
    title: form.info?.title?.trim() || 'Untitled',
    questions,
  };
}

interface FormsApiResponse {
  responseId: string;
  createTime?: string;
  lastSubmittedTime?: string;
  answers?: Record<string, { textAnswers?: { answers?: { value?: string }[] } }>;
}

interface FormsResponsesPage {
  responses?: FormsApiResponse[];
  nextPageToken?: string | null;
}

/**
 * Semua response form yang dikirim SETELAH `after` (ISO) — semua halaman
 * (pageSize maks 500). Response tanpa lastSubmittedTime dipakai
 * createTime sebagai fallback.
 */
export async function listFormResponses(
  serviceAccount: GoogleServiceAccount,
  formId: string,
  after?: string | null,
): Promise<FormsApiResponse[]> {
  const afterMs = after ? new Date(after).getTime() : 0;
  const rows: FormsApiResponse[] = [];
  let pageToken: string | null = null;
  do {
    const query = new URLSearchParams({ pageSize: '500' });
    if (pageToken) query.set('pageToken', pageToken);
    const page = await googleFetch<FormsResponsesPage>(
      serviceAccount,
      GOOGLE_FORMS_SCOPES,
      formsUrl(`/v1/forms/${encodeURIComponent(formId)}/responses?${query.toString()}`),
    );
    for (const response of page.responses ?? []) {
      const submitted = response.lastSubmittedTime ?? response.createTime;
      if (submitted && new Date(submitted).getTime() > afterMs) rows.push(response);
    }
    pageToken = page.nextPageToken ?? null;
  } while (pageToken);
  // API mengembalikan secara kronologis; sort defensif oleh waktu submit.
  rows.sort((a, b) =>
    (a.lastSubmittedTime ?? a.createTime ?? '').localeCompare(b.lastSubmittedTime ?? b.createTime ?? ''),
  );
  return rows;
}

/** Teks jawaban pertama untuk sebuah pertanyaan. */
function answerText(response: FormsApiResponse, questionId: string): string {
  return response.answers?.[questionId]?.textAnswers?.answers?.[0]?.value?.trim() ?? '';
}

/** Cari pertanyaan yang judulnya cocok dengan salah satu pola. */
function findQuestion(
  questions: GoogleFormQuestion[],
  patterns: RegExp,
): GoogleFormQuestion | undefined {
  return questions.find((question) => patterns.test(question.title));
}

/** Extrak field kontak dari satu response berdasarkan judul pertanyaan. */
export function extractContactFromResponse(
  questions: GoogleFormQuestion[],
  response: FormsApiResponse,
): { name: string | null; phone: string | null; email: string | null; notes: string | null } {
  const nameQuestion =
    findQuestion(questions, /^(name|nama|full name|nama lengkap)$/i) ??
    findQuestion(questions, /name|nama/i);
  const phoneQuestion =
    findQuestion(questions, /(phone|telepon|whatsapp|no\.?\s*hp|number)/i) ??
    findQuestion(questions, /kontak|contact/i);
  const emailQuestion = findQuestion(questions, /email/i);
  const notesQuestion = findQuestion(questions, /(notes?|catatan|pesan|message|keterangan|details?)/i);

  const name = nameQuestion ? answerText(response, nameQuestion.id) || null : null;
  const phoneRaw = phoneQuestion ? answerText(response, phoneQuestion.id) : '';
  const phone = phoneRaw ? normalizePhone(phoneRaw) : null;
  const email = emailQuestion ? answerText(response, emailQuestion.id) || null : null;
  const notes = notesQuestion ? answerText(response, notesQuestion.id) || null : null;
  return { name, phone, email, notes };
}

/** Jumlah digit nomor (tanpa +) — untuk validasi minimal ala E.164. */
function hasPlausiblePhone(phone: string): boolean {
  return /^\d{8,15}$/.test(phone.replace('+', ''));
}

export interface FormsSyncResult {
  imported: number;
  skipped: number;
  total: number;
}

/** Semua integrasi Google Forms AKTIF milik workspace yang belum di-soft-delete. */
export async function listActiveFormIntegrations(): Promise<
  { workspaceId: string; config: GoogleFormsConfig }[]
> {
  const rows = await db
    .select({
      workspaceId: workspaceIntegrations.workspaceId,
      providerConfig: workspaceIntegrations.providerConfig,
    })
    .from(workspaceIntegrations)
    .innerJoin(workspaces, eq(workspaces.id, workspaceIntegrations.workspaceId))
    .where(
      and(
        eq(workspaceIntegrations.integrationType, 'google-forms'),
        eq(workspaceIntegrations.isActive, true),
        isNull(workspaces.deletedAt),
      ),
    );
  return rows.map((row) => ({
    workspaceId: row.workspaceId,
    config: row.providerConfig as unknown as GoogleFormsConfig,
  }));
}

/**
 * Sinkronkan response form baru → kontak workspace.
 *
 * Aturan:
 * - Hanya response setelah kursor `lastSubmittedAt` diproses.
 * - Kontak dibuat bila ada NAMA + nomor telepon yang masuk akal.
 * - Response tanpa nomor / telepon tidak valid → dihitung `skipped`.
 * - Response tanpa nama tetap diproses bila nomornya sudah dikenal
 *   (update email/catatan yang kosong) — nama wajib hanya saat membuat baru.
 * - Dedup by nomor (unique workspace+phone, onConflictDoNothing) — response
 *   ganda untuk nomor sama tidak membuat kontak duplikat.
 * - Kursor dimajukan ke response terakhir yang DIPERIKSA (termasuk yang
 *   dilewati karena invalid) agar response rusak tidak dipindai ulang setiap
 *   tick. Response yang dilewati karena telepon tidak valid tidak akan
 *   pernah dibuat kontaknya — mapping judul pertanyaan menentukan nasibnya.
 */
export async function syncFormResponsesToContacts(
  workspaceId: string,
  config?: GoogleFormsConfig,
): Promise<FormsSyncResult> {
  let integrationConfig = config;
  if (!integrationConfig) {
    const [integration] = await db
      .select()
      .from(workspaceIntegrations)
      .where(
        and(
          eq(workspaceIntegrations.workspaceId, workspaceId),
          eq(workspaceIntegrations.integrationType, 'google-forms'),
        ),
      )
      .limit(1);
    if (!integration) throw new GoogleApiError('Integrasi Google Forms belum terhubung', 409);
    integrationConfig = integration.providerConfig as unknown as GoogleFormsConfig;
  }

  const cfg = integrationConfig;
  if (!cfg.serviceAccountJson || !cfg.formId) {
    throw new GoogleApiError('Konfigurasi Google Forms tidak lengkap', 400);
  }
  // contacts.userId wajib (FK auth user) — resolve dari workspace pemilik.
  const [workspace] = await db
    .select({ userId: workspaces.userId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!workspace) throw new GoogleApiError('Workspace tidak ditemukan', 409);
  const serviceAccount = parseServiceAccount(cfg.serviceAccountJson);

  const metadata = await getFormMetadata(serviceAccount, cfg.formId);
  const responses = await listFormResponses(serviceAccount, cfg.formId, cfg.lastSubmittedAt ?? null);

  let imported = 0;
  let skipped = 0;
  let cursor: string | null = cfg.lastSubmittedAt ?? null;

  for (const response of responses) {
    const submitted = response.lastSubmittedTime ?? response.createTime;
    // Kursor = response terakhir yang diproses (maju terlepas dari valid/tidak).
    if (submitted && (!cursor || submitted > cursor)) cursor = submitted;

    const contact = extractContactFromResponse(metadata.questions, response);
    // Nama wajib HANYA saat membuat kontak baru — response tanpa nama tetap
    // bisa dicocokkan ke kontak yang sudah ada lewat nomor teleponnya.
    if (!contact.phone || !hasPlausiblePhone(contact.phone)) {
      skipped += 1;
      continue;
    }

    // find-or-create by nomor (unik per workspace).
    const [existing] = await db
      .select({ id: contactsTable.id })
      .from(contactsTable)
      .where(and(eq(contactsTable.workspaceId, workspaceId), eq(contactsTable.phone, contact.phone)))
      .limit(1);
    if (existing) {
      // Nomor sudah dikenal — hanya perbarui email/catatan bila kosong.
      const [contactRow] = await db
        .select({ email: contactsTable.email, notes: contactsTable.notes })
        .from(contactsTable)
        .where(eq(contactsTable.id, existing.id))
        .limit(1);
      const needsUpdate =
        (contact.email && !contactRow?.email) || (contact.notes && !contactRow?.notes);
      if (needsUpdate) {
        await db
          .update(contactsTable)
          .set({
            ...(contact.email && !contactRow?.email ? { email: contact.email } : {}),
            ...(contact.notes && !contactRow?.notes ? { notes: contact.notes } : {}),
            updatedAt: new Date(),
          })
          .where(eq(contactsTable.id, existing.id));
      }
      imported += 1;
      continue;
    }

    // Nomor belum dikenal — nama wajib untuk membuat kontak baru.
    if (!contact.name) {
      skipped += 1;
      continue;
    }
    await db
      .insert(contactsTable)
      .values({
        userId: workspace.userId,
        workspaceId,
        name: contact.name,
        phone: contact.phone,
        email: contact.email ?? null,
        notes: contact.notes ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: contactsTable.id });
    // Kalah race (nomor sama masuk bersamaan) → kontak pemenang tetap terhitung.
    imported += 1;
  }

  await db
    .update(workspaceIntegrations)
    .set({ lastSyncAt: new Date(), updatedAt: new Date(), providerConfig: { ...cfg, lastSubmittedAt: cursor } })
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, workspaceId),
        eq(workspaceIntegrations.integrationType, 'google-forms'),
      ),
    );

  return { imported, skipped, total: responses.length };
}
