import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { Hono } from 'hono';

// Mock idempotency lib, guard soft-delete, loadTallyConfig, dan processor
// submission agar test tidak menyentuh DB/network (pola waha.test.ts).
// Submission diproses SINCRON di route (bukan queue Inngest) — tidak ada
// mock inngest/client di sini.
const { syncTallyMock } = vi.hoisted(() => ({ syncTallyMock: vi.fn() }));
const { markWebhookProcessedMock } = vi.hoisted(() => ({ markWebhookProcessedMock: vi.fn() }));
const { recordWebhookEventMock } = vi.hoisted(() => ({ recordWebhookEventMock: vi.fn() }));
const { isWorkspaceActiveMock } = vi.hoisted(() => ({ isWorkspaceActiveMock: vi.fn() }));
const { loadTallyConfigMock } = vi.hoisted(() => ({ loadTallyConfigMock: vi.fn() }));

vi.mock('../../lib/webhooks.ts', () => ({
  recordWebhookEvent: recordWebhookEventMock,
  markWebhookProcessed: markWebhookProcessedMock,
}));

vi.mock('../../lib/workspace-lifecycle.ts', () => ({
  isWorkspaceActive: isWorkspaceActiveMock,
}));

vi.mock('../../lib/tally.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/tally.ts')>();
  return {
    ...actual,
    loadTallyConfig: loadTallyConfigMock,
    syncTallySubmissionToContacts: syncTallyMock,
  };
});

// `.env` root (milik environment) menimpa env proses — no-op agar test bisa
// menetapkan NODE_ENV='production' untuk kasus fail-closed.
vi.mock('@oriole/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@oriole/config')>();
  return { ...actual, loadRootEnv: vi.fn() };
});

const WEBHOOK_SECRET = 'test-tally-webhook-secret';

let app: Hono;

async function buildApp(): Promise<Hono> {
  vi.resetModules();
  const { tallyWebhookRoutes } = await import('./tally.ts');
  return new Hono().route('/api/webhooks/tally', tallyWebhookRoutes);
}

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  // PORT=0 di environment shell ditolak schema env — test butuh nilai valid.
  process.env.PORT = '3000';
  process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/oriole_test';
  process.env.NEON_AUTH_URL = 'https://ep-test.neon.tech/neondb/auth';
  process.env.PADDLE_API_KEY = 'pdl_sdbx_test';
  process.env.PADDLE_WEBHOOK_SECRET = 'pdl_ntfset_test';
  process.env.RESEND_API_KEY = 're_test';
  process.env.VAPI_API_KEY = 'vapi_test';
  process.env.VAPI_PHONE_NUMBER_ID = 'phone-number-test';
  process.env.WHATSAPP_API_KEY = 'wa_test';
  process.env.WHATSAPP_WEBHOOK_SECRET = 'wa_test';
});

beforeEach(() => {
  syncTallyMock.mockReset();
  syncTallyMock.mockResolvedValue({ imported: true, skipped: null, bookingCreated: true });
  markWebhookProcessedMock.mockReset();
  markWebhookProcessedMock.mockResolvedValue(undefined);
  recordWebhookEventMock.mockReset();
  recordWebhookEventMock.mockResolvedValue('new');
  isWorkspaceActiveMock.mockReset();
  isWorkspaceActiveMock.mockResolvedValue(true);
  loadTallyConfigMock.mockReset();
  loadTallyConfigMock.mockResolvedValue({
    apiKey: 'tly_test',
    webhookSecret: WEBHOOK_SECRET,
    formId: 'nGM0Py',
    formName: 'Form Booking',
    isActive: true,
  });
});

function validBody(): string {
  return JSON.stringify({
    eventId: 'a4cb511e-d513-4fa5-baee-b815d718dfd1',
    eventType: 'FORM_RESPONSE',
    createdAt: '2026-06-28T15:00:21.889Z',
    data: {
      responseId: '2wgx4n',
      submissionId: '2wgx4n',
      formId: 'nGM0Py',
      formName: 'Form Booking',
      createdAt: '2026-06-28T15:00:21.000Z',
      fields: [
        { key: 'q-phone', label: 'Phone number', type: 'INPUT_PHONE_NUMBER', value: '+6281234567890' },
        { key: 'q-service', label: 'Layanan', type: 'MULTIPLE_CHOICE', value: ['opt-b'], options: [{ id: 'opt-b', text: 'Perawatan' }] },
      ],
    },
  });
}

