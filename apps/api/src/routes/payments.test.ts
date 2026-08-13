import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// ── Mocks ───────────────────────────────────────────────────────

// Mock jose agar requireAuth tidak perlu JWKS remote (network).
const { jwtVerifyMock } = vi.hoisted(() => ({
  jwtVerifyMock: vi.fn(),
}));

vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => vi.fn()),
  jwtVerify: jwtVerifyMock,
}));

// Env — dikontrol per test (PADDLE_API_KEY diubah untuk kasus belum konfigurasi).
const { envState } = vi.hoisted(() => ({
  envState: {
    API_URL: 'http://localhost:3000',
    NEON_AUTH_URL: 'https://ep-test.neon.tech/neondb/auth',
    PADDLE_API_KEY: 'pdl_sdbx_test_apikey_123456',
  } as Record<string, string>,
}));

vi.mock('../lib/env.ts', () => ({ env: envState }));

// Paddle SDK service — semua panggilan network di-stub.
const { transactionsCreateMock, transactionsUpdateMock } = vi.hoisted(() => ({
  transactionsCreateMock: vi.fn(),
  transactionsUpdateMock: vi.fn(),
}));

vi.mock('../services/paddle.ts', () => ({
  paddle: {
    transactions: {
      create: transactionsCreateMock,
      update: transactionsUpdateMock,
    },
  },
}));

// ── Fake Drizzle db ─────────────────────────────────────────────
// Mendukung predikat eq / in / isNull (struktur queryChunks drizzle),
// orderBy no-op, insert/update/delete dengan returning.
const { dbState } = vi.hoisted(() => ({
  dbState: {
    tables: new Map<string, Record<string, unknown>[]>(),
    seq: 1,
  },
}));

