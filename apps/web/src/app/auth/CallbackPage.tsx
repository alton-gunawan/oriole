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

const ATTEMPTS = 40; // ~20 detik polling getSession/getJWTToken (memberi waktu cold-start Neon)
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
  const user = useSessionStore((s) => s.user);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
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

    attempt.current = 0;
    let cancelled = false;

    const finishAuth = async (token?: string | null) => {
      if (token) setAccessToken(token);

      let authUser: { id: string; email?: string; name?: string } | undefined;
      try {
        const session = await authClient?.getSession();
        authUser = session?.data?.user ?? undefined;
      } catch {
        // abaikan — identitas tetap bisa dihydrasi via /api/me
      }

      const store = useSessionStore.getState();
      store.setStatus('authenticated');
      store.setUser(authUser?.id ? { id: authUser.id, email: authUser.email, name: authUser.name } : null);

      let me: {
        userId?: string;
        workspaces: Workspace[];
        name?: string | null;
        language?: string | null;
        timezone?: string | null;
        onboardingCompleted?: boolean;
        onboardingStep?: number;
      } | null = null;

      for (let att = 0; att < 4 && !me; att += 1) {
        if (att > 0) {
          await new Promise((resolve) => setTimeout(resolve, 500 * att));
        }
        try {
          me = await apiFetch<{
            userId?: string;
            workspaces: Workspace[];
            name?: string | null;
            language?: string | null;
            timezone?: string | null;
            onboardingCompleted?: boolean;
            onboardingStep?: number;
          }>('/me');
        } catch {
          me = null;
        }
      }

      if (me) {
        useWorkspaceStore.getState().setWorkspaces(me.workspaces);
        store.setUser({
          id: authUser?.id ?? me.userId ?? store.user?.id ?? '',
          email: authUser?.email ?? store.user?.email,
          name: me.name ?? authUser?.name ?? store.user?.name,
          language: me.language ?? null,
          timezone: me.timezone ?? null,
          onboardingCompleted: Boolean(me.onboardingCompleted || me.workspaces.length > 0),
          onboardingStep: me.onboardingStep ?? 1,
        });
      }

      if (token) {
        await handoffSessionCookie();
      }

      const latestUser = useSessionStore.getState().user;
      const onboardingCompleted = latestUser?.onboardingCompleted ?? false;
      const dest = !onboardingCompleted ? '/app/onboarding' : from;
      navigate(dest, { replace: true });
    };

    const timer = window.setInterval(async () => {
      attempt.current += 1;
      const token = await getNeonJwt();

      if (cancelled) return;

      if (token) {
        window.clearInterval(timer);
        await finishAuth(token);
        return;
      }

      // Fallback: setelah beberapa percobaan, coba cek apakah cookie sesi HttpOnly
      // sudah aktif di /api/me meskipun token JWT belum siap di local storage.
      if (attempt.current >= 4 && attempt.current % 4 === 0) {
        try {
          const me = await apiFetch<{ userId?: string; workspaces: Workspace[] }>('/me');
          if (me && (me.userId || me.workspaces)) {
            window.clearInterval(timer);
            await finishAuth(null);
            return;
          }
        } catch {
          // sesi belum siap, lanjut polling
        }
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
  }, [navigate, retryKey, t]);

  if (status === 'authenticated') {
    const dest = user?.onboardingCompleted ? '/app/dashboard' : '/app/onboarding';
    return <Navigate to={dest} replace />;
  }

  return (
    <AuthLayout>
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        {error ? (
          <>
            <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{t('auth.signInFailedTitle')}</p>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">{error}</p>
            <div className="mt-2 flex items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setRetryKey((k) => k + 1);
                }}
                className="rounded-lg bg-zinc-800 px-4 py-2 text-sm font-semibold text-white transition hover:bg-zinc-700 dark:bg-zinc-200 dark:text-zinc-900 dark:hover:bg-white"
              >
                {t('common.retry')}
              </button>
              <Link
                to="/auth/sign-in"
                className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-600"
              >
                {t('auth.backToSignIn')}
              </Link>
            </div>
          </>
        ) : (
          <>
            <Spinner />
            <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('auth.finishingSignIn')}</p>
          </>
        )}
      </div>
    </AuthLayout>
  );
}
