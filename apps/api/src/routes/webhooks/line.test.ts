import { createHmac } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Mock Inngest, idempotency lib, resolver channel, dan guard soft-delete agar
// test tidak menyentuh DB/network (pola sama dengan telegram.test.ts).
const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
const { markWebhookProcessedMock } = vi.hoisted(() => ({ markWebhookProcessedMock: vi.fn() }));
const { recordWebhookEventMock } = vi.hoisted(() => ({ recordWebhookEventMock: vi.fn() }));
const { resolveLineChannelMock } = vi.hoisted(() => ({ resolveLineChannelMock: vi.fn() }));
const { isWorkspaceActiveMock } = vi.hoisted(() => ({ isWorkspaceActiveMock: vi.fn() }));

vi.mock('../../inngest/client.ts', () => ({
  inngest: { send: sendMock },
}));

vi.mock('../../lib/webhooks.ts', () => ({
  recordWebhookEvent: recordWebhookEventMock,
  markWebhookProcessed: markWebhookProcessedMock,
}));

vi.mock('../../lib/line-handler.ts', () => ({
  resolveLineChannel: resolveLineChannelMock,
}));

vi.mock('../../lib/workspace-lifecycle.ts', () => ({
  isWorkspaceActive: isWorkspaceActiveMock,
}));

const CHANNEL_SECRET = 'test-line-channel-secret';

let app: Hono;

async function buildApp(): Promise<Hono> {
  vi.resetModules();
  const { lineWebhookRoutes } = await import('./line.ts');
  return new Hono().route('/api/webhooks/line', lineWebhookRoutes);
}

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/oriole_test';
  process.env.NEON_AUTH_URL = 'https://ep-test.neon.tech/neondb/auth';
  process.env.PADDLE_API_KEY = 'pdl_sdbx_test';
  process.env.PADDLE_WEBHOOK_SECRET = 'pdl_ntfset_test';
  process.env.RESEND_API_KEY = 're_test';
  process.env.VAPI_API_KEY = 'vapi_test';
  process.env.VAPI_PHONE_NUMBER_ID = 'phone-number-test';
  process.env.WHATSAPP_API_KEY = 'wa_test';
  process.env.WHATSAPP_WEBHOOK_SECRET = 'wa_secret';
  process.env.TELEGRAM_BOT_TOKEN = '123456:ABC';
});

beforeEach(() => {
  sendMock.mockReset();
  markWebhookProcessedMock.mockReset();
  markWebhookProcessedMock.mockResolvedValue(undefined);
  recordWebhookEventMock.mockReset();
  recordWebhookEventMock.mockResolvedValue('new');
  resolveLineChannelMock.mockReset();
  resolveLineChannelMock.mockResolvedValue({
    accessToken: 'test-access-token',
    channelSecret: CHANNEL_SECRET,
    isActive: true,
  });
  isWorkspaceActiveMock.mockReset();
  isWorkspaceActiveMock.mockResolvedValue(true);
});

function validBody(): string {
  return JSON.stringify({
    destination: 'U1234567890',
    events: [
      {
        type: 'message',
        timestamp: 1755000000000,
        source: { type: 'user', userId: 'U4af4980629abcdef' },
        replyToken: 'reply-token-1',
        message: { id: '325708', type: 'text', text: 'Halo' },
      },
    ],
  });
}

function sign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('base64');
}

function post(body: string, signature: string | undefined) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (signature !== undefined) headers['x-line-signature'] = signature;
  return app.request('/api/webhooks/line/ws-1', { method: 'POST', headers, body });
}

describe('POST /api/webhooks/line — keamanan', () => {
  it('signature valid → antre ke Inngest + ack', async () => {
    app = await buildApp();
    const body = validBody();
    const res = await post(body, sign(CHANNEL_SECRET, body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, eventKey: '325708' });

    expect(recordWebhookEventMock).toHaveBeenCalledWith(
      expect.anything(),
      'line',
      '325708',
      'update',
      expect.anything(),
    );
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'line/message.received',
        data: expect.objectContaining({ workspaceId: 'ws-1' }),
      }),
    );
    expect(markWebhookProcessedMock).toHaveBeenCalled();
  });

  it('signature salah → 401, tidak diproses', async () => {
    app = await buildApp();
    const body = validBody();
    const res = await post(body, sign('wrong-secret', body));
    expect(res.status).toBe(401);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('tanpa signature → 401', async () => {
    app = await buildApp();
    const res = await post(validBody(), undefined);
    expect(res.status).toBe(401);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('payload bukan JSON → 400', async () => {
    app = await buildApp();
    const res = await post('not-json', sign(CHANNEL_SECRET, 'not-json'));
    expect(res.status).toBe(400);
  });

  it('payload tanpa events → 200 tanpa proses', async () => {
    app = await buildApp();
    const body = JSON.stringify({ destination: 'U1', events: [] });
    const res = await post(body, sign(CHANNEL_SECRET, body));
    expect(res.status).toBe(200);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('channel belum dikonfigurasi → 404', async () => {
    resolveLineChannelMock.mockResolvedValue(null);
    app = await buildApp();
    const body = validBody();
    const res = await post(body, sign(CHANNEL_SECRET, body));
    expect(res.status).toBe(404);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('channel dijeda → ack 200 disabled tanpa proses', async () => {
    resolveLineChannelMock.mockResolvedValue({
      accessToken: 'test-access-token',
      channelSecret: CHANNEL_SECRET,
      isActive: false,
    });
    app = await buildApp();
    const body = validBody();
    const res = await post(body, sign(CHANNEL_SECRET, body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, disabled: true });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('workspace soft-deleted → ack 200 disabled', async () => {
    isWorkspaceActiveMock.mockResolvedValue(false);
    app = await buildApp();
    const body = validBody();
    const res = await post(body, sign(CHANNEL_SECRET, body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, disabled: true });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('duplicate payload → ack 200 tanpa antre ulang', async () => {
    recordWebhookEventMock.mockResolvedValue('processed');
    app = await buildApp();
    const body = validBody();
    const res = await post(body, sign(CHANNEL_SECRET, body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ duplicate: true, eventKey: '325708' });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('Inngest gagal → 503 agar Line me-retry', async () => {
    sendMock.mockRejectedValue(new Error('inngest down'));
    app = await buildApp();
    const body = validBody();
    const res = await post(body, sign(CHANNEL_SECRET, body));
    expect(res.status).toBe(503);
  });
});
