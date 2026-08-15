import { create } from 'zustand';

import { useWorkspaceStore } from './workspace';

/**
 * - `loading` — pengecekan sesi berjalan (splash).
 * - `authenticated` — sesi valid.
 * - `unauthenticated` — sesi benar-benar mati → halaman sign-in.
 * - `error` — server tidak terjangkau / 401 transien berulang; sesi lokal
 *   TETAP dipertahankan (user tidak di-logout karena masalah jaringan).
 */
export type SessionStatus = 'loading' | 'authenticated' | 'unauthenticated' | 'error';

export interface SessionUser {
  id: string;
  email?: string;
  name?: string;
  /** Preferensi bahasa UI dari profil server — null = ikuti browser. */
  language?: string | null;
  /** Preferensi zona waktu (IANA) dari profil server — null = ikuti browser. */
  timezone?: string | null;
}

interface SessionState {
  status: SessionStatus;
  user: SessionUser | null;
  setStatus: (status: SessionStatus) => void;
  setUser: (user: SessionUser | null) => void;
  clear: () => void;
  /** Status 'error' — sesi tetap utuh, UI menampilkan layar coba-ulang. */
  setError: () => void;
}

/**
 * Snapshot status sesi terakhir (localStorage) — dipakai landing page agar
 * CTA "Go to dashboard" vs "Sign in / Get started" tampil benar SECEPATNYA,
 * tanpa menunggu round-trip `/api/me` saat boot. Status asli di store tetap
 * 'loading' dulu (RequireAuth butuh itu untuk splash + redirect yang benar);
 * snapshot ini hanya sinyal optimis untuk UI publik.
 */
const SESSION_STATUS_KEY = 'oriole.session-status';

export function getCachedSessionStatus(): 'authenticated' | 'unauthenticated' | null {
  if (typeof window === 'undefined') return null;
  const value = window.localStorage.getItem(SESSION_STATUS_KEY);
  return value === 'authenticated' || value === 'unauthenticated' ? value : null;
}

function persistSessionStatus(status: 'authenticated' | 'unauthenticated'): void {
  try {
    window.localStorage.setItem(SESSION_STATUS_KEY, status);
  } catch {
    // localStorage diblokir (private mode) — bukan fatal, abaikan.
  }
}

/** State client ringan — sesi dibaca dari JWT / API (lib/auth + lib/api). */
export const useSessionStore = create<SessionState>()((set) => ({
  status: 'loading',
  user: null,
  setStatus: (status) => {
    if (status === 'authenticated' || status === 'unauthenticated') {
      persistSessionStatus(status);
    }
    set({ status });
  },
  setUser: (user) => set({ user }),
  clear: () => {
    persistSessionStatus('unauthenticated');
    set({ status: 'unauthenticated', user: null });
    useWorkspaceStore.getState().clear();
  },
  // Jangan sentuh user/workspaces — sesi belum tentu mati, hanya server
  // yang sedang tidak bisa dijangkau.
  setError: () => set({ status: 'error' }),
}));
