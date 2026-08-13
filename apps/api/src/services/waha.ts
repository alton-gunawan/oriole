/**
 * Client minimal gateway WAHA (WhatsApp HTTP API — unofficial channel).
 *
 * Format request/response persis mengikuti spikes/waha/README.md:
 *   GET  /api/sessions?all=true   — probe gateway + daftar session
 *   POST /api/sessions            — buat session dengan webhook + metadata
 *   POST /api/sendText            — kirim pesan teks (outbound BYO)
 *
 * Auth: header X-Api-Key (WAHA_API_KEY gateway). Webhook di-signed HMAC-SHA512
 * (X-Webhook-Hmac) dengan secret yang dibuat per-workspace dan disimpan di
 * providerConfig.webhookSecret — diverifikasi di adapter route
 * (routes/webhooks/waha.ts).
 */

import { and, eq } from 'drizzle-orm';
import { workspaceChannels } from '@oriole/database';

import { db } from '../db/index.ts';

export class WahaApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface WahaChannelConfig {
  webhookSecret: string | null;
  isActive: boolean;
  sessionName: string | null;
}

/**
 * Resolve channel WhatsApp BYO (provider 'waha') untuk workspace — dipakai
 * webhook adapter. Hanya provider waha yang dikembalikan (bukan 360dialog).
 * Secret webhook HMAC-SHA512 dibuat saat setup dan disimpan di
 * providerConfig.webhookSecret (sengaja bukan `apiKey`, lihat channels.ts).
 * Outbound BYO di-dispatch lewat resolveWhatsAppChannel + sendWhatsAppMessage
 * (services/whatsapp.ts) yang memilah provider — resolver ini hanya untuk
 * webhook adapter (HMAC).
 */
export async function resolveWahaChannel(workspaceId: string): Promise<WahaChannelConfig | null> {
  const [channel] = await db
    .select()
    .from(workspaceChannels)
    .where(
      and(
        eq(workspaceChannels.workspaceId, workspaceId),
        eq(workspaceChannels.channelType, 'whatsapp'),
      ),
    )
    .limit(1);

  const config = (channel?.providerConfig ?? {}) as Record<string, unknown>;
  if (config.provider !== 'waha') return null;

  const secret = config.webhookSecret;
  const sessionName = config.sessionName;
  return {
    webhookSecret: typeof secret === 'string' && secret.length > 0 ? secret : null,
    isActive: channel?.isActive ?? true,
    sessionName: typeof sessionName === 'string' ? sessionName : null,
  };
}

function wahaHeaders(apiKey: string): Record<string, string> {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    'x-api-key': apiKey,
  };
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/**
 * Timeout fetch: gateway yang menggantung (mis. IP privat yang tidak
 * merespons) tidak boleh mengunci request setup selamanya.
 */
const WAHA_REQUEST_TIMEOUT_MS = 10_000;

function wahaFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(WAHA_REQUEST_TIMEOUT_MS) });
}

export interface WahaSessionInfo {
  name: string;
  status: string;
}

/**
 * Probe gateway: GET /api/sessions?all=true → array session.
 * Bukan array → URL ini bukan gateway WAHA (ditolak di setup).
 */
export async function wahaListSessions(baseUrl: string, apiKey: string): Promise<WahaSessionInfo[]> {
  const res = await wahaFetch(`${normalizeBaseUrl(baseUrl)}/api/sessions?all=true`, {
    headers: wahaHeaders(apiKey),
  });
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    throw new WahaApiError(`Gateway WAHA menolak: ${res.status} ${JSON.stringify(json)}`, res.status);
  }
  if (!Array.isArray(json)) {
    throw new WahaApiError('URL tersebut bukan gateway WAHA (respons GET /api/sessions bukan array).');
  }
  return json as WahaSessionInfo[];
}

export interface WahaCreateSessionInput {
  baseUrl: string;
  apiKey: string;
  name: string;
  workspaceId: string;
  webhookUrl: string;
  webhookSecret: string;
}

/**
 * Konversi wa_id (nomor tanpa suffix, mis. "6281234567890") → chatId WAHA
 * ("6281234567890@c.us"). Identifier yang sudah bersuffix (defensif) dibiarkan.
 * Kebalikan dari chatIdToWaId di lib/waha-mapping.ts.
 */
