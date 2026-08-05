import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';

import { useSessionStore } from '../../stores/session';
import { useWorkspaceStore } from '../../stores/workspace';

/**
 * Guard rute: tampilkan splash saat sesi dicek, redirect ke /auth/sign-in
 * bila belum login. Status sesi dipulihkan sekali saat boot (main.tsx).
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const status = useSessionStore((s) => s.status);
  const workspaceCount = useWorkspaceStore((s) => s.workspaces.length);
  const workspaceInitialized = useWorkspaceStore((s) => s.initialized);
  const location = useLocation();

  if (status === 'loading') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-50">
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
