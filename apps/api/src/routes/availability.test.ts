import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Mock jose agar requireAuth tidak perlu JWKS remote (network).
const { jwtVerifyMock } = vi.hoisted(() => ({
  jwtVerifyMock: vi.fn(),
}));

vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => vi.fn()),
  jwtVerify: jwtVerifyMock,
}));

// Kalender eksternal di-mock — dua arah (busy blocks) diuji di level ini
// dengan mengontrol apa yang "ada" di kalender.
const { calendarBusyMock } = vi.hoisted(() => ({
  calendarBusyMock: vi.fn(async () => [] as { start: Date; end: Date }[]),
}));

vi.mock('../lib/google-calendar.ts', () => ({
  getExternalCalendarBusyIntervals: calendarBusyMock,
}));

// ── Fake Drizzle db (where-filtering, subset pola route lain) ──
const { dbState } = vi.hoisted(() => ({
  dbState: {
    tables: new Map<string, unknown[]>(),
    seq: 1,
  },
}));

vi.mock('../db/index.ts', async () => {
  const { bookings, staffMembers, staffSchedules, staffTimeOff, workspaces } = await import('@oriole/database');
  const tableNames = new WeakMap<object, string>();
  tableNames.set(bookings, 'bookings');
  tableNames.set(staffMembers, 'staff_members');
  tableNames.set(staffSchedules, 'staff_schedules');
  tableNames.set(staffTimeOff, 'staff_time_off');
  tableNames.set(workspaces, 'workspaces');

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
    !!c && typeof c === 'object' && typeof (c as { name?: unknown }).name === 'string' && 'table' in (c as object);

  function buildPredicate(cond: unknown, colKey: Record<string, string>): (row: Record<string, unknown>) => boolean {
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
      // Parameter Drizzle: objek {value} ATAU satu chunk Array berisi daftar
      // nilai inArray (Parameter/mentah).
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
    // inArray dirender sebagai 'in' (tanpa spasi) — ' in ' juga ditangani.
    const OP_CANDIDATES = ['ilike', ' like ', 'is not null', 'is null', '>=', '<=', '!=', '<>', ' in ', 'in', '>', '<', '='];
    const op = OP_CANDIDATES.find((candidate) => joined.includes(candidate)) ?? '';

    const get = (row: Record<string, unknown>) => row[key];
    const value = params[0];
    if (op.includes('!=') || op.includes('<>')) return (row) => get(row) !== value;
    if (op.includes(' is not null')) return (row) => get(row) != null;
    if (op.includes(' is null')) return (row) => get(row) == null;
    if (op.includes('>=')) return (row) => (get(row) as number) >= (value as number);
    if (op.includes('<=')) return (row) => (get(row) as number) <= (value as number);
    if (op.includes('>')) return (row) => (get(row) as number) > (value as number);
    if (op.includes('<')) return (row) => (get(row) as number) < (value as number);
    if (op === 'in' || op.includes(' in ')) {
      return (row) => params.includes(get(row));
    }
    return (row) => get(row) === value;
  }

  function filterRows(name: string, conds: unknown[], table: object) {
    const colKey = columnKeyMap(table);
    const predicates = conds.map((c) => buildPredicate(c, colKey));
    return (dbState.tables.get(name) ?? [])
      .filter((row) => predicates.every((pred) => pred(row as Record<string, unknown>)));
  }

  return {
    db: {
      select: (fields?: Record<string, unknown>) => ({
        from: (table: object) => {
          const name = tableNames.get(table) ?? 'unknown';
          const colKey = columnKeyMap(table);
          const builder: {
            where: (...conds: unknown[]) => typeof builder;
            orderBy: () => typeof builder;
            limit: (n: number) => typeof builder;
            then: (resolve: (rows: unknown[]) => unknown) => Promise<unknown>;
            _conds: unknown[];
            _limit?: number;
          } = {
            _conds: [],
            where(...conds) {
              builder._conds = conds;
              return builder;
            },
            orderBy() {
              return builder;
            },
            limit(n: number) {
              builder._limit = n;
              return builder;
            },
            then(resolve) {
              let rows = filterRows(name, builder._conds, table);
              if (builder._limit != null) rows = rows.slice(0, builder._limit);
              if (fields) {
                rows = rows.map((row) => {
                  const rowObj = row as Record<string, unknown>;
                  const out: Record<string, unknown> = {};
                  for (const [alias, col] of Object.entries(fields)) {
                    const colName = (col as { name?: string } | undefined)?.name;
                    const key = colName ? colKey[colName] : undefined;
                    out[alias] = key !== undefined ? rowObj[key] : undefined;
                  }
                  return out;
                });
              }
              return Promise.resolve(resolve(rows));
            },
          };
          return builder;
        },
      }),
      insert: () => ({ values: () => ({ returning: async () => [] }) }),
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
      delete: () => ({ where: () => ({ returning: async () => [] }) }),
    },
  };
});

