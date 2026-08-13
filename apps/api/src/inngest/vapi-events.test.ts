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
    INNGEST_EVENT_KEY: '',
    NODE_ENV: 'test',
  } as Record<string, string>,
}));

vi.mock('../lib/env.ts', () => ({ env: envState }));

const { createFunctionMock, sendMock } = vi.hoisted(() => ({
  createFunctionMock: vi.fn((opts: unknown, handler: unknown) => ({ opts, handler })),
  sendMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./client.ts', () => ({
  inngest: { createFunction: createFunctionMock, send: sendMock },
  inngestEventBaseUrl: () => 'http://localhost:8288/',
  inngestMode: () => 'dev',
}));

vi.mock('@oriole/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@oriole/config')>();
  return { ...actual, loadRootEnv: vi.fn() };
});

// ── Fake Drizzle db (select / insert+upsert / update) ──────────
const { dbState } = vi.hoisted(() => ({
  dbState: {
    tables: new Map<string, Record<string, unknown>[]>(),
    seq: 1,
  },
}));

vi.mock('../db/index.ts', async () => {
  const { bookings, calleCalls, workspaceIntegrations } = await import('@oriole/database');
  const tableNames = new WeakMap<object, string>();
  tableNames.set(bookings, 'bookings');
  tableNames.set(calleCalls, 'calleCalls');
  tableNames.set(workspaceIntegrations, 'workspace_integrations');

  function columnKeyMap(table: object): Record<string, string> {
    const map: Record<string, string> = {};
    for (const [key, col] of Object.entries(table as Record<string, unknown>)) {
      if (col && typeof col === 'object' && 'name' in col && typeof (col as { name: unknown }).name === 'string') {
        map[(col as { name: string }).name] = key;
      }
    }
    return map;
  }

  const isSqlChunk = (c: unknown): c is { queryChunks: unknown[] } =>
    !!c && typeof c === 'object' && Array.isArray((c as { queryChunks?: unknown }).queryChunks);
  const isStringChunk = (c: unknown): c is { value: unknown[] } =>
    !!c && typeof c === 'object' && Array.isArray((c as { value?: unknown }).value) &&
    ((c as { value: unknown[] }).value.every((v) => typeof v === 'string'));
  const isColumnChunk = (c: unknown): c is { name: string } =>
    !!c && typeof c === 'object' && typeof (c as { name?: unknown }).name === 'string' &&
    'table' in (c as object);

  function buildPredicate(
    cond: unknown,
    colKey: Record<string, string>,
  ): (row: Record<string, unknown>) => boolean {
    const chunks = (cond as { queryChunks?: unknown[] } | null)?.queryChunks;
    if (!Array.isArray(chunks) || chunks.length === 0) return () => true;
    const hasGroupChildren = chunks.some(isSqlChunk);
    if (hasGroupChildren) {
      const subPreds: ((row: Record<string, unknown>) => boolean)[] = [];
      const ops: ('and' | 'or')[] = [];
      for (const chunk of chunks) {
        if (isStringChunk(chunk)) {
          const sep = chunk.value.join('').trim();
          if (sep === 'and' || sep === 'or') ops.push(sep);
        } else if (isSqlChunk(chunk)) {
          subPreds.push(buildPredicate(chunk, colKey));
        }
      }
      return (row) => {
        let result = subPreds[0]?.(row) ?? true;
        for (let i = 0; i < ops.length; i++) {
          const next = subPreds[i + 1]?.(row) ?? true;
          result = ops[i] === 'or' ? result || next : result && next;
        }
        return result;
      };
    }
    let colName: string | null = null;
    const stringParts: string[] = [];
    const params: unknown[] = [];
    for (const chunk of chunks) {
      if (isColumnChunk(chunk)) {
        colName = chunk.name;
        continue;
      }
      if (isStringChunk(chunk)) {
        stringParts.push(chunk.value.join(''));
        continue;
      }
      if (Array.isArray(chunk)) {
        for (const item of chunk) {
          if (item && typeof item === 'object' && 'value' in (item as object)) {
            params.push((item as { value: unknown }).value);
          } else if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
            params.push(item);
          }
        }
        continue;
      }
      if (chunk && typeof chunk === 'object' && 'value' in (chunk as object)) {
        params.push((chunk as { value: unknown }).value);
      } else if (typeof chunk === 'string' || typeof chunk === 'number' || typeof chunk === 'boolean') {
        params.push(chunk);
      }
    }
    if (!colName) return () => true;
    const key = colKey[colName];
    if (key === undefined) return () => true;
    const joined = stringParts.join('').replace(/\s+/g, ' ').trim();
    const op =
      joined.includes('is not null') ? 'is not null' :
      joined.includes('is null') ? 'is null' : '=';
    const get = (row: Record<string, unknown>) => row[key];
    if (op === 'is not null') return (row) => get(row) != null;
    if (op === 'is null') return (row) => get(row) == null;
    return (row) => get(row) === params[0];
  }

  function selectBuilder(name: string, table: object, fields?: Record<string, unknown>) {
    const colKey = columnKeyMap(table);
    const builder: {
      _conds: unknown[];
      _limit?: number;
      where: (...conds: unknown[]) => typeof builder;
      limit: (n: number) => typeof builder;
      then: (resolve: (rows: unknown[]) => unknown) => Promise<unknown>;
    } = {
      _conds: [],
      where(...conds) {
        builder._conds = conds;
        return builder;
      },
      limit(n: number) {
        builder._limit = n;
        return builder;
      },
      then(resolve: (rows: unknown[]) => unknown) {
        const preds = builder._conds.map((c) => buildPredicate(c, colKey));
        let rows = (dbState.tables.get(name) ?? []).filter((row) => preds.every((p) => p(row)));
        if (builder._limit != null) rows = rows.slice(0, builder._limit);
        if (fields) {
          rows = rows.map((row) => {
            const out: Record<string, unknown> = {};
            for (const [alias, col] of Object.entries(fields)) {
              const colName = (col as { name?: string } | undefined)?.name;
              const key = colName ? colKey[colName] : undefined;
              out[alias] = key !== undefined ? row[key] : undefined;
            }
            return out;
          });
        }
        return Promise.resolve(resolve(rows));
      },
    };
    return builder;
  }

  return {
    db: {
      select: (fields?: Record<string, unknown>) => ({
        from: (table: object) => selectBuilder(tableNames.get(table) ?? 'unknown', table, fields),
      }),
      insert: (table: object) => {
        const name = tableNames.get(table) ?? 'unknown';
        return {
          values: (values: Record<string, unknown>) => {
            const row: Record<string, unknown> = {
              ...values,
              id: `row-${dbState.seq++}`,
              createdAt: new Date('2026-01-01T00:00:00.000Z'),
              updatedAt: new Date('2026-01-01T00:00:00.000Z'),
            };
            return {
              onConflictDoUpdate: (opts: { set: Record<string, unknown> }) => ({
                then: async (resolve: (rows: unknown[]) => unknown) => {
                  const store = dbState.tables.get(name) ?? [];
                  const idx = store.findIndex(
                    (r) => (r as Record<string, unknown>).calleCallId === values.calleCallId,
                  );
                  if (idx >= 0) {
                    const merged = {
                      ...store[idx],
                      ...opts.set,
                      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
                    };
                    store[idx] = merged;
                    return resolve([merged]);
                  }
                  store.push(row);
                  return resolve([row]);
                },
              }),
            };
          },
        };
      },
      update: (table: object) => {
        const name = tableNames.get(table) ?? 'unknown';
        const colKey = columnKeyMap(table);
        const apply = (values: Record<string, unknown>, conds: unknown[]) => {
          const preds = conds.map((c) => buildPredicate(c, colKey));
          const store = dbState.tables.get(name) ?? [];
          const matched: Record<string, unknown>[] = [];
          for (const row of store as Record<string, unknown>[]) {
            if (preds.every((p) => p(row))) {
              matched.push(row);
              Object.assign(row, values, { updatedAt: new Date('2026-01-02T00:00:00.000Z') });
            }
          }
          return matched;
        };
        return {
          set: (values: Record<string, unknown>) => ({
            where: (...conds: unknown[]) => {
              const run = () => apply(values, conds);
              return {
                returning: async () => run(),
                then(resolve: (rows: unknown[]) => unknown) {
                  return Promise.resolve(resolve(run()));
                },
              };
            },
          }),
        };
      },
    },
  };
});

