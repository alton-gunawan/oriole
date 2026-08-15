import { env } from '../config/env';
import { AuthActionError, getAuthClient, getNeonJwt } from './auth';
import { isAuthConfigured, setAccessToken } from './token';
import { useSessionStore } from '../stores/session';
import { useWorkspaceStore } from '../stores/workspace';
import type { Workspace } from './workspace';
import type { TranslationKey } from '../i18n';

/** Provider sosial yang didukung Neon Auth di app ini. */
export type SocialProvider = 'google' | 'github';

function ensureClient() {
  if (!isAuthConfigured) {
    throw new AuthActionError('Auth not configured.', 503, 'auth.authNotConfiguredTitle');
  }
  return getAuthClient();
}

/**
 * Hydrasi daftar workspace setelah auth email — dashboard butuh workspace aktif.
 * Gagal → AuthActionError (diterjemahkan di UI); status sesi TIDAK dicentang
 * agar user tetap di form dan bisa mencoba lagi.
 */
async function hydrateWorkspaces(token: string) {
  const response = await fetch(`${env.API_URL}/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new AuthActionError(
    'Workspace hydration failed',
    response.status,
    'errors.hydrationFailed' as TranslationKey,
  );
  const me = (await response.json()) as { workspaces: Workspace[] };
  useWorkspaceStore.getState().setWorkspaces(me.workspaces);
}

/**
 * Sign-in email/password. Sukses → token disimpan di sessionStorage, store
 * sesi diperbarui, dan workspace dihydrasi; error → AuthActionError.
 */
export async function signInWithEmail(input: { email: string; password: string }) {
  const client = ensureClient();
  const res = await client.signIn.email({
    email: input.email,
    password: input.password,
    callbackURL: `${window.location.origin}/auth/callback`,
  });
  if (res.error) {
    throw new AuthActionError(
      res.error.message || 'Incorrect email or password.',
      res.error.status,
      'errors.wrongCredentials',
    );
  }
  const token = await getNeonJwt();
  if (!token) throw new AuthActionError('Session invalid. Try again.', undefined, 'errors.sessionInvalid');
  setAccessToken(token);
  await hydrateWorkspaces(token);
  useSessionStore.getState().setStatus('authenticated');
}

/**
 * Sign-up email/password — setelah berhasil langsung sign-in (Better Auth
 * mengirim cookie sesi), lalu simpan JWT lokal dan hydrasi workspace.
 */
export async function signUpWithEmail(input: { name: string; email: string; password: string }) {
  const client = ensureClient();
  const res = await client.signUp.email({
    name: input.name,
    email: input.email,
    password: input.password,
    callbackURL: `${window.location.origin}/auth/callback`,
  });
  if (res.error) {
    throw new AuthActionError(
      res.error.message || 'Could not create account.',
      res.error.status,
      'errors.createAccount',
    );
  }
  const token = await getNeonJwt();
  if (!token) throw new AuthActionError('Session invalid. Try again.', undefined, 'errors.sessionInvalid');
  setAccessToken(token);
  await hydrateWorkspaces(token);
  useSessionStore.getState().setStatus('authenticated');
}

/**
 * Minta kode OTP reset password (email). Sukses → email berisi kode dikirim
 * Neon Auth; error → AuthActionError. Tidak membocorkan apakah email
 * terdaftar (Better Auth mengembalikan sukses untuk email yang tidak ada).
 */
export async function requestPasswordReset(email: string) {
  const client = ensureClient();
  const res = await client.forgetPassword.emailOtp({ email });
  if (res.error) {
    throw new AuthActionError(
      res.error.message || 'Could not send reset code.',
      res.error.status,
      'errors.resetSendFailed',
    );
  }
}

/**
 * Setel password baru memakai kode OTP dari email.
 * Sukses → password berubah; user bisa langsung masuk di /auth/sign-in.
 */
export async function resetPasswordWithOtp(input: { email: string; otp: string; newPassword: string }) {
  const client = ensureClient();
  const res = await client.emailOtp.resetPassword({
    email: input.email,
    otp: input.otp,
    password: input.newPassword,
  });
  if (res.error) {
    throw new AuthActionError(
      res.error.message || 'Could not reset password.',
      res.error.status,
      'errors.resetFailed',
    );
  }
}

/** Redirect ke OAuth Google — kembali via /auth/callback?from=<tujuan>. */
export function signInWithGoogle(destination?: string) {
  const client = ensureClient();
  const callbackURL = `${window.location.origin}/auth/callback?from=${encodeURIComponent(destination ?? '/app/dashboard')}`;
  void client.signIn.social({ provider: 'google', callbackURL });
}

/** Redirect ke OAuth GitHub — kembali via /auth/callback?from=<tujuan>. */
export function signInWithGithub(destination?: string) {
  const client = ensureClient();
  const callbackURL = `${window.location.origin}/auth/callback?from=${encodeURIComponent(destination ?? '/app/dashboard')}`;
  void client.signIn.social({ provider: 'github', callbackURL });
}
