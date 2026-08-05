import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Mock Inngest & idempotency lib agar test tidak menyentuh DB/network.
const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
const { recordWebhookEventMock } = vi.hoisted(() => ({ recordWebhookEventMock: vi.fn() }));

vi.mock('../../inngest/client.ts', () => ({
  inngest: { send: sendMock },
}));

vi.mock('../../lib/webhooks.ts', () => ({
  recordWebhookEvent: recordWebhookEventMock,
  markWebhookProcessed: vi.fn().mockResolvedValue(undefined),
}));

import { signWebhookBody } from '../../lib/webhook-signature';

const WEBHOOK_SECRET = 'test-calle-webhook-secret';

let app: Hono;

/**
 * Rebuild app dengan reset module agar `env` (snapshot saat import) membaca
 * nilai CALLE_WEBHOOK_SECRET terbaru di setiap kasus.
 */
async function buildApp(): Promise<Hono> {
  vi.resetModules();
  const { calleWebhookRoutes } = await import('./calle.ts');
  return new Hono().route('/api/webhooks/calle', calleWebhookRoutes);
}

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/oriole_test';
  process.env.NEON_AUTH_URL = 'https://ep-test.neon.tech/neondb/auth';
  process.env.PADDLE_API_KEY = 'pdl_sdbx_test';
  process.env.PADDLE_WEBHOOK_SECRET = 'pdl_ntfset_test';
  process.env.RESEND_API_KEY = 're_test';
  process.env.CALLE_API_KEY = 'calle_test';
});

beforeEach(() => {
  sendMock.mockReset();
  recordWebhookEventMock.mockReset();
  recordWebhookEventMock.mockResolvedValue('new');
});

function validBody(): string {
  return JSON.stringify({
    id: 'evt-1',
    type: 'call.completed',
    data: {
      callId: 'call-1',
      status: 'completed',
      phone: '+6281234567890',
      userId: 'u1',
      workspaceId: 'ws1',
      bookingId: 'b1',
    },
  });
}

describe('POST /api/webhooks/calle — keamanan', () => {
  it('fail-closed: tanpa CALLE_WEBHOOK_SECRET → 503', async () => {
    delete process.env.CALLE_WEBHOOK_SECRET;
    app = await buildApp();

    const res = await app.request('/api/webhooks/calle', {
      method: 'POST',
      body: validBody(),
    });
    expect(res.status).toBe(503);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('menolak tanpa header x-calle-signature → 401', async () => {
    process.env.CALLE_WEBHOOK_SECRET = WEBHOOK_SECRET;
    app = await buildApp();

    const res = await app.request('/api/webhooks/calle', {
      method: 'POST',
      body: validBody(),
    });
    expect(res.status).toBe(401);
  });

  it('menolak signature salah → 401', async () => {
    process.env.CALLE_WEBHOOK_SECRET = WEBHOOK_SECRET;
    app = await buildApp();

    const res = await app.request('/api/webhooks/calle', {
      method: 'POST',
      headers: { 'x-calle-signature': 'deadbeef' },
      body: validBody(),
    });
    expect(res.status).toBe(401);
  });

  it('menerima signature benar → 200 dan meng-queue Inngest', async () => {
    process.env.CALLE_WEBHOOK_SECRET = WEBHOOK_SECRET;
    app = await buildApp();

    const body = validBody();
    const res = await app.request('/api/webhooks/calle', {
      method: 'POST',
      headers: { 'x-calle-signature': signWebhookBody(body, WEBHOOK_SECRET) },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, eventId: 'evt-1' });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('signature benar tapi payload tidak valid → 400', async () => {
    process.env.CALLE_WEBHOOK_SECRET = WEBHOOK_SECRET;
    app = await buildApp();

    const body = JSON.stringify({ id: '' }); // id wajib min 1
    const res = await app.request('/api/webhooks/calle', {
      method: 'POST',
      headers: { 'x-calle-signature': signWebhookBody(body, WEBHOOK_SECRET) },
      body,
    });
    expect(res.status).toBe(400);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('body bukan JSON → 400', async () => {
    process.env.CALLE_WEBHOOK_SECRET = WEBHOOK_SECRET;
    app = await buildApp();

    const body = 'not-json{';
    const res = await app.request('/api/webhooks/calle', {
      method: 'POST',
      headers: { 'x-calle-signature': signWebhookBody(body, WEBHOOK_SECRET) },
      body,
    });
    expect(res.status).toBe(400);
  });

  it('event duplikat yang sudah diproses → 200 duplicate, tidak meng-queue lagi', async () => {
    process.env.CALLE_WEBHOOK_SECRET = WEBHOOK_SECRET;
    app = await buildApp();
    recordWebhookEventMock.mockResolvedValue('processed');

    const body = validBody();
    const res = await app.request('/api/webhooks/calle', {
      method: 'POST',
      headers: { 'x-calle-signature': signWebhookBody(body, WEBHOOK_SECRET) },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ duplicate: true });
    expect(sendMock).not.toHaveBeenCalled();
  });
});
