import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Mock Inngest, idempotency lib, resolver channel, dan guard soft-delete agar
// test tidak menyentuh DB/network (pola sama dengan waha.test.ts).
const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
const { markWebhookProcessedMock } = vi.hoisted(() => ({ markWebhookProcessedMock: vi.fn() }));
const { recordWebhookEventMock } = vi.hoisted(() => ({ recordWebhookEventMock: vi.fn() }));
const { resolveTelegramChannelMock } = vi.hoisted(() => ({ resolveTelegramChannelMock: vi.fn() }));
const { isWorkspaceActiveMock } = vi.hoisted(() => ({ isWorkspaceActiveMock: vi.fn() }));

vi.mock('../../inngest/client.ts', () => ({
  inngest: { send: sendMock },
}));

vi.mock('../../lib/webhooks.ts', () => ({
  recordWebhookEvent: recordWebhookEventMock,
  markWebhookProcessed: markWebhookProcessedMock,
}));

vi.mock('../../lib/telegram-handler.ts', () => ({
  resolveTelegramChannel: resolveTelegramChannelMock,
}));

vi.mock('../../lib/workspace-lifecycle.ts', () => ({
  isWorkspaceActive: isWorkspaceActiveMock,
}));

// `.env` root (milik environment) menimpa env proses — no-op agar test bisa
// menetapkan NODE_ENV='production' untuk kasus fail-closed.
vi.mock('@oriole/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@oriole/config')>();
  return { ...actual, loadRootEnv: vi.fn() };
});

const WEBHOOK_SECRET = 'test-telegram-webhook-secret';

let app: Hono;

async function buildApp(): Promise<Hono> {
  vi.resetModules();
  const { telegramWebhookRoutes } = await import('./telegram.ts');
  return new Hono().route('/api/webhooks/telegram', telegramWebhookRoutes);
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
  resolveTelegramChannelMock.mockReset();
  resolveTelegramChannelMock.mockResolvedValue({
    token: '123456:ABC',
    webhookSecret: WEBHOOK_SECRET,
    isActive: true,
  });
  isWorkspaceActiveMock.mockReset();
  isWorkspaceActiveMock.mockResolvedValue(true);
});

function validBody(updateId = 1001): string {
  return JSON.stringify({
    update_id: updateId,
    message: {
      message_id: 42,
      date: 1755000000,
      chat: { id: 123456789, first_name: 'Budi', type: 'private' },
      text: 'Halo',
    },
  });
}

function post(body: string, secret?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret !== undefined) headers['x-telegram-bot-api-secret-token'] = secret;
  return app.request('/api/webhooks/telegram/ws-1', { method: 'POST', headers, body });
}

describe('POST /api/webhooks/telegram — keamanan', () => {
  it('project soft-deleted → 200 disabled tanpa proses & tanpa queue', async () => {
    app = await buildApp();
    isWorkspaceActiveMock.mockResolvedValue(false);
    const res = await post(validBody());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, disabled: true });
    expect(resolveTelegramChannelMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('workspace tanpa channel telegram (belum setup) → 404', async () => {
    resolveTelegramChannelMock.mockResolvedValue(null);
    app = await buildApp();
    const res = await post(validBody());
    expect(res.status).toBe(404);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('menolak secret salah → 401', async () => {
    app = await buildApp();
    const res = await post(validBody(), 'wrong-secret');
    expect(res.status).toBe(401);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('menolak request tanpa header secret (secret sudah disetel) → 401', async () => {
    app = await buildApp();
    const res = await post(validBody());
    expect(res.status).toBe(401);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('fail-closed di produksi tanpa secret → 503', async () => {
    process.env.NODE_ENV = 'production';
    resolveTelegramChannelMock.mockResolvedValue({
      token: '123456:ABC',
      webhookSecret: null,
      isActive: true,
    });
    app = await buildApp();
    const res = await post(validBody());
    expect(res.status).toBe(503);
    process.env.NODE_ENV = 'test';
  });

  it('secret benar → 200, event di-record dengan namespace workspace, lalu di-queue', async () => {
    app = await buildApp();
    const body = validBody(2005);
    const res = await post(body, WEBHOOK_SECRET);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, eventId: 'ws-1:2005' });

    expect(recordWebhookEventMock).toHaveBeenCalledWith(
      expect.anything(),
      'telegram',
      'ws-1:2005',
      'update',
      expect.any(Object),
    );

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'telegram/message.received',
        data: { workspaceId: 'ws-1', update: expect.objectContaining({ update_id: 2005 }) },
      }),
    );
    expect(markWebhookProcessedMock).toHaveBeenCalledWith(expect.anything(), 'telegram', 'ws-1:2005');
  });

  it('channel dijeda (isActive false) → 200 disabled tanpa proses', async () => {
    app = await buildApp();
    resolveTelegramChannelMock.mockResolvedValue({
      token: '123456:ABC',
      webhookSecret: WEBHOOK_SECRET,
      isActive: false,
    });
    const res = await post(validBody(), WEBHOOK_SECRET);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, disabled: true });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('body bukan JSON → 400', async () => {
    app = await buildApp();
    const res = await post('not-json{', WEBHOOK_SECRET);
    expect(res.status).toBe(400);
  });

  it('event duplikat yang sudah diproses → 200 duplicate, tidak meng-queue lagi', async () => {
    app = await buildApp();
    recordWebhookEventMock.mockResolvedValue('processed');
    const res = await post(validBody(3001), WEBHOOK_SECRET);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ duplicate: true, eventId: 'ws-1:3001' });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('Inngest tidak tersedia (send reject) → 503 + tidak menandai processed', async () => {
    app = await buildApp();
    sendMock.mockRejectedValue(new Error("We couldn't find an event key"));
    const res = await post(validBody(), WEBHOOK_SECRET);
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain('Inngest');
    // Telegram akan me-retry — jangan tandai processed agar retry diproses ulang.
    expect(markWebhookProcessedMock).not.toHaveBeenCalled();
  });
});
