import { beforeAll, describe, expect, it, vi } from 'vitest';

// Mock Inngest client agar test tidak perlu Dev Server / network.
vi.mock('./inngest/client.ts', () => ({
  inngest: {
    send: vi.fn().mockResolvedValue({ ids: ['mock'] }),
    createFunction: () => ({}),
  },
}));

// Mock jose agar requireAuth tidak perlu JWKS remote (network).
const { jwtVerifyMock } = vi.hoisted(() => ({
  jwtVerifyMock: vi.fn(),
}));

vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => vi.fn()),
  jwtVerify: jwtVerifyMock,
}));

const AUTH_HEADER = { Authorization: 'Bearer test-jwt-token' };

beforeAll(() => {
  jwtVerifyMock.mockReset();
  jwtVerifyMock.mockResolvedValue({ payload: { sub: 'test-user-1', email: 'user@example.com' } });
});

import type { Hono } from 'hono';

let app: Hono;

beforeAll(async () => {
  // Env dummy — dibaca env.ts saat modul pertama kali di-import.
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/oriole_test';
  process.env.NEON_AUTH_URL = 'https://ep-test.neon.tech/neondb/auth';
  process.env.PADDLE_API_KEY = 'pdl_sdbx_test';
  process.env.PADDLE_WEBHOOK_SECRET = 'pdl_ntfset_test';
  process.env.RESEND_API_KEY = 're_test';
  process.env.CALLE_API_KEY = 'calle_test';
  process.env.CALLE_WEBHOOK_SECRET = 'test-calle-webhook-secret';

  ({ app } = await import('./index.ts'));
});

describe('Oriole API', () => {
  it('GET /api/health → 200 ok', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', service: 'oriole-api' });
  });

  it('GET /api/me tanpa token → 401', async () => {
    const res = await app.request('/api/me');
    expect(res.status).toBe(401);
  });

  it('POST /api/webhooks/paddle tanpa signature → 400', async () => {
    const res = await app.request('/api/webhooks/paddle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/webhooks/calle body tidak valid → 400 (dengan signature sah)', async () => {
    const { signWebhookBody } = await import('./lib/webhook-signature.ts');
    const body = JSON.stringify({});
    const res = await app.request('/api/webhooks/calle', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-calle-signature': signWebhookBody(body, 'test-calle-webhook-secret'),
      },
      body,
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/triggers/welcome-email tanpa auth → 401', async () => {
    const res = await app.request('/api/triggers/welcome-email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Test User' }),
    });
    expect(res.status).toBe(401);
  });

  it('POST /api/triggers/welcome-email dengan auth → event di-queue ke Inngest', async () => {
    const res = await app.request('/api/triggers/welcome-email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...AUTH_HEADER },
      body: JSON.stringify({ name: 'Test User' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      queued: true,
      event: 'user/signed-up',
      email: 'user@example.com',
    });
  });

  it('POST /api/triggers/welcome-email tanpa email di JWT → 400', async () => {
    jwtVerifyMock.mockResolvedValueOnce({ payload: { sub: 'no-email-user' } });
    const res = await app.request('/api/triggers/welcome-email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...AUTH_HEADER },
      body: JSON.stringify({ name: 'Test User' }),
    });
    expect(res.status).toBe(400);
  });

  /* ── Sesi cookie HttpOnly (hand-off JWT) ────────────────── */

  it('POST /api/auth/session tanpa token → 401', async () => {
    const res = await app.request('/api/auth/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'test-jwt-token' }),
    });
    expect(res.status).toBe(401);
  });

  it('POST /api/auth/session dengan Bearer valid → 200 + cookie HttpOnly', async () => {
    const res = await app.request('/api/auth/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...AUTH_HEADER },
      body: JSON.stringify({ token: 'test-jwt-token' }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('oriole_session=test-jwt-token');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Max-Age=604800');
  });

  it('cookie di-set dari Bearer yang diverifikasi, bukan field body', async () => {
    const res = await app.request('/api/auth/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...AUTH_HEADER },
      body: JSON.stringify({ token: 'evil-different-token' }),
    });
    expect(res.status).toBe(200);
    // Nilai cookie harus Bearer token ('test-jwt-token'), bukan body token.
    expect(res.headers.get('set-cookie') ?? '').toContain('oriole_session=test-jwt-token');
  });

  it('requireAuth menerima cookie sesi sebagai fallback (tanpa Bearer)', async () => {
    const res = await app.request('/api/triggers/welcome-email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: 'oriole_session=test-jwt-token' },
      body: JSON.stringify({ name: 'Test User' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ queued: true, email: 'user@example.com' });
  });

  it('DELETE /api/auth/session → cookie dihapus (Max-Age=0)', async () => {
    const res = await app.request('/api/auth/session', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('oriole_session=');
    expect(setCookie.toLowerCase()).toContain('max-age=0');
  });
});
