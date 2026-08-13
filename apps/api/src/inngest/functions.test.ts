import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────

// Env — objek yang direferensikan modul-modul yang di-import functions.ts
// (services/email.ts membaca RESEND_API_KEY saat module load).
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

// Inngest client — createFunction meng-capture handler agar test bisa
// memanggil fungsi secara langsung dengan stub `step`.
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

// Reminder channel dispatchers — fokus test pada rantai penjadwalan
// (event → guard → dispatch Telegram), channel lain di-stub.
const { dispatchTelegramMock, TelegramDispatchErrorMock } = vi.hoisted(() => ({
  dispatchTelegramMock: vi.fn(),
  TelegramDispatchErrorMock: class extends Error {},
}));
const { dispatchWhatsAppMock, WhatsAppDispatchErrorMock } = vi.hoisted(() => ({
  dispatchWhatsAppMock: vi.fn(),
  WhatsAppDispatchErrorMock: class extends Error {},
}));
const { dispatchEmailMock, EmailDispatchErrorMock } = vi.hoisted(() => ({
  dispatchEmailMock: vi.fn(),
  EmailDispatchErrorMock: class extends Error {},
}));

vi.mock('../lib/telegram-handler.ts', () => ({
  handleTelegramUpdate: vi.fn(),
  dispatchTelegramReminder: dispatchTelegramMock,
  TelegramDispatchError: TelegramDispatchErrorMock,
}));

vi.mock('../lib/whatsapp-handler.ts', () => ({
  handleWhatsAppUpdate: vi.fn(),
  dispatchWhatsAppReminder: dispatchWhatsAppMock,
  WhatsAppDispatchError: WhatsAppDispatchErrorMock,
}));

vi.mock('../lib/email-reminder.ts', () => ({
  dispatchEmailReminder: dispatchEmailMock,
  EmailDispatchError: EmailDispatchErrorMock,
}));

// `.env` root (milik environment) menimpa env proses — no-op agar test bisa
// mengontrol env (env.ts memanggil loadRootEnv saat import).
vi.mock('@oriole/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@oriole/config')>();
  return { ...actual, loadRootEnv: vi.fn() };
});

// ── Fake Drizzle db (bookings + workspaces) ─────────────────────
const { dbState } = vi.hoisted(() => ({
  dbState: {} as Record<string, Record<string, unknown>[]>,
}));

vi.mock('../db/index.ts', async () => {
  const { bookings, workspaces } = await import('@oriole/database');
  const tableNames = new WeakMap<object, string>();
  tableNames.set(bookings, 'bookings');
  tableNames.set(workspaces, 'workspaces');

  function camel(key: string): string {
    return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  }

  function extractPredicates(cond: unknown): { column: string; op: string; value?: unknown }[] {
    const out: { column: string; op: string; value?: unknown }[] = [];
    if (!cond || typeof cond !== 'object') return out;
    const root = cond as Record<string, unknown>;
    const chunksArr = root.queryChunks as unknown[] | undefined;
    const isAnd =
      Array.isArray(chunksArr) && (chunksArr[0] as { value?: string[] } | undefined)?.value?.[0] === '(';
    const inner = isAnd
      ? ((chunksArr?.[1] as { queryChunks?: unknown[] } | undefined)?.queryChunks ?? null)
      : null;
    const chunks = inner ?? [root];
    const bins = chunks.filter((_, i) => i % 2 === 0) as { queryChunks: unknown[] }[];
    for (const bin of bins) {
      const c = bin.queryChunks ?? [];
      const opStr = (c[2] as { value?: string[] } | undefined)?.value?.join('') ?? '';
      const col = (() => {
        const stack: unknown[] = [c[1]];
        while (stack.length) {
          const cur = stack.pop();
          if (!cur || typeof cur !== 'object') continue;
          const obj = cur as Record<string, unknown>;
          if (typeof obj.name === 'string' && obj.config && typeof obj.config === 'object') {
            return obj.name;
          }
          for (const v of Object.values(obj)) {
            if (v && typeof v === 'object') stack.push(v);
          }
        }
        return null;
      })();
      if (!col) continue;
      if (opStr.includes(' = ')) {
        out.push({ column: col, op: 'eq', value: (c[3] as { value?: unknown })?.value });
      } else if (opStr.includes(' is null')) {
        out.push({ column: col, op: 'isNull' });
      }
    }
    return out;
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
              const preds = extractPredicates(builder._cond);
              let rows = (dbState[name] ?? []).filter((row) =>
                preds.every((p) => {
                  const rv = row[camel(p.column)];
                  if (p.op === 'isNull') return rv === null || rv === undefined;
                  return rv === p.value;
                }),
              );
              if (builder._limit != null) rows = rows.slice(0, builder._limit);
              return Promise.resolve(resolve(rows));
            },
          };
          return builder;
        },
      }),
    },
  };
});

