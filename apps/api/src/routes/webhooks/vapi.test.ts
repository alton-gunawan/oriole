import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Mock Inngest & idempotency lib agar test tidak menyentuh DB/network.
const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
const { recordWebhookEventMock } = vi.hoisted(() => ({ recordWebhookEventMock: vi.fn() }));
const { dbUpdateMock } = vi.hoisted(() => ({ dbUpdateMock: vi.fn() }));

vi.mock('../../inngest/client.ts', () => ({
  inngest: { send: sendMock },
}));

vi.mock('../../lib/webhooks.ts', () => ({
  recordWebhookEvent: recordWebhookEventMock,
  markWebhookProcessed: vi.fn().mockResolvedValue(undefined),
}));

// db.update(...) dipakai route untuk status-update — catat pemanggilan.
vi.mock('../../db/index.ts', () => ({
  db: {
    update: dbUpdateMock,
  },
}));

// ── Mock lib inbound — fokus webhook: routing, auth, dispatch ──
const {
  resolveInboundWorkspaceIdMock,
  buildInboundAssistantMock,
  handleInboundToolCallMock,
  getInboundAssistantForWorkspaceMock,
  getWorkspaceIdByAssistantIdMock,
} = vi.hoisted(() => ({
  resolveInboundWorkspaceIdMock: vi.fn(),
  buildInboundAssistantMock: vi.fn(),
  handleInboundToolCallMock: vi.fn(),
  getInboundAssistantForWorkspaceMock: vi.fn(),
  getWorkspaceIdByAssistantIdMock: vi.fn(),
}));

vi.mock('../../lib/vapi-inbound.ts', () => ({
  resolveInboundWorkspaceId: resolveInboundWorkspaceIdMock,
  buildInboundAssistantForWorkspace: buildInboundAssistantMock,
  handleInboundToolCall: handleInboundToolCallMock,
  getInboundAssistantForWorkspace: getInboundAssistantForWorkspaceMock,
  getWorkspaceIdByAssistantId: getWorkspaceIdByAssistantIdMock,
}));

const WEBHOOK_SECRET = 'test-vapi-webhook-secret';

let app: Hono;

/**
 * Rebuild app dengan reset module agar `env` (snapshot saat import) membaca
 * nilai VAPI_WEBHOOK_SECRET terbaru di setiap kasus.
 */
async function buildApp(): Promise<Hono> {
  vi.resetModules();
  const { vapiWebhookRoutes } = await import('./vapi.ts');
  return new Hono().route('/api/webhooks/vapi', vapiWebhookRoutes);
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
});

beforeEach(() => {
  sendMock.mockReset();
  recordWebhookEventMock.mockReset();
  recordWebhookEventMock.mockResolvedValue('new');
  dbUpdateMock.mockReset();
  dbUpdateMock.mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  });
  resolveInboundWorkspaceIdMock.mockReset();
  buildInboundAssistantMock.mockReset();
  handleInboundToolCallMock.mockReset();
  getInboundAssistantForWorkspaceMock.mockReset();
  getWorkspaceIdByAssistantIdMock.mockReset();
  resolveInboundWorkspaceIdMock.mockResolvedValue('ws-1');
  getInboundAssistantForWorkspaceMock.mockResolvedValue(null);
  getWorkspaceIdByAssistantIdMock.mockResolvedValue(null);
  buildInboundAssistantMock.mockResolvedValue({
    name: 'oriole-inbound-test',
    model: { provider: 'openai', tools: [] },
    serverMessages: ['tool-calls'],
  });
});

function endOfCallReportBody(): string {
  return JSON.stringify({
    message: {
      type: 'end-of-call-report',
      endedReason: 'customer-ended-call',
      call: {
        id: 'call-1',
        name: 'booking:550e8400-e29b-41d4-a716-446655440000:confirm-attendance:manual',
        status: 'ended',
        startedAt: '2026-08-11T08:00:00.000Z',
        endedAt: '2026-08-11T08:01:30.000Z',
        customer: { number: '+6281234567890' },
      },
      artifact: {
        transcript: 'AI: Hello ... User: Yes',
        recordingUrl: 'https://recording.example.com/1.mp3',
      },
    },
  });
}

