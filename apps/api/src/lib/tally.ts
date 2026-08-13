import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { workspaceIntegrations, workspaces } from '@oriole/database';

import { db } from '../db/index.ts';
import { decryptSecret } from './crypto.ts';
import { env } from './env.ts';
import { normalizePhone } from './phone.ts';
import { upsertContactFromSubmission, type ContactSubmission } from './contact-ingest.ts';
import {
  createBookingFromFormSubmission,
  extractBookingFromTally,
  notifyOwnerNewBooking,
} from './form-booking.ts';

/* ────────────────────────────────────────────────────────────
 * Tally integration — submission form → kontak project.
 *
 * Sama seperti Typeform, Tally mengirim webhook REAL-TIME ke
 * POST /api/webhooks/tally/:workspaceId dengan signature
 * `Tally-Signature` (base64 HMAC-SHA256 dari raw body). Webhook
 * didaftarkan ke Tally via API (POST /webhooks) saat user
 * menghubungkan form — tidak perlu konfigurasi manual.
 *
 * Catatan platform: Tally TIDAK menyediakan OAuth 2.0 — satu-satunya
 * autentikasi adalah API key akun (Bearer token). Karena itu alur
 * connect memakai API key sekali-paste, lalu semua otomatis.
 * ──────────────────────────────────────────────────────────── */

export const TALLY_API_BASE = 'https://api.tally.so';

/** Konfigurasi privat integrasi Tally (disimpan di providerConfig). */
export interface TallyConfig {
  /** API key akun Tally (Bearer token) — dienkripsi at-rest. */
  apiKey: string;
  /** Secret webhook — dipakai memverifikasi Tally-Signature. */
  webhookSecret: string;
  formId: string;
  formName?: string | null;
  /** URL webhook yang didaftarkan ke Tally (bisa ditampilkan di UI). */
  webhookUrl?: string | null;
  /** ID webhook di Tally — dipakai saat mencabut webhook (best-effort). */
  webhookId?: string | null;
  /** Marker migrasi dari Typeform (row lama di-update migration 0022). */
  migratedFrom?: 'typeform' | null;
}

/** Error API Tally — `status` dipakai memetakan ke HTTP response. */
export class TallyApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'TallyApiError';
  }
}

/** Fetch ke API Tally dengan Bearer token; non-2xx → TallyApiError. */
async function tallyFetch<T>(apiKey: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${TALLY_API_BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(init?.headers ?? {}),
    },
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const description =
      typeof json.message === 'string' && json.message.length > 0
        ? json.message
        : typeof json.error === 'string' && json.error.length > 0
          ? json.error
          : JSON.stringify(json);
    throw new TallyApiError(`Tally menolak: ${description}`, res.status);
  }
  return json as T;
}

/* ────────────────────────────────────────────────────────────
 * Signature — `Tally-Signature: <base64 hmac-sha256(rawBody)>`
 * ──────────────────────────────────────────────────────────── */

/**
 * Verifikasi signature webhook Tally (base64 HMAC-SHA256, tanpa prefix).
 * Sama pola Typeform (base64), dihitung atas RAW body. Perbandingan
 * constant-time.
 */
export function verifyTallySignature(rawBody: string, secret: string, provided: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest();
  const actualBase64 = (provided ?? '').trim();
  if (actualBase64.length === 0) return false;
  const actual = Buffer.from(actualBase64, 'base64');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/* ────────────────────────────────────────────────────────────
 * API Tally (setup integrasi dari UI)
 * ──────────────────────────────────────────────────────────── */

export interface TallyFormOption {
  id: string;
  title: string;
}

/** GET /forms — daftar form milik akun (satu halaman, maks 500). */
export async function listTallyForms(apiKey: string): Promise<TallyFormOption[]> {
  const data = await tallyFetch<{ items?: { id?: string; name?: string }[] }>(
    apiKey,
    '/forms?limit=500',
  );
  return (data.items ?? [])
    .filter((form) => form.id)
    .map((form) => ({ id: form.id!, title: form.name ?? 'Untitled' }));
}

/** GET /forms/{id} — validasi + judul satu form. */
export async function getTallyForm(apiKey: string, formId: string): Promise<TallyFormOption> {
  const form = await tallyFetch<{ id?: string; name?: string }>(
    apiKey,
    `/forms/${encodeURIComponent(formId)}`,
  );
  return { id: form.id ?? formId, title: form.name ?? 'Untitled' };
}

/**
 * POST /webhooks — daftarkan webhook submission ke form.
 * Mengembalikan ID webhook (dipakai untuk mencabut saat disconnect).
 */
export async function registerTallyWebhook(
  apiKey: string,
  formId: string,
  url: string,
  signingSecret: string,
): Promise<{ id: string }> {
  const result = await tallyFetch<{ id?: string }>(apiKey, '/webhooks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      formId,
      url,
      eventTypes: ['FORM_RESPONSE'],
      signingSecret,
    }),
  });
  return { id: result.id ?? '' };
}

