import { env } from '../config/env';
import { clearAccessToken, getAccessToken } from './token';
import { useSessionStore } from '../stores/session';
import { useWorkspaceStore } from '../stores/workspace';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
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
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error;
  } catch {
    // Bukan JSON — pakai body mentah (mis. error proxy/HTML).
  }
  return body.length > 200 ? `${body.slice(0, 200)}…` : body;
}

/**
 * Fetch helper ke backend Hono — otomatis melampirkan Bearer token jika ada.
 * `path` TANPA prefix `/api` (base `env.API_URL` sudah memuatnya,
 * default `/api` di dev via proxy Vite). Contoh: `apiFetch('/health')`.
 *
 * Semua request dibatasi timeout (default 10s) agar UI tidak pernah
 * menggantung selamanya saat backend down/hang.
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getAccessToken();
  const activeWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId;

  // Timeout: abort fetch bila backend tidak merespons. `signal` pemanggil
  // (bila ada) tetap dihormati dengan menggabungkannya.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  const signal = init.signal
    ? AbortSignal.any([init.signal, controller.signal])
    : controller.signal;

  let res: Response;
  try {
    res = await fetch(`${env.API_URL}${path}`, {
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

  if (res.status === 401) {
    // Sesi kedaluwarsa / token tidak valid — reset sesi lokal sekarang juga.
    // RequireAuth akan melihat status 'unauthenticated' dan mengarahkan ke
    // halaman masuk, alih-alih menampilkan error yang membingungkan.
    clearAccessToken();
    useSessionStore.getState().clear();
    useWorkspaceStore.getState().clear();
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