export function waIdToChatId(waId: string): string {
  const trimmed = waId.trim();
  if (/@(c\.us|s\.whatsapp\.net|lid)$/i.test(trimmed)) return trimmed;
  return `${trimmed}@c.us`;
}

export interface WahaQrInfo {
  /** Status session dari gateway (mis. 'SCAN_QR_CODE' / 'WORKING'). */
  status: string | null;
  /** Data URI QR (base64 PNG) — ditampilkan ke user untuk dipindai. */
  url: string | null;
  /** Pairing code (NOWEB) — teks di dalam QR, diketik manual bila perlu. */
  expected: string | null;
  /** TTL detik sebelum QR berotasi — untuk countdown UI. */
  ttl: number | null;
}

/**
 * Ambil QR pairing. Bentuk respons BERVARIASI antar versi WAHA — parse
 * defensif terhadap KETIGA bentuk:
 *
 * 1. **WAHA ≥ 2026.x + header `Accept: application/json`** (yang selalu
 *    dikirim wahaHeaders): `GET /api/{session}/auth/qr` → JSON
 *    `{ "mimetype": "image/png", "data": "<base64>" }` — QR base64 tanpa
 *    status session.
 * 2. **WAHA ≥ 2026.x tanpa Accept JSON:** respons **PNG mentah**
 *    (Content-Type: image/png) — di-encode ulang jadi data-URI.
 * 3. **WAHA lama:** `POST /api/{session}/auth/qr` → JSON — QR data-uri di
 *    `.qr.url`, pairing code di `.qr.expected`, TTL di `.qr.ttl` (fallback
 *    ke akar objek bila tanpa wrapper `qr`).
 *
 * Strategi: GET dulu (versi sekarang), lalu POST (versi lama). Mode 1 & 2
 * tidak membawa status session → status null; pemanggil (route refresh-qr)
 * boleh probe wahaGetSession untuk membedakan WORKING vs SCAN_QR_CODE.
 */
export async function wahaGetQr(input: {
  baseUrl: string;
  apiKey: string;
  session: string;
}): Promise<WahaQrInfo> {
  const path = `/api/${input.session}/auth/qr`;
  const attempts: { method: 'GET' | 'POST' }[] = [{ method: 'GET' }, { method: 'POST' }];
  let lastDetail: unknown = null;
  for (const attempt of attempts) {
    let res: Response;
    try {
      res = await wahaFetch(`${normalizeBaseUrl(input.baseUrl)}${path}`, {
        method: attempt.method,
        headers: wahaHeaders(input.apiKey),
      });
    } catch (error) {
      lastDetail = error;
      continue;
    }
    if (!res.ok) {
      lastDetail = { status: res.status, body: await res.text().catch(() => '') };
      continue;
    }

    const contentType = res.headers.get('content-type') ?? '';

    // (2) PNG mentah → data-URI base64. Tanpa status session — null.
    if (contentType.includes('image/png') || contentType.includes('image/')) {
      const buffer = Buffer.from(await res.arrayBuffer());
      return {
        status: null,
        url: `data:image/png;base64,${buffer.toString('base64')}`,
        expected: null,
        ttl: null,
      };
    }

    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!json) {
      lastDetail = { contentType, body: await res.text().catch(() => '') };
      continue;
    }

    // (1) `{ mimetype, data }` — base64 QR modern tanpa status session.
    // Mimetype divalidasi image/* — data URI non-gambar tidak akan dirender
    // `<img>`; jika bukan gambar, jatuh ke branch (3) / error.
    if (
      typeof json.mimetype === 'string' &&
      json.mimetype.startsWith('image/') &&
      typeof json.data === 'string' &&
      json.data.length > 0
    ) {
      return {
        status: null,
        url: `data:${json.mimetype};base64,${json.data}`,
        expected: null,
        ttl: null,
      };
    }

    // (3) JSON versi lama — status + wrapper `qr` (atau flat).
    const qr = json.qr && typeof json.qr === 'object' ? (json.qr as Record<string, unknown>) : json;
    const ttlValue = typeof qr.ttl === 'number' ? (qr.ttl as number) : (json.ttl as number | undefined);
    return {
      status: typeof json.status === 'string' ? (json.status as string) : null,
      url: typeof qr.url === 'string' && qr.url.length > 0 ? (qr.url as string) : null,
      expected:
        typeof qr.expected === 'string' && qr.expected.length > 0
          ? (qr.expected as string)
          : typeof json.expected === 'string'
            ? (json.expected as string)
            : typeof json.pairingCode === 'string'
              ? (json.pairingCode as string)
              : null,
      ttl: typeof ttlValue === 'number' && Number.isFinite(ttlValue) ? ttlValue : null,
    };
  }
  throw new WahaApiError(`WAHA gagal mengambil QR (GET+POST): ${JSON.stringify(lastDetail)}`);
}

