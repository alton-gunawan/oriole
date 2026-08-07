import { env } from '../config/env';
import { clearAccessToken, getAccessToken, setAccessToken } from './token';
import { useSessionStore } from '../stores/session';
import { useWorkspaceStore } from '../stores/workspace';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /**
     * true = 401 yang TIDAK bisa dipulihkan dan otoritas sesi (Neon Auth)
     * sudah mengonfirmasi sesi mati → reset lokal telah dijalankan.
     * false = 401 transien (refresh gagal jaringan / server menolak token)
     * → sesi lokal TIDAK disentuh; pemanggil boleh retry.
     */
    public readonly sessionDead = false,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * API kita mengembalikan body JSON `{ error: string }` saat gagal.
 * Ekstrak pesan yang bisa ditampilkan ke user — hindari memaparkan
 * JSON mentah sebagai teks error.
 */
function extractErrorMessage(body: string, fallback: string): string {
  if (!body) return fallback;
  try {
    // `detail` (alasan asli, mis. dari Paddle) lebih informatif daripada
    // pesan generik `error` — diprioritaskan bila keduanya ada.
    const parsed = JSON.parse(body) as { error?: unknown; detail?: unknown };
    if (typeof parsed.detail === 'string' && parsed.detail.trim()) return parsed.detail;
    if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error;
  } catch {
    // Bukan JSON — pakai body mentah (mis. error proxy/HTML).
  }
  return body.length > 200 ? `${body.slice(0, 200)}…` : body;
}

/**
 * Fetch ke backend Hono dengan timeout + header otomatis (Bearer token,
 * cookie sesi HttpOnly, X-Workspace-Id). Mengembalikan Response mentah —
 * interpretasi status dilakukan pemanggil.
 */
