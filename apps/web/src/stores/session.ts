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

/** State client ringan — sesi dibaca dari JWT / API (lib/auth + lib/api). */
export const useSessionStore = create<SessionState>()((set) => ({
  status: 'loading',
  user: null,
  setStatus: (status) => set({ status }),
  setUser: (user) => set({ user }),
  clear: () => {
    set({ status: 'unauthenticated', user: null });
    useWorkspaceStore.getState().clear();
  },
  // Jangan sentuh user/workspaces — sesi belum tentu mati, hanya server
  // yang sedang tidak bisa dijangkau.
  setError: () => set({ status: 'error' }),
}));
