import { VapiClient, type Vapi } from '@vapi-ai/server-sdk';

import { env } from '../lib/env.ts';

/**
 * Vapi Developer API — official TypeScript SDK.
 * https://docs.vapi.ai/
 *
 * Pengganti CALL-E (HeyCall-e). Vapi adalah platform voice AI agent
 * (STT + LLM + TTS + telepon). Strategi asisten: **transient per panggilan**
 * — satu asisten dibangun per call dari prompt goal yang sudah dikomposisi
 * (`composeCallGoal`), jadi perilaku sama persis dengan CALL-E (setiap call
 * membawa prompt sendiri) tanpa perlu mengelola asisten di dashboard.
 */
/**
 * True bila Vapi dikonfigurasi (API key + phone number ID). Tanpa ini semua
 * aksi panggilan menolak dengan pesan jelas — API tetap bisa boot dengan
 * .env placeholder (lihat skema env).
 */
export const vapiConfigured = Boolean(env.VAPI_API_KEY && env.VAPI_PHONE_NUMBER_ID);

export const vapi = vapiConfigured ? new VapiClient({ token: env.VAPI_API_KEY! }) : null;

/** Error bisnis — Vapi belum dikonfigurasi; bukan kegagalan jaringan/provider. */
export class VapiNotConfiguredError extends Error {
  constructor() {
    super('Vapi belum dikonfigurasi (VAPI_API_KEY / VAPI_PHONE_NUMBER_ID kosong di .env).');
    this.name = 'VapiNotConfiguredError';
  }
}

/** Konteks yang dibutuhkan untuk membangun asisten transient Vapi. */
export interface VapiCallContext {
  /** System prompt goal (dari `composeCallGoal`) — sumber perilaku agen. */
  prompt: string;
  /** Bahasa panggilan (en / id). */
  language: 'en' | 'id';
  businessName?: string | null;
  customerName?: string | null;
  /**
   * Nama panggilan — dipakai sebagai jejak audit + basis guard duplikat.
   * Format: `booking:<bookingId>:<goalType>:<source>`.
   */
  callName: string;
}

export interface PlaceVapiCallInput extends VapiCallContext {
  /** Nomor tujuan (E.164) — customer.number. */
  phone: string;
  /**
   * Nomor keluar (id nomor Vapi). Kosong → env.VAPI_PHONE_NUMBER_ID.
   * Dipakai pemilihan nomor per-workspace (lihat lib/place-call.ts).
   */
  phoneNumberId?: string;
}

/**
 * Bangun asisten transient untuk satu panggilan.
 *
 * Server URL = endpoint webhook kita; Vapi mengirim `Authorization: Bearer
 * <VAPI_WEBHOOK_SECRET>` lewat `server.headers` (tanpa perlu setup credential
 * di dashboard). Tanpa secret, header tidak dikirim dan endpoint webhook
 * menolak semua event (fail-closed) — konsisten dengan desain CALLE.
 */
export function buildVapiAssistant(params: VapiCallContext): Vapi.CreateAssistantDto {
  const server: NonNullable<Vapi.CreateAssistantDto['server']> = {
    url: `${env.API_URL}/api/webhooks/vapi`,
  };
  if (env.VAPI_WEBHOOK_SECRET) {
    server.headers = { Authorization: `Bearer ${env.VAPI_WEBHOOK_SECRET}` };
  }

  return {
    name: `oriole-${params.callName}`,
    transcriber: {
      provider: 'deepgram',
      model: 'nova-2',
      language: params.language,
    },
    model: {
      provider: 'openai',
      model: env.VAPI_MODEL as Vapi.OpenAiModelModel,
      messages: [{ role: 'system', content: params.prompt }],
      temperature: 0.7,
    },
    voice: {
      provider: '11labs',
      voiceId: env.VAPI_VOICE_ID as Vapi.ElevenLabsVoiceId,
      language: params.language,
    },
    firstMessage: firstMessageFor(params),
    endCallPhrases: ['goodbye', 'bye'],
    server,
    serverMessages: ['end-of-call-report', 'status-update'],
    // Panggilan booking seharusnya singkat; pengaman durasi maksimal.
    maxDurationSeconds: 600,
  };
}

/** Kalimat pembuka panggilan keluar — sesuai bahasa & nama (bila ada). */
function firstMessageFor(params: VapiCallContext): string {
  const business = params.businessName ?? 'your provider';
  if (params.language === 'id') {
    return params.customerName
      ? `Halo, saya menelepon dari ${business}. Apakah saya berbicara dengan ${params.customerName}?`
      : `Halo, saya menelepon dari ${business} mengenai jadwal Anda.`;
  }
  return params.customerName
    ? `Hello, this is ${business} calling. Am I speaking with ${params.customerName}?`
    : `Hello, this is ${business} calling about your upcoming appointment.`;
}