/** DELETE /webhooks/{id} — cabut webhook (best-effort saat lepas). */
export async function removeTallyWebhook(apiKey: string, webhookId: string): Promise<void> {
  await tallyFetch(apiKey, `/webhooks/${encodeURIComponent(webhookId)}`, { method: 'DELETE' });
}

/** URL webhook masuk milik workspace — dipakai saat connect/re-register. */
export function tallyWebhookUrl(workspaceId: string): string {
  return `${env.API_URL}/api/webhooks/tally/${workspaceId}`;
}

/* ────────────────────────────────────────────────────────────
 * Payload webhook FORM_RESPONSE
 *
 * Struktur: { eventId, eventType, createdAt, data: { responseId,
 * submissionId, formId, formName, createdAt, fields: [{ key, label,
 * type, value, options? }] } }. `value` untuk pilihan (multiple choice
 * dll.) berupa array ID — teks di-resolve lewat `options`.
 * ──────────────────────────────────────────────────────────── */

const tallyFieldSchema = z
  .object({
    key: z.string(),
    label: z.string().optional(),
    type: z.string().optional(),
    value: z.unknown().optional(),
    options: z
      .array(z.object({ id: z.string(), text: z.string() }).passthrough())
      .optional(),
  })
  .passthrough();

/** Validasi longgar — field asing dipertahankan, bagian yang kita pakai wajib. */
export const tallyWebhookPayloadSchema = z
  .object({
    eventId: z.string().optional(),
    eventType: z.string().optional(),
    createdAt: z.string().optional(),
    data: z
      .object({
        responseId: z.string().optional(),
        submissionId: z.string().optional(),
        formId: z.string(),
        formName: z.string().optional(),
        createdAt: z.string().optional(),
        fields: z.array(tallyFieldSchema).default([]),
      })
      .passthrough(),
  })
  .passthrough();

export type TallyWebhookPayload = z.infer<typeof tallyWebhookPayloadSchema>;

export interface TallyField {
  key: string;
  label?: string;
  type?: string;
  value?: unknown;
  options?: { id: string; text: string }[];
}

/** Nilai jawaban apa adanya: teks/angka langsung, pilihan → teks option. */
export function tallyFieldText(field: TallyField): string | null {
  const value = field.value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    // Choice/checkbox: value = array ID → resolve ke teks option.
    const texts = value
      .map((id) => (typeof id === 'string' ? field.options?.find((o) => o.id === id)?.text : undefined))
      .filter((text): text is string => Boolean(text));
    if (texts.length > 0) return texts.join(', ');
    const ids = value.filter((id): id is string => typeof id === 'string');
    return ids.length > 0 ? ids.join(', ') : null;
  }
  return null;
}

/** Cari pertanyaan yang judulnya cocok dengan salah satu pola. */
function matchesLabel(field: TallyField, patterns: RegExp): boolean {
  return patterns.test((field.label ?? '').trim());
}

/**
 * Ekstrak field kontak dari satu submission Tally.
 *
 * Strategi: field bertipe khusus (INPUT_PHONE_NUMBER / INPUT_EMAIL) pasti
 * benar tanpa tebak label; nama & catatan memakai heuristic judul (sama
 * dengan Typeform / Google Forms agar konsisten lintas integrasi).
 */
export function extractContactFromTallySubmission(payload: TallyWebhookPayload): ContactSubmission {
  let phone: string | null = null;
  let email: string | null = null;
  let name: string | null = null;
  const notes: string[] = [];

  for (const field of payload.data.fields ?? []) {
    const value = tallyFieldText(field);
    if (!value) continue;
    const fieldType = (field.type ?? '').toUpperCase();

    // Field bertipe khusus → pasti benar, tanpa perlu tebak judul.
    if (fieldType === 'INPUT_PHONE_NUMBER') {
      phone = value;
      continue;
    }
    if (fieldType === 'INPUT_EMAIL') {
      email = value;
      continue;
    }

    if (matchesLabel(field, /^(name|nama|full name|nama lengkap)$/i) || matchesLabel(field, /name|nama/i)) {
      if (!name) name = value;
      continue;
    }
    if (matchesLabel(field, /email/i)) {
      if (!email) email = value;
      continue;
    }
    if (matchesLabel(field, /(phone|telepon|whatsapp|no\.?\s*hp|number)/i)) {
      if (!phone) phone = value;
      continue;
    }
    if (matchesLabel(field, /(notes?|catatan|pesan|message|keterangan|details?)/i)) {
      notes.push(value);
      continue;
    }
  }

  return {
    name,
    phone: phone ? normalizePhone(phone) : null,
    email,
    notes: notes.length > 0 ? notes.join(' · ') : null,
  };
}

