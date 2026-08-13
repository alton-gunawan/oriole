import type { VapiClient } from '@vapi-ai/server-sdk';

/**
 * Kredensial provider di sisi Vapi — endpoint `POST /credential` &
 * `GET /credential` (api.vapi.ai). Tidak ada di SDK resmi (resource
 * `credentials` belum dikeluarkan), jadi dipanggil lewat passthrough
 * `vapi.fetch()` — memakai auth/retry/logging SDK yang sama.
 *
 * Dipakai mode "Bring your own carrier" (BYOC): workspace menempel API key
 * Telnyx miliknya sendiri; operator (kita) membuat kredensial Telnyx DI SISI
 * VAPI atas nama akun Vapi kita, sehingga panggilan keluar workspace dialukan
 * lewat akun Telnyx mereka. API key Telnyx dikirim ke Vapi SEKALI saat
 * pembuatan — TIDAK pernah disimpan di database kita.
 *
 * Catatan wire-format: payload `{ provider: 'telnyx', apiKey, name }` adalah
 * rekonstruksi dari alur dashboard Vapi ("Import Telnyx" = nomor + API key +
 * label). Endpoint `POST /credential` & `GET /credential` diverifikasi ada
 * (respons 401 "Missing Authorization Header" tanpa auth). Bila Vapi
 * merilis DTO resmi, cukup ubah fungsi ini.
 */

/** Error dari API credential Vapi — status HTTP + pesan dari body. */
export class VapiCredentialApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(`Vapi credential API ${status}: ${message}`);
    this.name = 'VapiCredentialApiError';
    this.status = status;
  }
}

/** Ambil pesan error dari body response (best-effort, bukan JSON → kosong). */
async function readErrorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as {
      message?: string;
      error?: string;
      statusCode?: number;
    };
    return body?.message ?? body?.error ?? '';
  } catch {
    return '';
  }
}

export interface CreateTelnyxCredentialInput {
  /** Klien Vapi (harus dibuat dengan VAPI_API_KEY operator — BUKAN singleton `vapi`). */
  vapi: VapiClient;
  /** API key Telnyx milik workspace — dikirim ke Vapi, tidak pernah disimpan. */
  apiKey: string;
  /** Nama deterministik (per workspace) — dasar idempotensi/adopsi orphan. */
  name: string;
}

export interface VapiCredentialRef {
  id: string;
}

/**
 * Buat kredensial Telnyx di akun Vapi operator. TIDAK idempoten di sisi
 * Vapi — pemanggil wajib memakai findTelnyxCredentialByName dulu (atau
 * existingCredentialId dari baris integrasi) agar retry tidak menggandakan.
 */
export async function createTelnyxCredential(
  input: CreateTelnyxCredentialInput,
): Promise<VapiCredentialRef> {
  const res = await input.vapi.fetch('/credential', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'telnyx',
      apiKey: input.apiKey,
      name: input.name,
    }),
  });
  if (!res.ok) {
    const detail = await readErrorDetail(res);
    throw new VapiCredentialApiError(res.status, detail || res.statusText);
  }
  const body = (await res.json()) as {
    id?: unknown;
    credential?: { id?: unknown };
  };
  const id = typeof body?.id === 'string' ? body.id : body?.credential?.id;
  if (typeof id !== 'string' || !id) {
    throw new VapiCredentialApiError(
      res.status,
      'Respons pembuatan credential tidak memuat id (format API Vapi berubah?).',
    );
  }
  return { id };
}

/**
 * Cari kredensial Telnyx yang sudah ada dengan nama deterministik —
 * dipakai mengadopsi credential dari attempt yang gagal di tengah jalan
 * (crash antara create dan commit baris integrasi), supaya retry tidak
 * membuat credential ganda. `null` bila belum ada.
 */
export async function findTelnyxCredentialByName(
  vapi: VapiClient,
  name: string,
): Promise<VapiCredentialRef | null> {
  const res = await vapi.fetch('/credential', { method: 'GET' });
  if (!res.ok) {
    const detail = await readErrorDetail(res);
    throw new VapiCredentialApiError(res.status, detail || res.statusText);
  }
  const body = (await res.json()) as unknown;
  const list = Array.isArray(body)
    ? body
    : Array.isArray((body as { credentials?: unknown })?.credentials)
      ? (body as { credentials: unknown[] }).credentials
      : [];
  const match = list.find(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      (entry as { provider?: unknown }).provider === 'telnyx' &&
      (entry as { name?: unknown }).name === name,
  );
  const id = match && typeof (match as { id?: unknown }).id === 'string'
    ? (match as { id: string }).id
    : null;
  return id ? { id } : null;
}