/**
 * Tempatkan panggilan keluar Vapi: asisten transient + nomor tujuan.
 * Mengembalikan id & status awal call (mis. `queued` / `ringing`).
 */
export async function placeVapiCall(input: PlaceVapiCallInput): Promise<{
  id: string;
  status: string | null;
}> {
  if (!vapi) throw new VapiNotConfiguredError();
  const call = await vapi.calls.create({
    name: input.callName,
    assistant: buildVapiAssistant(input),
    phoneNumberId: input.phoneNumberId ?? env.VAPI_PHONE_NUMBER_ID,
    customer: { number: input.phone },
  });

  // create() bisa mengembalikan CallBatchResponse (hasil: Call[]) untuk batch
  // call — panggilan kita selalu single customer, jadi pastikan bentuk Call.
  if (!('status' in call)) {
    throw new Error('Vapi mengembalikan batch response untuk panggilan tunggal');
  }
  return { id: call.id, status: call.status ?? null };
}

/**
 * Cari call Vapi yang sudah dibuat dengan nama tertentu — dipakai reconcile
 * pada retry (lihat lib/place-call.ts): attempt sebelumnya bisa sukses create
 * tapi mati sebelum commit DB; list-lalu-cocokkan-by-name memungkinkan retry
 * mengadopsi call itu daripada menempatkan panggilan ganda.
 *
 * `calls.list` tidak mendukung filter by name, jadi kita filter sisi klien
 * pada jendela waktu yang pendek (15 menit). Karena nama panggilan kita unik
 * per panggilan logis, match pertama sudah cukup (list berurutan
 * terbaru-dahulu di sisi Vapi).
 */
/** Info publik satu nomor telepon Vapi (tanpa kredensial). */
export interface VapiPhoneNumberInfo {
  id: string;
  /** Nomor E.164 (tersedia untuk BYO — telnyx/twilio/vonage). */
  number: string | null;
  name: string | null;
  provider: string;
}

/**
 * Daftar nomor telepon yang terdaftar di akun Vapi (limit 100).
 * Dipakai halaman Integrations (Voice AI) — workspace memilih nomor mana
 * yang dipakai panggilan keluar mereka. Klien baru dibuat dari API key
 * (BUKAN singleton `vapi` yang butuh VAPI_PHONE_NUMBER_ID).
 */
export async function listVapiPhoneNumbers(): Promise<VapiPhoneNumberInfo[]> {
  if (!env.VAPI_API_KEY) return [];
  const client = new VapiClient({ token: env.VAPI_API_KEY });
  const numbers = await client.phoneNumbers.list({ limit: 100 });
  return numbers.map((n) => ({
    id: n.id,
    number: 'number' in n && typeof n.number === 'string' ? n.number : null,
    name: n.name ?? null,
    provider: n.provider,
  }));
}

/** Prefix nama nomor BYOC di Vapi — memisahkan nomor milik workspace dari milik operator. */
export const VAPI_BYOC_NAME_PREFIX = 'oriole-byoc-';

/**
 * Saring daftar nomor menjadi hanya nomor OPERATOR (murni, mudah diuji):
 * nomor yang didaftarkan mode BYO carrier (nama berprefix `oriole-byoc-`)
 * milik workspace tertentu; tidak boleh muncul/dipilih workspace lain.
 */
export function filterOperatorVapiNumbers(all: VapiPhoneNumberInfo[]): VapiPhoneNumberInfo[] {
  return all.filter((n) => !n.name?.startsWith(VAPI_BYOC_NAME_PREFIX));
}

/**
 * Daftar nomor OPERATOR (bukan BYOC) — dipakai picker "Server numbers".
 * Nomor yang didaftarkan mode BYO carrier tidak boleh tampil di picker
 * workspace lain.
 */
export async function listOperatorVapiPhoneNumbers(): Promise<VapiPhoneNumberInfo[]> {
  const all = await listVapiPhoneNumbers();
  return filterOperatorVapiNumbers(all);
}

/* ────────────────────────────────────────────────────────────
 * Nomor MASUK (inbound) — customer menelepon nomor ini dan dilayani
 * agen Voice AI. Nomor dibuat TANPA assistantId: Vapi mengirim pesan
 * `assistant-request` ke server URL nomor saat ada panggilan masuk, dan
 * webhook kita mengembalikan asisten transient per-workspace (lihat
 * lib/vapi-inbound.ts). Server URL dipasang di level NOMOR (bukan asisten)
 * karena asistennya dibuat saat runtime.
 * ──────────────────────────────────────────────────────────── */

/** Hasil pendaftaran nomor inbound di sisi Vapi. */
export interface RegisteredVapiInboundNumber {
  vapiPhoneNumberId: string;
  /** Nomor E.164 — null selama provisioning (Vapi mengalokasikan asinkron). */
  number: string | null;
}

