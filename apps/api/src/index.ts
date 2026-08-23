import { serve as serveHttp } from '@hono/node-server';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import { serve as serveInngest } from 'inngest/hono';

import { env } from './lib/env.ts';
import { captureException, flushAnalytics, shutdownAnalytics } from './lib/analytics.ts';
import { reconcileTelegramWebhooks } from './lib/telegram-reconcile.ts';
import { analyticsFlushMiddleware } from './middleware/analytics.ts';
import { createRateLimiter } from './middleware/rate-limit.ts';
import { inngest } from './inngest/client.ts';
import { inngestFunctions } from './inngest/functions.ts';
import { billingRoutes } from './routes/billing.ts';
import { bookingsRoutes } from './routes/bookings.ts';
import { servicesRoutes } from './routes/services.ts';
import { staffRoutes } from './routes/staff.ts';
import { availabilityRoutes } from './routes/availability.ts';
import { callsRoutes } from './routes/calls.ts';
import { contactsRoutes } from './routes/contacts.ts';
import { analyticsRoutes } from './routes/analytics.ts';
import { healthRoutes } from './routes/health.ts';
import { authSessionRoutes } from './routes/auth-session.ts';
import { meRoutes } from './routes/me.ts';
import { triggerRoutes } from './routes/triggers.ts';
import { bookingTriggersRoutes } from './routes/booking-triggers.ts';
import { channelsRoutes } from './routes/channels.ts';
import { integrationsRoutes } from './routes/integrations.ts';
import { paymentsRoutes } from './routes/payments.ts';
import { inboxRoutes } from './routes/inbox.ts';
import { vapiWebhookRoutes } from './routes/webhooks/vapi.ts';
import { metaWebhookRoutes } from './routes/webhooks/meta.ts';
import { paddleWebhookRoutes } from './routes/webhooks/paddle.ts';
import { tallyWebhookRoutes } from './routes/webhooks/tally.ts';
import { telegramWebhookRoutes } from './routes/webhooks/telegram.ts';
import { lineWebhookRoutes } from './routes/webhooks/line.ts';
import { wahaWebhookRoutes } from './routes/webhooks/waha.ts';
import { whatsappWebhookRoutes } from './routes/webhooks/whatsapp.ts';
import { whatsappBusinessWebhookRoutes } from './routes/webhooks/whatsapp-business.ts';
import { whatsappBusinessRoutes } from './routes/whatsapp-business.ts';

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
// Setiap limiter diberi `name` unik — counter-nya terpisah, jadi trafik API
// biasa (GET dashboard, polling) tidak pernah ikut menghitung limit limiter
// khusus seperti /setup (regresi lama: semua limiter berbagi satu bucket).
app.use('/api/*', createRateLimiter({ name: 'api', windowMs: 60_000, limit: 300 }));
app.use('/api/webhooks/*', createRateLimiter({ name: 'webhooks', windowMs: 60_000, limit: 120 }));
// Setup channel memanggil provider eksternal (getMe / 360dialog) —
// batasi ketat agar tidak bisa di-spam (biaya & abuse). Counter khusus
// limiter ini: hanya percobaan setup sungguhan yang dihitung.
app.use(
  '/api/channels/*/setup',
  createRateLimiter({
    name: 'channels-setup',
    windowMs: 60_000,
    limit: 20,
    message: 'Terlalu banyak percobaan setup channel. Coba lagi nanti.',
  }),
);

// ── Batas ukuran body — webhook boleh lebih besar (transkrip panggilan). ──
const bodyTooLarge = (c: Context) => c.json({ error: 'Body terlalu besar' }, 413);
for (const path of ['/api/bookings/*', '/api/staff/*', '/api/services/*', '/api/availability/*', '/api/calls/*', '/api/me/*', '/api/billing/*', '/api/triggers/*', '/api/integrations/*', '/api/payments/*']) {
  app.use(path, bodyLimit({ maxSize: 1024 * 1024, onError: bodyTooLarge }));
}
app.use('/api/webhooks/*', bodyLimit({ maxSize: 10 * 1024 * 1024, onError: bodyTooLarge }));

// ── PostHog analytics — flush event yang dicapture route handler ──
// Best-effort: kegagalan analitik tidak menggagalkan request.
app.use('/api/*', analyticsFlushMiddleware);

