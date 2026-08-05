import type { Context, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * Rate limiter in-memory (fixed window) tanpa dependensi.
 *
 * Cukup untuk deployment satu instance (Railway/Fly single machine).
 * Untuk scale-out multi-instance, ganti store dengan solusi bersama
 * (mis. Redis via @upstash/redis) atau rate limiter di gateway/CDN.
 */

interface RateLimitOptions {
  /** Panjang jendela waktu dalam milidetik. */
  windowMs: number;
  /** Maksimal request per jendela per key. */
  limit: number;
  /** Pembuat key pengelompokan (default: IP client via header proxy). */
  keyOf?: (c: Context) => string;
  /** Pesan error saat limit terlampaui. */
  message?: string;
  /** Status HTTP saat limit terlampaui (default 429). */
  status?: ContentfulStatusCode;
}

const stores = new Map<string, { count: number; resetAt: number }>();

// Pembersihan bucket kedaluwarsa agar memori tidak bocor.
const CLEANUP_INTERVAL_MS = 60_000;
const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of stores) {
    if (bucket.resetAt <= now) stores.delete(key);
  }
}, CLEANUP_INTERVAL_MS);
// Jangan menahan proses (dev server / test) tetap hidup.
cleanup.unref();

/** Dipakai test agar state limiter tidak bocor antar kasus. */
export function resetRateLimiterStoreForTests(): void {
  stores.clear();
}

/**
 * Key default: IP client dari header proxy.
 *
 * Catatan: header X-Forwarded-For DIHORMATI karena di produksi
 * (Railway/Fly/Cloudflare) platform edge menimpa nilainya dengan IP klien
 * asli. Risiko spoof header hanya ada saat app terpapar langsung tanpa
 * proxy tepercaya — di skenario itu rate limiter tetap backstop global.
 * (helper `getConnInfo` tidak tersedia di Hono 4.12 yang dipakai.)
 */
function defaultKeyOf(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  if (forwarded) return forwarded;
  const realIp = c.req.header('x-real-ip');
  if (realIp) return realIp;
  // Dev lokal / tanpa proxy — semua berbagi satu bucket; limit global
  // tetap relevan untuk memblokir banjir dari satu proses.
  return 'local';
}

export function createRateLimiter({
  windowMs,
  limit,
  keyOf,
  message = 'Terlalu banyak permintaan. Coba lagi nanti.',
  status = 429,
}: RateLimitOptions): MiddlewareHandler {
  const limitStatus = status as ContentfulStatusCode;
  const resolveKey = keyOf ?? defaultKeyOf;

  return async (c, next) => {
    const now = Date.now();
    const bucketKey = `${resolveKey(c)}:${Math.floor(now / windowMs)}`;

    const bucket = stores.get(bucketKey);
    if (!bucket || bucket.resetAt <= now) {
      stores.set(bucketKey, { count: 1, resetAt: now + windowMs });
      return next();
    }

    bucket.count += 1;
    if (bucket.count > limit) {
      return c.json({ error: message }, limitStatus);
    }
    return next();
  };
}