function sign(body: string): string {
  return createHmac('sha256', WEBHOOK_SECRET).update(body, 'utf8').digest('base64');
}

describe('POST /api/webhooks/tally — keamanan', () => {
  it('bisnis soft-deleted → 200 disabled tanpa proses', async () => {
    app = await buildApp();
    isWorkspaceActiveMock.mockResolvedValue(false);
    const res = await app.request('/api/webhooks/tally/ws-1', {
      method: 'POST',
      headers: { 'tally-signature': sign(validBody()) },
      body: validBody(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, disabled: true });
    expect(syncTallyMock).not.toHaveBeenCalled();
  });

  it('integrasi tidak dikonfigurasi → 404', async () => {
    app = await buildApp();
    loadTallyConfigMock.mockResolvedValue(null);
    const res = await app.request('/api/webhooks/tally/ws-1', {
      method: 'POST',
      headers: { 'tally-signature': sign(validBody()) },
      body: validBody(),
    });
    expect(res.status).toBe(404);
  });

  it('integrasi dijeda → 200 disabled (ack agar Tally tidak retry)', async () => {
    app = await buildApp();
    loadTallyConfigMock.mockResolvedValue({
      apiKey: 'tly_test',
      webhookSecret: WEBHOOK_SECRET,
      formId: 'nGM0Py',
      isActive: false,
    });
    const res = await app.request('/api/webhooks/tally/ws-1', {
      method: 'POST',
      headers: { 'tally-signature': sign(validBody()) },
      body: validBody(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, disabled: true });
    expect(syncTallyMock).not.toHaveBeenCalled();
  });

  it('signature salah → 401', async () => {
    app = await buildApp();
    const res = await app.request('/api/webhooks/tally/ws-1', {
      method: 'POST',
      headers: { 'tally-signature': sign(validBody() + 'tampered') },
      body: validBody(),
    });
    expect(res.status).toBe(401);
    expect(syncTallyMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/webhooks/tally — pemrosesan sinkron', () => {
  it('submission valid → diproses langsung (sync) + ack eventId', async () => {
    app = await buildApp();
    const res = await app.request('/api/webhooks/tally/ws-1', {
      method: 'POST',
      headers: { 'tally-signature': sign(validBody()) },
      body: validBody(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { received: boolean; eventId: string };
    expect(body.received).toBe(true);
    expect(body.eventId).toBe('ws-1:2wgx4n');
    expect(recordWebhookEventMock).toHaveBeenCalledWith(
      expect.anything(),
      'tally',
      'ws-1:2wgx4n',
      'form_response',
      expect.anything(),
    );
    expect(syncTallyMock).toHaveBeenCalledWith('ws-1', expect.objectContaining({ eventId: 'a4cb511e-d513-4fa5-baee-b815d718dfd1' }));
    expect(markWebhookProcessedMock).toHaveBeenCalledWith(expect.anything(), 'tally', 'ws-1:2wgx4n');
  });

  it('pemrosesan gagal → 500 (Tally retry) + TIDAK ditandai processed', async () => {
    app = await buildApp();
    syncTallyMock.mockRejectedValue(new Error('db down'));
    const res = await app.request('/api/webhooks/tally/ws-1', {
      method: 'POST',
      headers: { 'tally-signature': sign(validBody()) },
      body: validBody(),
    });
    expect(res.status).toBe(500);
    expect(markWebhookProcessedMock).not.toHaveBeenCalled();
  });

  it('duplikat (sudah processed) → ack duplicate tanpa proses ulang', async () => {
    app = await buildApp();
    recordWebhookEventMock.mockResolvedValue('processed');
    const res = await app.request('/api/webhooks/tally/ws-1', {
      method: 'POST',
      headers: { 'tally-signature': sign(validBody()) },
      body: validBody(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ duplicate: true, eventId: 'ws-1:2wgx4n' });
    expect(syncTallyMock).not.toHaveBeenCalled();
  });

  it('payload tanpa submissionId → ack 200 tanpa proses', async () => {
    app = await buildApp();
    const body = JSON.stringify({ eventId: 'evt-ping', eventType: 'FORM_RESPONSE', data: { formId: 'nGM0Py', fields: [] } });
    const res = await app.request('/api/webhooks/tally/ws-1', {
      method: 'POST',
      headers: { 'tally-signature': sign(body) },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, events: 0 });
    expect(syncTallyMock).not.toHaveBeenCalled();
  });
});
