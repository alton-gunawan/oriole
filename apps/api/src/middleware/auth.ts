import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import * as jose from 'jose';

import { env } from '../lib/env.ts';
import { SESSION_COOKIE } from '../lib/auth-cookie.ts';

/**
 * Neon Auth (Managed Better Auth) mengeluarkan JWT yang ditandatangani
 * dengan kunci yang di-expose pada JWKS remote di bawah
 * `${NEON_AUTH_URL}/.well-known/jwks.json`.
 *
 * Middleware ini memverifikasi `Authorization: Bearer <jwt>` tanpa perlu
 * menyimpan sesi — stateless. Lihat:
 * https://neon.tech/docs/guides/neon-auth-jwt
 */
export type AuthVariables = {
  userId: string;
  userEmail?: string;
};

let jwks: ReturnType<typeof jose.createRemoteJWKSet> | undefined;

function getJwks() {
  jwks ??= jose.createRemoteJWKSet(new URL(`${env.NEON_AUTH_URL}/.well-known/jwks.json`));
  return jwks;
}

export const requireAuth: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  const header = c.req.header('Authorization');
  // Sumber utama: `Authorization: Bearer <jwt>`. Fallback: cookie sesi
  // HttpOnly (hand-off setelah login — lihat routes/auth-session.ts).
  const token = header?.startsWith('Bearer ')
    ? header.slice('Bearer '.length)
    : getCookie(c, SESSION_COOKIE);
  if (!token) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  try {
    const { payload } = await jose.jwtVerify(token, getJwks(), {
      issuer: new URL(env.NEON_AUTH_URL).origin,
      // Defensif: batasi algoritma ke yang benar-benar dipakai JWKS Neon
      // Auth — TERVERIFIKASI dari endpoint live:
      //   { "alg": "EdDSA", "crv": "Ed25519", "kty": "OKP" }
      // (mencegah alg-confusion, mis. HS256 yang ditandatangani dengan
      // public key). JANGAN ubah tanpa mengecek ulang JWKS aktual.
      algorithms: ['EdDSA'],
      clockTolerance: 30,
      // NOTE: Neon Auth tidak mendokumentasikan klaim `aud` pada JWT-nya.
      // Setelah diverifikasi dengan token asli (decode via jwt.io), tambahkan
      // `audience: '<nilai aud>'` di sini untuk mengikat token ke app ini.
    });
    if (!payload.sub) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    c.set('userId', payload.sub);
    c.set('userEmail', typeof payload.email === 'string' ? payload.email : undefined);
    await next();
  } catch {
    return c.json({ error: 'Unauthorized' }, 401);
  }
};