async function doFetch(path: string, init: RequestInit, token: string | null): Promise<Response> {
  const activeWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId;

  // Timeout: abort fetch bila backend tidak merespons. `signal` pemanggil
  // (bila ada) tetap dihormati dengan menggabungkannya.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  const signal = init.signal
    ? AbortSignal.any([init.signal, controller.signal])
    : controller.signal;

  try {
    return await fetch(`${env.API_URL}${path}`, {
      ...init,
      // Kirim cookie sesi HttpOnly (hand-off) bersama request. Bearer token
      // tetap dilampirkan bila masih ada — keduanya diakui server.
      credentials: 'include',
      signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(activeWorkspaceId ? { 'X-Workspace-Id': activeWorkspaceId } : {}),
        ...init.headers,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Coba pulihkan JWT diam-diam dari sesi Better Auth (Neon Auth).
 *
 * JWT aplikasi short-lived, sedangkan sesi Better Auth sendiri panjang
 * (cookie HttpOnly yang direfresh otomatis oleh SDK). Saat server membalas
 * 401 karena JWT kedaluwarsa, kita bisa langsung meminta token baru
 * (`getJWTToken()` = `getSession().session.token`) alih-alih menganggap
 * sesi mati.
 *
 * Hasil dibedakan KETAT:
 * - `refreshed` → token baru tersedia.
 * - `no-session` → otoritas (Neon Auth) menyatakan TIDAK ada sesi → ini
 *   SATU-SATUNYA bukti sesi mati yang sah.
 * - `error` → error jaringan/SDK transien — BUKAN bukti sesi mati, dan
 *   TIDAK boleh memicu logout.
 *
 * Dynamic import → SDK Neon Auth yang besar tidak ikut bundle awal; baru
 * dimuat saat refresh benar-benar dibutuhkan (pola sama dengan signOut).
 *
 * Fan-out 401 paralel (mis. dashboard memuat banyak data tepat saat token
 * kedaluwarsa) di-dedup menjadi SATU panggilan refresh via promise bersama.
 */
type RefreshResult =
  | { kind: 'refreshed'; token: string }
  | { kind: 'no-session' }
  | { kind: 'error' };

let inFlightRefresh: Promise<RefreshResult> | null = null;

function tryRefreshToken(): Promise<RefreshResult> {
  inFlightRefresh ??= (async (): Promise<RefreshResult> => {
    try {
      const { getNeonJwtOrThrow } = await import('./auth');
      const token = await getNeonJwtOrThrow();
      return token ? { kind: 'refreshed', token } : { kind: 'no-session' };
    } catch {
      // Error jaringan / SDK gagal dimuat — transien, bukan bukti sesi mati.
      return { kind: 'error' };
    } finally {
      inFlightRefresh = null;
    }
  })();
  return inFlightRefresh;
}

/**
 * Refresh dengan satu kesempatan kedua bila hasilnya 'no-session': panggilan
 * ke Neon Auth bisa gagal sesaat (jaringan), dan `getJWTToken()` mengembalikan
 * null pada kondisi tersebut. Konfirmasi ulang sebelum memutuskan sesi mati.
 */
async function refreshWithRetry(): Promise<RefreshResult> {
  const first = await tryRefreshToken();
  if (first.kind === 'no-session') {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return tryRefreshToken();
  }
  return first;
}

/**
 * Reset total sesi lokal — HANYA dipanggil saat otoritas sesi (Neon Auth)
 * mengonfirmasi 'no-session' (bukan saat error jaringan / 401 transien).
 */
function resetSession(): void {
  clearAccessToken();
  useSessionStore.getState().clear();
  useWorkspaceStore.getState().clear();
}

/**
 * Fetch helper ke backend Hono — otomatis melampirkan Bearer token jika ada.
 * `path` TANPA prefix `/api` (base `env.API_URL` sudah memuatnya,
 * default `/api` di dev via proxy Vite). Contoh: `apiFetch('/health')`.
 *
 * Semua request dibatasi timeout (default 10s) agar UI tidak pernah
 * menggantung selamanya saat backend down/hang.
 *
 * Penanganan 401: token lokal bisa kedaluwarsa padahal sesi Better Auth
 * masih hidup. apiFetch mencoba refresh JWT diam-diam lalu retry SEKALI.
 * Sesi lokal hanya di-reset bila refresh gagal atau 401 bertahan — jadi
 * masalah sesaat (JWKS hiccup, API cold-start, clock skew) tidak lagi
 * mengusir user yang masih punya sesi valid.
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  let token = getAccessToken();
  let res = await doFetch(path, init, token);

  // 401 → coba pulihkan sesi diam-diam (tanpa mengganggu UI). Retry hanya
  // aman bila body bisa dikirim ulang (string/FormData/Blob) — stream
  // (ReadableStream) yang sudah dikonsumsi tidak bisa dipakai dua kali.
  const bodyRetryable = !(init.body instanceof ReadableStream);
  let sessionDead = false;
  if (res.status === 401 && bodyRetryable) {
    const refresh = await refreshWithRetry();
    if (refresh.kind === 'refreshed') {
      setAccessToken(refresh.token);
      res = await doFetch(path, init, refresh.token);
    } else if (refresh.kind === 'no-session') {
      // Satu-satunya kasus sah untuk logout: otoritas sesi menyatakan mati.
      resetSession();
      sessionDead = true;
    }
    // refresh.kind === 'error' → transien. JANGAN reset sesi: user yang
    // sesinya valid tidak boleh diusir karena jaringan berkedip sesaat.
  }

  // Masih 401: bila refresh sudah sukses tapi server tetap menolak (mis.
  // JWKS hiccup / clock skew server-side), sesi lokal juga TIDAK direset —
  // token yang valid tidak boleh dibuang karena masalah di sisi server.
  if (res.status === 401) {
    const body = await res.text();
    throw new ApiError(res.status, extractErrorMessage(body, res.statusText), sessionDead);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new ApiError(res.status, extractErrorMessage(body, res.statusText));
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}