export interface WahaSendTextInput {
  baseUrl: string;
  apiKey: string;
  /** Nama session WAHA (mis. ws_<workspaceId>). */
  session: string;
  /** chatId WAHA: nomor internasional tanpa '+' + @c.us. */
  chatId: string;
  text: string;
  /** Id pesan yang dibalas (reply_to) — opsional. */
  replyTo?: string;
}

/**
 * Kirim pesan teks via WAHA (POST /api/sendText — lihat spikes/waha/README.md).
 * Tidak ada 24h window / template Meta — free text kapan saja (trade-off
 * risiko ban yang sudah disetujui di consent). messageId = id pesan WAHA.
 */
export async function wahaSendText(input: WahaSendTextInput): Promise<{ messageId: string | null }> {
  const body: Record<string, unknown> = {
    session: input.session,
    chatId: input.chatId,
    text: input.text,
  };
  if (input.replyTo) body.reply_to = input.replyTo;

  const res = await wahaFetch(`${normalizeBaseUrl(input.baseUrl)}/api/sendText`, {
    method: 'POST',
    headers: wahaHeaders(input.apiKey),
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    throw new WahaApiError(`WAHA gagal mengirim pesan: ${res.status} ${JSON.stringify(json)}`, res.status);
  }
  const id = json?.id;
  return { messageId: typeof id === 'string' && id.length > 0 ? id : null };
}

/**
 * Detail satu session (GET /api/sessions/{name}) — dipakai watchdog health
 * (probe berkala). Status: STOPPED / STARTING / SCAN_QR_CODE / WORKING / FAILED.
 */
export async function wahaGetSession(
  baseUrl: string,
  apiKey: string,
  session: string,
): Promise<WahaSessionInfo> {
  const res = await wahaFetch(`${normalizeBaseUrl(baseUrl)}/api/sessions/${encodeURIComponent(session)}`, {
    headers: wahaHeaders(apiKey),
  });
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    throw new WahaApiError(`WAHA gagal membaca session: ${res.status} ${JSON.stringify(json)}`, res.status);
  }
  return json as WahaSessionInfo;
}

/**
 * Mulai session WAHA yang berhenti (POST /api/sessions/{session}/start).
 * Session yang QR-nya kadaluarsa tanpa dipindai / setelah gateway restart
 * berada di status STOPPED — `auth/qr` saat itu menolak (422/404). Dipanggil
 * refresh-qr sebelum mengambil QR agar pairing bisa dilanjutkan TANPA re-setup.
 * CATATAN versi: WAHA 2026.x memakai /api/sessions/{session}/start (bukan
 * /api/{session}/start yang 404 di versi ini).
 */
export async function wahaStartSession(
  baseUrl: string,
  apiKey: string,
  session: string,
): Promise<WahaSessionInfo> {
  const res = await wahaFetch(
    `${normalizeBaseUrl(baseUrl)}/api/sessions/${encodeURIComponent(session)}/start`,
    { method: 'POST', headers: wahaHeaders(apiKey) },
  );
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    throw new WahaApiError(`WAHA gagal memulai session: ${res.status} ${JSON.stringify(json)}`, res.status);
  }
  return json as WahaSessionInfo;
}

/**
 * Identitas akun session (GET /api/sessions/{session}/me) — nomor sendiri
 * (me.id, mis. "6281111111111@c.us"). Fail-open: null bila gateway tidak
 * menjawab (watchdog tidak boleh mati karena endpoint opsional ini).
 */
