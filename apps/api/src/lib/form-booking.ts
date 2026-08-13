import { and, eq, isNull } from 'drizzle-orm';
import { authUser, bookings, workspaces } from '@oriole/database';
import { parseSlotTime } from '@oriole/messaging';
import { brand } from '@oriole/config';

import { db } from '../db/index.ts';
import { matchService } from './vapi-inbound.ts';
import { syncBookingContact } from './contact-sync.ts';
import { captureBookingEvent } from './analytics.ts';
import { emitAutoCallScheduled, emitBookingCreated } from './reminders.ts';
import {
  emitCalendarBookingEvent,
  emitOutgoingWebhookEvent,
  emitSlackBookingEvent,
  emitVideoLinkEvent,
} from './integration-events.ts';
import type { GoogleFormQuestion } from './google-forms.ts';
import type { TallyField, TallyWebhookPayload } from './tally.ts';

/* ────────────────────────────────────────────────────────────
 * Booking dari submisi form (Google Forms / Tally).
 *
 * Setelah submission diproses menjadi kontak (contact-ingest), submission
 * yang memuat data booking (layanan + tanggal/jam + nama + telepon) otomatis
 * menjadi booking `pending` di workspace. Idempoten per (source, sourceRef) —
 * retry webhook / crash di tengah batch tidak membuat booking ganda. Owner
 * project diberi tahu lewat email (authUser pemilik workspace).
 *
 * Mapping field → booking (heuristic judul pertanyaan, sama seperti
 * extractContact*):
 *   - Judul booking : pertanyaan layanan/service/jasa/treatment/paket/kursus/
 *                     judul — fallback: judul form.
 *   - Tanggal & jam : pertanyaan tanggal + jam (atau satu field datetime).
 *                     Naive time ditafsirkan di zona waktu form (fallback
 *                     'Asia/Jakarta' — pasar utama aplikasi, copy id-ID).
 *   - Zona waktu    : pertanyaan "zona waktu" (opsional, IANA).
 *   - Deskripsi     : pertanyaan catatan/pesan/keterangan (opsional).
 *   - Nama/telepon  : reuse extractContact* (customer booking).
 * ──────────────────────────────────────────────────────────── */

/** Zona waktu fallback saat form tidak menanyakannya. */
export const DEFAULT_FORM_BOOKING_TIMEZONE = 'Asia/Jakarta';

/** Jam default saat form hanya menanyakan tanggal (09:00). */
const DEFAULT_BOOKING_HOUR = 9;

export interface FormBookingExtract {
  title: string | null;
  /** ISO datetime (UTC) bila tanggal/jam berhasil diparse — null = bukan booking. */
  scheduledAt: string | null;
  timezone: string;
  description: string | null;
}

/* ── Helper parse teks (angka) ─────────────────────────────── */

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Zona waktu valid (IANA)? — guard sebelum Intl dipakai parseSlotTime. */
export function isValidTimezone(timezone: string | null | undefined): boolean {
  if (!timezone || timezone.trim().length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone.trim() });
    return true;
  } catch {
    return false;
  }
}

/** Parse jam dari teks ("14:00", "14", "14.00") → {hour, minute} | null. */
function parseTimePart(text: string): { hour: number; minute: number } | null {
  const match = /(\d{1,2})(?::|\.)?(\d{2})?(?::\d{2})?/.exec(text.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = match[2] !== undefined ? Number(match[2]) : 0;
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** Parse tanggal dari teks → {year, month, day} | null. */
function parseDatePart(text: string): { year: number; month: number; day: number } | null {
  const trimmed = text.trim();

  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed); // YYYY-MM-DD
  if (match) return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };

  match = /^(\d{4})(\d{2})(\d{2})$/.exec(trimmed); // YYYYMMDD
  if (match) return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };

  // D/M/YYYY atau M/D/YYYY — bila bagian pertama > 12 pasti DD/MM/YYYY (id-ID).
  match = /^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$/.exec(trimmed);
  if (match) {
    const a = Number(match[1]);
    const b = Number(match[2]);
    const year = Number(match[3]);
    if (a > 12) return { year, month: b, day: a };
    if (b > 12) return { year, month: a, day: b };
    return { year, month: a, day: b }; // ambigu → tafsir MM/DD/YYYY
  }
  return null;
}

/**
 * Gabungkan jawaban tanggal + jam menjadi Date (UTC instant), ditafsirkan
 * sebagai naive time di zona `timezone`. Menolak waktu yang sudah lewat
 * (parseSlotTime) dan format tak dikenal. `now` bisa di-override (test).
 */
