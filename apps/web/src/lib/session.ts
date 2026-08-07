import { ApiError, apiFetch } from './api';
import { clearAccessToken, isAuthConfigured } from './token';
import { clearSessionCookie } from './session-cookie';
import { useSessionStore } from '../stores/session';
import { useWorkspaceStore } from '../stores/workspace';
import type { Workspace } from './workspace';

/**
 * Lifecycle sesi ringan (dipakai bundle awal):
 * - `restoreSession()` — pulihkan sesi saat boot (token → status → /api/me).
 * - `signOut()` — bersihkan sesi lokal; panggilan server via dynamic import
 *   agar SDK Neon Auth tidak ikut bundle awal.
 */

/** Jeda antar-retry boot — API cold-start / jaringan putus sesaat itu wajar. */
const BOOT_RETRY_DELAYS_MS = [500, 1500, 3000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function restoreSession(): Promise<void> {
  const store = useSessionStore.getState();
  // Dipanggil saat boot (status 'loading') atau dari tombol coba-ulang
  // (status 'error'). Sesi yang sudah authenticated/unauthenticated tidak
  // dipulihkan ulang.
  const canRestore = store.status === 'loading' || store.status === 'error';
  if (!canRestore || !isAuthConfigured) {
    if (store.status === 'loading') store.clear();
    return;
  }
  if (store.status === 'error') store.setStatus('loading'); // retry → splash

  // Token boleh tidak ada di sessionStorage: setelah hand-off, sesi hidup
  // di cookie HttpOnly. `/me` memakai Bearer bila ada, atau cookie
  // (apiFetch selalu mengirim credentials: 'include').
  //
  // Boot di-retry beberapa kali dengan jeda: kegagalan sesaat (API
  // cold-start, jaringan, 5xx) TIDAK boleh mengusir user yang masih punya
  // sesi valid. HANYA 401 yang dibuktikan mati (sessionDead, otoritas
  // menyatakan tidak ada sesi) yang me-reset; sisanya → status 'error'
  // dengan layar coba-ulang (bukan halaman sign-in).
  let attempt = 0;
  while (true) {
    try {
      const me = await apiFetch<{
        userId: string;
        email?: string;
        /** Nama tampilan dari tabel profiles — null bila belum pernah di-set. */
        name?: string | null;
        workspaces: Workspace[];
      }>('/me');
      useWorkspaceStore.getState().setWorkspaces(me.workspaces);
      store.setStatus('authenticated');
      store.setUser({ id: me.userId, email: me.email, name: me.name ?? undefined });
      return;
    } catch (err) {
      // 401 yang sudah dikonfirmasi mati oleh otoritas sesi → reset lokal.
      if (err instanceof ApiError && err.status === 401 && err.sessionDead) {
        clearAccessToken();
        store.clear();
        return;
      }
      // 401 transien (refresh gagal jaringan / server menolak token),
      // jaringan mati, API down/5xx, timeout: retry dengan jeda.
      if (attempt >= BOOT_RETRY_DELAYS_MS.length) {
        // Retry habis — jangan biarkan splash/loading selamanya, dan JANGAN
        // logout: sesi (token + workspace) tetap dipertahankan. Layar
        // 'error' menyediakan tombol coba-ulang; reload juga akan mencoba
        // lagi.
        store.setError();
        return;
      }
      await sleep(BOOT_RETRY_DELAYS_MS[attempt]);
      attempt += 1;
    }
  }
}

export async function signOut(): Promise<void> {
  try {
    const { authClient } = await import('./auth');
    await authClient?.signOut();
  } catch {
    // SDK tidak dimuat / gagal — sesi lokal tetap dibersihkan.
  }
  // Hapus cookie sesi aplikasi di API (jika ada).
  await clearSessionCookie();
  clearAccessToken();
  useSessionStore.getState().clear();
  useWorkspaceStore.getState().clear();
}
