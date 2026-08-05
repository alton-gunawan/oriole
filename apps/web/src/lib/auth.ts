import { createInternalNeonAuth } from '@neondatabase/auth';
import { BetterAuthVanillaAdapter } from '@neondatabase/auth/vanilla/adapters';

import { env } from '../config/env';
import { isAuthConfigured } from './token';
import type { TranslationKey } from '../i18n';

export { clearAccessToken, getAccessToken, isAuthConfigured, setAccessToken } from './token';

/**
 * Neon Auth (Managed Better Auth) — sisi frontend.
 *
 * `createInternalNeonAuth` membungkus Better Auth client agar kita bisa
 * mengekstrak JWT (`getJWTToken()`) untuk dikirim ke API kita sendiri
 * (`Authorization: Bearer <jwt>`, diverifikasi terhadap JWKS remote —
 * lihat middleware auth di apps/api).
 *
 * Modul ini hanya di-import oleh halaman auth (lazy) dan aksi sesi,
 * sehingga SDK besar tidak ikut bundle awal.
 */

/**
 * Wrapper Neon Auth. `adapter` = Better Auth client (vanilla);
 * `neon.getJWTToken()` = sumber tunggal pengambilan JWT sesi.
 * Dibuat null bila env belum dikonfigurasi agar app tetap bisa boot.
 */
const neon = isAuthConfigured
  ? createInternalNeonAuth(env.NEON_AUTH_URL, { adapter: BetterAuthVanillaAdapter() })
  : null;

export const authClient = neon?.adapter ?? null;

export function getAuthClient(): NonNullable<typeof authClient> {
  if (!authClient) {
    throw new Error('Neon Auth belum dikonfigurasi. Isi VITE_NEON_AUTH_URL di environment.');
  }
  return authClient;
}

/** Ambil JWT sesi dari client Neon Auth (null bila tidak ada sesi). */
export async function getNeonJwt(): Promise<string | null> {
  if (!neon) return null;
  try {
    return await neon.getJWTToken();
  } catch {
    return null;
  }
}

export interface AuthSessionUser {
  id: string;
  email?: string;
  name?: string;
}

/** Error auth yang aman ditampilkan ke user (pesan dari Better Auth). */
export class AuthActionError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    /** Kunci i18n — bila ada, UI menerjemahkan lewat t() alih-alih menampilkan `message`. */
    public readonly messageKey?: TranslationKey,
  ) {
    super(message);
    this.name = 'AuthActionError';
  }
}
