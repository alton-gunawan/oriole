import { zodResolver } from '@hookform/resolvers/zod';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, Navigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '@astryxdesign/core';

import { AuthField, AuthLayout } from './AuthLayout';
import { isAuthConfigured } from '../../lib/auth';
import { requestPasswordReset, resetPasswordWithOtp } from '../../lib/auth-actions';
import { errorMessage } from '../../lib/errors';
import { useSessionStore } from '../../stores/session';
import {
  forgotPasswordEmailSchema,
  resetPasswordSchema,
  type ForgotPasswordEmailInput,
  type ResetPasswordInput,
} from '../../lib/validations';

type Stage = 'email' | 'otp' | 'done';

/**
 * Lupa password — alur kode OTP via email (endpoint email-OTP Neon Auth):
 * 1) isi email → OTP dikirim; 2) masukkan OTP + password baru.
 * Setelah berhasil, arahkan ke halaman masuk.
 */
export function ForgotPasswordPage() {
  const { t } = useTranslation();
  const status = useSessionStore((s) => s.status);
  const [stage, setStage] = useState<Stage>('email');
  const [error, setError] = useState<string | null>(null);

  const emailSchema = useMemo(() => forgotPasswordEmailSchema(t), [t]);
  const resetSchema = useMemo(() => resetPasswordSchema(t), [t]);

  const emailForm = useForm<ForgotPasswordEmailInput>({
    resolver: zodResolver(emailSchema),
    defaultValues: { email: '' },
  });

  // Reset form diisi ulang setiap kali user masuk ke stage OTP, sehingga
  // email tersimpan dan tidak perlu diketik ulang.
  const resetForm = useForm<ResetPasswordInput>({
    resolver: zodResolver(resetSchema),
    defaultValues: { email: emailForm.watch('email'), otp: '', password: '', confirmPassword: '' },
  });

  if (status === 'authenticated') {
    return <Navigate to="/app/dashboard" replace />;
  }

  if (!isAuthConfigured) {
    return (
      <AuthLayout>
        <div className="space-y-3 text-center">
          <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{t('auth.authNotConfiguredTitle')}</p>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {t('auth.authNotConfiguredBody')}
          </p>
        </div>
      </AuthLayout>
    );
  }

  const onSendCode = async (values: ForgotPasswordEmailInput) => {
    setError(null);
    try {
      await requestPasswordReset(values.email);
      resetForm.setValue('email', values.email);
      resetForm.resetField('otp');
      resetForm.resetField('password');
      resetForm.resetField('confirmPassword');
      setStage('otp');
    } catch (err) {
      setError(errorMessage(err, t, 'errors.resetSendFailed'));
    }
  };

  const onResetPassword = async (values: ResetPasswordInput) => {
    setError(null);
    try {
      await resetPasswordWithOtp({
        email: values.email,
        otp: values.otp,
        newPassword: values.password,
      });
      setStage('done');
    } catch (err) {
      setError(errorMessage(err, t, 'errors.resetFailed'));
    }
  };

  return (
    <AuthLayout>
      {stage === 'email' && (
        <form onSubmit={emailForm.handleSubmit(onSendCode)} className="space-y-4" noValidate>
          <div className="space-y-1">
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{t('auth.forgotTitle')}</h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('auth.forgotDesc')}</p>
          </div>

          <AuthField
            label={t('common.email')}
            type="email"
            autoComplete="email"
            placeholder={t('auth.emailPlaceholder')}
            error={emailForm.formState.errors.email?.message}
            {...emailForm.register('email')}
          />

          {error && (
            <div
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-400"
            >
              {error}
            </div>
          )}

          <Button
            label={t('auth.sendResetCode')}
            variant="primary"
            isLoading={emailForm.formState.isSubmitting}
            isDisabled={emailForm.formState.isSubmitting}
            type="submit"
            width="100%"
          />

          <p className="pt-1 text-center text-sm text-zinc-500 dark:text-zinc-400">
            {t('auth.rememberPassword')}{' '}
            <Link to="/auth/sign-in" className="font-medium text-amber-600 hover:text-amber-700 hover:underline">
              {t('auth.signInCta')}
            </Link>
          </p>
        </form>
      )}

      {stage === 'otp' && (
        <form onSubmit={resetForm.handleSubmit(onResetPassword)} className="space-y-4" noValidate>
          <div className="space-y-1">
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{t('auth.resetTitle')}</h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('auth.resetDesc')}</p>
          </div>

          <AuthField
            label={t('auth.otpLabel')}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder={t('auth.otpPlaceholder')}
            error={resetForm.formState.errors.otp?.message}
            {...resetForm.register('otp')}
          />
          <AuthField
            label={t('common.password')}
            type="password"
            autoComplete="new-password"
            placeholder={t('auth.passwordPlaceholder')}
            error={resetForm.formState.errors.password?.message}
            {...resetForm.register('password')}
          />
          <AuthField
            label={t('auth.confirmPassword')}
            type="password"
            autoComplete="new-password"
            placeholder={t('auth.confirmPasswordPlaceholder')}
            error={resetForm.formState.errors.confirmPassword?.message}
            {...resetForm.register('confirmPassword')}
          />

          {error && (
            <div
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-400"
            >
              {error}
            </div>
          )}

          <Button
            label={t('auth.resetCta')}
            variant="primary"
            isLoading={resetForm.formState.isSubmitting}
            isDisabled={resetForm.formState.isSubmitting}
            type="submit"
            width="100%"
          />

          <p className="pt-1 text-center text-sm text-zinc-500 dark:text-zinc-400">
            <Link to="/auth/forgot-password" className="font-medium text-amber-600 hover:text-amber-700 hover:underline">
              {t('auth.resendCode')}
            </Link>
          </p>
        </form>
      )}

      {stage === 'done' && (
        <div className="space-y-4 text-center">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{t('auth.resetDoneTitle')}</h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('auth.resetDoneDesc')}</p>
          <Link
            to="/auth/sign-in"
            className="inline-block w-full rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-600"
          >
            {t('auth.backToSignIn')}
          </Link>
        </div>
      )}
    </AuthLayout>
  );
}
