import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────

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
  tableNames.set(workspaceIntegrations, 'workspaceIntegrations');

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

  /** Predikat dari kondisi Drizzle: eq / isNull di dalam grup and/or. */
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

  function updateBuilder(name: string, table: object) {
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
        where: (...conds: unknown[]) => ({
          then(resolve: (rows: unknown[]) => unknown) {
            return Promise.resolve(resolve(apply(values, conds)));
          },
        }),
      }),
    };
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
              onConflictDoNothing: () => ({
                returning: async () => {
                  const store = dbState.tables.get(name) ?? [];
                  const dup = store.some((r) => (r as Record<string, unknown>).calleCallId === values.calleCallId);
                  if (dup) return [];
                  store.push(row);
                  return [{ id: row.id }];
                },
              }),
            };
          },
        };
      },
      delete: (table: object) => {
        const name = tableNames.get(table) ?? 'unknown';
        const colKey = columnKeyMap(table);
        return {
          where: (...conds: unknown[]) => {
            const run = () => {
              const preds = conds.map((c) => buildPredicate(c, colKey));
              const store = dbState.tables.get(name) ?? [];
              const removed = store.filter((row) => preds.every((p) => p(row)));
              dbState.tables.set(
                name,
                store.filter((row) => !preds.every((p) => p(row))),
              );
              return removed;
            };
            // Thenable yang bisa di-await DAN di-.catch (dipakai place-call);
            // .catch tetap menjalankan delete — hanya menelan error.
            return {
              then(resolve: (rows: unknown[]) => unknown) {
                return Promise.resolve(resolve(run()));
              },
              catch() {
                return Promise.resolve(run());
              },
            };
          },
        };
      },
      update: (table: object) => updateBuilder(tableNames.get(table) ?? 'unknown', table),
    },
  };
});

// Env di-mock (pola standar lib test): loadRootEnv sengaja tidak memuat .env
// saat NODE_ENV=test, jadi env yang menyentuh kode harus distub di sini.
const { envState } = vi.hoisted(() => ({
  envState: {
    VAPI_PHONE_NUMBER_ID: 'phone-number-test',
  },
}));

vi.mock('../lib/env.ts', () => ({ env: envState }));

const { placeVapiCallMock, findVapiCallByNameMock } = vi.hoisted(() => ({
  placeVapiCallMock: vi.fn(),
  findVapiCallByNameMock: vi.fn(),
}));

vi.mock('../services/vapi.ts', () => ({
  placeVapiCall: placeVapiCallMock,
  findVapiCallByName: findVapiCallByNameMock,
  VapiNotConfiguredError: class VapiNotConfiguredError extends Error {
    constructor() {
      super('Vapi belum dikonfigurasi (VAPI_API_KEY / VAPI_PHONE_NUMBER_ID kosong di .env).');
      this.name = 'VapiNotConfiguredError';
    }
  },
}));

import { placeBookingCall, reservationIdFor, isPendingReservation } from './place-call.ts';

// ── Fixtures ────────────────────────────────────────────────────

const BOOKING_ID = '550e8400-e29b-41d4-a716-446655440000';
const CALL_NAME = `booking:${BOOKING_ID}:confirm-attendance:auto-call:2026-08-11T09:00:00.000Z`;
const PENDING_ID = reservationIdFor(CALL_NAME);

const baseInput = {
  workspaceId: 'ws-1',
  bookingId: BOOKING_ID,
  userId: 'user-1',
  phone: '+6281234567890',
  prompt: 'System prompt goal',
  language: 'en' as const,
  goalType: 'confirm-attendance' as const,
  callName: CALL_NAME,
};

beforeEach(() => {
  dbState.seq = 1;
  dbState.tables.set('calleCalls', []);
  dbState.tables.set('workspaceIntegrations', []);
  dbState.tables.set('bookings', [
    { id: BOOKING_ID, calleCallId: null, status: 'pending' },
  ]);
  placeVapiCallMock.mockReset();
  findVapiCallByNameMock.mockReset();
  findVapiCallByNameMock.mockResolvedValue(null);
  placeVapiCallMock.mockResolvedValue({ id: 'vapi-call-1', status: 'ringing' });
});

function calleRows(): Record<string, unknown>[] {
  return dbState.tables.get('calleCalls') ?? [];
}

