import { zodResolver } from '@hookform/resolvers/zod';
import { useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Trans, useTranslation } from 'react-i18next';
import { Link, Navigate, useNavigate } from 'react-router';
import { Button, useToast } from '@astryxdesign/core';
import { useFeatureFlagPayload } from '@posthog/react';
import type { TurnstileInstance } from '@marsidev/react-turnstile';

import { AuthField, AuthLayout, GitHubIcon, GoogleIcon } from './AuthLayout';
import { isAuthConfigured } from '../../lib/auth';
import { env } from '../../config/env';
import { trackEvent } from '../../lib/analytics';
import { signInWithGithub, signInWithGoogle, signUpWithEmail, type SocialProvider } from '../../lib/auth-actions';
import { verifyTurnstileToken } from '../../lib/turnstile';
import { errorMessage } from '../../lib/errors';
import { useSessionStore } from '../../stores/session';
import { signUpSchema, type SignUpInput } from '../../lib/validations';
import { TurnstileWidget } from '../components/TurnstileWidget';

export function SignUpPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const toast = useToast();
  const status = useSessionStore((s) => s.status);
  const user = useSessionStore((s) => s.user);
  const [socialBusy, setSocialBusy] = useState<SocialProvider | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileInstance>(null);
  const isManualSubmitRef = useRef(false);

  // Eksperimen A/B (PostHog): flag multi-variant `signup-hero-variant`
  // membawa payload JSON. Bila payload punya `cta`, dipakai sebagai label
  // tombol daftar; tanpa flag/payload (flag belum dibuat, analitik mati,
  // atau variant kontrol) → label default i18n. Nilai fallback selalu aman.
  const heroPayload = useFeatureFlagPayload('signup-hero-variant') as
    | { cta?: string }
    | null
    | undefined;
  const ctaLabel = heroPayload?.cta?.trim() || t('auth.signUpCta');

  const schema = useMemo(() => signUpSchema(t), [t]);
  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<SignUpInput>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', email: '', password: '', confirmPassword: '', agreeTerms: false },
  });

  // Form TIDAK diblokir saat status 'loading' (pengecekan sesi masih
  // berjalan) — langsung dirender; redirect `Navigate` di bawah menangani
  // sesi yang ternyata valid. Mencegah spinner abadi saat /me lambat/down.
  if (status === 'authenticated') {
    const dest = user?.onboardingCompleted ? '/app/dashboard' : '/app/onboarding';
    return <Navigate to={dest} replace />;
  }

  if (!isAuthConfigured) {
    return (
      <AuthLayout>
        <div className="space-y-3 text-center">
          <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{t('auth.authNotConfiguredTitle')}</p>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 [&_code]:rounded [&_code]:bg-zinc-100 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-xs">
            <Trans i18nKey="auth.authNotConfiguredBodyUp">
              Fill in <code>VITE_NEON_AUTH_URL</code> then restart Vite.
            </Trans>
          </p>
        </div>
      </AuthLayout>
    );
  }

  const onSubmit = async (values: SignUpInput) => {
    if (env.TURNSTILE_SITE_KEY) {
      if (!turnstileToken) {
        toast({
          body: t('auth.turnstileRequired'),
          type: 'error',
          isAutoHide: true,
          autoHideDuration: 5000,
        });
        return;
      }
      try {
        await verifyTurnstileToken(turnstileToken);
      } catch (err) {
        turnstileRef.current?.reset();
        setTurnstileToken(null);
        toast({
          body: errorMessage(err, t, 'auth.turnstileError'),
          type: 'error',
          isAutoHide: true,
          autoHideDuration: 5000,
        });
        return;
      }
    }
    void trackEvent('signup_started', { method: 'email' });
    try {
      await signUpWithEmail(values);
      navigate('/app/onboarding', { replace: true });
    } catch (err) {
      turnstileRef.current?.reset();
      setTurnstileToken(null);
      toast({
        body: errorMessage(err, t, 'errors.generic'),
        type: 'error',
        isAutoHide: true,
        autoHideDuration: 5000,
      });
    }
  };

  const onSocial = async (provider: SocialProvider) => {
    void trackEvent('signup_started', { method: provider });
    setSocialBusy(provider);
    try {
      if (provider === 'github') await signInWithGithub();
      else await signInWithGoogle();
    } catch (err) {
      setSocialBusy(null);
      toast({
        body: errorMessage(err, t, 'errors.signInStart'),
        type: 'error',
        isAutoHide: true,
        autoHideDuration: 5000,
      });
    }
  };

  const onFormSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    const agree = getValues('agreeTerms');
    if (!isManualSubmitRef.current && !agree) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    isManualSubmitRef.current = false;
    handleSubmit(onSubmit, (formErrors) => {
      const firstKey = Object.keys(formErrors)[0] as keyof SignUpInput | undefined;
      const msg = firstKey ? formErrors[firstKey]?.message : t('errors.generic');
      if (msg) {
        toast({
          body: msg,
          type: 'error',
          isAutoHide: true,
          autoHideDuration: 5000,
        });
      }
    })(e);
  };

  return (
    <AuthLayout>
      <form
        onSubmit={onFormSubmit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            isManualSubmitRef.current = true;
          }
        }}
        className="space-y-4"
        noValidate
      >
        <Button
          label={socialBusy === 'google' ? t('auth.openingGoogle') : t('auth.signUpGoogle')}
          variant="secondary"
          icon={<GoogleIcon className="size-4" />}
          isDisabled={socialBusy !== null}
          onClick={() => onSocial('google')}
          width="100%"
        />
        <Button
          label={socialBusy === 'github' ? t('auth.openingGithub') : t('auth.signUpGithub')}
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
          label={t('auth.nameLabel')}
          type="text"
          autoComplete="name"
          placeholder={t('auth.namePlaceholder')}
          error={errors.name?.message}
          {...register('name')}
        />
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
          autoComplete="new-password"
          placeholder={t('auth.passwordPlaceholder')}
          error={errors.password?.message}
          {...register('password')}
        />
        <AuthField
          label={t('auth.confirmPassword')}
          type="password"
          autoComplete="new-password"
          placeholder={t('auth.confirmPasswordPlaceholder')}
          error={errors.confirmPassword?.message}
          {...register('confirmPassword')}
        />

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
        </div>

        {env.TURNSTILE_SITE_KEY && (
          <TurnstileWidget
            ref={turnstileRef}
            onSuccess={(token) => {
              setTurnstileToken(token);
            }}
            onError={() => {
              setTurnstileToken(null);
              toast({
                body: t('auth.turnstileError'),
                type: 'error',
                isAutoHide: true,
                autoHideDuration: 5000,
              });
            }}
            onExpire={() => {
              setTurnstileToken(null);
            }}
          />
        )}

        <Button
          label={ctaLabel}
          variant="primary"
          isLoading={isSubmitting}
          isDisabled={isSubmitting || (Boolean(env.TURNSTILE_SITE_KEY) && !turnstileToken)}
          type="submit"
          onClick={() => {
            isManualSubmitRef.current = true;
          }}
          width="100%"
        />

        <p className="pt-1 text-center text-sm text-zinc-500 dark:text-zinc-400">
          {t('auth.haveAccount')}{' '}
          <Link to="/auth/sign-in" className="font-medium text-amber-600 hover:text-amber-700 hover:underline">
            {t('auth.signInCta')}
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}