/**
 * Daftarkan nomor inbound baru (provider 'vapi' — nomor Vapi/Twilio).
 * `areaCode` opsional (kode area, mis. "415"); tanpa itu Vapi memilih.
 * Nomor dilengkapi server URL webhook kita + auth header (sama seperti
 * asisten keluar), jadi `assistant-request` terautentikasi (fail-closed).
 */
export async function registerVapiInboundNumber(input: {
  workspaceId: string;
  /** Label di dashboard Vapi — prefix memisahkan milik inbound Oriole. */
  name: string;
  areaCode?: string;
}): Promise<RegisteredVapiInboundNumber> {
  if (!env.VAPI_API_KEY) throw new VapiNotConfiguredError();
  const client = new VapiClient({ token: env.VAPI_API_KEY });
  const server: NonNullable<Vapi.Server> = {
    url: `${env.API_URL}/api/webhooks/vapi`,
  };
  if (env.VAPI_WEBHOOK_SECRET) {
    server.headers = { Authorization: `Bearer ${env.VAPI_WEBHOOK_SECRET}` };
  }
  const created = await client.phoneNumbers.create({
    provider: 'vapi',
    name: input.name,
    ...(input.areaCode ? { numberDesiredAreaCode: input.areaCode } : {}),
    server,
  });
  return {
    vapiPhoneNumberId: created.id,
    number: 'number' in created && typeof created.number === 'string' ? created.number : null,
  };
}

/** Hapus nomor inbound dari akun Vapi (best-effort — caller tangani kegagalan). */
export async function unregisterVapiInboundNumber(vapiPhoneNumberId: string): Promise<void> {
  if (!env.VAPI_API_KEY) throw new VapiNotConfiguredError();
  const client = new VapiClient({ token: env.VAPI_API_KEY });
  await client.phoneNumbers.delete({ id: vapiPhoneNumberId });
}

export async function findVapiCallByName(
  callName: string,
  since: Date = new Date(Date.now() - 15 * 60_000),
): Promise<{ id: string; status: string | null } | null> {
  // Vapi tidak dikonfigurasi → tidak mungkin ada call yang bisa diadopsi.
  if (!vapi) return null;
  const calls = await vapi.calls.list({
    limit: 100,
    createdAtGe: since.toISOString(),
  });
  const match = calls.find((call) => call.name === callName);
  if (!match) return null;
  return { id: match.id, status: match.status ?? null };
}

/* ────────────────────────────────────────────────────────────
 * Pemetaan endedReason Vapi → status aplikasi.
 *
 * Status aplikasi (kolom calle_calls.status) memakai kosakata lama CALL-E:
 *   completed / failed / canceled (+ status hidup seperti queued/in-progress).
 * `countCallAttempts` memperlakukan failed/error sebagai attempt gagal →
 * goal engine bisa menyarankan follow-up berikutnya.
 * ──────────────────────────────────────────────────────────── */

export type VapiCallOutcome = 'completed' | 'failed' | 'canceled';

/** Alasan berakhir yang berarti percakapan/penyelesaian goal terjadi. */
const COMPLETED_ENDED_REASONS = new Set([
  'assistant-ended-call',
  'assistant-ended-call-after-message-spoken',
  'assistant-ended-call-with-hangup-task',
  'assistant-said-end-call-phrase',
  'assistant-forwarded-call',
  'customer-ended-call',
  // Legacy / transport-reported completion.
  'hangup',
  'exceeded-max-duration',
  'call.ending.hook-executed-say',
  'call.ending.hook-executed-transfer',
  'call.in-progress.twilio-completed-call',
  'call.in-progress.sip-completed-call',
  'call.in-progress.vonage-completed-call',
]);

/** Alasan yang berarti panggilan dibatalkan (bukan kegagalan teknis). */
const CANCELED_ENDED_REASONS = new Set([
  'manually-canceled',
  'call-deleted',
  'scheduled-call-deleted',
  'call.start.error-subscription-frozen',
  'call.start.error-subscription-insufficient-credits',
  'call.start.error-subscription-wallet-does-not-exist',
  'call.start.error-subscription-upgrade-failed',
  'call.start.error-subscription-concurrency-limit-reached',
]);

/**
 * Map `endedReason` webhook Vapi → status aplikasi.
 * Alasan di luar set di atas (semua *-failed, *-error*, customer-did-not-answer,
 * customer-busy, voicemail, assistant-not-found, transport errors, ...)
 * diperlakukan sebagai `failed`. `null` bila alasan kosong (bukan terminal).
 */
export function mapEndedReason(reason: string | null | undefined): VapiCallOutcome | null {
  if (!reason) return null;
  if (COMPLETED_ENDED_REASONS.has(reason)) return 'completed';
  if (CANCELED_ENDED_REASONS.has(reason)) return 'canceled';
  return 'failed';
}