vi.mock('../db/index.ts', async () => {
  const { bookings, paymentLinks, services, workspaceIntegrations, workspaces } = await import('@oriole/database');
  const tableNames = new WeakMap<object, string>();
  tableNames.set(workspaces, 'workspaces');
  tableNames.set(bookings, 'bookings');
  tableNames.set(services, 'services');
  tableNames.set(paymentLinks, 'paymentLinks');
  tableNames.set(workspaceIntegrations, 'workspaceIntegrations');

  const NOW = new Date('2026-01-01T00:00:00.000Z');

  function camel(key: string): string {
    return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  }

  function extractValue(node: unknown): unknown {
    if (Array.isArray(node)) {
      return node.map((n) => {
        const v = n as { value?: unknown };
        return v?.value ?? v;
      });
    }
    const v = node as { value?: unknown };
    return v?.value ?? null;
  }

  type Predicate = { column: string; op: 'eq' | 'in' | 'isNull'; value?: unknown };

  function collectPredicates(cond: unknown, out: Predicate[] = []): Predicate[] {
    if (!cond || typeof cond !== 'object') return out;
    const obj = cond as Record<string, unknown>;
    const chunks = obj.queryChunks as unknown[] | undefined;
    if (!Array.isArray(chunks)) return out;
    for (const chunk of chunks) {
      if (!chunk || typeof chunk !== 'object') continue;
      const c = chunk as Record<string, unknown>;
      if (!Array.isArray(c.queryChunks)) continue;
      const inner = c.queryChunks as unknown[];
      if (inner.length < 4) {
        collectPredicates(chunk, out);
        continue;
      }
      const nameNode = inner[1] as { name?: string } | undefined;
      const opNode = inner[2] as { value?: string[] } | undefined;
      const col = nameNode?.name;
      if (!col || !opNode?.value) continue;
      const op = opNode.value.join('');
      if (op.includes('=')) {
        out.push({ column: col, op: 'eq', value: extractValue(inner[3]) });
      } else if (op.includes(' in ')) {
        out.push({ column: col, op: 'in', value: extractValue(inner[3]) });
      } else if (op.includes('is null')) {
        out.push({ column: col, op: 'isNull' });
      }
    }
    return out;
  }

  function matches(row: Record<string, unknown>, predicates: Predicate[]): boolean {
    return predicates.every((p) => {
      const rv = row[camel(p.column)];
      if (p.op === 'isNull') return rv === null || rv === undefined;
      if (p.op === 'in') return Array.isArray(p.value) && p.value.includes(rv);
      return rv === p.value;
    });
  }

  return {
    db: {
      select: () => ({
        from: (table: object) => {
          const name = tableNames.get(table) ?? 'unknown';
          const builder: {
            _cond?: unknown;
            _limit?: number;
            where: (c: unknown) => typeof builder;
            orderBy: (...cols: unknown[]) => typeof builder;
            limit: (n: number) => typeof builder;
            then: (resolve: (rows: unknown[]) => unknown) => Promise<unknown>;
          } = {
            where(c: unknown) {
              builder._cond = c;
              return builder;
            },
            orderBy() {
              return builder;
            },
            limit(n: number) {
              builder._limit = n;
              return builder;
            },
            then(resolve: (rows: unknown[]) => unknown) {
              const predicates = collectPredicates(builder._cond);
              let rows = (dbState.tables.get(name) ?? []).filter((row) =>
                matches(row, predicates),
              );
              if (builder._limit != null) rows = rows.slice(0, builder._limit);
              return Promise.resolve(resolve(rows));
            },
          };
          return builder;
        },
      }),
      insert: (table: object) => ({
        values: (values: Record<string, unknown>) => ({
          returning: async () => {
            const name = tableNames.get(table) ?? 'unknown';
            const rows = dbState.tables.get(name) ?? [];
            const row = {
              ...values,
              id: `pay-${dbState.seq++}`,
              status: 'pending',
              createdAt: NOW,
              updatedAt: NOW,
            };
            rows.push(row);
            return [row];
          },
        }),
      }),
      update: (table: object) => ({
        set: (values: Record<string, unknown>) => ({
          where: (cond: unknown) => ({
            returning: async () => {
              const name = tableNames.get(table) ?? 'unknown';
              const rows = dbState.tables.get(name) ?? [];
              const predicates = collectPredicates(cond);
              const idx = rows.findIndex((row) => matches(row, predicates));
              if (idx < 0) return [];
              const merged = { ...rows[idx], ...values, updatedAt: NOW };
              rows[idx] = merged;
              return [merged];
            },
          }),
        }),
      }),
      delete: (table: object) => ({
        where: (cond: unknown) => {
          // Route memakai `await db.delete().where()` (tanpa .returning()) untuk
          // rollback — hasil where() harus thenable seperti query drizzle asli.
          const exec = async () => {
            const name = tableNames.get(table) ?? 'unknown';
            const rows = dbState.tables.get(name) ?? [];
            const predicates = collectPredicates(cond);
            const idx = rows.findIndex((row) => matches(row, predicates));
            if (idx < 0) return { rowCount: 0 };
            rows.splice(idx, 1);
            return { rowCount: 1 };
          };
          return {
            returning: async () => {
              const result = await exec();
              return result.rowCount ? [{ id: 'deleted' }] : [];
            },
            then(resolve: (value: unknown) => unknown) {
              return exec().then(resolve);
            },
          };
        },
      }),
    },
  };
});

// ── Setup app ───────────────────────────────────────────────────
const AUTH_HEADER = { Authorization: 'Bearer test-jwt-token' };
const WORKSPACE_HEADER = { 'X-Workspace-Id': 'ws-1' };

const BOOKING_ID = '550e8400-e29b-41d4-a716-446655440000';
const OTHER_BOOKING_ID = '11111111-1111-4111-8111-111111111111';
const PAYMENT_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

let app: Hono;

