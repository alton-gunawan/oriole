import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Mock Inngest, idempotency lib, resolver channel, health lib, dan guard
// soft-delete agar test tidak menyentuh DB/network (pola sama dengan
// whatsapp.test.ts). Health webhook (session.status/ack) di-stub terpisah —
// logikanya diuji di lib/waha-health.test.ts.
const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
const { markWebhookProcessedMock } = vi.hoisted(() => ({ markWebhookProcessedMock: vi.fn() }));
const { recordWebhookEventMock } = vi.hoisted(() => ({ recordWebhookEventMock: vi.fn() }));
const { resolveWahaChannelMock } = vi.hoisted(() => ({ resolveWahaChannelMock: vi.fn() }));
const { isWorkspaceActiveMock } = vi.hoisted(() => ({ isWorkspaceActiveMock: vi.fn() }));
const { applyWahaSessionStatusMock, applyWahaMessageAckMock, applyWahaMessageSeenMock } =
  vi.hoisted(() => ({
    applyWahaSessionStatusMock: vi.fn(),
    applyWahaMessageAckMock: vi.fn(),
    applyWahaMessageSeenMock: vi.fn(),
  }));

vi.mock('../../inngest/client.ts', () => ({
  inngest: { send: sendMock },
}));

vi.mock('../../lib/webhooks.ts', () => ({
  recordWebhookEvent: recordWebhookEventMock,
  markWebhookProcessed: markWebhookProcessedMock,
}));

vi.mock('../../services/waha.ts', () => ({
  resolveWahaChannel: resolveWahaChannelMock,
}));