app.get('/', (c) => {
  const ptxn = c.req.query('_ptxn');
  if (ptxn) {
    return c.redirect(
      `${env.APP_URL}/app/onboarding?session=success&_ptxn=${encodeURIComponent(ptxn)}`,
      302,
    );
  }
  return c.json({ name: 'Oriole API', version: '0.1.0', endpoints: ['/api/health', '/api/inngest'] });
});

// ── Error handler: log detail, respons generik (tanpa stack trace / detail internal). ──
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
  console.error('[api] unhandled error:', err);
  // Error tracking PostHog (server-side) — best-effort, jangan pernah
  // menggagalkan response karena analitik gagal.
  const userId = (c as unknown as Context<{ Variables: { userId?: string } }>).get('userId');
  captureException(err, userId ?? 'api-server', {
    path: c.req.path,
    method: c.req.method,
    url: c.req.url,
  });
  void flushAnalytics().catch(() => {});
  return c.json({ error: 'Terjadi kesalahan internal. Coba lagi.' }, 500);
});

// ── Routes aplikasi ─────────────────────────────────────────
app.route('/api/health', healthRoutes);
app.route('/api/auth', authSessionRoutes);
app.route('/api/me', meRoutes);
app.route('/api/bookings', bookingsRoutes);
app.route('/api/bookings', bookingTriggersRoutes);
app.route('/api/staff', staffRoutes);
app.route('/api/services', servicesRoutes);
app.route('/api/availability', availabilityRoutes);
app.route('/api/channels', channelsRoutes);
app.route('/api/integrations', integrationsRoutes);
app.route('/api/payments', paymentsRoutes);
app.route('/api/inbox', inboxRoutes);
app.route('/api/contacts', contactsRoutes);
app.route('/api/analytics', analyticsRoutes);
app.route('/api/calls', callsRoutes);
app.route('/api/billing', billingRoutes);
app.route('/api/triggers', triggerRoutes);
app.route('/api/webhooks/paddle', paddleWebhookRoutes);
app.route('/api/webhooks/meta', metaWebhookRoutes);
app.route('/api/webhooks/vapi', vapiWebhookRoutes);
app.route('/api/webhooks/tally', tallyWebhookRoutes);
app.route('/api/webhooks/telegram', telegramWebhookRoutes);
app.route('/api/webhooks/line', lineWebhookRoutes);
app.route('/api/webhooks/waha', wahaWebhookRoutes);
app.route('/api/webhooks/whatsapp', whatsappWebhookRoutes);
app.route('/api/webhooks/whatsapp-business', whatsappBusinessWebhookRoutes);
app.route('/api/whatsapp-business', whatsappBusinessRoutes);

// Jangan mount Inngest / mulai server saat di-import oleh test (NODE_ENV=test).
if (env.NODE_ENV !== 'test') {
  if (env.NODE_ENV === 'production' && !env.INNGEST_SIGNING_KEY) {
    console.warn(
      '⚠️  INNGEST_SIGNING_KEY belum disetel — endpoint /api/inngest tidak memverifikasi signature! Setel di produksi.',
    );
  }
  // Warning hanya relevan bila Vapi benar-benar dipakai (VAPI_API_KEY ada):
  // tanpa API key tidak ada asisten/panggilan/webhook, jadi tidak ada yang
  // ditolak — warning hanya jadi noise saat fitur nonaktif (konsisten dengan
  // integrasi opsional lain yang diam saat mati). Endpoint webhook tetap
  // fail-closed sendiri (503 + pesan jelas) bila secret hilang saat dipakai.
  if (env.VAPI_API_KEY && !env.VAPI_WEBHOOK_SECRET) {
    console.warn(
      '⚠️  VAPI_WEBHOOK_SECRET belum disetel — webhook Vapi menolak semua event (fail-closed). Setel di .env (header Authorization Bearer dikonfigurasi otomatis di asisten Vapi).',
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

  // ── Self-healing webhook Telegram: setelah restart/deploy, pastikan URL
  // webhook di sisi Telegram cocok dengan WEBHOOK_BASE_URL saat ini (tanpa
  // ini bot bisa berhenti merespons karena webhook masih menunjuk URL lama).
  // Non-blocking — tidak menunda boot; kegagalan hanya dicatat sebagai log.
  void reconcileTelegramWebhooks();

  // ── Shutdown graceful: flush event PostHog yang masih antri. ──
  const shutdown = () => {
    void shutdownAnalytics().finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

export type AppType = typeof app;
