import { env } from './env.ts';

/* ────────────────────────────────────────────────────────────
 * Zoom — buat meeting otomatis untuk booking (Server-to-Server OAuth).
 *
 * App Zoom tipe "Server-to-Server OAuth" (zoom.us → Build App) memberi
 * kredensial ACCOUNT_ID + CLIENT_ID + CLIENT_SECRET (env) yang dipakai
 * server untuk membuat meeting atas nama akun. Tanpa alur OAuth user —
 * cocok untuk single business account per deployment.
 * ──────────────────────────────────────────────────────────── */

export const ZOOM_API_BASE = 'https://api.zoom.us/v2';
export const ZOOM_OAUTH_URL = 'https://zoom.us/oauth/token';

export class ZoomApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ZoomApiError';
  }
}

/** Deteksi placeholder (.env.example) — kredensial sungguhan wajib di produksi. */
function isPlaceholder(value: string | undefined | null): boolean {
  if (!value) return true;
  return /\.\.\.|xxxx|placeholder/i.test(value);
}

/** Zoom siap membuat meeting (semua kredensial env terisi). */
export function isZoomConfigured(): boolean {
  return (
    !isPlaceholder(env.ZOOM_ACCOUNT_ID) &&
    !isPlaceholder(env.ZOOM_CLIENT_ID) &&
    !isPlaceholder(env.ZOOM_CLIENT_SECRET)
  );
}

/** Cache token access (valid 1 jam) — hindari OAuth tiap pembuatan meeting. */
let cachedToken: { token: string; expiresAt: number } | null = null;

/**
 * Ambil access token Server-to-Server (grant_type=account_credentials).
 * Token di-cache sampai kedaluwarsa (1 jam, buffer 5 menit).
 */
export async function getZoomAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token;
  if (!isZoomConfigured()) {
    throw new ZoomApiError('Zoom belum dikonfigurasi di server (ZOOM_ACCOUNT_ID / ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET).', 0);
  }

  const params = new URLSearchParams({
    grant_type: 'account_credentials',
    account_id: env.ZOOM_ACCOUNT_ID as string,
  });
  let res: Response;
  try {
    res = await fetch(`${ZOOM_OAUTH_URL}?${params.toString()}`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${env.ZOOM_CLIENT_ID}:${env.ZOOM_CLIENT_SECRET}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
  } catch (error) {
    throw new ZoomApiError(`Zoom tidak dapat dijangkau (${error instanceof Error ? error.message : 'network error'}).`, 0);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ZoomApiError(`Zoom OAuth menolak (${res.status}): ${body.slice(0, 200)}`, res.status);
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new ZoomApiError('Zoom OAuth tidak mengembalikan access token.', 502);
  }
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + ((data.expires_in ?? 3600) - 300) * 1000,
  };
  return cachedToken.token;
}

/** Respons meeting Zoom — field yang relevan untuk booking. */
export interface ZoomMeeting {
  id: number;
  topic: string;
  joinUrl: string;
  startUrl: string;
}

/**
 * Buat meeting terjadwal (type 2) untuk satu booking. Mengembalikan
 * joinUrl (untuk customer/reminder) + startUrl (untuk staf, opsional).
 */
export async function createZoomMeeting(input: {
  topic: string;
  startTime: Date;
  durationMinutes: number;
  timezone: string;
}): Promise<ZoomMeeting> {
  const token = await getZoomAccessToken();
  const payload = {
    topic: input.topic,
    type: 2,
    start_time: input.startTime.toISOString(),
    duration: Math.max(1, Math.min(720, Math.round(input.durationMinutes))),
    timezone: input.timezone,
    settings: {
      host_video: false,
      participant_video: false,
      join_before_host: true,
      waiting_room: false,
      approval_type: 0,
    },
  };

  let res: Response;
  try {
    res = await fetch(`${ZOOM_API_BASE}/users/me/meetings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw new ZoomApiError(`Zoom tidak dapat dijangkau (${error instanceof Error ? error.message : 'network error'}).`, 0);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ZoomApiError(`Zoom menolak pembuatan meeting (${res.status}): ${body.slice(0, 200)}`, res.status);
  }
  const data = (await res.json()) as { id?: number; topic?: string; join_url?: string; start_url?: string };
  if (!data.id || !data.join_url) {
    throw new ZoomApiError('Zoom tidak mengembalikan URL meeting.', 502);
  }
  return {
    id: data.id,
    topic: data.topic ?? input.topic,
    joinUrl: data.join_url,
    startUrl: data.start_url ?? '',
  };
}

/** Bersihkan cache token (dipakai test — jangan biarkan state bocor antar test). */
export function resetZoomTokenCache(): void {
  cachedToken = null;
}