// ── Import functions setelah mock siap ──────────────────────────
import { remindBooking } from './functions.ts';

type RemindHandler = (args: {
  event: { name: string; data: Record<string, unknown> };
  step: {
    sleepUntil: (name: string, date: Date) => Promise<unknown>;
    run: (name: string, fn: () => unknown) => Promise<unknown>;
  };
}) => Promise<unknown>;

const handler = (remindBooking as unknown as { handler: RemindHandler }).handler;

// ── Fixtures ────────────────────────────────────────────────────

const WORKSPACE_ID = 'ws-1';
const BOOKING_ID = '550e8400-e29b-41d4-a716-446655440000';
const SCHEDULED_AT = '2026-08-15T07:00:00.000Z';
const REMINDER_AT = '2026-08-15T05:00:00.000Z';

function booking(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    workspaceId: WORKSPACE_ID,
    userId: 'user-1',
    title: 'Scaling Gigi',
    customerName: 'Budi',
    phone: '081234567890',
    status: 'pending',
    timezone: 'Asia/Jakarta',
    scheduledAt: new Date(SCHEDULED_AT),
    ...overrides,
  };
}

function workspace(overrides: Record<string, unknown> = {}) {
  return { id: WORKSPACE_ID, name: 'Klinik Gigi Sehat', deletedAt: null, ...overrides };
}

function makeStep() {
  const calls: { name: string }[] = [];
  const step = {
    sleepUntil: vi.fn().mockResolvedValue(undefined),
    run: vi.fn(async (name: string, fn: () => unknown) => {
      calls.push({ name });
      return fn();
    }),
    _calls: calls,
  };
  return step;
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    name: 'booking/created',
    data: {
      bookingId: BOOKING_ID,
      workspaceId: WORKSPACE_ID,
      scheduledAt: SCHEDULED_AT,
      reminderAt: REMINDER_AT,
      ...overrides,
    },
  };
}

