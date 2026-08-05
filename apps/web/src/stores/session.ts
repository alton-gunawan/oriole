import { create } from 'zustand';

import { useWorkspaceStore } from './workspace';

export type SessionStatus = 'loading' | 'authenticated' | 'unauthenticated';

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
}));