function statusUpdateBody(): string {
  return JSON.stringify({
    message: { type: 'status-update', status: 'in-progress', call: { id: 'call-1' } },
  });
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${WEBHOOK_SECRET}` };
}

function assistantRequestBody(): string {
  return JSON.stringify({
    message: {
      type: 'assistant-request',
      phoneNumber: { id: 'phone-inbound-1', number: '+14155550123' },
      call: { id: 'call-inbound-1' },
    },
  });
}

function toolCallsBody(): string {
  return JSON.stringify({
    message: {
      type: 'tool-calls',
      call: { id: 'call-inbound-1', phoneNumberId: 'phone-inbound-1' },
      toolCalls: [
        {
          id: 'tool-call-1',
          type: 'function',
          function: { name: 'check_availability', arguments: '{"date":"2026-08-20"}' },
        },
      ],
    },
  });
}

describe('POST /api/webhooks/vapi — keamanan', () => {
  it('fail-closed: tanpa VAPI_WEBHOOK_SECRET → 503', async () => {
    delete process.env.VAPI_WEBHOOK_SECRET;
    app = await buildApp();

    const res = await app.request('/api/webhooks/vapi', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: endOfCallReportBody(),
    });
    expect(res.status).toBe(503);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('menolak tanpa header Authorization → 401', async () => {
    process.env.VAPI_WEBHOOK_SECRET = WEBHOOK_SECRET;
    app = await buildApp();

    const res = await app.request('/api/webhooks/vapi', {
      method: 'POST',
      body: endOfCallReportBody(),
    });
    expect(res.status).toBe(401);
  });

  it('menolak secret salah → 401', async () => {
    process.env.VAPI_WEBHOOK_SECRET = WEBHOOK_SECRET;
    app = await buildApp();

    const res = await app.request('/api/webhooks/vapi', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-secret' },
      body: endOfCallReportBody(),
    });
    expect(res.status).toBe(401);
  });

  it('menerima X-Vapi-Secret legacy → 200', async () => {
    process.env.VAPI_WEBHOOK_SECRET = WEBHOOK_SECRET;
    app = await buildApp();

    const res = await app.request('/api/webhooks/vapi', {
      method: 'POST',
      headers: { 'x-vapi-secret': WEBHOOK_SECRET },
      body: endOfCallReportBody(),
    });
    expect(res.status).toBe(200);
  });
});

describe('POST /api/webhooks/vapi — assistant-request (inbound)', () => {
  it('nomor terdaftar → mengembalikan asisten transient per-workspace', async () => {
    process.env.VAPI_WEBHOOK_SECRET = WEBHOOK_SECRET;
    app = await buildApp();

    const res = await app.request('/api/webhooks/vapi', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: assistantRequestBody(),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.assistant).toBeDefined();
    expect(body.assistant.name).toContain('oriole-inbound');
    expect(resolveInboundWorkspaceIdMock).toHaveBeenCalledWith('phone-inbound-1');
    expect(buildInboundAssistantMock).toHaveBeenCalledWith('ws-1');
  });

  it('nomor tidak terdaftar → 404 (Vapi menggantung call dengan error)', async () => {
    process.env.VAPI_WEBHOOK_SECRET = WEBHOOK_SECRET;
    app = await buildApp();
    resolveInboundWorkspaceIdMock.mockResolvedValue(null);

    const res = await app.request('/api/webhooks/vapi', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: assistantRequestBody(),
    });
    expect(res.status).toBe(404);
    expect(buildInboundAssistantMock).not.toHaveBeenCalled();
  });

  it('asisten permanen tersimpan → mengembalikan assistantId (jalur hibrida)', async () => {
    process.env.VAPI_WEBHOOK_SECRET = WEBHOOK_SECRET;
    app = await buildApp();
    getInboundAssistantForWorkspaceMock.mockResolvedValue({
      assistantId: 'vapi-assistant-1',
      name: 'oriole-receptionist-salon-cantik',
    });

    const res = await app.request('/api/webhooks/vapi', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: assistantRequestBody(),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.assistantId).toBe('vapi-assistant-1');
    expect(body.assistant).toBeUndefined();
    // Tanpa membangun asisten transient — Vapi memakai asisten tersimpan.
    expect(buildInboundAssistantMock).not.toHaveBeenCalled();
  });

  it('gagal baca asisten tersimpan → fallback transient (call tetap jalan)', async () => {
    process.env.VAPI_WEBHOOK_SECRET = WEBHOOK_SECRET;
    app = await buildApp();
    getInboundAssistantForWorkspaceMock.mockRejectedValue(new Error('db down'));

    const res = await app.request('/api/webhooks/vapi', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: assistantRequestBody(),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.assistant).toBeDefined();
    expect(buildInboundAssistantMock).toHaveBeenCalledWith('ws-1');
  });

  it('tanpa phoneNumber.id → 400', async () => {
    process.env.VAPI_WEBHOOK_SECRET = WEBHOOK_SECRET;
    app = await buildApp();

    const res = await app.request('/api/webhooks/vapi', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ message: { type: 'assistant-request', call: { id: 'call-1' } } }),
    });
    expect(res.status).toBe(400);
    expect(resolveInboundWorkspaceIdMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/webhooks/vapi — tool-calls (inbound)', () => {
  it('dispatch tool call → results dengan JSON string untuk agen', async () => {
    process.env.VAPI_WEBHOOK_SECRET = WEBHOOK_SECRET;
    app = await buildApp();
    handleInboundToolCallMock.mockResolvedValue({
      ok: true,
      result: { slots: [{ time: '10:00' }], timezone: 'UTC' },
    });

    const res = await app.request('/api/webhooks/vapi', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: toolCallsBody(),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({
      toolCallId: 'tool-call-1',
      name: 'check_availability',
    });
    expect(JSON.parse(body.results[0].result)).toMatchObject({ timezone: 'UTC' });
    expect(handleInboundToolCallMock).toHaveBeenCalledWith(
      'ws-1',
      { callId: 'call-inbound-1', toolCallId: 'tool-call-1' },
      { name: 'check_availability', arguments: '{"date":"2026-08-20"}' },
    );
  });

  it('tool gagal → error dikembalikan (agen menjelaskan ke customer)', async () => {
    process.env.VAPI_WEBHOOK_SECRET = WEBHOOK_SECRET;
    app = await buildApp();
    handleInboundToolCallMock.mockResolvedValue({ ok: false, error: 'Slot sudah terisi.' });

    const res = await app.request('/api/webhooks/vapi', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: toolCallsBody(),
    });
    const body = await res.json();
    expect(body.results[0].error).toBe('Slot sudah terisi.');
    expect(body.results[0].result).toBeUndefined();
  });

  it('nomor tidak terdaftar → 404 tanpa dispatch', async () => {
    process.env.VAPI_WEBHOOK_SECRET = WEBHOOK_SECRET;
    app = await buildApp();
    resolveInboundWorkspaceIdMock.mockResolvedValue(null);

    const res = await app.request('/api/webhooks/vapi', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: toolCallsBody(),
    });
    expect(res.status).toBe(404);
    expect(handleInboundToolCallMock).not.toHaveBeenCalled();
  });

  it('tool-calls tanpa phoneNumberId tapi ada assistantId (Playground) → resolve via assistantId', async () => {
    process.env.VAPI_WEBHOOK_SECRET = WEBHOOK_SECRET;
    app = await buildApp();
    getWorkspaceIdByAssistantIdMock.mockResolvedValue('ws-1');
    handleInboundToolCallMock.mockResolvedValue({ ok: true, result: { bookingId: 'b-1' } });

    const res = await app.request('/api/webhooks/vapi', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        message: {
          type: 'tool-calls',
          call: { id: 'call-inbound-1', assistantId: 'vapi-assistant-1' },
          toolCalls: [
            {
              id: 'tool-call-1',
              type: 'function',
              function: { name: 'create_booking', arguments: '{}' },
            },
          ],
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(getWorkspaceIdByAssistantIdMock).toHaveBeenCalledWith('vapi-assistant-1');
    expect(handleInboundToolCallMock).toHaveBeenCalledWith(
      'ws-1',
      { callId: 'call-inbound-1', toolCallId: 'tool-call-1' },
      { name: 'create_booking', arguments: '{}' },
    );
  });
});

describe('POST /api/webhooks/vapi — status-update', () => {
  it('status live di-update di DB (idempotent, tanpa Inngest)', async () => {
    process.env.VAPI_WEBHOOK_SECRET = WEBHOOK_SECRET;
    app = await buildApp();

    const res = await app.request('/api/webhooks/vapi', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: statusUpdateBody(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, event: 'status-update', status: 'in-progress' });
    expect(dbUpdateMock).toHaveBeenCalledTimes(1);
    expect(sendMock).not.toHaveBeenCalled();
    expect(recordWebhookEventMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/webhooks/vapi — end-of-call-report', () => {
  it('secret benar → 200 dan meng-queue Inngest (vapi/event.received)', async () => {
    process.env.VAPI_WEBHOOK_SECRET = WEBHOOK_SECRET;
    app = await buildApp();

    const res = await app.request('/api/webhooks/vapi', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: endOfCallReportBody(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, eventId: 'call-1:eocr' });
    expect(recordWebhookEventMock).toHaveBeenCalledWith(
      expect.anything(),
      'vapi',
      'call-1:eocr',
      'end-of-call-report',
      expect.any(Object),
    );
    expect(sendMock).toHaveBeenCalledTimes(1);
    // Event Inngest membawa `id` = eventId untuk dedup pengiriman ulang
    // (markWebhookProcessed gagal setelah send sukses → Vapi kirim ulang
    // webhook → Inngest tidak memicu fungsi dua kali).
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'call-1:eocr', name: 'vapi/event.received' }),
    );
  });

  it('duplikat yang belum selesai diproses (pending) → di-queue ulang, bukan dibuang', async () => {
    process.env.VAPI_WEBHOOK_SECRET = WEBHOOK_SECRET;
    app = await buildApp();
    // Attempt sebelumnya crash di tengah (record ada, processedAt null) →
    // proses ulang agar outcome tidak lenyap.
    recordWebhookEventMock.mockResolvedValue('pending');

    const res = await app.request('/api/webhooks/vapi', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: endOfCallReportBody(),
    });
    expect(res.status).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'call-1:eocr' }));
  });

  it('secret benar tapi payload tidak valid → 400', async () => {
    process.env.VAPI_WEBHOOK_SECRET = WEBHOOK_SECRET;
    app = await buildApp();

    const res = await app.request('/api/webhooks/vapi', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ message: { type: 'end-of-call-report' } }), // tanpa call.id
    });
    expect(res.status).toBe(400);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('body bukan JSON → 400', async () => {
    process.env.VAPI_WEBHOOK_SECRET = WEBHOOK_SECRET;
    app = await buildApp();

    const res = await app.request('/api/webhooks/vapi', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: 'not-json{',
    });
    expect(res.status).toBe(400);
  });

  it('event duplikat yang sudah diproses → 200 duplicate, tidak meng-queue lagi', async () => {
    process.env.VAPI_WEBHOOK_SECRET = WEBHOOK_SECRET;
    app = await buildApp();
    recordWebhookEventMock.mockResolvedValue('processed');

    const res = await app.request('/api/webhooks/vapi', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: endOfCallReportBody(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ duplicate: true });
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/webhooks/vapi — event lain', () => {
  it('event informatif (transcript/hang) → ack 200 tanpa side effect', async () => {
    process.env.VAPI_WEBHOOK_SECRET = WEBHOOK_SECRET;
    app = await buildApp();

    const res = await app.request('/api/webhooks/vapi', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        message: { type: 'transcript', transcript: 'partial', call: { id: 'call-1' } },
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, event: 'transcript', callId: 'call-1' });
    expect(sendMock).not.toHaveBeenCalled();
    expect(recordWebhookEventMock).not.toHaveBeenCalled();
  });
});