// ── Import handler setelah mock siap ────────────────────────────
import { onVapiEvent } from './functions.ts';

type VapiHandler = (args: {
  event: { data: Record<string, unknown> };
  step: { run: (name: string, fn: () => unknown) => Promise<unknown> };
}) => Promise<unknown>;

const handler = (onVapiEvent as unknown as { handler: VapiHandler }).handler;

// ── Fixtures ────────────────────────────────────────────────────

const WORKSPACE_ID = 'ws-1';
const BOOKING_ID = '550e8400-e29b-41d4-a716-446655440000';
const CALL_ID = 'vapi-call-1';
const CALL_NAME = `booking:${BOOKING_ID}:confirm-attendance:auto-call:2026-08-11T09:00:00.000Z`;

function eocrEvent(overrides: Record<string, unknown> = {}) {
  return {
    name: 'vapi/event.received',
    data: {
      eventId: `${CALL_ID}:eocr`,
      eventType: 'end-of-call-report',
      payload: {
        message: {
          type: 'end-of-call-report',
          endedReason: 'customer-ended-call',
          call: {
            id: CALL_ID,
            name: CALL_NAME,
            status: 'ended',
            startedAt: '2026-08-11T09:00:00.000Z',
            endedAt: '2026-08-11T09:01:30.000Z',
            customer: { number: '+6281234567890' },
          },
          artifact: { transcript: 'AI: Halo ... User: Ya', recordingUrl: 'https://rec.example/1.mp3' },
          ...overrides,
        },
      },
    },
  };
}

function makeStep() {
  return {
    run: vi.fn(async (_name: string, fn: () => unknown) => fn()),
  };
}

function calleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    calleCallId: CALL_ID,
    userId: 'user-1',
    workspaceId: WORKSPACE_ID,
    bookingId: BOOKING_ID,
    phone: '+6281234567890',
    task: 'prompt',
    goalType: 'confirm-attendance',
    status: 'queued',
    createdAt: new Date('2026-08-11T08:00:00.000Z'),
    updatedAt: new Date('2026-08-11T08:00:00.000Z'),
    ...overrides,
  };
}

function bookingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    workspaceId: WORKSPACE_ID,
    userId: 'user-1',
    phone: '+6281234567890',
    calleCallId: CALL_ID,
    status: 'pending',
    ...overrides,
  };
}

beforeEach(() => {
  dbState.seq = 1;
  dbState.tables.set('calleCalls', []);
  dbState.tables.set('bookings', []);
  dbState.tables.set('workspace_integrations', []);
  sendMock.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('onVapiEvent — upsert + selesaikan booking (end-of-call-report)', () => {
  it('call sukses dengan row yang ada → status/result di-upsert, booking completed + event ter-emit', async () => {
    dbState.tables.set('calleCalls', [calleRow()]);
    dbState.tables.set('bookings', [bookingRow()]);

    await handler({ event: eocrEvent(), step: makeStep() as never });

    const rows = dbState.tables.get('calleCalls') ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      calleCallId: CALL_ID,
      status: 'completed',
      goalType: 'confirm-attendance', // dipertahankan oleh upsert
    });
    const result = (rows[0] as { result: Record<string, unknown> }).result;
    expect(result.endedReason).toBe('customer-ended-call');
    expect(result.durationSeconds).toBe(90);
    expect(result.transcript).toContain('Halo');

    // Booking ditandai completed.
    expect((dbState.tables.get('bookings')?.[0] as { status: string }).status).toBe('completed');
    // Event booking/completed terkirim (emitBookingCompleted → safeSend).
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'booking/completed',
        data: expect.objectContaining({ bookingId: BOOKING_ID, workspaceId: WORKSPACE_ID }),
      }),
    );
  });

  it('row hilang tapi booking ketemu via nama panggilan → row dibuat ulang (outcome tidak lenyap)', async () => {
    // Simulasi: create sukses, commit DB gagal — tidak ada row calle_calls.
    dbState.tables.set('calleCalls', []);
    dbState.tables.set('bookings', [bookingRow({ calleCallId: null })]);

    await handler({ event: eocrEvent(), step: makeStep() as never });

    const rows = dbState.tables.get('calleCalls') ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      calleCallId: CALL_ID,
      bookingId: BOOKING_ID,
      workspaceId: WORKSPACE_ID,
      phone: '+6281234567890',
      status: 'completed',
    });
    // Booking.calleCallId null (commit gagal) → guard lulus → completed.
    expect((dbState.tables.get('bookings')?.[0] as { status: string }).status).toBe('completed');
  });

  it('panggilan gagal (customer-did-not-answer) → status failed, booking TIDAK completed', async () => {
    dbState.tables.set('calleCalls', [calleRow()]);
    dbState.tables.set('bookings', [bookingRow()]);

    const evt = eocrEvent();
    (evt.data.payload.message as Record<string, unknown>).endedReason = 'customer-did-not-answer';
    await handler({ event: evt, step: makeStep() as never });

    const rows = dbState.tables.get('calleCalls') ?? [];
    expect((rows[0] as { status: string }).status).toBe('failed');
    expect((dbState.tables.get('bookings')?.[0] as { status: string }).status).toBe('pending');
    expect(sendMock).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'booking/completed' }));
  });

  it('eocr call LAMA dengan booking yang sudah menunjuk ke call lebih baru → outcome dicatat, completion ditahan', async () => {
    dbState.tables.set('calleCalls', []);
    dbState.tables.set('bookings', [bookingRow({ calleCallId: 'vapi-call-NEWER' })]);

    await handler({ event: eocrEvent(), step: makeStep() as never });

    // Upsert tetap mencatat outcome call lama.
    const rows = dbState.tables.get('calleCalls') ?? [];
    expect(rows).toHaveLength(1);
    expect((rows[0] as { status: string }).status).toBe('completed');
    // Booking TIDAK di-complete (panggilan yang lebih baru masih berjalan).
    expect((dbState.tables.get('bookings')?.[0] as { status: string }).status).toBe('pending');
    expect(sendMock).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'booking/completed' }));
  });

  it('call bukan milik aplikasi (tanpa row & tanpa booking di nama) → skip upsert, tanpa completion', async () => {
    dbState.tables.set('calleCalls', []);
    dbState.tables.set('bookings', []);

    await handler({ event: eocrEvent(), step: makeStep() as never });

    expect(dbState.tables.get('calleCalls')).toHaveLength(0);
    expect(sendMock).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it('event tanpa call id → skipped no-call-id', async () => {
    const evt = eocrEvent();
    (evt.data.payload.message as Record<string, unknown>).call = undefined;

    const result = await handler({ event: evt, step: makeStep() as never });
    expect(result).toEqual({ skipped: 'no-call-id' });
  });
});