const AUTH_HEADER = { Authorization: 'Bearer test-jwt-token' };
const WORKSPACE_HEADER = { 'X-Workspace-Id': 'ws-1' };

const STAFF_ID = '22222222-2222-4222-8222-222222222222';

function baseStaff(overrides: Record<string, unknown> = {}) {
  return {
    id: STAFF_ID,
    name: 'Dr. Sari',
    timezone: 'UTC',
    bufferMinutes: 0,
    workspaceId: 'ws-1',
    ...overrides,
  };
}

function baseBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: '99999999-9999-4999-8999-999999999999',
    title: 'Konsultasi',
    scheduledAt: new Date('2026-02-02T10:00:00.000Z'),
    durationMinutes: 60,
    status: 'confirmed',
    workspaceId: 'ws-1',
    staffId: null,
    ...overrides,
  };
}

let app: Hono;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/oriole_test';
  process.env.NEON_AUTH_URL = 'https://ep-test.neon.tech/neondb/auth';
  process.env.PADDLE_API_KEY = 'pdl_sdbx_test';
  process.env.PADDLE_WEBHOOK_SECRET = 'pdl_ntfset_test';
  process.env.RESEND_API_KEY = 're_test';
  process.env.VAPI_API_KEY = 'vapi_test';
  process.env.VAPI_PHONE_NUMBER_ID = 'phone-number-test';

  jwtVerifyMock.mockReset();
  jwtVerifyMock.mockResolvedValue({ payload: { sub: 'test-user-1', email: 'user@example.com' } });

  const { availabilityRoutes } = await import('./availability.ts');
  app = new Hono().route('/api/availability', availabilityRoutes);
});

beforeEach(() => {
  dbState.seq = 1;
  dbState.tables.set('workspaces', [{ id: 'ws-1', userId: 'test-user-1' }]);
  dbState.tables.set('bookings', []);
  dbState.tables.set('staff_members', []);
  dbState.tables.set('staff_schedules', []);
  dbState.tables.set('staff_time_off', []);
  calendarBusyMock.mockReset();
  calendarBusyMock.mockResolvedValue([]);
});

function getSlots(query: string) {
  return app.request(`/api/availability/slots${query}`, {
    headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
  });
}

