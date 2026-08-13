import { zodResolver } from '@hookform/resolvers/zod';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Trans, useTranslation } from 'react-i18next';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { Button } from '@astryxdesign/core';

import { AuthField, AuthLayout, GitHubIcon, GoogleIcon } from './AuthLayout';
import { isAuthConfigured } from '../../lib/auth';
import { trackEvent } from '../../lib/analytics';
import { signInWithEmail, signInWithGithub, signInWithGoogle, type SocialProvider } from '../../lib/auth-actions';
import { errorMessage } from '../../lib/errors';
import { useSessionStore } from '../../stores/session';
import { signInSchema, type SignInInput } from '../../lib/validations';

export function SignInPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const status = useSessionStore((s) => s.status);
  const [error, setError] = useState<string | null>(null);
  const [socialBusy, setSocialBusy] = useState<SocialProvider | null>(null);

  const schema = useMemo(() => signInSchema(t), [t]);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignInInput>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
  });

  // Catatan: form TIDAK diblokir saat status 'loading' (pengecekan sesi
  // masih berjalan). Form langsung dirender; bila sesi ternyata valid,
  // redirect `Navigate` di bawah menanganinya. Ini mencegah spinner abadi
  // saat /api/me lambat atau API sedang down.
  if (status === 'authenticated') {
    return <Navigate to="/app/dashboard" replace />;
  }

  if (!isAuthConfigured) {
    return (
      <AuthLayout>
        <div className="space-y-3 text-center">
          <p className="text-sm font-medium text-zinc-800">{t('auth.authNotConfiguredTitle')}</p>
          <p className="text-sm text-zinc-500 [&_code]:rounded [&_code]:bg-zinc-100 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-xs">
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
    void trackEvent('signin_started', { method: 'email' });
    try {
      await signInWithEmail(values);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from ?? '/app/dashboard', { replace: true });
    } catch (err) {
      setError(errorMessage(err, t, 'errors.generic'));
    }
  };

  const onSocial = (provider: SocialProvider) => {
    setError(null);
    void trackEvent('signin_started', { method: provider });
    setSocialBusy(provider);
    try {
      const from = (location.state as { from?: string } | null)?.from;
      if (provider === 'github') signInWithGithub(from);
      else signInWithGoogle(from);
      // halaman akan redirect; jika gagal, kembalikan state tombol
      setTimeout(() => setSocialBusy(null), 10_000);
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
          <span className="h-px flex-1 bg-zinc-200" />
          {t('auth.or')}
          <span className="h-px flex-1 bg-zinc-200" />
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

        {error && (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {error}
          </div>
        )}

        <Button
          label={t('auth.signInCta')}
          variant="primary"
          isLoading={isSubmitting}
          isDisabled={isSubmitting}
          type="submit"
          width="100%"
        />

        <p className="pt-1 text-center text-sm text-zinc-500">
          {t('auth.noAccount')}{' '}
          <Link to="/auth/sign-up" className="font-medium text-amber-600 hover:text-amber-700 hover:underline">
            {t('auth.signUp')}
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}
