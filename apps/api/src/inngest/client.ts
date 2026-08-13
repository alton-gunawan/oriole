import { Inngest } from 'inngest';

import { env } from '../lib/env.ts';

/**
 * Inngest — durable background jobs & webhook orchestration.
 *
 * Mode ditentukan dari keberadaan INNGEST_EVENT_KEY:
 *  - Key disetel (produksi)            → cloud mode (`https://inn.gs`).
 *  - Key KOSONG / tidak ada (lokal)    → `isDev: true`, mengarah ke Dev
 *    Server (`http://localhost:8288`, jalankan `pnpm dev:inngest`).
 *
 * PENTING: SDK hanya memakai Dev Server bila `isDev: true` ATAU
 * `INNGEST_DEV` disetel — default-nya `cloud`. Dengan INNGEST_EVENT_KEY=''
 * di .env, `send()` dulu melempar "couldn't find an event key" (mode cloud
 * tanpa key) → webhook WAHA 500 → pesan masuk tidak pernah diproses.
 *
 * Bila key kosong dan Dev Server tidak berjalan, `send()` gagal dengan
 * error koneksi yang jelas (webhook route menangkapnya + log petunjuk).
 */
export const inngest = new Inngest({
  id: 'oriole-api',
  // Dev mode HANYA di luar produksi tanpa key. Di produksi tanpa key, tetap
  // mode cloud → send() melempar error key yang jelas (dijaga 503 + log oleh
  // route webhook), bukan diam-diam menunjuk localhost:8288.
  isDev: !env.INNGEST_EVENT_KEY && env.NODE_ENV !== 'production',
  ...(env.INNGEST_EVENT_KEY ? { eventKey: env.INNGEST_EVENT_KEY } : {}),
});

/**
 * URL yang dipakai SDK untuk MENGIRIM event (dipakai health-check pipeline).
 *
 * Memakai getter internal SDK (`inngest.eventBaseUrl`) yang meresolusi persis
 * sama dengan `send()`: options.baseUrl → INNGEST_EVENT_API_BASE_URL →
 * INNGEST_BASE_URL → INNGEST_DEV (bila berupa URL) → default dev
 * (http://localhost:8288) atau cloud (https://inn.gs).
 *
 * Fallback manual hanya untuk SDK versi lain yang tidak mengekspos getter —
 * urutan env di bawah mengikuti resolusi internal SDK (components/Inngest.js).
 */
export function inngestEventBaseUrl(): string {
  const client = inngest as unknown as { eventBaseUrl?: string };
  if (typeof client.eventBaseUrl === 'string' && client.eventBaseUrl.length > 0) {
    return client.eventBaseUrl;
  }

  // Urutan MIRIP SDK (components/Inngest.js): env URL → INNGEST_DEV (URL) → default.
  if (process.env.INNGEST_EVENT_API_BASE_URL) return process.env.INNGEST_EVENT_API_BASE_URL;
  if (process.env.INNGEST_BASE_URL) return process.env.INNGEST_BASE_URL;
  const devUrl = process.env.INNGEST_DEV;
  if (devUrl) {
    try {
      return new URL(devUrl).toString();
    } catch {
      // INNGEST_DEV = "true"/"false" (boolean mode), bukan URL — lanjut.
    }
  }
  const isDev = !env.INNGEST_EVENT_KEY && env.NODE_ENV !== 'production';
  return isDev ? 'http://localhost:8288/' : 'https://inn.gs/';
}

/** Mode pipeline Inngest — logika sama dengan `isDev` pada konstruktor client. */
export function inngestMode(): 'dev' | 'cloud' {
  return !env.INNGEST_EVENT_KEY && env.NODE_ENV !== 'production' ? 'dev' : 'cloud';
}
