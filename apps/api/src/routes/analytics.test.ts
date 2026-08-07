import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Mock jose agar requireAuth tidak perlu JWKS remote (network).
const { jwtVerifyMock } = vi.hoisted(() => ({
  jwtVerifyMock: vi.fn(),
}));

vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => vi.fn()),
  jwtVerify: jwtVerifyMock,
}));

// ── Fake Drizzle db ──────────────────────────────────────────────
// Implementasi minimal chain query yang dipakai route analytics
// (select → from → innerJoin → where; hasil per tabel dari dbState).
const { dbState } = vi.hoisted(() => ({
  dbState: {
    tables: new Map<string, unknown[]>(),
  },
}));

vi.mock('../db/index.ts', async () => {
  const { bookings, calleCalls, conversations, messages, workspaces } =
    await import('@oriole/database');
  const tableNames = new WeakMap<object, string>();
  tableNames.set(bookings, 'bookings');
  tableNames.set(calleCalls, 'calleCalls');
  tableNames.set(conversations, 'conversations');
  tableNames.set(messages, 'messages');
  tableNames.set(workspaces, 'workspaces');

  function makeSelectBuilder(name: string) {
    const builder = {
      where() {
        return builder;
      },
      innerJoin() {
        return builder;
      },
      then(resolve: (rows: unknown[]) => unknown) {
        return Promise.resolve(resolve([...(dbState.tables.get(name) ?? [])]));
      },
    };
    return builder;
  }

  return {
    db: {
      select: () => ({
        from: (table: object) => makeSelectBuilder(tableNames.get(table) ?? 'unknown'),
      }),
    },
  };
});

const AUTH_HEADER = { Authorization: 'Bearer test-jwt-token' };
const WORKSPACE_HEADER = { 'X-Workspace-Id': 'ws-1' };

// Bulan berjalan aktual (route memakai `new Date()` sendiri) — data test
// dibuat relatif terhadap sekarang agar selalu deterministik.
function monthKeyOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function thisMonth(day: number, hour = 0): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), day, hour);
}

function monthsAgo(months: number, day = 5): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() - months, day);
}

let app: Hono;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/oriole_test';
  process.env.NEON_AUTH_URL = 'https://ep-test.neon.tech/neondb/auth';
  process.env.PADDLE_API_KEY = 'pdl_sdbx_test';
  process.env.PADDLE_WEBHOOK_SECRET = 'pdl_ntfset_test';
  process.env.RESEND_API_KEY = 're_test';
  process.env.CALLE_API_KEY = 'calle_test';

  jwtVerifyMock.mockReset();
  jwtVerifyMock.mockResolvedValue({ payload: { sub: 'test-user-1', email: 'user@example.com' } });

  const { analyticsRoutes } = await import('./analytics.ts');
  app = new Hono().route('/api/analytics', analyticsRoutes);

  dbState.tables.set('workspaces', [{ id: 'ws-1', userId: 'test-user-1' }]);
  dbState.tables.set('bookings', []);
  dbState.tables.set('calleCalls', []);
  dbState.tables.set('messages', []);
  dbState.tables.set('conversations', []);
});

describe('GET /api/analytics/overview', () => {
  it('tanpa token → 401', async () => {
    const res = await app.request('/api/analytics/overview');
    expect(res.status).toBe(401);
  });

  it('dengan token tanpa header workspace → 400', async () => {
    const res = await app.request('/api/analytics/overview', { headers: AUTH_HEADER });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Workspace wajib dipilih' });
  });

  it('workspace bukan milik user → 404', async () => {
    dbState.tables.set('workspaces', []);
    const res = await app.request('/api/analytics/overview', {
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(404);
    dbState.tables.set('workspaces', [{ id: 'ws-1', userId: 'test-user-1' }]);
  });

  it('workspace kosong → summary nol + 12 bulan terisi 0', async () => {
    dbState.tables.set('bookings', []);
    dbState.tables.set('calleCalls', []);
    dbState.tables.set('messages', []);
    dbState.tables.set('conversations', []);
    const res = await app.request('/api/analytics/overview', {
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary).toEqual({
      bookingsTotal: 0,
      bookingsThisMonth: 0,
      callsTotal: 0,
      callsThisMonth: 0,
      messagesTotal: 0,
      contactsTotal: 0,
      needsAttention: 0,
    });
    expect(body.bookingsByMonth).toHaveLength(12);
    expect(body.bookingStatus).toEqual([]);
    expect(body.callOutcomes).toEqual([]);
    expect(body.messagesByChannel).toEqual([]);
    expect(body.funnel).toEqual([
      { step: 'created', count: 0 },
      { step: 'confirmed', count: 0 },
      { step: 'completed', count: 0 },
    ]);
  });

  it('mengagregasi data per workspace', async () => {
    dbState.tables.set('bookings', [
      { status: 'confirmed', createdAt: thisMonth(2) },
      { status: 'completed', createdAt: thisMonth(10) },
      { status: 'cancelled', createdAt: monthsAgo(2) },
      { status: 'pending', createdAt: monthsAgo(6) },
    ]);
    dbState.tables.set('calleCalls', [
      { status: 'completed', createdAt: thisMonth(1) },
      { status: 'failed', createdAt: monthsAgo(1) },
    ]);
    dbState.tables.set('messages', [
      { channel: 'telegram', direction: 'inbound' },
      { channel: 'telegram', direction: 'outbound' },
      { channel: 'telegram', direction: 'inbound' },
      { channel: 'whatsapp', direction: 'outbound' },
    ]);
    dbState.tables.set('conversations', [
      { state: { needsAttention: true } },
      { state: null },
    ]);

    const res = await app.request('/api/analytics/overview', {
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.summary).toMatchObject({
      bookingsTotal: 4,
      bookingsThisMonth: 2,
      callsTotal: 2,
      callsThisMonth: 1,
      messagesTotal: 4,
      needsAttention: 1,
    });

    // Bulan berjalan berisi 2 booking; bulan lain tersisa.
    const current = monthKeyOf(new Date());
    const currentMonth = body.bookingsByMonth.find(
      (row: { month: string }) => row.month === current,
    );
    expect(currentMonth?.count).toBe(2);
    expect(body.bookingsByMonth).toHaveLength(12);

    expect(body.bookingStatus).toEqual(
      expect.arrayContaining([
        { status: 'confirmed', count: 1 },
        { status: 'completed', count: 1 },
        { status: 'cancelled', count: 1 },
        { status: 'pending', count: 1 },
      ]),
    );

    expect(body.callOutcomes).toEqual(
      expect.arrayContaining([
        { status: 'completed', count: 1 },
        { status: 'failed', count: 1 },
      ]),
    );

    expect(body.messagesByChannel).toEqual(
      expect.arrayContaining([
        { channel: 'telegram', inbound: 2, outbound: 1 },
        { channel: 'whatsapp', inbound: 0, outbound: 1 },
      ]),
    );

    // Funnel: 4 dibuat → 2 sampai konfirmasi (confirmed+completed) → 1 selesai.
    expect(body.funnel).toEqual([
      { step: 'created', count: 4 },
      { step: 'confirmed', count: 2 },
      { step: 'completed', count: 1 },
    ]);
  });
});
