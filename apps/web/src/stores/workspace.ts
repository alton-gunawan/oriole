import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { queryClient } from '../lib/queryClient';
import { groupAnalyticsWorkspace } from '../lib/analytics';
import type { Workspace } from '../lib/workspace';

interface WorkspaceState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  initialized: boolean;
  /**
   * true saat pindah project sedang berlangsung — UI (AppShell) menampilkan
   * overlay loader sampai data workspace baru selesai dimuat.
   */
  isSwitching: boolean;
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
  /** Pilih workspace lain + tunggu data-nya selesai dimuat (Promise resolve
   *  saat tidak ada lagi query in-flight). Dipanggil dari switcher sidebar. */
  switchWorkspace: (workspaceId: string) => Promise<void>;
  clear: () => void;
}

/** Kunci localStorage — hanya `lastOpenedAt` yang di-persist. */
const STORAGE_NAME = 'oriole.workspace.lastOpenedAt';

const nowIso = () => new Date().toISOString();

/**
 * Durasi minimum overlay switcher terlihat (ms) — mencegah kedipan saat
 * data workspace baru sudah ada di cache dan selesai seketika.
 */
const MIN_SWITCH_VISIBLE_MS = 350;

/** Jaring pengaman: bila ada query yang tidak pernah settle (mis. hang),
 *  overlay tetap hilang setelah batas ini agar UI tidak terkunci. */
const SWITCH_TIMEOUT_MS = 10_000;

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set, get) => ({
      workspaces: [],
      activeWorkspaceId: null,
      initialized: false,
      isSwitching: false,
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
      addWorkspace: (workspace) => {
        const first = !useWorkspaceStore.getState().activeWorkspaceId;
        set((state) => ({
          workspaces: [...state.workspaces, workspace],
          activeWorkspaceId: state.activeWorkspaceId ?? workspace.id,
          initialized: true,
          // Hanya jadi aktif bila ini workspace pertama — baru dihitung "dibuka".
          lastOpenedAt: state.activeWorkspaceId
            ? state.lastOpenedAt
            : { ...state.lastOpenedAt, [workspace.id]: nowIso() },
        }));
        // Analitik: workspace pertama yang dibuat = group aktif.
        if (first) void groupAnalyticsWorkspace(workspace.id);
      },
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
      switchWorkspace: async (activeWorkspaceId) => {
        const state = get();
        if (!activeWorkspaceId || state.isSwitching || activeWorkspaceId === state.activeWorkspaceId) {
          return;
        }

        set({
          isSwitching: true,
          activeWorkspaceId,
          lastOpenedAt: { ...state.lastOpenedAt, [activeWorkspaceId]: nowIso() },
        });
        // Analitik: pindahkan group workspace aktif.
        void groupAnalyticsWorkspace(activeWorkspaceId);

        // Tunggu data workspace baru selesai: semua query yang baru mount
        // (kunci react-query memuat activeWorkspaceId) mulai fetch setelah
        // re-render, lalu settle. Query workspace lama yang masih in-flight
        // ikut dihitung — hanya memperpanjang overlay sesaat.
        await new Promise<void>((resolve) => {
          const startedAt = Date.now();
          let done = false;

          const finish = () => {
            if (done) return;
            done = true;
            clearInterval(timer);
            clearTimeout(safety);
            unsubscribe();
            resolve();
          };

          const check = () => {
            // Minimum durasi agar overlay tidak berkedip, lalu tunggu sampai
            // tidak ada lagi query yang in-flight.
            if (Date.now() - startedAt < MIN_SWITCH_VISIBLE_MS) return;
            if (queryClient.isFetching() > 0) return;
            finish();
          };

          const unsubscribe = queryClient.getQueryCache().subscribe(check);
          // Polling cadangan: subscribe hanya dipicu saat cache BERUBAH —
          // bila tidak ada query sama sekali (halaman belum mount ulang),
          // interval yang memeriksa minimum durasi tetap menyelesaikan.
          const timer = setInterval(check, 120);
          const safety = setTimeout(finish, SWITCH_TIMEOUT_MS);
          check();
        });

        set({ isSwitching: false });
      },
      // `clear()` (logout/401) sengaja TIDAK menghapus lastOpenedAt — riwayat
      // buka bersifat per-device dan id workspace unik per akun, jadi aman
      // dipertahankan antar sesi.
      clear: () =>
        set({ workspaces: [], activeWorkspaceId: null, initialized: false, isSwitching: false }),
    }),
    {
      name: STORAGE_NAME,
      partialize: (state) => ({ lastOpenedAt: state.lastOpenedAt }),
    },
  ),
);
