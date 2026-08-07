import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';

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

  if (status === 'error') {
    // Server tidak terjangkau / 401 transien berulang — sesi masih utuh,
    // jangan logout user. Tawarkan coba-ulang & keluar sebagai jalan keluar.
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-5 bg-surface px-4 text-center">
        <span className="flex size-12 items-center justify-center overflow-hidden rounded-md bg-amber-500">
          <AppLogo />
        </span>
        <div className="max-w-md">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">{t('auth.offlineTitle')}</h1>
          <p className="mt-3 text-base leading-relaxed text-zinc-500">{t('auth.offlineBody')}</p>
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
            className="inline-block size-6 animate-spin rounded-full border-2 border-zinc-300 border-t-amber-500"
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
