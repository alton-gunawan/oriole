import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Industry } from '@oriole/call-goals';
import {
  conversations,
  services as servicesTable,
  workspaceIntegrations,
  workspaces,
} from '@oriole/database';

import { db } from '../db/index.ts';
import { decryptSecret } from './crypto.ts';
import { tallyFormUrl } from './form-links.ts';
import { webhookBaseUrl } from './webhook-url.ts';
import { normalizePhone } from './phone.ts';
import { upsertContactFromSubmission, type ContactSubmission } from './contact-ingest.ts';
import {
  createBookingFromFormSubmission,
  extractBookingFromTally,
  notifyOwnerNewBooking,
} from './form-booking.ts';

/* ────────────────────────────────────────────────────────────
 * Tally integration — submission form → kontak bisnis.
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
  /**
   * Form memuat hidden field `phone` + default answer → URL `?phone=`
   * mengisi nomor HP otomatis. Di-set saat generate/update berhasil dengan
   * blok prefill (fallback ke false bila Tally menolak blok tersebut).
   */
  phonePrefill?: boolean;
  /**
   * Form memuat hidden field `orioleChatId` (token chat asal) → konfirmasi
   * otomatis bisa dikirim ke chat Telegram asal form. Form BARU dengan prefill
   * aktif selalu memuatnya; form LAMA (dibuat sebelum fitur ini) punya
   * `phonePrefill: true` TANPA flag ini → di-PATCH ulang oleh
   * ensureTallyFormEnhanced agar URL `?orioleChatId=` berfungsi.
   */
  chatToken?: boolean;
  /**
   * Pertanyaan layanan memakai DROPDOWN berisi layanan dari katalog
   * workspace (bukan teks bebas). Snapshot saat generate/update — sinkronkan
   * ulang via POST /integrations/tally/update-content saat layanan berubah.
   */
  serviceDropdown?: boolean;
  /**
   * Kapan terakhir konten form disinkronkan (PATCH) — baik berhasil maupun
   * ditolak Tally. Dipakai auto-sync di UI (guard 24 jam) agar form lama yang
   * belum punya prefill/dropdown diperbarui otomatis tanpa menekan API tiap
   * halaman dimuat saat Tally menolak payload.
   */
  contentSyncAttemptedAt?: string;
  /** Pesan error sinkronisasi konten terakhir (null = sukses) — untuk UI. */
  lastContentSyncError?: string | null;
  /** Kapan terakhir konfirmasi booking dicoba kirim ke customer (ISO). */
  lastConfirmationAt?: string | null;
  /** Alasan konfirmasi gagal terakhir (null = sukses) — untuk UI. */
  lastConfirmationError?: string | null;
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

/**
 * Fetch ke API Tally dengan Bearer token; non-2xx → TallyApiError.
 *
 * Timeout 30s: membuat form Tally (banyak block) bisa lambat, dan tanpa
 * timeout backend bisa menggantung selamanya — yang akhirnya membuat
 * frontend (timeout 10s) membatalkan request dan menampilkan "Fetch is
 * aborted" meski sebenarnya masih diproses.
 */