describe('GET /api/availability/slots — mode tanpa staf', () => {
  it('tanpa booking → 24/7 (93 slot 60 menit per hari, muat penuh)', async () => {
    const res = await getSlots('?from=2026-02-02&to=2026-02-02&duration=60');
    expect(res.status).toBe(200);
    const body = await res.json();
    // Slot terakhir 23:00 (23:00+60 ≤ tengah malam); 23:15 tidak muat penuh.
    expect(body.slots).toHaveLength(93);
    expect(body.slots[0]).toEqual({ start: '2026-02-02T00:00:00.000Z', end: '2026-02-02T01:00:00.000Z' });
    expect(body.slots[92].start).toBe('2026-02-02T23:00:00.000Z');
    expect(body.truncated).toBe(false);
  });

  it('booking aktif memblokir slot-nya (status pending/confirmed)', async () => {
    dbState.tables.set('bookings', [baseBooking()]); // 10:00-11:00Z
    const res = await getSlots('?from=2026-02-02&to=2026-02-02&duration=60');
    const body = await res.json();
    const starts = body.slots.map((s: { start: string }) => s.start);
    // Slot 10:00-11:00 diblokir; 09:45-10:45 juga menabrak (09:00 terakhir
    // sebelum booking); 11:00 (mulai tepat saat selesai) bebas.
    expect(starts).not.toContain('2026-02-02T10:00:00.000Z');
    expect(starts).not.toContain('2026-02-02T09:45:00.000Z');
    expect(starts).toContain('2026-02-02T09:00:00.000Z');
    expect(starts).toContain('2026-02-02T11:00:00.000Z');
  });

  it('booking dibatalkan TIDAK memblokir slot', async () => {
    dbState.tables.set('bookings', [baseBooking({ status: 'cancelled' })]);
    const res = await getSlots('?from=2026-02-02&to=2026-02-02&duration=60');
    const body = await res.json();
    expect(body.slots).toHaveLength(93);
  });

  it('event eksternal kalender memblokir slot (two-way)', async () => {
    calendarBusyMock.mockResolvedValue([
      { start: new Date('2026-02-02T09:00:00Z'), end: new Date('2026-02-02T10:30:00Z') },
    ]);
    const res = await getSlots('?from=2026-02-02&to=2026-02-02&duration=60');
    const body = await res.json();
    const starts = body.slots.map((s: { start: string }) => s.start);
    expect(starts).not.toContain('2026-02-02T09:00:00.000Z');
    expect(starts).not.toContain('2026-02-02T09:30:00.000Z');
    expect(starts).toContain('2026-02-02T10:30:00.000Z');
  });
});

