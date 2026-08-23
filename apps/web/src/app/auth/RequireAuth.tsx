import { useEffect, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';

import { apiFetch } from '../../lib/api';
import { restoreSession, signOut } from '../../lib/session';
import { AppBrand } from '../components/AppLogo';
import { useSessionStore } from '../../stores/session';
import { useWorkspaceStore } from '../../stores/workspace';

/**
 * Guard rute: tampilkan splash saat sesi dicek, redirect ke /auth/sign-in
 * bila belum login. Status sesi dipulihkan sekali saat boot (main.tsx).
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const status = useSessionStore((s) => s.status);
  const user = useSessionStore((s) => s.user);
  const workspaceInitialized = useWorkspaceStore((s) => s.initialized);
  const location = useLocation();

  const onboardingCompleted = user?.onboardingCompleted;

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
      <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-zinc-950 px-4 text-center text-zinc-100 selection:bg-amber-500 selection:text-white">
        <AppBrand />
        <div className="max-w-md">
          <h1 className="text-2xl font-semibold tracking-tight text-white">{t('auth.offlineTitle')}</h1>
          <p className="mt-3 text-base leading-relaxed text-zinc-400">{t('auth.offlineBody')}</p>
          <p className="mt-4 inline-flex items-center gap-2 text-sm text-zinc-400">
            <span
              aria-hidden
              className="inline-block size-3.5 animate-spin rounded-full border-2 border-zinc-700 border-t-amber-500"
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
            className="rounded-lg bg-zinc-800 px-5 py-2.5 text-sm font-semibold text-zinc-200 transition hover:bg-zinc-700 active:scale-[0.98]"
          >
            {t('auth.signOut')}
          </button>
        </div>
      </main>
    );
  }

  if (status === 'loading') {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-zinc-950 px-4 text-zinc-100 selection:bg-amber-500 selection:text-white">
        <div className="flex flex-col items-center gap-6">
          <AppBrand />
          <span
            aria-hidden
            className="inline-block size-6 animate-spin rounded-full border-2 border-zinc-800 border-t-amber-500"
          />
        </div>
      </main>
    );
  }

  if (status === 'unauthenticated') {
    return <Navigate to="/auth/sign-in" replace state={{ from: location.pathname }} />;
  }

  // Jika belum menyelesaikan onboarding → arahkan ke onboarding wizard
  if (
    workspaceInitialized &&
    !onboardingCompleted &&
    location.pathname !== '/app/onboarding'
  ) {
    return <Navigate to="/app/onboarding" replace />;
  }

  // Jika sudah menyelesaikan onboarding dan membuka /app/onboarding → langsung ke Bookings
  if (
    workspaceInitialized &&
    onboardingCompleted &&
    location.pathname === '/app/onboarding' &&
    !location.search.includes('force=true')
  ) {
    return <Navigate to="/app/bookings" replace />;
  }

  return <>{children}</>;
}
