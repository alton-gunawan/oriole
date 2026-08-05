import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';

import { AuthLayout, Spinner } from './AuthLayout';
import { authClient, getNeonJwt, isAuthConfigured, setAccessToken } from '../../lib/auth';
import { apiFetch } from '../../lib/api';
import { handoffSessionCookie } from '../../lib/session-cookie';
import type { Workspace } from '../../lib/workspace';
import { useWorkspaceStore } from '../../stores/workspace';
import { useSessionStore } from '../../stores/session';

const ATTEMPTS = 16; // ~8 detik polling getSession/getJWTToken
const INTERVAL_MS = 500;

/**
 * Halaman penyelesaian OAuth (Google/GitHub). Setelah redirect kembali dari
 * Neon Auth, client Better Auth menukar verifier menjadi sesi — polling
 * `getNeonJwt()` (≈ getSession) sampai JWT tersedia, lalu simpan token
 * dan arahkan ke halaman asal.
 */
export function CallbackPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const status = useSessionStore((s) => s.status);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef(0);

  useEffect(() => {
    if (!isAuthConfigured) {
      navigate('/auth/sign-in', { replace: true });
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const oauthError = params.get('error');
    if (oauthError) {
      setError(params.get('error_description') ?? t('errors.oauthCanceled'));
      return;
    }

    // Tujuan asli (di-set saat OAuth dimulai via ?from=) — default dashboard.
    const from = params.get('from') ?? '/app/dashboard';

    let cancelled = false;
    const timer = window.setInterval(async () => {
      attempt.current += 1;
      const token = await getNeonJwt();

      if (cancelled) return;

      if (token) {
        window.clearInterval(timer);
        setAccessToken(token);

        let user: { id: string; email?: string; name?: string } | undefined;
        try {
          const session = await authClient?.getSession();
          user = session?.data?.user ?? undefined;
        } catch {
          // abaikan — identitas tetap bisa dihydrasi via /api/me
        }

        const store = useSessionStore.getState();
        store.setStatus('authenticated');
        store.setUser(user?.id ? { id: user.id, email: user.email, name: user.name } : null);
        try {
          const me = await apiFetch<{ workspaces: Workspace[] }>('/me');
          useWorkspaceStore.getState().setWorkspaces(me.workspaces);
        } catch {
          useWorkspaceStore.getState().setWorkspaces([]);
        }
        // Hardening: hand-off JWT ke cookie HttpOnly (best-effort —
        // gagal berarti Bearer token tetap dipakai).
        await handoffSessionCookie();
        navigate(from, { replace: true });
        return;
      }

      if (attempt.current >= ATTEMPTS) {
        window.clearInterval(timer);
        if (!cancelled) {
          setError(t('errors.sessionNotFound'));
        }
      }
    }, INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [navigate, t]);

  if (status === 'authenticated') {
    return <Navigate to="/app/dashboard" replace />;
  }

  return (
    <AuthLayout>
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        {error ? (
          <>
            <p className="text-sm font-medium text-zinc-800">{t('auth.signInFailedTitle')}</p>
            <p className="text-sm text-zinc-500">{error}</p>
            <Link
              to="/auth/sign-in"
              className="mt-1 rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-600"
            >
              {t('auth.backToSignIn')}
            </Link>
          </>
        ) : (
          <>
            <Spinner />
            <p className="text-sm text-zinc-500">{t('auth.finishingSignIn')}</p>
          </>
        )}
      </div>
    </AuthLayout>
  );
}
