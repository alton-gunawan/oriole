import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Mock Inngest, idempotency, resolver tenant, dan guard lifecycle.
const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
const { recordWebhookEventMock } = vi.hoisted(() => ({ recordWebhookEventMock: vi.fn() }));
const { resolveWorkspaceMock } = vi.hoisted(() => ({ resolveWorkspaceMock: vi.fn() }));
const { isWorkspaceActiveMock } = vi.hoisted(() => ({ isWorkspaceActiveMock: vi.fn() }));

vi.mock('../../inngest/client.ts', () => ({
  inngest: { send: sendMock },
}));

vi.mock('../../lib/webhooks.ts', () => ({
  recordWebhookEvent: recordWebhookEventMock,
  markWebhookProcessed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/whatsapp-business.ts', () => ({
  resolveWorkspaceByPhoneNumberId: resolveWorkspaceMock,
}));

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

const APP_SECRET = 'meta-whatsapp-app-secret';
const VERIFY_TOKEN = 'meta-verify-token';
const WAMID = 'wamid.HBgLNTYyMDAwMDAwMDAwFQIAERgSMjAyNi0wOC0xNQo';

let app: Hono;

async function buildApp(): Promise<Hono> {
  vi.resetModules();
  const { whatsappBusinessWebhookRoutes } = await import('./whatsapp-business.ts');
  return new Hono().route('/api/webhooks/whatsapp-business', whatsappBusinessWebhookRoutes);
}

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/oriole_test';
  process.env.NEON_AUTH_URL = 'https://ep-test.neon.tech/neondb/auth';
  process.env.PADDLE_API_KEY = 'pdl_sdbx_test';
  process.env.PADDLE_WEBHOOK_SECRET = 'pdl_ntfset_test';
  process.env.RESEND_API_KEY = 're_test';
  process.env.META_WHATSAPP_APP_SECRET = APP_SECRET;
  process.env.META_WHATSAPP_VERIFY_TOKEN = VERIFY_TOKEN;
});

beforeEach(() => {
  sendMock.mockReset();
  recordWebhookEventMock.mockReset();
  recordWebhookEventMock.mockResolvedValue('new');
  resolveWorkspaceMock.mockReset();
  resolveWorkspaceMock.mockResolvedValue('ws-1');
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
  return `sha256=${signWebhookBody(body, APP_SECRET)}`;
}

describe('GET /api/webhooks/whatsapp-business — verifikasi webhook', () => {
  it('token verifikasi benar → mengembalikan hub.challenge', async () => {
    app = await buildApp();
    const res = await app.request(
      `/api/webhooks/whatsapp-business?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=12345`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('12345');
  });

  it('token verifikasi salah → 403', async () => {
    app = await buildApp();
    const res = await app.request(
      '/api/webhooks/whatsapp-business?hub.mode=subscribe&hub.verify_token=salah&hub.challenge=12345',
    );
    expect(res.status).toBe(403);
  });
});

describe('POST /api/webhooks/whatsapp-business', () => {
  it('signature salah → 401 tanpa queue', async () => {
    app = await buildApp();
    const res = await app.request('/api/webhooks/whatsapp-business', {
      method: 'POST',
      headers: { 'x-hub-signature-256': 'sha256=deadbeef' },
      body: validBody(),
    });
    expect(res.status).toBe(401);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('fail-closed di produksi tanpa app secret → 503', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.META_WHATSAPP_APP_SECRET;
    app = await buildApp();
    const res = await app.request('/api/webhooks/whatsapp-business', {
      method: 'POST',
      body: validBody(),
    });
    expect(res.status).toBe(503);
    process.env.NODE_ENV = 'test';
    process.env.META_WHATSAPP_APP_SECRET = APP_SECRET;
  });

  it('phone_number_id tidak dikenal platform → 200 skipped tanpa queue', async () => {
    resolveWorkspaceMock.mockResolvedValue(null);
    app = await buildApp();
    const body = validBody();
    const res = await app.request('/api/webhooks/whatsapp-business', {
      method: 'POST',
      headers: { 'x-hub-signature-256': sign(body) },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, skipped: 'unknown-phone-number-id' });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('bisnis soft-deleted → 200 disabled tanpa queue', async () => {
    isWorkspaceActiveMock.mockResolvedValue(false);
    app = await buildApp();
    const body = validBody();
    const res = await app.request('/api/webhooks/whatsapp-business', {
      method: 'POST',
      headers: { 'x-hub-signature-256': sign(body) },
      body,
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
    const res = await app.request('/api/webhooks/whatsapp-business', {
      method: 'POST',
      headers: { 'x-hub-signature-256': sign(body) },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, events: 0 });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('event valid → resolve tenant dari phone_number_id + queue Inngest', async () => {
    app = await buildApp();
    const body = validBody();
    const res = await app.request('/api/webhooks/whatsapp-business', {
      method: 'POST',
      headers: { 'x-hub-signature-256': sign(body) },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true });
    expect(resolveWorkspaceMock).toHaveBeenCalledWith('0987654321');
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'whatsapp/message.received',
        data: expect.objectContaining({ workspaceId: 'ws-1' }),
      }),
    );
  });

  it('event duplikat → 200 duplicate tanpa queue lagi', async () => {
    recordWebhookEventMock.mockResolvedValue('processed');
    app = await buildApp();
    const body = validBody();
    const res = await app.request('/api/webhooks/whatsapp-business', {
      method: 'POST',
      headers: { 'x-hub-signature-256': sign(body) },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ duplicate: true });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('body bukan JSON → 400', async () => {
    app = await buildApp();
    const res = await app.request('/api/webhooks/whatsapp-business', {
      method: 'POST',
      headers: { 'x-hub-signature-256': sign('not-json{') },
      body: 'not-json{',
    });
    expect(res.status).toBe(400);
  });
});
