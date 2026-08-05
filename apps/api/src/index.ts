import { serve as serveHttp } from '@hono/node-server';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import { serve as serveInngest } from 'inngest/hono';

import { env } from './lib/env.ts';
import { createRateLimiter } from './middleware/rate-limit.ts';
import { inngest } from './inngest/client.ts';
import { inngestFunctions } from './inngest/functions.ts';
import { billingRoutes } from './routes/billing.ts';
import { bookingsRoutes } from './routes/bookings.ts';
import { callsRoutes } from './routes/calls.ts';
import { contactsRoutes } from './routes/contacts.ts';
import { analyticsRoutes } from './routes/analytics.ts';
import { healthRoutes } from './routes/health.ts';
import { authSessionRoutes } from './routes/auth-session.ts';
import { meRoutes } from './routes/me.ts';
import { triggerRoutes } from './routes/triggers.ts';
import { bookingTriggersRoutes } from './routes/booking-triggers.ts';
import { channelsRoutes } from './routes/channels.ts';
import { inboxRoutes } from './routes/inbox.ts';
import { calleWebhookRoutes } from './routes/webhooks/calle.ts';
import { paddleWebhookRoutes } from './routes/webhooks/paddle.ts';
import { telegramWebhookRoutes } from './routes/webhooks/telegram.ts';
import { whatsappWebhookRoutes } from './routes/webhooks/whatsapp.ts';

export const app = new Hono();

app.use(
  '/api/*',
  cors({
    origin: env.APP_URL,
    credentials: true,
    allowHeaders: ['Content-Type', 'Authorization', 'X-Workspace-Id'],
  }),
);

// ── Security headers (nosniff, frame, HSTS, referrer) ─────────
app.use('*', secureHeaders());

// ── Rate limiting (in-memory; satu instance). Multi-instance → Redis. ──
app.use('/api/*', createRateLimiter({ windowMs: 60_000, limit: 300 }));
app.use('/api/webhooks/*', createRateLimiter({ windowMs: 60_000, limit: 120 }));
app.use(
  '/api/bookings/*/trigger-call',
  createRateLimiter({
    windowMs: 60_000,
    limit: 10,
    message: 'Terlalu banyak pemicu panggilan. Coba lagi nanti.',
  }),
);
// Setup channel memanggil provider eksternal (getMe / 360dialog) —
// batasi ketat agar tidak bisa di-spam (biaya & abuse).
app.use(
  '/api/channels/*/setup',
  createRateLimiter({
    windowMs: 60_000,
    limit: 10,
    message: 'Terlalu banyak percobaan setup channel. Coba lagi nanti.',
  }),
);

// ── Batas ukuran body — webhook boleh lebih besar (transkrip panggilan). ──
const bodyTooLarge = (c: Context) => c.json({ error: 'Body terlalu besar' }, 413);
for (const path of ['/api/bookings/*', '/api/calls/*', '/api/me/*', '/api/billing/*', '/api/triggers/*']) {
  app.use(path, bodyLimit({ maxSize: 1024 * 1024, onError: bodyTooLarge }));
}
app.use('/api/webhooks/*', bodyLimit({ maxSize: 10 * 1024 * 1024, onError: bodyTooLarge }));

app.get('/', (c) =>
  c.json({ name: 'Oriole API', version: '0.1.0', endpoints: ['/api/health', '/api/inngest'] }),
);

// ── Error handler: log detail, respons generik (tanpa stack trace / detail internal). ──
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
  console.error('[api] unhandled error:', err);
  return c.json({ error: 'Terjadi kesalahan internal. Coba lagi.' }, 500);
});

// ── Routes aplikasi ─────────────────────────────────────────
app.route('/api/health', healthRoutes);
app.route('/api/auth', authSessionRoutes);
app.route('/api/me', meRoutes);
app.route('/api/bookings', bookingsRoutes);
app.route('/api/bookings', bookingTriggersRoutes);
app.route('/api/channels', channelsRoutes);
app.route('/api/inbox', inboxRoutes);
app.route('/api/contacts', contactsRoutes);
app.route('/api/analytics', analyticsRoutes);
app.route('/api/calls', callsRoutes);
app.route('/api/billing', billingRoutes);
app.route('/api/triggers', triggerRoutes);
app.route('/api/webhooks/paddle', paddleWebhookRoutes);
app.route('/api/webhooks/calle', calleWebhookRoutes);
app.route('/api/webhooks/telegram', telegramWebhookRoutes);
app.route('/api/webhooks/whatsapp', whatsappWebhookRoutes);

// Jangan mount Inngest / mulai server saat di-import oleh test (NODE_ENV=test).
if (env.NODE_ENV !== 'test') {
  if (env.NODE_ENV === 'production' && !env.INNGEST_SIGNING_KEY) {
    console.warn(
      '⚠️  INNGEST_SIGNING_KEY belum disetel — endpoint /api/inngest tidak memverifikasi signature! Setel di produksi.',
    );
  }
  if (!env.CALLE_WEBHOOK_SECRET) {
    console.warn(
      '⚠️  CALLE_WEBHOOK_SECRET belum disetel — webhook CALL-E menolak semua event (fail-closed). Setel di .env dan konfigurasi header x-calle-signature di dashboard CALL-E.',
    );
  }

  // ── Inngest serve (handshake + function runner) ────────────
  app.on(
    ['GET', 'PUT', 'POST'],
    '/api/inngest',
    serveInngest({ client: inngest, functions: inngestFunctions }),
  );

  serveHttp({ fetch: app.fetch, port: env.PORT }, (info) => {
    console.log(`🪶 Oriole API listening on http://localhost:${info.port}`);
  });
}

export type AppType = typeof app;