export function parseFormBookingDateTime(
  dateText: string | null,
  timeText: string | null,
  timezone: string,
  now: Date = new Date(),
): Date | null {
  const tz = isValidTimezone(timezone) ? timezone.trim() : 'UTC';

  // Jawaban tunggal yang sudah berupa datetime penuh (ISO / "YYYY-MM-DD HH:mm").
  if (dateText?.trim()) {
    const asFull = parseSlotTime(dateText, tz, now);
    if (asFull) return asFull;
  }

  const datePart = dateText ? parseDatePart(dateText) : null;
  if (!datePart) return null;
  const timePart = timeText ? parseTimePart(timeText) : null;

  const naive = `${pad2(datePart.year)}-${pad2(datePart.month)}-${pad2(datePart.day)} ${pad2(
    timePart?.hour ?? DEFAULT_BOOKING_HOUR,
  )}:${pad2(timePart?.minute ?? 0)}`;
  return parseSlotTime(naive, tz, now);
}

/* ── Helper pencocokan pertanyaan (mirror google-forms/tally) ── */

function findQuestion(
  questions: { id: string; title: string }[],
  patterns: RegExp,
  excludeId?: string,
): { id: string; title: string } | undefined {
  return questions.find(
    (question) => question.id !== excludeId && patterns.test(question.title),
  );
}

const TITLE_PATTERNS = /^(layanan|service|jasa|treatment|perawatan|pemeriksaan|paket|kursus|mata pelajaran|kelas|jenis|judul|produk|item)/i;
const DATE_PATTERNS = /(tanggal|date|hari|kapan|jadwal|schedule)/i;
const TIME_PATTERNS = /(jam|pukul|waktu|time)/i;
const TIMEZONE_PATTERNS = /(zona waktu|timezone|time zone|waktu setempat)/i;
const DESCRIPTION_PATTERNS = /(notes?|catatan|pesan|message|keterangan|details?)/i;

/* ── Google Forms ──────────────────────────────────────────── */

/** Jawaban pertama untuk pertanyaan (dari response Forms API). */
function googleAnswerText(
  response: { answers?: Record<string, { textAnswers?: { answers?: { value?: string }[] } }> },
  questionId: string,
): string {
  return response.answers?.[questionId]?.textAnswers?.answers?.[0]?.value?.trim() ?? '';
}

/**
 * Ekstrak field booking dari satu response Google Forms berdasarkan judul
 * pertanyaan (heuristic — dokumentasi mapping di header modul ini).
 */
export function extractBookingFromGoogleResponse(
  questions: GoogleFormQuestion[],
  response: { answers?: Record<string, { textAnswers?: { answers?: { value?: string }[] } }> },
  formTitle: string,
): FormBookingExtract {
  const timezoneQuestion = findQuestion(questions, TIMEZONE_PATTERNS);
  const timezoneRaw = timezoneQuestion ? googleAnswerText(response, timezoneQuestion.id) : '';
  const timezone = isValidTimezone(timezoneRaw) ? timezoneRaw.trim() : DEFAULT_FORM_BOOKING_TIMEZONE;

  const titleQuestion = findQuestion(questions, TITLE_PATTERNS);
  const title = titleQuestion ? googleAnswerText(response, titleQuestion.id) : '';

  const dateQuestion = findQuestion(questions, DATE_PATTERNS, timezoneQuestion?.id);
  const timeQuestion = findQuestion(questions, TIME_PATTERNS, timezoneQuestion?.id);
  const dateText = dateQuestion ? googleAnswerText(response, dateQuestion.id) : '';
  const timeText = timeQuestion ? googleAnswerText(response, timeQuestion.id) : '';

  const descriptionQuestion = findQuestion(questions, DESCRIPTION_PATTERNS);
  const description = descriptionQuestion
    ? googleAnswerText(response, descriptionQuestion.id) || null
    : null;

  const scheduledAt = parseFormBookingDateTime(dateText, timeText, timezone);
  return {
    title: title.trim() || formTitle.trim() || null,
    scheduledAt: scheduledAt ? scheduledAt.toISOString() : null,
    timezone,
    description,
  };
}

/* ── Tally ────────────────────────────────────────────────── */

/**
 * Ekstrak field booking dari satu submission Tally — strategi sama dengan
 * extractContactFromTallySubmission: field bertipe INPUT_DATE untuk tanggal,
 * INPUT_TIME untuk jam, heuristic judul untuk layanan/zona/catatan.
 */
