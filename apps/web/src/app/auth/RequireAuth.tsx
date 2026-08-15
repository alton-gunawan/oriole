import { useEffect, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';

import { apiFetch } from '../../lib/api';
import { restoreSession, signOut } from '../../lib/session';
import { AppLogo } from '../components/AppLogo';
import { useSessionStore } from '../../stores/session';
import { useWorkspaceStore } from '../../stores/workspace';

/**
 * Guard rute: tampilkan splash saat sesi dicek, redirect ke /auth/sign-in
 * bila belum login. Status sesi dipulihkan sekali saat boot (main.tsx).
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const status = useSessionStore((s) => s.status);
  const workspaceCount = useWorkspaceStore((s) => s.workspaces.length);
  const workspaceInitialized = useWorkspaceStore((s) => s.initialized);
  const location = useLocation();

  // Layar 'error' menyembuhkan dirinya sendiri: ping health API secara
  // berkala (jeda naik, tanpa batas) dan begitu server terjangkau, pulihkan
  // sesi penuh secara otomatis — user tidak perlu klik 'Coba lagi'.
  useEffect(() => {
    if (status !== 'error') return;
    let cancelled = false;
    let timer: number | undefined;
    let attempt = 0;
    const DELAYS_MS = [5000, 10_000, 20_000, 30_000];

    async function checkAndRestore(): Promise<void> {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 5000);
      try {
        // Health check cepat (5s timeout) — hanya bila API benar-benar
        // terjangkau barulah restore sesi (yang menampilkan splash loading).
        await apiFetch('/health', { signal: controller.signal });
        if (!cancelled) await restoreSession();
      } catch {
        // Masih offline — jadwalkan percobaan berikutnya.
      } finally {
        window.clearTimeout(timeout);
      }
    }

    async function loop(): Promise<void> {
      if (cancelled) return;
      await checkAndRestore();
      if (cancelled) return;
      const delay = DELAYS_MS[Math.min(attempt, DELAYS_MS.length - 1)];
      attempt += 1;
      timer = window.setTimeout(loop, delay);
    }

    void loop();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [status]);

  if (status === 'error') {
    // Server tidak terjangkau / 401 transien berulang — sesi masih utuh,
    // jangan logout user. Layar ini auto-retry (lihat effect di atas);
    // tombol coba-ulang & keluar tetap tersedia sebagai jalan keluar manual.
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-5 bg-surface px-4 text-center">
        <span className="flex size-12 items-center justify-center overflow-hidden rounded-md bg-amber-500">
          <AppLogo />
        </span>
        <div className="max-w-md">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">{t('auth.offlineTitle')}</h1>
          <p className="mt-3 text-base leading-relaxed text-zinc-500 dark:text-zinc-400">{t('auth.offlineBody')}</p>
          <p className="mt-4 inline-flex items-center gap-2 text-sm text-zinc-400">
            <span
              aria-hidden
              className="inline-block size-3.5 animate-spin rounded-full border-2 border-zinc-300 dark:border-zinc-600 border-t-amber-500"
            />
            {t('auth.offlineRetrying')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void restoreSession()}
            className="rounded-lg bg-amber-500 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-amber-600 active:scale-[0.98]"
          >
            {t('auth.retry')}
          </button>
          <button
            type="button"
            onClick={() => void signOut().then(() => window.location.assign('/auth/sign-in'))}
            className="rounded-lg bg-red-500 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-red-600 active:scale-[0.98]"
          >
            {t('auth.signOut')}
          </button>
        </div>
      </main>
    );
  }

  if (status === 'loading') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-surface">
        <div className="flex flex-col items-center gap-4">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-amber-500 text-xl font-bold text-white">
            O
          </span>
          <span
            aria-hidden
            className="inline-block size-6 animate-spin rounded-full border-2 border-zinc-300 dark:border-zinc-600 border-t-amber-500"
          />
        </div>
      </main>
    );
  }

  if (status === 'unauthenticated') {
    return <Navigate to="/auth/sign-in" replace state={{ from: location.pathname }} />;
  }

  if (
    workspaceInitialized &&
    workspaceCount === 0 &&
    location.pathname !== '/app/onboarding'
  ) {
    return <Navigate to="/app/onboarding" replace />;
  }

  if (
    workspaceInitialized &&
    workspaceCount > 0 &&
    location.pathname === '/app/onboarding'
  ) {
    return <Navigate to="/app/dashboard" replace />;
  }

  return <>{children}</>;
}