beforeEach(() => {
  dbState.bookings = [];
  dbState.workspaces = [];
  dispatchTelegramMock.mockReset();
  dispatchTelegramMock.mockResolvedValue({ messageId: 777 });
  dispatchWhatsAppMock.mockReset();
  dispatchWhatsAppMock.mockResolvedValue({ messageId: 'wamid-1' });
  dispatchEmailMock.mockReset();
  dispatchEmailMock.mockResolvedValue(undefined);
  sendMock.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('remindBooking — rantai penjadwalan reminder', () => {
  it('event valid + booking pending + workspace aktif → dispatch ke Telegram dengan argumen benar', async () => {
    dbState.bookings = [booking()];
    dbState.workspaces = [workspace()];
    const step = makeStep();

    const result = await handler({ event: event(), step: step as never });

    expect(result).toEqual({ sent: true, bookingId: BOOKING_ID });
    expect(step.sleepUntil).toHaveBeenCalledWith('wait-for-reminder', new Date(REMINDER_AT));

    // Argumen ke dispatchTelegramReminder: workspaceId, booking (scheduledAt
    // diubah kembali ke Date dari string serialisasi Inngest), businessName.
    expect(dispatchTelegramMock).toHaveBeenCalledTimes(1);
    const arg = dispatchTelegramMock.mock.calls[0][0] as {
      workspaceId: string;
      booking: { id: string; scheduledAt: Date; timezone: string };
      businessName: string;
    };
    expect(arg.workspaceId).toBe(WORKSPACE_ID);
    expect(arg.booking.id).toBe(BOOKING_ID);
    expect(arg.booking.scheduledAt).toBeInstanceOf(Date);
    expect(arg.booking.scheduledAt.toISOString()).toBe(SCHEDULED_AT);
    expect(arg.booking.timezone).toBe('Asia/Jakarta');
    expect(arg.businessName).toBe('Klinik Gigi Sehat');

    // Channel lain tetap dijalankan (rantai tidak berhenti di Telegram).
    expect(dispatchWhatsAppMock).toHaveBeenCalledTimes(1);
    expect(dispatchEmailMock).toHaveBeenCalledTimes(1);
  });

  it('event tanpa reminderAt → skipped invalid-event, tidak ada dispatch', async () => {
    const step = makeStep();
    const result = await handler({
      event: event({ reminderAt: undefined }),
      step: step as never,
    });
    expect(result).toEqual({ skipped: 'invalid-event' });
    expect(dispatchTelegramMock).not.toHaveBeenCalled();
  });

  it('booking tidak ditemukan → skipped booking-not-found, tidak ada dispatch', async () => {
    dbState.workspaces = [workspace()];
    const step = makeStep();
    const result = await handler({ event: event(), step: step as never });
    expect(result).toEqual({ skipped: 'booking-not-found' });
    expect(dispatchTelegramMock).not.toHaveBeenCalled();
  });

  it('booking status cancelled → skipped status-cancelled, tidak ada dispatch', async () => {
    dbState.bookings = [booking({ status: 'cancelled' })];
    dbState.workspaces = [workspace()];
    const step = makeStep();
    const result = await handler({ event: event(), step: step as never });
    expect(result).toEqual({ skipped: 'status-cancelled' });
    expect(dispatchTelegramMock).not.toHaveBeenCalled();
  });

  it('booking sudah di-reschedule (scheduledAt beda dari event) → skipped rescheduled', async () => {
    dbState.bookings = [booking({ scheduledAt: new Date('2026-08-16T07:00:00.000Z') })];
    dbState.workspaces = [workspace()];
    const step = makeStep();
    const result = await handler({ event: event(), step: step as never });
    expect(result).toEqual({ skipped: 'rescheduled' });
    expect(dispatchTelegramMock).not.toHaveBeenCalled();
  });

  it('workspace soft-deleted → skipped workspace-deleted', async () => {
    dbState.bookings = [booking()];
    dbState.workspaces = [workspace({ deletedAt: new Date('2026-08-01T00:00:00Z') })];
    const step = makeStep();
    const result = await handler({ event: event(), step: step as never });
    expect(result).toEqual({ skipped: 'workspace-deleted' });
    expect(dispatchTelegramMock).not.toHaveBeenCalled();
  });

  it('TelegramDispatchError (mis. customer belum terhubung) → dicatat, channel lain tetap jalan', async () => {
    dbState.bookings = [booking()];
    dbState.workspaces = [workspace()];
    dispatchTelegramMock.mockRejectedValue(new TelegramDispatchErrorMock('Customer belum terhubung ke Telegram bot.'));
    const step = makeStep();

    const result = await handler({ event: event(), step: step as never });

    expect(result).toEqual({ sent: true, bookingId: BOOKING_ID });
    expect(console.warn).toHaveBeenCalledWith('[reminder] telegram skip: Customer belum terhubung ke Telegram bot.');
    // Channel lain tetap di-dispatch (error bisnis per-channel tidak mematikan rantai).
    expect(dispatchWhatsAppMock).toHaveBeenCalledTimes(1);
    expect(dispatchEmailMock).toHaveBeenCalledTimes(1);
  });

  it('error provider (network) dari Telegram → dilempar ulang agar Inngest me-retry', async () => {
    dbState.bookings = [booking()];
    dbState.workspaces = [workspace()];
    dispatchTelegramMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const step = makeStep();

    await expect(handler({ event: event(), step: step as never })).rejects.toThrow('ECONNREFUSED');
    // Channel lain TIDAK dijalankan — retry seluruh run.
    expect(dispatchWhatsAppMock).not.toHaveBeenCalled();
    expect(dispatchEmailMock).not.toHaveBeenCalled();
  });
});