export async function wahaGetMe(
  baseUrl: string,
  apiKey: string,
  session: string,
): Promise<{ id: string | null; pushName: string | null } | null> {
  const res = await wahaFetch(`${normalizeBaseUrl(baseUrl)}/api/sessions/${encodeURIComponent(session)}/me`, {
    headers: wahaHeaders(apiKey),
  });
  if (!res.ok) return null;
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!json || typeof json !== 'object') return null;
  return {
    id: typeof json.id === 'string' && json.id.length > 0 ? (json.id as string) : null,
    pushName: typeof json.pushName === 'string' ? (json.pushName as string) : null,
  };
}

/**
 * Buat session WAHA untuk workspace. 409 = session dengan nama yang sama
 * sudah ada (re-setup) — pemanggil boleh melanjutkan.
 */
/**
 * Konfigurasi session WAHA (webhook adapter + metadata + store NOWEB) —
 * dipakai BERSAMA oleh create (POST) dan update (PUT) agar kedua jalur selalu
 * konsisten: re-setup yang menemukan session lama memperbarui config-nya
 * (webhook URL/secret terkini), bukan membiarkan config basi.
 */
function buildWahaSessionConfig(input: WahaCreateSessionInput) {
  return {
    webhooks: [
      {
        url: input.webhookUrl,
        // message = inbound only (kebutuhan inbox); message.any juga
        // memicu echo outbound — berlangganan 'message' saja memangkas
        // traffic webhook 2x per pesan masuk (dedup idempotency tetap
        // melindungi adapter bila suatu saat perlu menambah message.any).
        events: ['message', 'message.ack', 'session.status'],
        hmac: { key: input.webhookSecret },
        retries: { policy: 'constant', delaySeconds: 2, attempts: 5 },
      },
    ],
    metadata: { 'workspace.id': input.workspaceId },
    // Store NOWEB (per-session, bukan env global — lihat deploy/waha/):
    // simpan kontak/chats/messages session agar bertahan restart dan data
    // lengkap untuk resolve nama kontak. fullSync=false ≈ ~3 bulan riwayat
    // (default engine NOWEB — lihat WHATSAPP_DEFAULT_ENGINE di compose).
    noweb: { store: { enabled: true, fullSync: false } },
  };
}

export async function wahaCreateSession(input: WahaCreateSessionInput): Promise<WahaSessionInfo> {
  const res = await wahaFetch(`${normalizeBaseUrl(input.baseUrl)}/api/sessions`, {
    method: 'POST',
    headers: wahaHeaders(input.apiKey),
    body: JSON.stringify({
      name: input.name,
      config: buildWahaSessionConfig(input),
    }),
  });
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    throw new WahaApiError(`WAHA gagal membuat session: ${res.status} ${JSON.stringify(json)}`, res.status);
  }
  return json as WahaSessionInfo;
}

/**
 * Perbarui session yang SUDAH ADA (PUT /api/sessions/{session}) — dipakai
 * re-setup saat create menolak karena nama session dipakai. WAHA 2026.x
 * menyarankan jalur ini secara eksplisit: "Session '…' already exists. Use PUT
 * to update it.". Payload config sama dengan create (webhook adapter + store).
 */
export async function wahaUpdateSession(input: WahaCreateSessionInput): Promise<WahaSessionInfo> {
  const res = await wahaFetch(
    `${normalizeBaseUrl(input.baseUrl)}/api/sessions/${encodeURIComponent(input.name)}`,
    {
      method: 'PUT',
      headers: wahaHeaders(input.apiKey),
      body: JSON.stringify({ config: buildWahaSessionConfig(input) }),
    },
  );
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    throw new WahaApiError(`WAHA gagal memperbarui session: ${res.status} ${JSON.stringify(json)}`, res.status);
  }
  return json as WahaSessionInfo;
}

/**
 * Apakah error create berarti session SUDAH ADA (reuse, bukan kegagalan)?
 * WAHA lama → 409; WAHA 2026.x → 422 dengan pesan "Session '…' already
 * exists. Use PUT to update it.". Regex mensyaratkan konteks "session '…'
 * already exists" (bukan sekadar kata "already exists" di body 422 lain).
 */
export function isWahaSessionAlreadyExistsError(error: WahaApiError): boolean {
  return error.status === 409 || (error.status === 422 && /session ['"][^'"]+['"] already exists/i.test(error.message));
}
