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
    const token = await neon.getJWTToken();
    if (token) return token;
  } catch {
    // abaikan dan coba fallback getSession
  }
  try {
    const session = await authClient?.getSession();
    const token = session?.data?.session?.token;
    if (typeof token === 'string' && token.length > 0) return token;
  } catch {
    // abaikan
  }
  return null;
}

/**
 * Ambil JWT sesi dengan SEMANTIK KETAT: `null` = otoritas (Neon Auth) dengan
 * tegas menyatakan TIDAK ada sesi; error jaringan/SDK DILEMPARKAN (bukan
 * null). Dipakai lapisan refresh 401 — hanya `null` yang boleh memicu reset
 * sesi lokal; error adalah kondisi transien yang TIDAK boleh logout user.
 */
export async function getNeonJwtOrThrow(): Promise<string | null> {
  if (!neon) return null;
  return neon.getJWTToken();
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
