import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';

import { env } from '../lib/env.ts';
import { SESSION_COOKIE } from '../lib/auth-cookie.ts';
import { requireAuth } from '../middleware/auth.ts';

/** Masa hidup cookie sesi (7 hari) — token JWT-nya sendiri tetap short-lived. */
const SESSION_MAX_AGE = 60 * 60 * 24 * 7;

/**
 * Body hanya dipakai sebagai pemaksa `Content-Type: application/json`
 * (memicu CORS preflight → mempersempit permukaan CSRF). Nilai asli cookie
 * diambil dari Bearer token yang SUDAH diverifikasi `requireAuth` — lihat
 * handler — bukan dari field body ini.
 */
const sessionBootstrapSchema = z.object({});

function cookieOptions(): Parameters<typeof setCookie>[3] {
  return {
    httpOnly: true,
    // Secure hanya di produksi (HTTP lokal tidak punya TLS).
    secure: env.NODE_ENV === 'production',
    // Produksi: web (Cloudflare Pages) dan API lintas-origin → butuh
    // SameSite=None. Development: same-origin (Vite proxy) cukup 'Lax'.
    sameSite: env.NODE_ENV === 'production' ? 'None' : 'Lax',
    path: '/',
  };
}

/**
 * Bootstrap sesi cookie (HttpOnly) — pola hand-off:
 * client mengirim JWT SEKALI setelah login (verifikasi penuh via
 * `requireAuth`), server menyimpannya sebagai cookie HttpOnly + Secure
 * (tidak bisa dibaca JavaScript), lalu client BOLEH membuang token dari
 * sessionStorage.
 *
 * Backward-compatible: `requireAuth` tetap menerima `Authorization: Bearer`
 * sebagai sumber utama; cookie hanya fallback.
 */
export const authSessionRoutes = new Hono()
  .post('/session', requireAuth, zValidator('json', sessionBootstrapSchema), (c) => {
    // Cookie di-set dari Bearer token yang SUDAH diverifikasi requireAuth —
    // bukan dari body (yang tidak diverifikasi dan bisa berbeda). Klien yang
    // sudah pakai cookie (fallback) tidak bisa bootstrap ulang dari cookie.
    const header = c.req.header('Authorization');
    if (!header?.startsWith('Bearer ')) {
      return c.json({ error: 'Hand-off memerlukan Authorization: Bearer' }, 400);
    }
    setCookie(c, SESSION_COOKIE, header.slice('Bearer '.length), {
      ...cookieOptions(),
      maxAge: SESSION_MAX_AGE,
    });
    return c.json({ ok: true });
  })
  .delete('/session', (c) => {
    deleteCookie(c, SESSION_COOKIE, cookieOptions());
    return c.json({ ok: true });
  });
