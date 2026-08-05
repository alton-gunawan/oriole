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

export async function restoreSession(): Promise<void> {
  const store = useSessionStore.getState();
  if (store.status !== 'loading' || !isAuthConfigured) {
    if (store.status === 'loading') store.clear();
    return;
  }

  // Token boleh tidak ada di sessionStorage: setelah hand-off, sesi hidup
  // di cookie HttpOnly. `/me` memakai Bearer bila ada, atau cookie
  // (apiFetch selalu mengirim credentials: 'include').
  try {
    const me = await apiFetch<{ userId: string; email?: string; workspaces: Workspace[] }>('/me');
    useWorkspaceStore.getState().setWorkspaces(me.workspaces);
    store.setStatus('authenticated');
    store.setUser({ id: me.userId, email: me.email });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      clearAccessToken();
      store.clear();
    } else {
      // Bukan 401 (jaringan mati, API down/5xx, timeout): JANGAN pernah
      // kembali ke 'loading' — itu membuat halaman auth (dan splash)
      // spinner selamanya karena tidak ada yang akan mengubah statusnya.
      // `store.clear()` → 'unauthenticated' supaya form auth tetap tampil;
      // token TIDAK dihapus agar sesi valid bisa pulih saat /me sehat.
      store.clear();
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