function basePaymentLink(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pay-1',
    workspaceId: 'ws-1',
    bookingId: null,
    title: 'Deposit Konsultasi',
    description: null,
    amountMinor: 25000,
    currency: 'USD',
    status: 'pending',
    paddleTransactionId: null,
    checkoutUrl: null,
    customerName: null,
    customerEmail: null,
    paidAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function paymentsIntegration(overrides: Record<string, unknown> = {}) {
  return {
    id: 'int-1',
    workspaceId: 'ws-1',
    integrationType: 'payments',
    identifier: 'Paddle',
    providerConfig: {},
    isActive: true,
    lastSyncAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

beforeAll(async () => {
  jwtVerifyMock.mockReset();
  jwtVerifyMock.mockResolvedValue({ payload: { sub: 'test-user-1', email: 'user@example.com' } });
  transactionsCreateMock.mockReset();
  transactionsUpdateMock.mockReset();

  const { paymentsRoutes } = await import('./payments.ts');
  app = new Hono().route('/api/payments', paymentsRoutes);
});

beforeEach(() => {
  dbState.tables.set('workspaces', [{ id: 'ws-1', userId: 'test-user-1', deletedAt: null }]);
  dbState.tables.set('services', [
    {
      id: 'svc-gigi',
      name: 'Konsultasi Gigi',
      workspaceId: 'ws-1',
      userId: 'test-user-1',
    },
  ]);
  dbState.tables.set('bookings', [
    { id: BOOKING_ID, workspaceId: 'ws-1', userId: 'test-user-1', serviceId: 'svc-gigi' },
  ]);
  dbState.tables.set('paymentLinks', []);
  dbState.tables.set('workspaceIntegrations', []);
  transactionsCreateMock.mockReset();
  transactionsUpdateMock.mockReset();
  envState.PADDLE_API_KEY = 'pdl_sdbx_test_apikey_123456';
});

// ── GET /api/payments ───────────────────────────────────────────
describe('GET /api/payments', () => {
  it('tanpa auth → 401', async () => {
    const res = await app.request('/api/payments');
    expect(res.status).toBe(401);
  });

  it('tanpa payment link → daftar kosong', async () => {
    const res = await app.request('/api/payments', {
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { payments: unknown[] };
    expect(body.payments).toEqual([]);
  });

  it('link milik workspace lain tidak ikut (filter workspaceId)', async () => {
    dbState.tables.set('paymentLinks', [
      basePaymentLink({ id: 'pay-1', workspaceId: 'ws-1' }),
      basePaymentLink({ id: 'pay-2', workspaceId: 'ws-other' }),
    ]);
    const res = await app.request('/api/payments', {
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { payments: { id: string }[] };
    expect(body.payments.map((p) => p.id)).toEqual(['pay-1']);
  });

  it('filter bookingId → hanya link booking tersebut, dengan bookingTitle', async () => {
    dbState.tables.set('paymentLinks', [
      basePaymentLink({ id: 'pay-1', bookingId: BOOKING_ID }),
      basePaymentLink({ id: 'pay-2', bookingId: null }),
    ]);
    const res = await app.request(`/api/payments?bookingId=${BOOKING_ID}`, {
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { payments: { id: string; bookingId: string | null; bookingTitle: string | null }[] };
    expect(body.payments).toHaveLength(1);
    expect(body.payments[0]).toMatchObject({
      id: 'pay-1',
      bookingId: BOOKING_ID,
      bookingTitle: 'Konsultasi Gigi',
    });
  });
});

// ── POST /api/payments ──────────────────────────────────────────
describe('POST /api/payments', () => {
  const CREATE_BODY = {
    bookingId: BOOKING_ID,
    title: 'Deposit Konsultasi',
    amount: 250,
    currency: 'USD',
    customerEmail: 'budi@example.com',
  };

  it('integrasi belum dihubungkan → 409, tidak ada checkout', async () => {
    const res = await app.request('/api/payments', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify(CREATE_BODY),
    });
    expect(res.status).toBe(409);
    expect(transactionsCreateMock).not.toHaveBeenCalled();
    expect(dbState.tables.get('paymentLinks')).toHaveLength(0);
  });

  it('integrasi dijeda (nonaktif) → 409', async () => {
    dbState.tables.set('workspaceIntegrations', [paymentsIntegration({ isActive: false })]);
    const res = await app.request('/api/payments', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify(CREATE_BODY),
    });
    expect(res.status).toBe(409);
    expect(transactionsCreateMock).not.toHaveBeenCalled();
  });

  it('PADDLE_API_KEY placeholder → 503, tidak ada checkout', async () => {
    dbState.tables.set('workspaceIntegrations', [paymentsIntegration()]);
    envState.PADDLE_API_KEY = 'pdl_sdbx_apikey_...';
    const res = await app.request('/api/payments', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify(CREATE_BODY),
    });
    expect(res.status).toBe(503);
    expect(transactionsCreateMock).not.toHaveBeenCalled();
    expect(dbState.tables.get('paymentLinks')).toHaveLength(0);
  });

  it('body tidak valid → 400 (amount nol / mata uang asing / email buruk / booking bukan UUID)', async () => {
    dbState.tables.set('workspaceIntegrations', [paymentsIntegration()]);

    const zero = await app.request('/api/payments', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...CREATE_BODY, amount: 0 }),
    });
    expect(zero.status).toBe(400);

    // Mata uang di luar daftar Paddle (mis. IDR lokal / kode aneh) ditolak.
    const badCurrency = await app.request('/api/payments', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...CREATE_BODY, currency: 'IDR' }),
    });
    expect(badCurrency.status).toBe(400);

    const badEmail = await app.request('/api/payments', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...CREATE_BODY, customerEmail: 'not-an-email' }),
    });
    expect(badEmail.status).toBe(400);

    const badBooking = await app.request('/api/payments', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...CREATE_BODY, bookingId: 'not-a-uuid' }),
    });
    expect(badBooking.status).toBe(400);

    expect(transactionsCreateMock).not.toHaveBeenCalled();
  });

  it('booking bukan milik workspace → 400', async () => {
    dbState.tables.set('workspaceIntegrations', [paymentsIntegration()]);
    const res = await app.request('/api/payments', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...CREATE_BODY, bookingId: OTHER_BOOKING_ID }),
    });
    expect(res.status).toBe(400);
    expect(transactionsCreateMock).not.toHaveBeenCalled();
  });

  it('sukses → 201, checkout Paddle dipanggil dengan non-catalog price (minor units)', async () => {
    dbState.tables.set('workspaceIntegrations', [paymentsIntegration()]);
    transactionsCreateMock.mockResolvedValue({
      id: 'txn_01abc',
      checkout: { url: 'https://checkout.paddle.com/abc' },
    });

    const res = await app.request('/api/payments', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify(CREATE_BODY),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      payment: { id: string; amountMinor: number; currency: string; status: string; checkoutUrl: string; bookingId: string | null };
    };
    expect(body.payment).toMatchObject({
      id: 'pay-1',
      amountMinor: 25000,
      currency: 'USD',
      status: 'pending',
      checkoutUrl: 'https://checkout.paddle.com/abc',
      bookingId: BOOKING_ID,
    });

    // Non-catalog price: jumlah bebas (bukan priceId catalog) + customData kontrak.
    const createArg = transactionsCreateMock.mock.calls[0][0] as {
      items: { quantity: number; price: { description: string; unitPrice: { amount: string; currencyCode: string }; product: { name: string } } }[];
      customData: { payment_link_id: string; workspace_id: string };
    };
    expect(createArg.items[0]).toMatchObject({
      quantity: 1,
      price: {
        description: 'Deposit Konsultasi',
        unitPrice: { amount: '25000', currencyCode: 'USD' },
        product: { name: 'Deposit Konsultasi' },
      },
    });
    expect(createArg.customData).toEqual({ payment_link_id: 'pay-1', workspace_id: 'ws-1' });

    // Row tersimpan dengan transaksi + URL.
    const rows = dbState.tables.get('paymentLinks') ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      paddleTransactionId: 'txn_01abc',
      checkoutUrl: 'https://checkout.paddle.com/abc',
      amountMinor: 25000,
    });
  });

  it('Paddle menolak (detail error) → 502 + rollback lokal', async () => {
    dbState.tables.set('workspaceIntegrations', [paymentsIntegration()]);
    transactionsCreateMock.mockRejectedValue(
      Object.assign(new Error('Transaction balance is less than charge limit'), {
        detail: 'Transaction balance is less than what we can charge. Minimum is $0.50.',
      }),
    );

    const res = await app.request('/api/payments', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify(CREATE_BODY),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; detail?: string };
    expect(body.detail).toContain('Minimum is $0.50');
    // Link yang gagal checkout di-rollback — tidak ada data menggantung.
    expect(dbState.tables.get('paymentLinks')).toHaveLength(0);
  });

  it('tanpa bookingId → link umum (bookingId null)', async () => {
    dbState.tables.set('workspaceIntegrations', [paymentsIntegration()]);
    transactionsCreateMock.mockResolvedValue({
      id: 'txn_01def',
      checkout: { url: 'https://checkout.paddle.com/def' },
    });
    const res = await app.request('/api/payments', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Donasi', amount: 50 }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { payment: { currency: string; amountMinor: number; bookingId: string | null } };
    // Default mata uang USD + konversi major → minor.
    expect(body.payment).toMatchObject({ currency: 'USD', amountMinor: 5000, bookingId: null });
  });
});

