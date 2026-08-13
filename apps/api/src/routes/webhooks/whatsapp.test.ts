import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Mock Inngest, idempotency lib, dan resolver channel agar test tidak menyentuh DB/network.
const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
const { recordWebhookEventMock } = vi.hoisted(() => ({ recordWebhookEventMock: vi.fn() }));
const { resolveChannelMock } = vi.hoisted(() => ({ resolveChannelMock: vi.fn() }));
const { isWorkspaceActiveMock } = vi.hoisted(() => ({ isWorkspaceActiveMock: vi.fn() }));

vi.mock('../../inngest/client.ts', () => ({
  inngest: { send: sendMock },
}));

vi.mock('../../lib/webhooks.ts', () => ({
  recordWebhookEvent: recordWebhookEventMock,
  markWebhookProcessed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/whatsapp.ts', () => ({
  resolveWhatsAppChannel: resolveChannelMock,
}));

// Guard soft-delete project — default: workspace aktif.
vi.mock('../../lib/workspace-lifecycle.ts', () => ({
  isWorkspaceActive: isWorkspaceActiveMock,
}));

// `.env` root (milik environment) menimpa env proses — no-op agar test
// bisa menetapkan NODE_ENV='production' untuk kasus fail-closed.
vi.mock('@oriole/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@oriole/config')>();
  return { ...actual, loadRootEnv: vi.fn() };
});

import { signWebhookBody } from '../../lib/webhook-signature';

const WEBHOOK_SECRET = 'test-whatsapp-app-secret';
const WAMID = 'wamid.HBgLNTYyMDAwMDAwMDAwFQIAERgSMjAyNi0wOC0xNQo';

let app: Hono;

async function buildApp(): Promise<Hono> {
  vi.resetModules();
  const { whatsappWebhookRoutes } = await import('./whatsapp.ts');
  return new Hono().route('/api/webhooks/whatsapp', whatsappWebhookRoutes);
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
  process.env.WHATSAPP_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

beforeEach(() => {
  sendMock.mockReset();
  recordWebhookEventMock.mockReset();
  recordWebhookEventMock.mockResolvedValue('new');
  resolveChannelMock.mockReset();
  resolveChannelMock.mockResolvedValue({ apiKey: 'wa_test', webhookSecret: WEBHOOK_SECRET, isActive: true });
  isWorkspaceActiveMock.mockReset();
  isWorkspaceActiveMock.mockResolvedValue(true);
});

function validBody(): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '1234567890',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '6281234567890', phone_number_id: '0987654321' },
              contacts: [{ profile: { name: 'Budi' }, wa_id: '6281234567890' }],
              messages: [{ from: '6281234567890', id: WAMID, timestamp: '1755000000', type: 'text', text: { body: 'Halo' } }],
            },
          },
        ],
      },
    ],
  });
}

function sign(body: string): string {
  return `sha256=${signWebhookBody(body, WEBHOOK_SECRET)}`;
}

describe('POST /api/webhooks/whatsapp — keamanan', () => {
  it('project soft-deleted → 200 disabled tanpa proses & tanpa queue', async () => {
    app = await buildApp();
    isWorkspaceActiveMock.mockResolvedValue(false);
    const res = await app.request('/api/webhooks/whatsapp/ws-1', {
      method: 'POST',
      headers: { 'x-hub-signature-256': sign(validBody()) },
      body: validBody(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, disabled: true });
    expect(resolveChannelMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('workspace tanpa channel → 404', async () => {
    resolveChannelMock.mockResolvedValue(null);
    app = await buildApp();
    const res = await app.request('/api/webhooks/whatsapp/ws-1', {
      method: 'POST',
      headers: { 'x-hub-signature-256': sign(validBody()) },
      body: validBody(),
    });
    expect(res.status).toBe(404);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('channel BYO (provider waha) → 404 — webhook 360dialog hanya untuk provider itu', async () => {
    resolveChannelMock.mockResolvedValue({
      provider: 'waha',
      baseUrl: 'http://waha.test:3000',
      gatewayApiKey: 'gw-key',
      sessionName: 'ws_ws-1',
      isActive: true,
    });
    app = await buildApp();
    const res = await app.request('/api/webhooks/whatsapp/ws-1', {
      method: 'POST',
      headers: { 'x-hub-signature-256': sign(validBody()) },
      body: validBody(),
    });
    expect(res.status).toBe(404);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('menolak signature salah → 401', async () => {
    app = await buildApp();
    const res = await app.request('/api/webhooks/whatsapp/ws-1', {
      method: 'POST',
      headers: { 'x-hub-signature-256': 'sha256=deadbeef' },
      body: validBody(),
    });
    expect(res.status).toBe(401);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('fail-closed di produksi tanpa secret → 503', async () => {
    process.env.NODE_ENV = 'production';
    resolveChannelMock.mockResolvedValue({ apiKey: 'wa_test', webhookSecret: null, isActive: true });
    app = await buildApp();
    const res = await app.request('/api/webhooks/whatsapp/ws-1', {
      method: 'POST',
      body: validBody(),
    });
    expect(res.status).toBe(503);
    process.env.NODE_ENV = 'test';
  });

  it('signature benar → 200 dan meng-queue Inngest', async () => {
    app = await buildApp();
    const body = validBody();
    const res = await app.request('/api/webhooks/whatsapp/ws-1', {
      method: 'POST',
      headers: { 'x-hub-signature-256': sign(body) },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'whatsapp/message.received' }),
    );
  });

  it('channel dijeda (isActive false) → 200 disabled tanpa proses', async () => {
    app = await buildApp();
    resolveChannelMock.mockResolvedValue({ apiKey: 'wa_test', webhookSecret: WEBHOOK_SECRET, isActive: false });
    const res = await app.request('/api/webhooks/whatsapp/ws-1', {
      method: 'POST',
      headers: { 'x-hub-signature-256': sign(validBody()) },
      body: validBody(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, disabled: true });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('payload tanpa pesan (status/verifikasi) → 200 events 0 tanpa queue', async () => {
    app = await buildApp();
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        { changes: [{ field: 'messages', value: { statuses: [{ id: WAMID, status: 'delivered' }] } }] },
      ],
    });
    const res = await app.request('/api/webhooks/whatsapp/ws-1', {
      method: 'POST',
      headers: { 'x-hub-signature-256': sign(body) },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, events: 0 });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('body bukan JSON → 400', async () => {
    app = await buildApp();
    const res = await app.request('/api/webhooks/whatsapp/ws-1', {
      method: 'POST',
      headers: { 'x-hub-signature-256': sign('not-json{') },
      body: 'not-json{',
    });
    expect(res.status).toBe(400);
  });

  it('event duplikat yang sudah diproses → 200 duplicate, tidak meng-queue lagi', async () => {
    app = await buildApp();
    recordWebhookEventMock.mockResolvedValue('processed');
    const body = validBody();
    const res = await app.request('/api/webhooks/whatsapp/ws-1', {
      method: 'POST',
      headers: { 'x-hub-signature-256': sign(body) },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ duplicate: true });
    expect(sendMock).not.toHaveBeenCalled();
  });
});
