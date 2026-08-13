import { createMiddleware } from 'hono/factory';

import { flushAnalytics } from '../lib/analytics.ts';

/**
 * Flush antrian event PostHog setelah response selesai.
 *
 * posthog-node men-queue event ke batch (flushAt=20 / flushInterval=3s).
 * Middleware ini memastikan event yang dicapture di route handler benar-benar
 * terkirim per-request — tanpa menunggu batch penuh atau timer.
 *
 * Best-effort: kegagalan flush TIDAK boleh menggagalkan atau memperlambat
 * response (analitik adalah tambahan, bukan jalur kritis).
 */
export const analyticsFlushMiddleware = createMiddleware(async (_c, next) => {
  await next();
  try {
    await flushAnalytics();
  } catch {
    // Analitik gagal → abaikan, response tetap utuh.
  }
});
