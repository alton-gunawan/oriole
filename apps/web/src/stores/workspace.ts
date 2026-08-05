import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { Workspace } from '../lib/workspace';

interface WorkspaceState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  initialized: boolean;
  /**
   * Waktu (ISO) terakhir kali workspace dibuka/dipilih — dilacak di sisi
   * client (per-device) dan di-persist ke localStorage. Dipakai switcher
   * project di sidebar untuk menampilkan "last opened".
   */
  lastOpenedAt: Record<string, string>;
  setWorkspaces: (workspaces: Workspace[]) => void;
  addWorkspace: (workspace: Workspace) => void;
  updateWorkspace: (workspace: Workspace) => void;
  removeWorkspace: (workspaceId: string) => void;
  setActiveWorkspace: (workspaceId: string) => void;
  clear: () => void;
}

/** Kunci localStorage — hanya `lastOpenedAt` yang di-persist. */
const STORAGE_NAME = 'oriole.workspace.lastOpenedAt';

const nowIso = () => new Date().toISOString();

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set) => ({
      workspaces: [],
      activeWorkspaceId: null,
      initialized: false,
      lastOpenedAt: {},
      setWorkspaces: (workspaces) =>
        set((state) => {
          const activeWorkspaceId =
            state.activeWorkspaceId &&
            workspaces.some((workspace) => workspace.id === state.activeWorkspaceId)
              ? state.activeWorkspaceId
              : (workspaces[0]?.id ?? null);
          return {
            workspaces,
            initialized: true,
            activeWorkspaceId,
            // Boot sesi = membuka workspace aktif → catat sebagai terakhir dibuka.
            lastOpenedAt: activeWorkspaceId
              ? { ...state.lastOpenedAt, [activeWorkspaceId]: nowIso() }
              : state.lastOpenedAt,
          };
        }),
      addWorkspace: (workspace) =>
        set((state) => ({
          workspaces: [...state.workspaces, workspace],
          activeWorkspaceId: state.activeWorkspaceId ?? workspace.id,
          initialized: true,
          // Hanya jadi aktif bila ini workspace pertama — baru dihitung "dibuka".
          lastOpenedAt: state.activeWorkspaceId
            ? state.lastOpenedAt
            : { ...state.lastOpenedAt, [workspace.id]: nowIso() },
        })),
      updateWorkspace: (workspace) =>
        set((state) => ({
          workspaces: state.workspaces.map((item) => (item.id === workspace.id ? workspace : item)),
        })),
      removeWorkspace: (workspaceId) =>
        set((state) => {
          const workspaces = state.workspaces.filter((item) => item.id !== workspaceId);
          // Bersihkan riwayat buka workspace yang dihapus.
          const lastOpenedAt = { ...state.lastOpenedAt };
          delete lastOpenedAt[workspaceId];
          // Jika workspace aktif dihapus, pindah ke sisa pertama (atau null →
          // RequireAuth akan mengarahkan ke onboarding saat tidak ada lagi).
          // Pengganti yang otomatis aktif dihitung sebagai "baru dibuka".
          const wasActive = state.activeWorkspaceId === workspaceId;
          const activeWorkspaceId = wasActive
            ? (workspaces[0]?.id ?? null)
            : state.activeWorkspaceId;
          return {
            workspaces,
            activeWorkspaceId,
            lastOpenedAt:
              wasActive && activeWorkspaceId
                ? { ...lastOpenedAt, [activeWorkspaceId]: nowIso() }
                : lastOpenedAt,
          };
        }),
      setActiveWorkspace: (activeWorkspaceId) =>
        set((state) => ({
          activeWorkspaceId,
          lastOpenedAt: activeWorkspaceId
            ? { ...state.lastOpenedAt, [activeWorkspaceId]: nowIso() }
            : state.lastOpenedAt,
        })),
      // `clear()` (logout/401) sengaja TIDAK menghapus lastOpenedAt — riwayat
      // buka bersifat per-device dan id workspace unik per akun, jadi aman
      // dipertahankan antar sesi.
      clear: () => set({ workspaces: [], activeWorkspaceId: null, initialized: false }),
    }),
    {
      name: STORAGE_NAME,
      partialize: (state) => ({ lastOpenedAt: state.lastOpenedAt }),
    },
  ),
);
