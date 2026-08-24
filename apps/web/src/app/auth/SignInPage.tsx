import { zodResolver } from '@hookform/resolvers/zod';
import { useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Trans, useTranslation } from 'react-i18next';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { Button } from '@astryxdesign/core';
import type { TurnstileInstance } from '@marsidev/react-turnstile';

import { AuthField, AuthLayout, GitHubIcon, GoogleIcon } from './AuthLayout';
import { isAuthConfigured } from '../../lib/auth';
import { env } from '../../config/env';
import { trackEvent } from '../../lib/analytics';
import { signInWithEmail, signInWithGithub, signInWithGoogle, type SocialProvider } from '../../lib/auth-actions';
import { verifyTurnstileToken } from '../../lib/turnstile';
import { errorMessage } from '../../lib/errors';
import { useSessionStore } from '../../stores/session';
import { signInSchema, type SignInInput } from '../../lib/validations';
import { TurnstileWidget } from '../components/TurnstileWidget';

export function SignInPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const status = useSessionStore((s) => s.status);
  const user = useSessionStore((s) => s.user);
  const [error, setError] = useState<string | null>(null);
  const [socialBusy, setSocialBusy] = useState<SocialProvider | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileInstance>(null);

  const schema = useMemo(() => signInSchema(t), [t]);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignInInput>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '', agreeTerms: false },
  });

  // Catatan: form TIDAK diblokir saat status 'loading' (pengecekan sesi
  // masih berjalan). Form langsung dirender; bila sesi ternyata valid,
  // redirect `Navigate` di bawah menanganinya. Ini mencegah spinner abadi
  // saat /api/me lambat atau API sedang down.
  if (status === 'authenticated') {
    const dest = user?.onboardingCompleted ? '/app/dashboard' : '/app/onboarding';
    // Belum onboarding → langsung ke wizard; sudah onboarding → dashboard.
    // RequireAuth juga punya guard yang sama, tapi redirect di sini menghindari
    // kedipan dashboard sebelum bounce.
    return <Navigate to={dest} replace />;
  }

  if (!isAuthConfigured) {
    return (
      <AuthLayout>
        <div className="space-y-3 text-center">
          <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{t('auth.authNotConfiguredTitle')}</p>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 [&_code]:rounded [&_code]:bg-zinc-100 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-xs">
            <Trans i18nKey="auth.authNotConfiguredBody">
              Fill in <code>VITE_NEON_AUTH_URL</code> (Neon Auth endpoint) then restart Vite.
            </Trans>
          </p>
        </div>
      </AuthLayout>
    );
  }

  const onSubmit = async (values: SignInInput) => {
    setError(null);
    if (env.TURNSTILE_SITE_KEY) {
      if (!turnstileToken) {
        setError(t('auth.turnstileRequired'));
        return;
      }
      try {
        await verifyTurnstileToken(turnstileToken);
      } catch (err) {
        turnstileRef.current?.reset();
        setTurnstileToken(null);
        setError(errorMessage(err, t, 'auth.turnstileError'));
        return;
      }
    }
    void trackEvent('signin_started', { method: 'email' });
    try {
      await signInWithEmail(values);
      const onboardingDone = useSessionStore.getState().user?.onboardingCompleted ?? false;
      if (!onboardingDone) {
        navigate('/app/onboarding', { replace: true });
        return;
      }
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from ?? '/app/dashboard', { replace: true });
    } catch (err) {
      turnstileRef.current?.reset();
      setTurnstileToken(null);
      setError(errorMessage(err, t, 'errors.generic'));
    }
  };

  const onSocial = async (provider: SocialProvider) => {
    setError(null);
    void trackEvent('signin_started', { method: provider });
    setSocialBusy(provider);
    try {
      const from = (location.state as { from?: string } | null)?.from;
      if (provider === 'github') await signInWithGithub(from);
      else await signInWithGoogle(from);
    } catch (err) {
      setSocialBusy(null);
      setError(errorMessage(err, t, 'errors.signInStart'));
    }
  };

  return (
    <AuthLayout>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <Button
          label={socialBusy === 'google' ? t('auth.openingGoogle') : t('auth.continueGoogle')}
          variant="secondary"
          icon={<GoogleIcon className="size-4" />}
          isDisabled={socialBusy !== null}
          onClick={() => onSocial('google')}
          width="100%"
        />
        <Button
          label={socialBusy === 'github' ? t('auth.openingGithub') : t('auth.continueGithub')}
          variant="secondary"
          icon={<GitHubIcon className="size-4" />}
          isDisabled={socialBusy !== null}
          onClick={() => onSocial('github')}
          width="100%"
        />

        <div className="flex items-center gap-3 text-xs text-zinc-400">
          <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-700" />
          {t('auth.or')}
          <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-700" />
        </div>

        <AuthField
          label={t('common.email')}
          type="email"
          autoComplete="email"
          placeholder={t('auth.emailPlaceholder')}
          error={errors.email?.message}
          {...register('email')}
        />
        <AuthField
          label={t('common.password')}
          type="password"
          autoComplete="current-password"
          placeholder="••••••••"
          error={errors.password?.message}
          {...register('password')}
        />
        <p className="-mt-2 text-right">
          <Link
            to="/auth/forgot-password"
            className="text-sm font-medium text-amber-600 transition hover:text-amber-700 hover:underline"
          >
            {t('auth.forgotPassword')}
          </Link>
        </p>

        <div className="pt-1">
          <label className="flex items-center gap-2.5 text-sm text-zinc-600 dark:text-zinc-400 cursor-pointer select-none">
            <input
              type="checkbox"
              className="size-4 shrink-0 rounded border-zinc-300 dark:border-zinc-700 text-amber-600 focus:ring-amber-500/20"
              {...register('agreeTerms')}
            />
            <span>
              <Trans
                i18nKey="auth.agreeTermsCheckbox"
                components={{
                  agreement: (
                    <Link
                      to="/user-agreement"
                      target="_blank"
                      className="font-medium text-amber-600 dark:text-amber-500 hover:underline"
                    />
                  ),
                  privacy: (
                    <Link
                      to="/privacy-policy"
                      target="_blank"
                      className="font-medium text-amber-600 dark:text-amber-500 hover:underline"
                    />
                  ),
                }}
              />
            </span>
          </label>
          {errors.agreeTerms && (
            <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">
              {errors.agreeTerms.message}
            </p>
          )}
        </div>

        {env.TURNSTILE_SITE_KEY && (
          <TurnstileWidget
            ref={turnstileRef}
            onSuccess={(token) => {
              setTurnstileToken(token);
              setError(null);
            }}
            onError={() => {
              setTurnstileToken(null);
              setError(t('auth.turnstileError'));
            }}
            onExpire={() => {
              setTurnstileToken(null);
            }}
          />
        )}

        {error && (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-400"
          >
            {error}
          </div>
        )}

        <Button
          label={t('auth.signInCta')}
          variant="primary"
          isLoading={isSubmitting}
          isDisabled={isSubmitting || (Boolean(env.TURNSTILE_SITE_KEY) && !turnstileToken)}
          type="submit"
          width="100%"
        />

        <p className="pt-1 text-center text-sm text-zinc-500 dark:text-zinc-400">
          {t('auth.noAccount')}{' '}
          <Link to="/auth/sign-up" className="font-medium text-amber-600 hover:text-amber-700 hover:underline">
            {t('auth.signUp')}
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}