/* ────────────────────────────────────────────────────────────
 * Resolve konfigurasi + sinkronisasi → kontak
 * ──────────────────────────────────────────────────────────── */

export type TallyIntegrationConfig = TallyConfig & { isActive: boolean };

/** Ambil API key Tally tersimpan untuk workspace (null bila belum connect). */
export async function getTallyApiKey(workspaceId: string): Promise<string | null> {
  const config = await loadTallyConfig(workspaceId);
  if (!config?.apiKey) return null;
  return decryptSecret(config.apiKey);
}

/** Muat konfigurasi integrasi Tally aktif untuk sebuah workspace. */
export async function loadTallyConfig(workspaceId: string): Promise<TallyIntegrationConfig | null> {
  const [integration] = await db
    .select()
    .from(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, workspaceId),
        eq(workspaceIntegrations.integrationType, 'tally'),
      ),
    )
    .limit(1);
  if (!integration) return null;
  const config = integration.providerConfig as unknown as TallyConfig;
  if (!config.apiKey || !config.formId || !config.webhookSecret) return null;
  return { ...config, isActive: integration.isActive };
}

export interface TallySyncResult {
  imported: boolean;
  skipped: 'not-configured' | 'invalid-submission' | 'no-contact' | null;
  /** true bila submission juga menghasilkan booking baru (0 = bukan booking). */
  bookingCreated: boolean;
}

/**
 * Proses satu submission webhook → kontak workspace.
 * Webhook sudah diverifikasi + didedup di route; fungsi ini idempotent
 * (find-or-create by nomor), jadi aman dipanggil ulang oleh retry Inngest.
 */
export async function syncTallySubmissionToContacts(
  workspaceId: string,
  payload: TallyWebhookPayload,
): Promise<TallySyncResult> {
  const config = await loadTallyConfig(workspaceId);
  if (!config || !config.isActive) {
    return { imported: false, skipped: 'not-configured', bookingCreated: false };
  }

  const submissionId = payload.data?.submissionId ?? payload.data?.responseId;
  if (!submissionId) {
    return { imported: false, skipped: 'invalid-submission', bookingCreated: false };
  }

  // contacts.userId wajib (FK auth user) — resolve dari pemilik workspace.
  const [workspace] = await db
    .select({ userId: workspaces.userId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!workspace) return { imported: false, skipped: 'not-configured', bookingCreated: false };

  const contact = extractContactFromTallySubmission(payload);
  const outcome = await upsertContactFromSubmission(workspace.userId, workspaceId, contact);

  // Booking otomatis: submission yang memuat layanan + tanggal/jam menjadi
  // booking pending (idempoten per submissionId — retry webhook aman).
  let bookingCreated = false;
  const booking = extractBookingFromTally(payload);
  if (booking.title && booking.scheduledAt) {
    const result = await createBookingFromFormSubmission({
      workspaceId,
      userId: workspace.userId,
      source: 'tally',
      sourceRef: submissionId,
      title: booking.title,
      scheduledAt: booking.scheduledAt,
      timezone: booking.timezone,
      description: booking.description ?? contact.notes,
      customerName: contact.name,
      phone: contact.phone,
    });
    bookingCreated = result.created;
    if (result.created) {
      await notifyOwnerNewBooking({
        workspaceId,
        title: booking.title,
        customerName: contact.name,
        phone: contact.phone,
        scheduledAt: booking.scheduledAt,
        timezone: booking.timezone,
      });
    }
  }

  // Tandai sinkronisasi terakhir (kapan pun submission diproses).
  await db
    .update(workspaceIntegrations)
    .set({ lastSyncAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, workspaceId),
        eq(workspaceIntegrations.integrationType, 'tally'),
      ),
    );

  return {
    imported: outcome === 'imported',
    skipped: outcome === 'skipped' ? 'no-contact' : null,
    bookingCreated,
  };
}
