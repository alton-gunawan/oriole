import { env } from '../config/env';

/**
 * Penyimpanan JWT sesi (sessionStorage) + flag konfigurasi — modul ringan
 * tanpa dependensi SDK, agar tidak menarik bundle auth ke bundle awal.
 */
const TOKEN_KEY = 'oriole.access_token';

export function getAccessToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.sessionStorage.getItem(TOKEN_KEY);
}

export function setAccessToken(token: string): void {
  window.sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearAccessToken(): void {
  window.sessionStorage.removeItem(TOKEN_KEY);
}

/** Apakah VITE_NEON_AUTH_URL sudah diisi (auth aktif). */
export const isAuthConfigured = Boolean(env.NEON_AUTH_URL);
