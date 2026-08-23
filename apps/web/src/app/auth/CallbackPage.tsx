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
  const user = useSessionStore((s) => s.user);
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
        // Retry singkat: /me yang gagal sesaat (cold-start, jaringan) tidak
        // boleh membuat workspace terlihat kosong → user malah disuruh bikin
        // bisnis lagi. Bila SEMUA percobaan gagal, store sengaja dibiarkan
        // BELUM terinisialisasi: RequireAuth tidak akan me-redirect ke
        // onboarding (mencegah pembuatan bisnis duplikat), shell menampilkan
        // state kosong, dan reload berikutnya memulihkan daftar bisnis.
        let me: {
          workspaces: Workspace[];
          name?: string | null;
          language?: string | null;
          timezone?: string | null;
          onboardingCompleted?: boolean;
          onboardingStep?: number;
        } | null = null;
        for (let attempt = 0; attempt < 3 && !me; attempt += 1) {
          if (attempt > 0) {
            await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
          }
          try {
            me = await apiFetch<{
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
            id: user?.id ?? store.user?.id ?? '',
            email: user?.email ?? store.user?.email,
            name: me.name ?? user?.name ?? store.user?.name,
            language: me.language ?? null,
            timezone: me.timezone ?? null,
            onboardingCompleted: Boolean(me.onboardingCompleted || me.workspaces.length > 0),
            onboardingStep: me.onboardingStep ?? 1,
          });
        }
        // Hardening: hand-off JWT ke cookie HttpOnly (best-effort —
        // gagal berarti Bearer token tetap dipakai).
        await handoffSessionCookie();
        // New users (belum onboarding) → wajib ke onboarding, bukan dashboard.
        const latestUser = useSessionStore.getState().user;
        const onboardingCompleted = latestUser?.onboardingCompleted ?? false;
        const dest = !onboardingCompleted ? '/app/onboarding' : from;
        navigate(dest, { replace: true });
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
            <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('auth.finishingSignIn')}</p>
          </>
        )}
      </div>
    </AuthLayout>
  );
}