export function extractBookingFromTally(payload: TallyWebhookPayload): FormBookingExtract {
  let title: string | null = null;
  let dateText: string | null = null;
  let timeText: string | null = null;
  let timezone: string | null = null;
  const descriptionParts: string[] = [];

  for (const field of payload.data.fields ?? []) {
    const value = tallyFieldText(field);
    if (!value) continue;
    const fieldType = (field.type ?? '').toUpperCase();
    const label = (field.label ?? '').trim();

    // Field bertipe tanggal/jam → pasti (Tally: YYYY-MM-DD / HH:mm).
    if (fieldType === 'INPUT_DATE') {
      if (!dateText) dateText = value;
      continue;
    }
    if (fieldType === 'INPUT_TIME') {
      if (!timeText) timeText = value;
      continue;
    }

    if (TITLE_PATTERNS.test(label)) {
      if (!title) title = value;
      continue;
    }
    if (TIMEZONE_PATTERNS.test(label)) {
      if (!timezone) timezone = value;
      continue;
    }
    if (TIME_PATTERNS.test(label) && !TIMEZONE_PATTERNS.test(label)) {
      if (!timeText) timeText = value;
      continue;
    }
    if (DATE_PATTERNS.test(label)) {
      if (!dateText) dateText = value;
      continue;
    }
    if (DESCRIPTION_PATTERNS.test(label)) {
      descriptionParts.push(value);
      continue;
    }
  }

  const resolvedTimezone = isValidTimezone(timezone)
    ? (timezone as string).trim()
    : DEFAULT_FORM_BOOKING_TIMEZONE;
  const scheduledAt = parseFormBookingDateTime(dateText, timeText, resolvedTimezone);
  return {
    title: title?.trim() || null,
    scheduledAt: scheduledAt ? scheduledAt.toISOString() : null,
    timezone: resolvedTimezone,
    description: descriptionParts.length > 0 ? descriptionParts.join(' · ') : null,
  };
}

/** Nilai jawaban Tally apa adanya (teks/angka langsung, pilihan → teks option). */
function tallyFieldText(field: TallyField): string | null {
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

/* ────────────────────────────────────────────────────────────
 * Pembuatan booking + notifikasi owner
 * ──────────────────────────────────────────────────────────── */

export type FormBookingSource = 'google-forms' | 'tally';

export interface CreateFormBookingInput {
  workspaceId: string;
  /** userId pemilik workspace (auth) — dipakai booking.userId & kontak. */
  userId: string;
  source: FormBookingSource;
  /** Referensi unik dari sumber (responseId / token) — kunci idempotensi. */
  sourceRef: string;
  title: string;
  scheduledAt: string;
  timezone: string;
  description?: string | null;
  customerName: string | null;
  phone: string | null;
}

export interface CreateFormBookingResult {
  created: boolean;
  bookingId?: string;
  skipped?: 'duplicate' | 'invalid-schedule' | 'no-title';
}

/**
 * Buat booking `pending` dari submission form. Idempoten:
 * - Duplikat (workspaceId, source, sourceRef) → `created: false` (retry aman).
 * - Judul kosong / jadwal tidak valid → `created: false` (kontak tetap dibuat).
 * Setelah insert: tautkan kontak, jadwalkan reminder + auto-call, sinkronkan
 * kalender, dan emit webhook keluar `booking.created` (mirror route POST).
 */
export async function createBookingFromFormSubmission(
  input: CreateFormBookingInput,
): Promise<CreateFormBookingResult> {
  const rawTitle = input.title.trim();
  const scheduled = new Date(input.scheduledAt);
  if (!rawTitle) return { created: false, skipped: 'no-title' };
  if (Number.isNaN(scheduled.getTime())) return { created: false, skipped: 'invalid-schedule' };

  // Booking diambil dari layanan katalog (best-effort): judul yang diisi
  // pelanggan dicocokkan ke katalog workspace. Bila cocok, title/durasi/
  // serviceId diambil dari katalog (konsisten dengan route POST /bookings &
  // channel AI). Bila tidak cocok (judul bebas / katalog kosong), fallback
  // aman ke judul manual + durasi default 60 — form tidak pernah gagal.
  const matched = await matchService(input.workspaceId, rawTitle);
  const title = 'service' in matched ? matched.service.name : rawTitle;
  const serviceId = 'service' in matched ? matched.service.id : null;
  const durationMinutes = 'service' in matched ? matched.service.durationMinutes : 60;

  // Idempotensi: unique (workspace_id, source, source_ref) — cek dulu agar
  // retry Inngest yang mengulang setelah crash tidak membuat booking ganda.
  const [existing] = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        eq(bookings.workspaceId, input.workspaceId),
        eq(bookings.source, input.source),
        eq(bookings.sourceRef, input.sourceRef),
      ),
    )
    .limit(1);
  if (existing) return { created: false, skipped: 'duplicate' };

  const [row] = await db
    .insert(bookings)
    .values({
      userId: input.userId,
      workspaceId: input.workspaceId,
      description: input.description?.trim() ? input.description.trim() : null,
      scheduledAt: scheduled,
      timezone: input.timezone || DEFAULT_FORM_BOOKING_TIMEZONE,
      customerName: input.customerName?.trim() || null,
      phone: input.phone?.trim() || null,
      staffId: 'service' in matched && matched.service.staffIds.length === 1 ? matched.service.staffIds[0] : null,
      durationMinutes,
      serviceId,
      source: input.source,
      sourceRef: input.sourceRef,
    })
    .onConflictDoNothing()
    .returning();
  // Kalah race (submission sama masuk bersamaan) → booking pemenang dipakai.
  if (!row) return { created: false, skipped: 'duplicate' };

  // Tautkan kontak (pipeline sama dengan route POST /bookings).
  await syncBookingContact({
    userId: input.userId,
    workspaceId: input.workspaceId,
    bookingId: row.id,
    customerName: row.customerName,
    phone: row.phone,
  });

  // Reminder + auto-call + kalender + webhook keluar (mirror route bookings).
  await emitBookingCreated({
    workspaceId: input.workspaceId,
    bookingId: row.id,
    scheduledAt: scheduled,
    timezone: row.timezone,
  });
  if (row.phone) {
    await emitAutoCallScheduled({
      workspaceId: input.workspaceId,
      bookingId: row.id,
      scheduledAt: scheduled,
      timezone: row.timezone,
    });
  }
  await emitCalendarBookingEvent(input.workspaceId, row.id, 'upsert');
  await emitOutgoingWebhookEvent(input.workspaceId, 'booking.created', {
    id: row.id,
    workspaceId: input.workspaceId,
    // Title = nama layanan katalog (bila cocok) atau judul form (fallback).
    title,
    status: row.status,
    scheduledAt: row.scheduledAt.toISOString(),
    timezone: row.timezone,
    customerName: row.customerName,
    phone: row.phone,
    source: row.source,
    sourceRef: row.sourceRef,
  });
  await emitSlackBookingEvent(input.workspaceId, 'booking.created', {
    id: row.id,
    workspaceId: input.workspaceId,
    title,
    status: row.status,
    scheduledAt: row.scheduledAt.toISOString(),
    timezone: row.timezone,
    customerName: row.customerName,
    phone: row.phone,
  });
  await emitVideoLinkEvent(input.workspaceId, row.id);

  captureBookingEvent('booking.created', {
    workspaceId: input.workspaceId,
    bookingId: row.id,
    userId: input.userId,
    source: input.source,
    goalType: row.goalType,
    status: row.status,
  });

  return { created: true, bookingId: row.id };
}

