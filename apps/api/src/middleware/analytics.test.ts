import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/oriole_test';
process.env.NEON_AUTH_URL = 'https://ep-test.neon.tech/neondb/auth';
process.env.PADDLE_API_KEY = 'pdl_sdbx_test';
process.env.PADDLE_WEBHOOK_SECRET = 'pdl_ntfset_test';
process.env.RESEND_API_KEY = 're_test';
process.env.VAPI_API_KEY = 'vapi_test';
process.env.VAPI_PHONE_NUMBER_ID = 'phone-number-test';

// Dynamic import SETELAH env disetel (env.ts dibaca saat modul di-import;
// import statis ESM di-hoist ke atas assignment process.env).
const { setAnalyticsSinkForTests } = await import('../lib/analytics.ts');
import type { AnalyticsEventPayload, AnalyticsSink } from '../lib/analytics.ts';
const { analyticsFlushMiddleware } = await import('./analytics.ts');

/** Sink yang mencatat jumlah flush (dan bisa diminta melempar). */
class TrackedSink implements AnalyticsSink {
  flushCalls = 0;
  constructor(private readonly failOnFlush = false) {}

  capture(_payload: AnalyticsEventPayload): void {}
  captureException(): void {}
  async flush(): Promise<void> {
    this.flushCalls += 1;
    if (this.failOnFlush) throw new Error('flush gagal (simulasi)');
  }
  async shutdown(): Promise<void> {}
}

describe('analyticsFlushMiddleware', () => {
  afterEach(() => {
    setAnalyticsSinkForTests(undefined);
  });

  it('meneruskan request & response utuh; flush dipanggil setelah response', async () => {
    const sink = new TrackedSink();
    setAnalyticsSinkForTests(sink);

    const app = new Hono();
    app.use('*', analyticsFlushMiddleware);
    app.get('/ping', (c) => c.text('pong'));

    const res = await app.request('/ping');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('pong');
    expect(sink.flushCalls).toBe(1);
  });

  it('flush yang melempar TIDAK menggagalkan response (best-effort)', async () => {
    const sink = new TrackedSink(true);
    setAnalyticsSinkForTests(sink);

    const app = new Hono();
    app.use('*', analyticsFlushMiddleware);
    app.get('/boom', (c) => c.json({ ok: true }));

    const res = await app.request('/boom');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sink.flushCalls).toBe(1);
  });

  it('tanpa sink (analitik nonaktif) → request tetap normal', async () => {
    const app = new Hono();
    app.use('*', analyticsFlushMiddleware);
    app.get('/ping', (c) => c.text('pong'));

    const res = await app.request('/ping');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('pong');
  });
});