vi.mock('../../lib/waha-health.ts', () => ({
  applyWahaSessionStatus: applyWahaSessionStatusMock,
  applyWahaMessageAck: applyWahaMessageAckMock,
  applyWahaMessageSeen: applyWahaMessageSeenMock,
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

import { signWahaWebhookBody } from '../../lib/webhook-signature';

const WEBHOOK_SECRET = 'test-waha-webhook-secret';
const WAHA_MESSAGE_ID = 'false_6281234567890@c.us_3EB0CAAAAAAAAAAAAAAAAAAAAAAAA';

let app: Hono;

async function buildApp(): Promise<Hono> {
  vi.resetModules();
  const { wahaWebhookRoutes } = await import('./waha.ts');
  return new Hono().route('/api/webhooks/waha', wahaWebhookRoutes);
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
  markWebhookProcessedMock.mockReset();
  markWebhookProcessedMock.mockResolvedValue(undefined);
  recordWebhookEventMock.mockReset();
  recordWebhookEventMock.mockResolvedValue('new');
  resolveWahaChannelMock.mockReset();
  resolveWahaChannelMock.mockResolvedValue({
    webhookSecret: WEBHOOK_SECRET,
    isActive: true,
    sessionName: 'ws_ws-1',
  });
  isWorkspaceActiveMock.mockReset();
  isWorkspaceActiveMock.mockResolvedValue(true);
  applyWahaSessionStatusMock.mockReset();
  applyWahaSessionStatusMock.mockResolvedValue(undefined);
  applyWahaMessageAckMock.mockReset();
  applyWahaMessageAckMock.mockResolvedValue(undefined);
  applyWahaMessageSeenMock.mockReset();
  applyWahaMessageSeenMock.mockResolvedValue(undefined);
});

function validBody(): string {
  return JSON.stringify({
    id: 'evt_01k3xyz0000000000000000000',
    timestamp: 1755000000000,
    event: 'message',
    session: 'ws_ws-1',
    me: { id: '6281111111111@c.us', pushName: 'Oriole' },
    engine: 'NOWEB',
    environment: { version: '2026.7.2' },
    payload: {
      id: WAHA_MESSAGE_ID,
      timestamp: 1755000000,
      from: '6281234567890@c.us',
      fromMe: false,
      to: 'me',
      body: 'Halo',
      hasMedia: false,
      ack: 1,
    },
  });
}

function sign(body: string): string {
  return signWahaWebhookBody(body, WEBHOOK_SECRET);
}

describe('POST /api/webhooks/waha — keamanan', () => {
  it('bisnis soft-deleted → 200 disabled tanpa proses & tanpa queue', async () => {
    app = await buildApp();
    isWorkspaceActiveMock.mockResolvedValue(false);
    const res = await app.request('/api/webhooks/waha/ws-1', {
      method: 'POST',
      headers: { 'x-webhook-hmac': sign(validBody()) },
      body: validBody(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, disabled: true });
    expect(resolveWahaChannelMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('workspace tanpa channel waha (belum setup / provider lain) → 404', async () => {
    resolveWahaChannelMock.mockResolvedValue(null);
    app = await buildApp();
    const res = await app.request('/api/webhooks/waha/ws-1', {
      method: 'POST',
      headers: { 'x-webhook-hmac': sign(validBody()) },
      body: validBody(),
    });
    expect(res.status).toBe(404);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('menolak signature salah → 401', async () => {
    app = await buildApp();
    const res = await app.request('/api/webhooks/waha/ws-1', {
      method: 'POST',
      headers: { 'x-webhook-hmac': 'deadbeef' },
      body: validBody(),
    });
    expect(res.status).toBe(401);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('menolak algoritma selain sha512 → 401', async () => {
    app = await buildApp();
    const res = await app.request('/api/webhooks/waha/ws-1', {
      method: 'POST',
      headers: { 'x-webhook-hmac': sign(validBody()), 'x-webhook-hmac-algorithm': 'sha256' },
      body: validBody(),
    });
    expect(res.status).toBe(401);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('fail-closed di produksi tanpa secret → 503', async () => {
    process.env.NODE_ENV = 'production';
    resolveWahaChannelMock.mockResolvedValue({ webhookSecret: null, isActive: true, sessionName: 'ws_ws-1' });
    app = await buildApp();
    const res = await app.request('/api/webhooks/waha/ws-1', {
      method: 'POST',
      body: validBody(),
    });
    expect(res.status).toBe(503);
    process.env.NODE_ENV = 'test';
  });

  it('signature benar → 200, event WAHA di-map ke bentuk Meta lalu di-queue', async () => {
    app = await buildApp();
    const body = validBody();
    const res = await app.request('/api/webhooks/waha/ws-1', {
      method: 'POST',
      headers: { 'x-webhook-hmac': sign(body), 'x-webhook-hmac-algorithm': 'sha512' },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true });

    expect(recordWebhookEventMock).toHaveBeenCalledWith(
      expect.anything(),
      'waha',
      `ws-1:waha:${WAHA_MESSAGE_ID}`,
      'message',
      expect.any(Object),
    );

    expect(sendMock).toHaveBeenCalledTimes(1);
    type SentMessage = { from: string; id: string; text: { body: string } };
    const sent = sendMock.mock.calls[0][0] as {
      name: string;
      data: { payload: { entry: { changes: { value: { messages: SentMessage[] } }[] }[] } };
    };
    expect(sent.name).toBe('whatsapp/message.received');
    const message = sent.data.payload.entry[0].changes[0].value.messages[0];
    // wa_id dari chatId, id WAHA sebagai kunci idempotency, teks apa adanya.
    expect(message.from).toBe('6281234567890');
    expect(message.id).toBe(WAHA_MESSAGE_ID);
    expect(message.text.body).toBe('Halo');
    // Pesan masuk = aktivitas → heartbeat lastSeenAt.
    expect(applyWahaMessageSeenMock).toHaveBeenCalledWith('ws-1');
  });

  it('channel dijeda (isActive false) → 200 disabled tanpa proses', async () => {
    app = await buildApp();
    resolveWahaChannelMock.mockResolvedValue({ webhookSecret: WEBHOOK_SECRET, isActive: false, sessionName: 'ws_ws-1' });
    const res = await app.request('/api/webhooks/waha/ws-1', {
      method: 'POST',
      headers: { 'x-webhook-hmac': sign(validBody()) },
      body: validBody(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, disabled: true });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('session.status WORKING → health diperbarui (applyWahaSessionStatus) tanpa queue', async () => {
    app = await buildApp();
    const body = JSON.stringify({
      id: 'evt_02',
      event: 'session.status',
      session: 'ws_ws-1',
      me: { id: '6281111111111@c.us' },
      payload: { status: 'WORKING', statuses: [{ status: 'SCAN_QR_CODE', timestamp: 1 }], data: null },
    });
    const res = await app.request('/api/webhooks/waha/ws-1', {
      method: 'POST',
      headers: { 'x-webhook-hmac': sign(body) },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, events: 0 });
    expect(sendMock).not.toHaveBeenCalled();
    // Dedup idempotency tetap berlaku untuk event non-pesan.
    expect(recordWebhookEventMock).toHaveBeenCalledWith(
      expect.anything(),
      'waha',
      'ws-1:waha:evt_02:session.status',
      'session.status',
      expect.any(Object),
    );
    expect(applyWahaSessionStatusMock).toHaveBeenCalledWith('ws-1', expect.objectContaining({ id: 'evt_02' }));
  });

  it('message.ack → status outbound diperbarui (applyWahaMessageAck) tanpa queue', async () => {
    app = await buildApp();
    const body = JSON.stringify({
      id: 'evt_09',
      event: 'message.ack',
      session: 'ws_ws-1',
      payload: {
        id: 'true_6281111111111@c.us_3EB0CAAAAAAAAAAAAAAAAAAAAAAAA',
        from: '6281111111111@c.us',
        fromMe: true,
        ack: 3,
      },
    });
    const res = await app.request('/api/webhooks/waha/ws-1', {
      method: 'POST',
      headers: { 'x-webhook-hmac': sign(body) },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, events: 0 });
    expect(sendMock).not.toHaveBeenCalled();
    expect(applyWahaMessageAckMock).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ ack: 3 }),
    );
  });

  it('echo outbound (fromMe) → 200 events 0 + heartbeat, tanpa queue', async () => {
    app = await buildApp();
    const body = JSON.stringify({
      id: 'evt_03',
      event: 'message.any',
      session: 'ws_ws-1',
      payload: {
        id: `true_6281111111111@c.us_3EB0C`,
        from: '6281111111111@c.us',
        fromMe: true,
        body: 'Halo',
        hasMedia: false,
      },
    });
    const res = await app.request('/api/webhooks/waha/ws-1', {
      method: 'POST',
      headers: { 'x-webhook-hmac': sign(body) },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, events: 0 });
    expect(sendMock).not.toHaveBeenCalled();
    expect(applyWahaMessageSeenMock).toHaveBeenCalledWith('ws-1');
  });

  it('body bukan JSON → 400', async () => {
    app = await buildApp();
    const res = await app.request('/api/webhooks/waha/ws-1', {
      method: 'POST',
      headers: { 'x-webhook-hmac': sign('not-json{') },
      body: 'not-json{',
    });
    expect(res.status).toBe(400);
  });

  it('event duplikat yang sudah diproses → 200 duplicate, tidak meng-queue lagi', async () => {
    app = await buildApp();
    recordWebhookEventMock.mockResolvedValue('processed');
    const body = validBody();
    const res = await app.request('/api/webhooks/waha/ws-1', {
      method: 'POST',
      headers: { 'x-webhook-hmac': sign(body) },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ duplicate: true });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('Inngest tidak tersedia (send reject) → 503 + tidak menandai processed', async () => {
    app = await buildApp();
    sendMock.mockRejectedValue(new Error("We couldn't find an event key"));
    const body = validBody();
    const res = await app.request('/api/webhooks/waha/ws-1', {
      method: 'POST',
      headers: { 'x-webhook-hmac': sign(body) },
      body,
    });
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain('Inngest');
    // WAHA akan me-retry — jangan tandai processed agar retry diproses ulang.
    expect(markWebhookProcessedMock).not.toHaveBeenCalled();
  });
});
