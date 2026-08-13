import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────

const { envState } = vi.hoisted(() => ({
  envState: {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/oriole_test',
    NEON_AUTH_URL: 'https://ep-test.neon.tech/neondb/auth',
    PADDLE_API_KEY: 'pdl_sdbx_test',
    PADDLE_WEBHOOK_SECRET: 'pdl_ntfset_test',
    RESEND_API_KEY: 're_test',
    VAPI_API_KEY: 'vapi_test',
    VAPI_PHONE_NUMBER_ID: 'phone-number-test',
    WHATSAPP_API_KEY: 'wa_test',
    WHATSAPP_WEBHOOK_SECRET: 'wa_secret',
    INNGEST_EVENT_KEY: '',
    NODE_ENV: 'test',
    TELEGRAM_BOT_TOKEN: '123456:ABC',
  } as Record<string, string>,
}));

vi.mock('../lib/env.ts', () => ({ env: envState }));

const { createFunctionMock, sendMock } = vi.hoisted(() => ({
  createFunctionMock: vi.fn((opts: unknown, handler: unknown) => ({ opts, handler })),
  sendMock: vi.fn(),
}));

vi.mock('./client.ts', () => ({
  inngest: {
    createFunction: createFunctionMock,
    send: sendMock,
  },
  inngestEventBaseUrl: () => 'http://localhost:8288/',
  inngestMode: () => 'dev',
}));

// `.env` root (milik environment) menimpa env proses — no-op agar test bisa
// mengontrol env (env.ts memanggil loadRootEnv saat import).
vi.mock('@oriole/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@oriole/config')>();
  return { ...actual, loadRootEnv: vi.fn() };
});

// Channel dispatchers & helper libs — fokus test hanya pada sync payment link.
vi.mock('../lib/telegram-handler.ts', () => ({
  handleTelegramUpdate: vi.fn(),
  dispatchTelegramReminder: vi.fn(),
  TelegramDispatchError: class extends Error {},
}));
vi.mock('../lib/whatsapp-handler.ts', () => ({
  handleWhatsAppUpdate: vi.fn(),
  dispatchWhatsAppReminder: vi.fn(),
  WhatsAppDispatchError: class extends Error {},
}));
vi.mock('../lib/email-reminder.ts', () => ({
  dispatchEmailReminder: vi.fn(),
  EmailDispatchError: class extends Error {},
}));

// ── Fake Drizzle db (paymentLinks: select + update) ─────────────
const { dbState } = vi.hoisted(() => ({
  dbState: {} as Record<string, Record<string, unknown>[]>,
}));

vi.mock('../db/index.ts', async () => {
  const { paymentLinks, subscriptions } = await import('@oriole/database');
  const tableNames = new WeakMap<object, string>();
  tableNames.set(paymentLinks, 'paymentLinks');
  tableNames.set(subscriptions, 'subscriptions');

  function camel(key: string): string {
    return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  }

  function extractValue(node: unknown): unknown {
    if (Array.isArray(node)) {
      return node.map((n) => (n as { value?: unknown })?.value ?? n);
    }
    return (node as { value?: unknown })?.value ?? null;
  }

  type Predicate = { column: string; op: 'eq'; value?: unknown };

  function collectPredicates(cond: unknown, out: Predicate[] = []): Predicate[] {
    if (!cond || typeof cond !== 'object') return out;
    const chunks = (cond as { queryChunks?: unknown[] }).queryChunks;
    if (!Array.isArray(chunks)) return out;
    for (const chunk of chunks) {
      if (!chunk || typeof chunk !== 'object') continue;
      const inner = (chunk as { queryChunks?: unknown[] }).queryChunks;
      if (!Array.isArray(inner) || inner.length < 4) {
        collectPredicates(chunk, out);
        continue;
      }
      const col = (inner[1] as { name?: string } | undefined)?.name;
      const op = ((inner[2] as { value?: string[] } | undefined)?.value ?? []).join('');
      if (col && op.includes('=')) {
        out.push({ column: col, op: 'eq', value: extractValue(inner[3]) });
      }
    }
    return out;
  }

  function matches(row: Record<string, unknown>, predicates: Predicate[]): boolean {
    return predicates.every((p) => row[camel(p.column)] === p.value);
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
            limit: (n: number) => typeof builder;
            then: (resolve: (rows: unknown[]) => unknown) => Promise<unknown>;
          } = {
            where(c: unknown) {
              builder._cond = c;
              return builder;
            },
            limit(n: number) {
              builder._limit = n;
              return builder;
            },
            then(resolve: (rows: unknown[]) => unknown) {
              const predicates = collectPredicates(builder._cond);
              let rows = (dbState[name] ?? []).filter((row) => matches(row, predicates));
              if (builder._limit != null) rows = rows.slice(0, builder._limit);
              return Promise.resolve(resolve(rows));
            },
          };
          return builder;
        },
      }),
      update: (table: object) => ({
        set: (values: Record<string, unknown>) => ({
          where: (cond: unknown) => ({
            then(resolve: (value: unknown) => unknown) {
              const name = tableNames.get(table) ?? 'unknown';
              const rows = dbState[name] ?? [];
              const predicates = collectPredicates(cond);
              const idx = rows.findIndex((row) => matches(row, predicates));
              if (idx >= 0) rows[idx] = { ...rows[idx], ...values };
              return Promise.resolve(resolve(undefined));
            },
          }),
        }),
      }),
      insert: (table: object) => ({
        values: (values: Record<string, unknown>) => ({
          // sync-subscription memakai onConflictDoUpdate (target paddle id).
          onConflictDoUpdate: () => ({
            returning: async () => {
              const name = tableNames.get(table) ?? 'unknown';
              const rows = dbState[name] ?? [];
              const row = { ...values, id: `sub-${rows.length + 1}` };
              rows.push(row);
              return [row];
            },
          }),
        }),
      }),
    },
  };
});