// ── POST /api/payments/:id/cancel ───────────────────────────────
describe('POST /api/payments/:id/cancel', () => {
  it('link bukan milik workspace → 404', async () => {
    dbState.tables.set('paymentLinks', [basePaymentLink({ id: PAYMENT_ID, workspaceId: 'ws-other' })]);
    const res = await app.request(`/api/payments/${PAYMENT_ID}/cancel`, {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(404);
    expect(transactionsUpdateMock).not.toHaveBeenCalled();
  });

  it('link sudah paid → 409 (tidak bisa dibatalkan)', async () => {
    dbState.tables.set('paymentLinks', [
      basePaymentLink({ id: PAYMENT_ID, status: 'paid', paddleTransactionId: 'txn_01' }),
    ]);
    const res = await app.request(`/api/payments/${PAYMENT_ID}/cancel`, {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(409);
    expect(transactionsUpdateMock).not.toHaveBeenCalled();
  });

  it('sukses → batalkan di Paddle dulu (status canceled), lalu lokal', async () => {
    dbState.tables.set('paymentLinks', [
      basePaymentLink({ id: PAYMENT_ID, paddleTransactionId: 'txn_01' }),
    ]);
    transactionsUpdateMock.mockResolvedValue({ id: 'txn_01', status: 'canceled' });

    const res = await app.request(`/api/payments/${PAYMENT_ID}/cancel`, {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(200);
    expect(transactionsUpdateMock).toHaveBeenCalledWith('txn_01', { status: 'canceled' });
    const body = (await res.json()) as { payment: { status: string } };
    expect(body.payment.status).toBe('canceled');
    expect(dbState.tables.get('paymentLinks')?.[0].status).toBe('canceled');
  });

  it('Paddle menolak pembatalan → 502, link TETAP pending (URL masih hidup)', async () => {
    dbState.tables.set('paymentLinks', [
      basePaymentLink({ id: PAYMENT_ID, paddleTransactionId: 'txn_01' }),
    ]);
    transactionsUpdateMock.mockRejectedValue(
      Object.assign(new Error('Transaction cannot be canceled'), { detail: 'already billed' }),
    );

    const res = await app.request(`/api/payments/${PAYMENT_ID}/cancel`, {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { detail?: string };
    expect(body.detail).toBe('already billed');
    expect(dbState.tables.get('paymentLinks')?.[0].status).toBe('pending');
  });

  it('tanpa paddleTransactionId (link lama / dev) → batal lokal langsung', async () => {
    dbState.tables.set('paymentLinks', [basePaymentLink({ id: PAYMENT_ID })]);
    const res = await app.request(`/api/payments/${PAYMENT_ID}/cancel`, {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(200);
    expect(transactionsUpdateMock).not.toHaveBeenCalled();
    expect(((await res.json()) as { payment: { status: string } }).payment.status).toBe('canceled');
  });
});