async function tallyFetch<T>(apiKey: string, path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let res: Response;
  try {
    res = await fetch(`${TALLY_API_BASE}${path}`, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(init?.headers ?? {}),
      },
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      // Plain Error (bukan TallyApiError) → route memetakannya ke 502
      // dengan pesan ramah "Gagal membuat form Tally. Coba lagi.".
      throw new Error('Tally API timeout');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
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

/* ────────────────────────────────────────────────────────────
 * Pembuatan form booking (POST /forms) — field sesuai sistem booking
 * ──────────────────────────────────────────────────────────── */

/** Satu block form Tally (payload longgar mengikuti schema API Tally). */
export interface TallyFormBlock {
  uuid: string;
  type: string;
  groupUuid: string;
  groupType: string;
  payload: Record<string, unknown>;
}

interface BookingFormField {
  label: string;
  type: string;
  required: boolean;
  payload?: Record<string, unknown>;
  /** true = field layanan (bisa menjadi DROPDOWN dari katalog). */
  isService?: boolean;
  /**
   * Hidden field yang dipakai sebagai default answer (phone / name) — URL
   * `?phone=` / `?name=` mengisi input ini otomatis saat form dimuat.
   */
  prefill?: 'phone' | 'name';
}

/** Profil form booking per industri — label layanan + field tambahan. */
interface IndustryFormProfile {
  /** Label pertanyaan "layanan" — harus cocok dengan TITLE_PATTERNS ekstraksi. */
  serviceLabel: string;
  /** Field tambahan opsional spesifik industri (jangan mulai dengan kata kunci judul). */
  extraFields?: BookingFormField[];
}

/**
 * Field booking standar — label/tipe DIPILIH agar cocok dengan heuristic
 * ekstraksi (extractContactFromTallySubmission + extractBookingFromTally):
 * nama → Nama, telepon → INPUT_PHONE_NUMBER, layanan → Layanan,
 * tanggal → INPUT_DATE, jam → INPUT_TIME, catatan → Catatan.
 */
const BOOKING_FORM_FIELDS: BookingFormField[] = [
  { label: 'Nama', type: 'INPUT_TEXT', required: true, prefill: 'name' },
  {
    label: 'Nomor HP / WhatsApp',
    type: 'INPUT_PHONE_NUMBER',
    required: true,
    prefill: 'phone',
    payload: { internationalFormat: true, defaultCountryCode: 'ID' },
  },
  { label: 'Layanan', type: 'INPUT_TEXT', required: true },
  { label: 'Tanggal', type: 'INPUT_DATE', required: true },
  { label: 'Jam', type: 'INPUT_TIME', required: true },
  { label: 'Catatan', type: 'INPUT_TEXT', required: false },
];

/**
 * Profil per industri — form booking yang di-generate menyesuaikan kosakata
 * bisnis (label layanan) + field tambahan yang relevan. Label layanan selalu
 * diawali kata kunci judul (layanan/service/jenis/perawatan/kelas/paket/…)
 * agar mapping ekstraksi booking tetap bekerja tanpa modifikasi.
 */
export const INDUSTRY_FORM_PROFILES: Record<Industry, IndustryFormProfile> = {
  clinic: {
    serviceLabel: 'Jenis Pemeriksaan',
    extraFields: [{ label: 'Poli / Dokter', type: 'INPUT_TEXT', required: false }],
  },
  salon: {
    serviceLabel: 'Jenis Layanan',
    extraFields: [{ label: 'Stylist pilihan', type: 'INPUT_TEXT', required: false }],
  },
  fitness: {
    serviceLabel: 'Kelas / Latihan',
    extraFields: [{ label: 'Instruktur pilihan', type: 'INPUT_TEXT', required: false }],
  },
  spa: {
    serviceLabel: 'Jenis Perawatan',
    extraFields: [{ label: 'Terapis pilihan', type: 'INPUT_TEXT', required: false }],
  },
  dental: {
    serviceLabel: 'Perawatan Gigi',
    extraFields: [{ label: 'Dokter yang diinginkan', type: 'INPUT_TEXT', required: false }],
  },
  other: { serviceLabel: 'Layanan' },
};

/** Field booking untuk sebuah industri — base + profil industri (fallback ke other). */
function bookingFormFieldsFor(industry?: string | null): BookingFormField[] {
  const profile =
    industry && industry in INDUSTRY_FORM_PROFILES
      ? INDUSTRY_FORM_PROFILES[industry as Industry]
      : INDUSTRY_FORM_PROFILES.other;
  const [nama, phone, service, date, time, notes] = BOOKING_FORM_FIELDS;
  return [
    nama,
    phone,
    { ...service, label: profile.serviceLabel, isService: true },
    date,
    time,
    ...(profile.extraFields ?? []),
    notes,
  ];
}

/** Blok label pertanyaan (TITLE groupType QUESTION) — mendahului input. */
function tallyQuestionTitle(label: string): TallyFormBlock {
  const uuid = randomUUID();
  return { uuid, type: 'TITLE', groupUuid: uuid, groupType: 'QUESTION', payload: { html: label } };
}

/**
 * Blok input (INPUT_* standalone — groupUuid = uuid sendiri).
 * Bila `phonePrefill` aktif, input nomor HP mendapat default answer yang
 * menunjuk hidden field `phone` — inilah yang membuat URL `?phone=...`
 * mengisi nomor otomatis (mekanisme resmi Tally: URL param → hidden field
 * → default answer). Per OpenAPI Tally: hasDefaultAnswer=true + defaultAnswer
 * berupa referensi Field ke hidden field (bukan string).
 */
function tallyInputBlock(
  field: BookingFormField,
  opts: { phonePrefill?: boolean; hidden?: TallyHiddenFieldRefs | null } = {},
): TallyFormBlock {
  const uuid = randomUUID();
  const payload: Record<string, unknown> = {
    isRequired: field.required,
    ...(field.payload ?? {}),
  };
  // Input bertanda `prefill` (Nama / Nomor HP) mendapat default answer dari
  // hidden field yang sesuai — URL `?name=` / `?phone=` mengisinya otomatis.
  if (opts.phonePrefill && field.prefill && opts.hidden) {
    const fieldUuid = field.prefill === 'phone' ? opts.hidden.phoneUuid : opts.hidden.nameUuid;
    payload.hasDefaultAnswer = true;
    payload.defaultAnswer = {
      uuid: fieldUuid,
      type: 'HIDDEN_FIELD',
      questionType: 'HIDDEN_FIELDS',
      blockGroupUuid: opts.hidden.groupUuid,
      title: field.prefill,
    };
  }
  return { uuid, type: field.type, groupUuid: uuid, groupType: field.type, payload };
}

/**
 * Referensi hidden field `phone` + `name` + `orioleChatId` — dipakai dua
 * tempat sekaligus:
 *  1. blok HIDDEN_FIELDS di payload form (hiddenFields: [{uuid, name}])
 *  2. defaultAnswer input (referensi Field ke uuid hidden field masing-masing)
 * Payload mengikuti OpenAPI resmi Tally (api.tally.so/openapi.json):
 *   - HiddenFieldsPayload → `hiddenFields: [{ uuid, name }]`
 *   - DefaultAnswerString → oneOf [Field, string], di mana Field untuk
 *     hidden field berbentuk { uuid, type: 'HIDDEN_FIELD',
 *     questionType: 'HIDDEN_FIELDS', blockGroupUuid, title }.
 * Nama hidden field = nama query param URL (?phone= / ?name= /
 * ?orioleChatId=). `orioleChatId` membawa chat asal form: bot menyuntikkan
 * chat id ke URL saat mengirim tautan, submission membawanya kembali, dan
 * webhook mengirim konfirmasi langsung ke chat itu — tanpa menunggu
 * customer kirim pesan lagi (lihat syncTallySubmissionToContacts).
 */
interface TallyHiddenFieldRefs {
  /** Blok HIDDEN_FIELDS — diletakkan di akhir form. */
  block: TallyFormBlock;
  /** groupUuid blok HIDDEN_FIELDS — dipakai referensi defaultAnswer. */
  groupUuid: string;
  /** uuid hidden field `phone` — referensi defaultAnswer input nomor HP. */
  phoneUuid: string;
  /** uuid hidden field `name` — referensi defaultAnswer input nama. */
  nameUuid: string;
  /** uuid hidden field `orioleChatId` — token chat asal form (bukan input). */
  chatUuid: string;
}

function tallyHiddenFieldsBlock(): TallyHiddenFieldRefs {
  const phoneUuid = randomUUID();
  const nameUuid = randomUUID();
  const chatUuid = randomUUID();
  const groupUuid = randomUUID();
  return {
    phoneUuid,
    nameUuid,
    chatUuid,
    groupUuid,
    block: {
      uuid: groupUuid,
      type: 'HIDDEN_FIELDS',
      groupUuid,
      groupType: 'HIDDEN_FIELDS',
      payload: {
        hiddenFields: [
          { uuid: phoneUuid, name: 'phone' },
          { uuid: nameUuid, name: 'name' },
          { uuid: chatUuid, name: 'orioleChatId' },
        ],
      },
    },
  };
}

/**
 * Blok opsi dropdown layanan — satu DROPDOWN_OPTION per layanan katalog.
 * Semua opsi berbagi SATU groupUuid (dokumentasi Tally "Creating a
 * dropdown"): payload { index, isFirst, isLast, text }. Nama dobel dibuang;
 * urutan mengikuti katalog (sortOrder).
 */
function tallyServiceDropdownOptions(services: { id: string; name: string }[]): TallyFormBlock[] {
  const groupUuid = randomUUID();
  const names = [...new Set(services.map((s) => s.name?.trim()).filter((n): n is string => Boolean(n)))];
  return names.map((text, index) => ({
    uuid: randomUUID(),
    type: 'DROPDOWN_OPTION',
    groupUuid,
    groupType: 'DROPDOWN',
    payload: {
      index,
      isFirst: index === 0,
      isLast: index === names.length - 1,
      text,
    },
  }));
}

/** Judul form booking — dipakai blok FORM_TITLE + nama tersimpan. */
export function tallyBookingFormTitle(businessName?: string | null): string {
  return businessName?.trim() ? `Booking ${businessName.trim()}` : 'Booking';
}

/**
 * Bangun block form booking Tally (murni — diuji unit). Urutan: judul form,
 * lalu pasangan TITLE + INPUT per field (asosiasi label→input bersifat
 * posisional, sesuai dokumentasi Tally "Adding blocks to a form").
 * `industry` menyesuaikan label layanan + field tambahan (profil per industri).
 * `phonePrefill` menambahkan hidden field `phone` + default answer pada
 * input nomor HP → URL `?phone=...` mengisi nomor otomatis.
 */
export function buildTallyBookingFormBlocks(input: {
  businessName?: string | null;
  industry?: string | null;
  phonePrefill?: boolean;
  /** Layanan katalog — dipakai saat pertanyaan layanan memakai DROPDOWN. */
  services?: { id: string; name: string }[];
} = {}): TallyFormBlock[] {
  const title = tallyBookingFormTitle(input.businessName);
  const titleUuid = randomUUID();
  const formTitle: TallyFormBlock = {
    uuid: titleUuid,
    type: 'FORM_TITLE',
    groupUuid: titleUuid,
    groupType: 'TEXT',
    payload: { title, html: title },
  };
  // Hidden field `phone` + `name` dibangun LEBIH DULU agar input yang
  // bersangkutan bisa mereferensikannya (defaultAnswer → Field ref ke uuid
  // hidden field masing-masing).
  const hidden = input.phonePrefill ? tallyHiddenFieldsBlock() : null;
  const serviceNames = (input.services ?? []).filter((s) => s.name?.trim());
  const blocks: TallyFormBlock[] = [formTitle];
  for (const field of bookingFormFieldsFor(input.industry)) {
    blocks.push(tallyQuestionTitle(field.label));
    if (field.isService && serviceNames.length > 0) {
      // Layanan = dropdown dari katalog (bukan teks bebas).
      blocks.push(...tallyServiceDropdownOptions(serviceNames));
    } else {
      blocks.push(tallyInputBlock(field, { phonePrefill: input.phonePrefill, hidden }));
    }
  }
  if (hidden) {
    blocks.push(hidden.block);
  }
  return blocks;
}

export interface TallyFormCreated {
  id: string;
  name: string;
  url: string;
  /** true = form memuat hidden field `phone` (URL `?phone=` aktif). */
  phonePrefill: boolean;
  /** true = pertanyaan layanan memakai DROPDOWN dari katalog. */
  serviceDropdown: boolean;
}

export interface TallyFormInput {
  businessName?: string | null;
  industry?: string | null;
  /** Default true — nonaktifkan hanya bila dipanggil tanpa prefill. */
  phonePrefill?: boolean;
  /** Layanan katalog workspace — membangun DROPDOWN (kosong = teks bebas). */
  services?: { id: string; name: string }[];
}

/**
 * Tier fallback saat Tally menolak blok tertentu. Urutan prioritas:
 *   1. prefill phone + dropdown layanan
 *   2. dropdown layanan saja (prefill ditolak)
 *   3. prefill phone saja (dropdown ditolak)
 *   4. form polos (perilaku lama)
 * Tier yang berhasil dipakai; semua ditolak → error terakhir dilempar.
 * `phonePrefill` / `serviceDropdown` di return menandakan hasil sebenarnya.
 */
async function createTallyFormWithFallback(
  input: TallyFormInput,
  request: (blocks: TallyFormBlock[]) => Promise<{ id?: string; name?: string }>,
): Promise<TallyFormCreated & { id: string }> {
  const attemptPrefill = input.phonePrefill !== false;
  const hasServices = (input.services ?? []).some((s) => s.name?.trim());

  const tiers: { prefill: boolean; dropdown: boolean }[] = [];
  if (attemptPrefill && hasServices) tiers.push({ prefill: true, dropdown: true });
  if (hasServices) tiers.push({ prefill: false, dropdown: true });
  if (attemptPrefill) tiers.push({ prefill: true, dropdown: false });
  tiers.push({ prefill: false, dropdown: false });

  let lastError: unknown;
  for (const tier of tiers) {
    try {
      const form = await request(
        buildTallyBookingFormBlocks({
          ...input,
          phonePrefill: tier.prefill,
          services: tier.dropdown ? input.services ?? [] : [],
        }),
      );
      return {
        id: requireFormId(form),
        name: form.name ?? 'Booking',
        url: tallyFormUrl(requireFormId(form)),
        phonePrefill: tier.prefill,
        serviceDropdown: tier.dropdown,
      };
    } catch (error) {
      if (!(error instanceof TallyApiError)) throw error;
      lastError = error;
      console.warn(
        `[tally] tier (prefill=${tier.prefill}, dropdown=${tier.dropdown}) ditolak API, coba tier berikutnya:`,
        (error as TallyApiError).message,
      );
    }
  }
  throw lastError;
}

function requireFormId(form: { id?: string }): string {
  if (!form.id) throw new TallyApiError('Tally tidak mengembalikan id form.');
  return form.id;
}

/**
 * Buat form booking Tally via POST /forms (status PUBLISHED) — field sesuai
 * sistem booking Oriole. Return id + URL publik (https://tally.so/r/{id}).
 * Bila prefill phone aktif, form diberi hidden field `phone` + default
 * answer (fallback aman bila Tally menolak payload prefill).
 */
export async function createTallyBookingForm(
  apiKey: string,
  input: TallyFormInput = {},
): Promise<TallyFormCreated> {
  return createTallyFormWithFallback(
    input,
    (blocks) =>
      tallyFetch<{ id?: string; name?: string }>(apiKey, '/forms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'PUBLISHED', blocks }),
      }),
  );
}

/**
 * Perbarui konten form booking Tally (PATCH /forms/:id) — timpa SELURUH
 * block dengan field booking standar (industri-aware). Dipakai tombol
 * "Update form content" di Integrations: form yang sudah terhubung tapi
 * isinya tidak lengkap (mis. hanya pesan sapaan) langsung menjadi form
 * booking penuh tanpa harus buat form baru. Webhook & submission yang ada
 * tidak terpengaruh (hanya blocks yang diganti). Sama seperti create,
 * prefill phone dicoba lebih dulu dengan fallback aman.
 */
export async function updateTallyBookingForm(
  apiKey: string,
  formId: string,
  input: TallyFormInput = {},
): Promise<TallyFormCreated> {
  return createTallyFormWithFallback(
    input,
    (blocks) =>
      tallyFetch<{ id?: string; name?: string }>(apiKey, `/forms/${encodeURIComponent(formId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        // status + blocks saja — nama form di dashboard Tally tetap milik user.
        body: JSON.stringify({ status: 'PUBLISHED', blocks }),
      }),
  );
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

/** URL webhook masuk milik workspace — dipakai saat connect/re-register.
 * Base URL = WEBHOOK_BASE_URL (URL publik, mis. tunnel HTTPS) bila disetel,
 * jatuh ke API_URL. API_URL bisa berupa alamat internal (mis. http://api:3000
 * di Docker) yang TIDAK bisa dijangkau Tally dari internet — memakai base
 * publik yang sama seperti webhook channel lain (webhook-url.ts). */
export function tallyWebhookUrl(workspaceId: string): string {
  return `${webhookBaseUrl()}/api/webhooks/tally/${workspaceId}`;
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
    if (trimmed.length === 0) return null;
    // DROPDOWN/single-select: Tally bisa mengirim ID option (string) —
    // resolve ke teks option agar judul/title tidak berisi ID mentah.
    const option = field.options?.find((o) => o.id === trimmed);
    return option?.text ?? trimmed;
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

/**
 * Layanan katalog workspace untuk DROPDOWN form Tally (aktif, urut sortOrder).
 * Kosong = form memakai teks bebas untuk layanan (fallback aman).
 */
export async function listWorkspaceServicesForForm(workspaceId: string): Promise<
  { id: string; name: string }[]
> {
  const rows = await db
    .select({ id: servicesTable.id, name: servicesTable.name })
    .from(servicesTable)
    .where(and(eq(servicesTable.workspaceId, workspaceId), eq(servicesTable.isActive, true)))
    .orderBy(servicesTable.sortOrder, servicesTable.createdAt);
  return rows.filter((row) => row.name?.trim());
}

/**
 * Pastikan form Tally workspace memuat blok enhanced (prefill phone/nama,
 * dropdown layanan, token chat `orioleChatId`). Best-effort & idempotent:
 * flags sudah true → no-op; formId/API key tidak ada → no-op. Dipanggil
 * fire-and-forget saat bot mengirim tautan form — form yang dibuat sebelum
 * fitur ini (atau yang auto-sync-nya belum pernah berhasil) diperbarui
 * otomatis PADA SAAT TAUTAN DIKIRIM, tanpa menunggu owner membuka halaman
 * Integrations. Hasil + error dicatat di providerConfig untuk visibilitas UI.
 */
export async function ensureTallyFormEnhanced(workspaceId: string): Promise<boolean> {
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
  if (!integration) return false;
  const config = integration.providerConfig as unknown as TallyConfig;
  // Kondisi kritis: prefill aktif DAN form memuat token chat `orioleChatId` →
  // konfirmasi otomatis ke chat asal bisa jalan. Form lama (dibuat sebelum
  // fitur token chat) punya phonePrefill=true tapi TANPA orioleChatId — flag
  // `chatToken` membedakannya; tanpa token, form di-PATCH ulang di bawah
  // (throttle 1 jam). Dropdown layanan menyusul via tombol sync (tanpa
  // layanan di katalog memang false).
  if (config.phonePrefill === true && config.chatToken === true) return true;
  // Throttle 1 jam: saat Tally menolak payload, jangan menekan API tiap kali
  // tautan form dikirim ke customer.
  const lastAttempt = config.contentSyncAttemptedAt ? Date.parse(config.contentSyncAttemptedAt) : 0;
  if (Number.isFinite(lastAttempt) && Date.now() - lastAttempt < 60 * 60 * 1000) return false;
  const apiKey = decryptSecret(config.apiKey ?? '');
  if (!apiKey || !config.formId) return false;

  // Stamp hasil (sukses/gagal) ke providerConfig — UI menampilkan alasan bila gagal.
  const stamp = async (patch: Partial<TallyConfig>): Promise<void> => {
    await db
      .update(workspaceIntegrations)
      .set({
        providerConfig: { ...config, ...patch },
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workspaceIntegrations.workspaceId, workspaceId),
          eq(workspaceIntegrations.integrationType, 'tally'),
        ),
      )
      .returning();
  };

  try {
    const [workspace] = await db
      .select({ name: workspaces.name, industry: workspaces.industry })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    const services = await listWorkspaceServicesForForm(workspaceId);
    const updated = await updateTallyBookingForm(apiKey, config.formId, {
      businessName: workspace?.name ?? null,
      industry: workspace?.industry ?? null,
      services,
    });
    await stamp({
      phonePrefill: updated.phonePrefill,
      // Form hasil PATCH dengan prefill aktif selalu memuat hidden field
      // orioleChatId → konfirmasi ke chat asal bisa jalan.
      chatToken: updated.phonePrefill,
      serviceDropdown: updated.serviceDropdown,
      contentSyncAttemptedAt: new Date().toISOString(),
      lastContentSyncError: null,
    });
    return updated.phonePrefill === true;
  } catch (error) {
    console.warn('[tally] ensureTallyFormEnhanced gagal:', error);
    await stamp({
      contentSyncAttemptedAt: new Date().toISOString(),
      lastContentSyncError: error instanceof Error ? error.message : 'gagal menyinkronkan form',
    });
    return false;
  }
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
 * Auto-respond: kirim konfirmasi "booking diterima" ke chat Telegram customer
 * — lewat `chatRef` (token chat asal form, tanpa menunggu customer kirim
 * pesan lagi) ATAU nomor HP yang sudah terhubung (perilaku lama).
 * Best-effort — chat tak dikenal / channel nonaktif hanya dicatat (pola
 * dispatch reminder). Dynamic import memutus rantai modul berat
 * (telegram-handler → whatsapp-handler → ai-chat) agar modul tally tetap
 * ringan saat dimuat dan tidak menimbulkan cycle.
 */
/** Catat hasil percobaan konfirmasi ke providerConfig — untuk UI (best-effort). */
async function stampTallyConfirmation(
  workspaceId: string,
  outcome: { ok: boolean; error?: string },
): Promise<void> {
  try {
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
    if (!integration) return;
    const config = integration.providerConfig as unknown as TallyConfig;
    await db
      .update(workspaceIntegrations)
      .set({
        providerConfig: {
          ...config,
          lastConfirmationAt: new Date().toISOString(),
          lastConfirmationError: outcome.ok
            ? null
            : (outcome.error ?? 'gagal mengirim konfirmasi'),
        },
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workspaceIntegrations.workspaceId, workspaceId),
          eq(workspaceIntegrations.integrationType, 'tally'),
        ),
      )
      .returning();
  } catch (error) {
    console.warn('[tally] gagal mencatat status konfirmasi:', error);
  }
}

async function notifyCustomerBookingCreated(
  workspaceId: string,
  booking: {
    bookingId?: string;
    title: string;
    customerName: string | null;
    phone: string | null;
    scheduledAt: string;
    timezone: string;
    businessName: string | null;
  },
  chatRef: string | null,
): Promise<void> {
  if (!booking.bookingId || !booking.phone) return;
  try {
    const { dispatchTelegramConfirmation, TelegramDispatchError } = await import('./telegram-handler.ts');
    try {
      await dispatchTelegramConfirmation({
        workspaceId,
        booking: {
          id: booking.bookingId,
          title: booking.title,
          customerName: booking.customerName,
          phone: booking.phone,
          scheduledAt: new Date(booking.scheduledAt),
          timezone: booking.timezone,
          videoLink: null,
        },
        businessName: booking.businessName,
        // Token chat asal form → konfirmasi dikirim langsung ke chat itu
        // (dispatchChannelConfirmation memakai override bila ada).
        chatOverride: chatRef ? { identifier: chatRef } : undefined,
      });
      await stampTallyConfirmation(workspaceId, { ok: true });
    } catch (error) {
      if (error instanceof TelegramDispatchError) {
        // Best-effort: jangan gagalkan booking, tapi CATAT agar bisnis bisa
        // melihat kenapa konfirmasi tidak sampai (bukan "diam saja").
        console.warn(`[tally] konfirmasi telegram skip: ${error.message}`);
        await stampTallyConfirmation(workspaceId, { ok: false, error: error.message });
        return;
      }
      throw error;
    }
  } catch (error) {
    console.warn('[tally] gagal mengirim konfirmasi telegram:', error);
  }
}

/**
 * Chat asal form — nilai hidden field `orioleChatId` yang disuntikkan bot ke
 * URL form (lihat form-links.ts). Null bila submission tidak membawa token
 * (mis. form dikirim via email / dibuka tanpa parameter).
 */
export function extractTallyChatRef(payload: TallyWebhookPayload): string | null {
  for (const field of payload.data.fields ?? []) {
    const name = (field.key ?? field.label ?? '').trim();
    if (!name.toLowerCase().includes('oriolechatid')) continue;
    const value = field.value;
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return null;
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
    .select({ userId: workspaces.userId, name: workspaces.name })
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
      // Auto-respond ke customer: konfirmasi "booking diterima" via Telegram.
      // Chat asal form (token orioleChatId) dikonfirmasi dulu milik workspace
      // ini (percakapan Telegram nyata) sebelum dipakai sebagai override —
      // token palsu tidak bisa mengarahkan konfirmasi ke chat lain. Bila
      // token tidak ada / tidak dikenal → fallback nomor HP yang terhubung
      // (perilaku lama). Best-effort — tidak menggagalkan booking.
      const chatRef = extractTallyChatRef(payload);
      let telegramChat: string | null = null;
      if (chatRef) {
        const [known] = await db
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(
              eq(conversations.workspaceId, workspaceId),
              eq(conversations.channelType, 'telegram'),
              eq(conversations.externalId, chatRef),
            ),
          )
          .limit(1);
        if (known) telegramChat = chatRef;
      }
      await notifyCustomerBookingCreated(
        workspaceId,
        {
          bookingId: result.bookingId,
          title: booking.title,
          customerName: contact.name,
          phone: contact.phone,
          scheduledAt: booking.scheduledAt,
          timezone: booking.timezone,
          businessName: workspace.name ?? null,
        },
        telegramChat,
      );
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