// ── Import fungsi setelah mock siap ─────────────────────────────
import { onPaddleEvent } from './functions.ts';

type PaddleHandler = (args: {
  event: { name: string; data: Record<string, unknown> };
  step: { run: (name: string, fn: () => unknown) => Promise<unknown> };
}) => Promise<unknown>;

const handler = (onPaddleEvent as unknown as { handler: PaddleHandler }).handler;

// ── Fixtures ────────────────────────────────────────────────────
const WORKSPACE_ID = 'ws-1';
const PAYMENT_LINK_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const TRANSACTION_ID = 'txn_01h2g4abc';

function makeStep() {
  const calls: { name: string }[] = [];
  const step = {
    run: vi.fn(async (name: string, fn: () => unknown) => {
      calls.push({ name });
      return fn();
    }),
    _calls: calls,
  };
  return step;
}

function paddleEvent(overrides: Record<string, unknown> = {}) {
  return {
    name: 'paddle/event.received',
    data: {
      eventId: 'evt_001',
      eventType: 'transaction.completed',
      payload: {
        id: TRANSACTION_ID,
        status: 'completed',
        billed_at: '2026-01-05T08:00:00Z',
        custom_data: { payment_link_id: PAYMENT_LINK_ID, workspace_id: WORKSPACE_ID },
        customer: { email: 'budi@example.com', name: 'Budi' },
      },
      ...overrides,
    },
  };
}

function pendingLink(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_LINK_ID,
    workspaceId: WORKSPACE_ID,
    bookingId: null,
    title: 'Deposit Konsultasi',
    amountMinor: 25000,
    currency: 'USD',
    status: 'pending',
    paddleTransactionId: null,
    checkoutUrl: 'https://checkout.paddle.com/abc',
    customerName: null,
    customerEmail: null,
    paidAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  dbState.paymentLinks = [];
  sendMock.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('onPaddleEvent — sync payment link (transaction.*)', () => {
  it('transaction.completed → link pending jadi paid + txn id + email customer', async () => {
    dbState.paymentLinks = [pendingLink()];
    const step = makeStep();

    await handler({ event: paddleEvent(), step: step as never });

    expect(step._calls.map((c) => c.name)).toContain('sync-payment-link');
    expect(dbState.paymentLinks[0]).toMatchObject({
      status: 'paid',
      paddleTransactionId: TRANSACTION_ID,
      customerEmail: 'budi@example.com',
      customerName: 'Budi',
    });
    expect((dbState.paymentLinks[0].paidAt as Date).toISOString()).toBe('2026-01-05T08:00:00.000Z');
  });

  it('event duplikat / link sudah paid → tidak mengubah status (idempotent)', async () => {
    dbState.paymentLinks = [
      pendingLink({
        status: 'paid',
        paddleTransactionId: 'txn_lama',
        paidAt: new Date('2026-01-03T00:00:00.000Z'),
      }),
    ];
    const step = makeStep();

    await handler({ event: paddleEvent(), step: step as never });

    // Tetap paid dengan data transaksi lama — transaksi baru tidak menimpa.
    expect(dbState.paymentLinks[0]).toMatchObject({
      status: 'paid',
      paddleTransactionId: 'txn_lama',
    });
  });

  it('workspace_id di custom_data tidak cocok → skip (jangan sentuh link orang lain)', async () => {
    dbState.paymentLinks = [pendingLink()];
    const step = makeStep();

    await handler({
      event: paddleEvent({ payload: { id: TRANSACTION_ID, custom_data: { payment_link_id: PAYMENT_LINK_ID, workspace_id: 'ws-other' } } }),
      step: step as never,
    });

    expect(dbState.paymentLinks[0].status).toBe('pending');
  });

  it('transaction.canceled → link pending jadi canceled', async () => {
    dbState.paymentLinks = [pendingLink()];
    const step = makeStep();

    await handler({
      event: paddleEvent({
        eventType: 'transaction.canceled',
        payload: { id: TRANSACTION_ID, status: 'canceled', custom_data: { payment_link_id: PAYMENT_LINK_ID, workspace_id: WORKSPACE_ID } },
      }),
      step: step as never,
    });

    expect(dbState.paymentLinks[0].status).toBe('canceled');
  });

  it('transaction.completed untuk link yang sudah canceled → tidak dibuka lagi', async () => {
    dbState.paymentLinks = [pendingLink({ status: 'canceled' })];
    const step = makeStep();

    await handler({ event: paddleEvent(), step: step as never });

    expect(dbState.paymentLinks[0].status).toBe('canceled');
  });

  it('event tanpa payment_link_id (subscription) → sync-payment-link no-op, subscriptions tidak disentuh', async () => {
    dbState.paymentLinks = [pendingLink()];
    const step = makeStep();

    await handler({
      event: paddleEvent({
        eventType: 'subscription.updated',
        payload: { id: 'sub_01', status: 'active', custom_data: { user_id: 'user-1' } },
      }),
      step: step as never,
    });

    // Link tidak berubah (bukan transaksi payment link).
    expect(dbState.paymentLinks[0].status).toBe('pending');
    // Step sync-payment-link tetap jalan (guard di dalam), tanpa error.
    expect(step._calls.map((c) => c.name)).toContain('sync-payment-link');
  });

  it('payment link tidak ditemukan di DB → warn + skip tanpa crash', async () => {
    const step = makeStep();

    await handler({ event: paddleEvent(), step: step as never });

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('payment link tidak ditemukan'),
    );
  });
});