describe('isPendingReservation / reservationIdFor', () => {
  it('membangun id deterministik dari callName', () => {
    expect(PENDING_ID).toBe(`pending:${CALL_NAME}`);
    expect(isPendingReservation(PENDING_ID)).toBe(true);
    expect(isPendingReservation('vapi-call-1')).toBe(false);
    expect(isPendingReservation(null)).toBe(false);
  });
});

describe('placeBookingCall — happy path', () => {
  it('reserve → create → commit (id asli + tautan booking)', async () => {
    const result = await placeBookingCall(baseInput);

    expect(result).toEqual({
      status: 'placed',
      callId: 'vapi-call-1',
      goalType: 'confirm-attendance',
      calleStatus: 'ringing',
      adopted: false,
    });
    expect(placeVapiCallMock).toHaveBeenCalledWith(
      expect.objectContaining({ callName: CALL_NAME, phone: '+6281234567890' }),
    );
    // Row reservasi di-commit ke id asli, tanpa row duplikat.
    const rows = calleRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      calleCallId: 'vapi-call-1',
      status: 'ringing',
      bookingId: BOOKING_ID,
      goalType: 'confirm-attendance',
    });
    expect(dbState.tables.get('bookings')?.[0].calleCallId).toBe('vapi-call-1');
  });
});