describe('GET /api/availability/slots — mode staf', () => {
  function seedSchedule(dayOfWeek: number, startMinutes: number, endMinutes: number) {
    dbState.tables.set('staff_members', [baseStaff()]);
    dbState.tables.set('staff_schedules', [{ staffId: STAFF_ID, dayOfWeek, startMinutes, endMinutes }]);
  }

  it('jadwal Senin 09:00-17:00 UTC → 29 slot (16:00 terakhir)', async () => {
    seedSchedule(1, 9 * 60, 17 * 60); // 2026-02-02 = Senin
    const res = await getSlots(`?from=2026-02-02&to=2026-02-02&duration=60&staffId=${STAFF_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.slots).toHaveLength(29);
    expect(body.slots[0].start).toBe('2026-02-02T09:00:00.000Z');
    expect(body.slots[28].start).toBe('2026-02-02T16:00:00.000Z');
  });

  it('jadwal dalam Asia/Jakarta diterjemahkan ke UTC (02:00-10:00Z)', async () => {
    dbState.tables.set('staff_members', [baseStaff({ timezone: 'Asia/Jakarta' })]);
    dbState.tables.set('staff_schedules', [{ staffId: STAFF_ID, dayOfWeek: 1, startMinutes: 9 * 60, endMinutes: 17 * 60 }]);
    const res = await getSlots(`?from=2026-02-02&to=2026-02-02&duration=60&staffId=${STAFF_ID}`);
    const body = await res.json();
    expect(body.slots[0].start).toBe('2026-02-02T02:00:00.000Z');
    expect(body.slots).toHaveLength(29);
  });

  it('booking staf lain TIDAK memblokir slot staf ini', async () => {
    seedSchedule(1, 9 * 60, 17 * 60);
    dbState.tables.set('bookings', [baseBooking({ staffId: 'other-staff-1' })]); // 10:00Z staf lain
    const res = await getSlots(`?from=2026-02-02&to=2026-02-02&duration=60&staffId=${STAFF_ID}`);
    const body = await res.json();
    expect(body.slots).toHaveLength(29);
  });

  it('booking staf ini memblokir slot staf ini', async () => {
    seedSchedule(1, 9 * 60, 17 * 60);
    dbState.tables.set('bookings', [baseBooking({ staffId: STAFF_ID })]); // 10:00-11:00Z
    const res = await getSlots(`?from=2026-02-02&to=2026-02-02&duration=60&staffId=${STAFF_ID}`);
    const body = await res.json();
    const starts = body.slots.map((s: { start: string }) => s.start);
    expect(starts).not.toContain('2026-02-02T10:00:00.000Z');
    expect(starts).not.toContain('2026-02-02T09:45:00.000Z');
    expect(starts).toContain('2026-02-02T09:00:00.000Z');
    expect(starts).toContain('2026-02-02T11:00:00.000Z');
  });

  it('buffer staf melebarkan blokir (15 menit)', async () => {
    dbState.tables.set('staff_members', [baseStaff({ bufferMinutes: 15 })]);
    dbState.tables.set('staff_schedules', [{ staffId: STAFF_ID, dayOfWeek: 1, startMinutes: 9 * 60, endMinutes: 17 * 60 }]);
    dbState.tables.set('bookings', [baseBooking({ staffId: STAFF_ID })]); // 10:00-11:00Z → busy 09:45-11:15
    const res = await getSlots(`?from=2026-02-02&to=2026-02-02&duration=60&staffId=${STAFF_ID}`);
    const body = await res.json();
    const starts = body.slots.map((s: { start: string }) => s.start);
    expect(starts).not.toContain('2026-02-02T09:45:00.000Z');
    expect(starts[0]).toBe('2026-02-02T11:15:00.000Z');
  });

  it('staf tanpa jadwal = 24/7', async () => {
    dbState.tables.set('staff_members', [baseStaff()]);
    const res = await getSlots(`?from=2026-02-02&to=2026-02-02&duration=60&staffId=${STAFF_ID}`);
    const body = await res.json();
    expect(body.slots).toHaveLength(93);
  });

  it('hari cuti staf → tidak ada slot', async () => {
    seedSchedule(1, 9 * 60, 17 * 60);
    dbState.tables.set('staff_time_off', [
      { staffId: STAFF_ID, startDate: new Date('2026-02-02T00:00:00Z'), endDate: new Date('2026-02-02T00:00:00Z'), reason: null },
    ]);
    const res = await getSlots(`?from=2026-02-02&to=2026-02-02&duration=60&staffId=${STAFF_ID}`);
    const body = await res.json();
    expect(body.slots).toHaveLength(0);
  });
});

describe('GET /api/availability/slots — validasi', () => {
  it('staffId tidak dikenal → 404', async () => {
    const res = await getSlots(`?from=2026-02-02&to=2026-02-02&duration=60&staffId=${STAFF_ID}`);
    expect(res.status).toBe(404);
  });

  it('staffId workspace lain → 404', async () => {
    dbState.tables.set('staff_members', [baseStaff({ workspaceId: 'ws-2' })]);
    const res = await getSlots(`?from=2026-02-02&to=2026-02-02&duration=60&staffId=${STAFF_ID}`);
    expect(res.status).toBe(404);
  });

  it('rentang lebih dari 31 hari → 400', async () => {
    const res = await getSlots('?from=2026-02-01&to=2026-04-01&duration=60');
    expect(res.status).toBe(400);
  });

  it('format tanggal salah → 400', async () => {
    const res = await getSlots('?from=02/02/2026&to=2026-02-03&duration=60');
    expect(res.status).toBe(400);
  });

  it('durasi di luar 5..720 → 400', async () => {
    const res = await getSlots('?from=2026-02-02&to=2026-02-02&duration=9999');
    expect(res.status).toBe(400);
  });
});