/**
 * Notifikasi email ke owner workspace saat booking baru dibuat dari form.
 * Best-effort: kegagalan email TIDAK menggagalkan pembuatan booking.
 */
/** Escape HTML agar nilai dari form (title/nama/telepon) aman di email HTML. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function notifyOwnerNewBooking(input: {
  workspaceId: string;
  title: string;
  customerName: string | null;
  phone: string | null;
  scheduledAt: string;
  timezone: string;
}): Promise<void> {
  try {
    const [workspace] = await db
      .select({ userId: workspaces.userId, name: workspaces.name })
      .from(workspaces)
      .where(and(eq(workspaces.id, input.workspaceId), isNull(workspaces.deletedAt)))
      .limit(1);
    if (!workspace) return;

    const [owner] = await db
      .select({ email: authUser.email })
      .from(authUser)
      .where(eq(authUser.id, workspace.userId))
      .limit(1);
    if (!owner?.email) return;

    const tz = isValidTimezone(input.timezone) ? input.timezone : DEFAULT_FORM_BOOKING_TIMEZONE;
    const when = new Intl.DateTimeFormat('id-ID', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: tz,
    }).format(new Date(input.scheduledAt));

    // Nilai dari form bisa berisi karakter HTML (judul/nama/telepon) — escape
    // agar tidak menjadi injection ke email owner.
    const title = escapeHtml(input.title);
    const customerName = input.customerName ? escapeHtml(input.customerName) : null;
    const phone = input.phone ? escapeHtml(input.phone) : null;
    const lines = [
      `Booking baru diterima${workspace.name ? ` untuk ${escapeHtml(workspace.name)}` : ''}:`,
      '',
      `• ${title}`,
      `• ${when}`,
      customerName ? `• Nama: ${customerName}` : null,
      phone ? `• Telepon: ${phone}` : null,
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n');

    // Import lazy: services/email.ts membangun klien Resend saat modul dimuat,
    // yang melempar bila RESEND_API_KEY kosong (mis. di test). Karena email ini
    // best-effort, modul form-booking tidak boleh gagal load karenanya.
    const { resend } = await import('../services/email.ts');
    await resend.emails.send({
      from: brand.emailFrom,
      to: [owner.email],
      subject: `Booking baru: ${input.title}${input.customerName ? ` (${input.customerName})` : ''}`,
      html: `<p>${lines.replace(/\n/g, '<br/>')}</p>`,
    });
  } catch (error) {
    // Best-effort — jangan gagalkan pembuatan booking karena email gagal.
    console.warn('[form-booking] gagal mengirim email owner:', error);
  }
}