describe('placeBookingCall — retry reconciliation (tidak menggandakan panggilan)', () => {
  it('create sukses tapi commit gagal sebelumnya (reservasi tersisa) → call yang ada diadopsi', async () => {
    // Simulasi attempt pertama: reservasi dibuat, create sukses, mati sebelum commit.
    dbState.tables.set('calleCalls', [
      {
        id: 'row-old',
        calleCallId: PENDING_ID,
        bookingId: BOOKING_ID,
        goalType: 'confirm-attendance',
        status: 'queued',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);
    // Reconcile menemukan call yang sudah dibuat dengan nama yang sama.
    findVapiCallByNameMock.mockResolvedValue({ id: 'vapi-call-9', status: 'in-progress' });

    const result = await placeBookingCall(baseInput);

    expect(result).toEqual({
      status: 'placed',
      callId: 'vapi-call-9',
      goalType: 'confirm-attendance',
      calleStatus: 'in-progress',
      adopted: true,
    });
    // TIDAK ada create baru — panggilan ganda dicegah.
    expect(placeVapiCallMock).not.toHaveBeenCalled();
    // Row di-commit ke id yang diadopsi.
    expect(calleRows()).toHaveLength(1);
    expect(calleRows()[0].calleCallId).toBe('vapi-call-9');
  });

  it('reservasi basi tanpa call yang ada → take over (create) tanpa kehilangan panggilan', async () => {
    // Attempt mati antara reserve dan create; reservasi sudah basi (>60s).
    const old = new Date(Date.now() - 120_000);
    dbState.tables.set('calleCalls', [
      {
        id: 'row-old',
        calleCallId: PENDING_ID,
        bookingId: BOOKING_ID,
        goalType: 'confirm-attendance',
        status: 'queued',
        createdAt: old,
        updatedAt: old,
      },
    ]);
    findVapiCallByNameMock.mockResolvedValue(null);

    const result = await placeBookingCall(baseInput);

    expect(result.status).toBe('placed');
    expect(placeVapiCallMock).toHaveBeenCalledTimes(1);
    // Row lama yang sama di-commit (update by pendingId), tidak ada duplikat.
    expect(calleRows()).toHaveLength(1);
    expect(calleRows()[0].calleCallId).toBe('vapi-call-1');
  });

  it('reservasi segar milik attempt lain → skip call-in-flight (jangan create paralel)', async () => {
    dbState.tables.set('calleCalls', [
      {
        id: 'row-fresh',
        calleCallId: PENDING_ID,
        bookingId: BOOKING_ID,
        goalType: 'confirm-attendance',
        status: 'queued',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    findVapiCallByNameMock.mockResolvedValue(null);

    const result = await placeBookingCall(baseInput);

    expect(result).toEqual({ status: 'skipped', reason: 'call-in-flight' });
    expect(placeVapiCallMock).not.toHaveBeenCalled();
  });
});

describe('placeBookingCall — guard (booking, goalType)', () => {
  it('panggilan nyata masih berjalan → skip call-in-flight', async () => {
    dbState.tables.set('calleCalls', [
      {
        id: 'row-live',
        calleCallId: 'vapi-live-1',
        bookingId: BOOKING_ID,
        goalType: 'confirm-attendance',
        status: 'in-progress',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);

    const result = await placeBookingCall(baseInput);

    expect(result).toEqual({ status: 'skipped', reason: 'call-in-flight' });
    expect(placeVapiCallMock).not.toHaveBeenCalled();
  });

  it('reservasi basi panggilan logis LAIN (source beda) → dibersihkan, panggilan ini jalan', async () => {
    const old = new Date(Date.now() - 120_000);
    // Reservasi manual yang ditinggal mati untuk booking+goal yang sama.
    dbState.tables.set('calleCalls', [
      {
        id: 'row-manual',
        calleCallId: `pending:booking:${BOOKING_ID}:confirm-attendance:manual`,
        bookingId: BOOKING_ID,
        goalType: 'confirm-attendance',
        status: 'queued',
        createdAt: old,
        updatedAt: old,
      },
    ]);

    const result = await placeBookingCall(baseInput);

    expect(result.status).toBe('placed');
    expect(placeVapiCallMock).toHaveBeenCalledTimes(1);
    // Reservasi basi dibersihkan; hanya row baru yang tersisa.
    const rows = calleRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].calleCallId).toBe('vapi-call-1');
  });
});

describe('placeBookingCall — kegagalan create', () => {
  it('create error → reservasi dihapus + error dilempar (retry bisa menempatkan ulang)', async () => {
    placeVapiCallMock.mockRejectedValue(new Error('Vapi 500'));

    await expect(placeBookingCall(baseInput)).rejects.toThrow('Vapi 500');

    // Reservasi dibersihkan — tidak ada sisa basi.
    expect(calleRows()).toHaveLength(0);
    expect(dbState.tables.get('bookings')?.[0].calleCallId).toBeNull();
  });

  it('Vapi tidak dikonfigurasi → skip vapi-not-configured (bukan error yang di-retry)', async () => {
    const { VapiNotConfiguredError } = await import('../services/vapi.ts');
    placeVapiCallMock.mockRejectedValue(new VapiNotConfiguredError());

    const result = await placeBookingCall(baseInput);

    expect(result).toEqual({ status: 'skipped', reason: 'vapi-not-configured' });
    // Reservasi dibersihkan — tidak ada sisa basi.
    expect(calleRows()).toHaveLength(0);
    expect(dbState.tables.get('bookings')?.[0].calleCallId).toBeNull();
  });
});

describe('placeBookingCall — nomor keluar per workspace (Voice AI integration)', () => {
  it('tanpa integrasi vapi → pakai default server (env VAPI_PHONE_NUMBER_ID)', async () => {
    const result = await placeBookingCall(baseInput);
    expect(result.status).toBe('placed');

    const call = placeVapiCallMock.mock.calls[0]?.[0] as { phoneNumberId?: string };
    expect(call.phoneNumberId).toBe('phone-number-test');
  });

  it('workspace memilih nomor di Integrations → dipakai untuk panggilan', async () => {
    dbState.tables.set('workspaceIntegrations', [
      {
        id: 'wsi-1',
        workspaceId: 'ws-1',
        integrationType: 'vapi',
        identifier: '+628211111111',
        providerConfig: { vapiPhoneNumberId: 'vapi-workspace-1', phoneNumber: '+628211111111' },
        isActive: true,
      },
    ]);

    const result = await placeBookingCall(baseInput);
    expect(result.status).toBe('placed');

    const call = placeVapiCallMock.mock.calls[0]?.[0] as { phoneNumberId?: string };
    expect(call.phoneNumberId).toBe('vapi-workspace-1');
  });

  it('integrasi vapi nonaktif → jatuh ke default server', async () => {
    dbState.tables.set('workspaceIntegrations', [
      {
        id: 'wsi-1',
        workspaceId: 'ws-1',
        integrationType: 'vapi',
        identifier: '+628211111111',
        providerConfig: { vapiPhoneNumberId: 'vapi-workspace-1', phoneNumber: '+628211111111' },
        isActive: false,
      },
    ]);

    const result = await placeBookingCall(baseInput);
    expect(result.status).toBe('placed');

    const call = placeVapiCallMock.mock.calls[0]?.[0] as { phoneNumberId?: string };
    expect(call.phoneNumberId).toBe('phone-number-test');
  });
});
