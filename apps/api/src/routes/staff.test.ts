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

// ── Fake Drizzle db (where-filtering penuh) ──────────────────────
// Mendukung select/insert/update/delete + predicate eq/in/lt/gte/is-null.
// `where` benar-benar memfilter — scoping workspace teruji, bukan dianggap.
const { dbState } = vi.hoisted(() => ({
  dbState: {
    tables: new Map<string, unknown[]>(),
    seq: 1,
  },
}));

vi.mock('../db/index.ts', async () => {
  const { staffMembers, staffSchedules, staffTimeOff, workspaces } = await import('@oriole/database');
  const tableNames = new WeakMap<object, string>();
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

  const now = new Date('2026-01-01T00:00:00.000Z');

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
      insert: (table: object) => {
        const name = tableNames.get(table) ?? 'unknown';
        const insertRows = (values: Record<string, unknown> | Record<string, unknown>[]) => {
          const list = Array.isArray(values) ? values : [values];
          const rows = list.map((value) => {
            const row: Record<string, unknown> = {
              ...value,
              id: `${name}-${dbState.seq++}`,
              createdAt: now,
              updatedAt: now,
            };
            // Default DB (kolom notNull dengan default) — mirror schema.
            if (name === 'staff_members') {
              row.isActive ??= true;
              row.color ??= '#f59e0b';
              row.timezone ??= 'UTC';
              row.bufferMinutes ??= 0;
            }
            dbState.tables.get(name)?.push(row);
            return row;
          });
          return rows;
        };
        return {
          // insert().values(...).returning() — untuk route yang butuh baris balik.
          values: (values: Record<string, unknown> | Record<string, unknown>[]) => ({
            returning: async () => insertRows(values),
            // insert().values(...) TANPA returning — route cukup await hasilnya
            // (thenable) dan tetap menulis baris.
            then(resolve: (rows: unknown[]) => unknown) {
              return Promise.resolve(resolve(insertRows(values)));
            },
          }),
        };
      },
      update: (table: object) => {
        const name = tableNames.get(table) ?? 'unknown';
        return {
          set: (values: Record<string, unknown>) => ({
            where: (...conds: unknown[]) => ({
              returning: async () => {
                const rows = filterRows(name, conds, table);
                if (rows.length === 0) return [];
                const updated = {
                  ...(rows[0] as Record<string, unknown>),
                  ...values,
                  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
                };
                const index = (dbState.tables.get(name) ?? []).indexOf(rows[0]);
                if (index >= 0) (dbState.tables.get(name) as unknown[])[index] = updated;
                return [updated];
              },
            }),
          }),
        };
      },
      delete: (table: object) => {
        const name = tableNames.get(table) ?? 'unknown';
        const doDelete = (conds: unknown[]) => {
          const rows = filterRows(name, conds, table);
          if (rows.length === 0) return [];
          const id = (rows[0] as { id: string }).id;
          const store = dbState.tables.get(name) as unknown[] | undefined;
          if (store) {
            for (const row of rows) {
              const index = store.indexOf(row);
              if (index >= 0) store.splice(index, 1);
            }
          }
          return [{ id }];
        };
        return {
          where: (...conds: unknown[]) => ({
            // delete().where().returning()
            returning: async () => doDelete(conds),
            // delete().where() — route cukup await (hapus tetap jalan).
            then(resolve: (rows: unknown[]) => unknown) {
              return Promise.resolve(resolve(doDelete(conds)));
            },
          }),
        };
      },
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
    email: 'sari@clinic.id',
    phone: '+6281111111',
    color: '#f59e0b',
    timezone: 'Asia/Jakarta',
    isActive: true,
    bufferMinutes: 15,
    userId: 'test-user-1',
    workspaceId: 'ws-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
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

  const { staffRoutes } = await import('./staff.ts');
  app = new Hono().route('/api/staff', staffRoutes);
});

beforeEach(() => {
  dbState.seq = 1;
  dbState.tables.set('workspaces', [{ id: 'ws-1', userId: 'test-user-1' }]);
  dbState.tables.set('staff_members', []);
  dbState.tables.set('staff_schedules', []);
  dbState.tables.set('staff_time_off', []);
});

function req(path: string, init: RequestInit = {}) {
  return app.request(path, { ...init, headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, ...init.headers } });
}

describe('GET /api/staff', () => {
  it('tanpa token → 401', async () => {
    const res = await app.request('/api/staff');
    expect(res.status).toBe(401);
  });

  it('daftar kosong → staff: []', async () => {
    const res = await req('/api/staff');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ staff: [] });
  });

  it('mengembalikan staf workspace dengan schedules & timeOff kosong', async () => {
    dbState.tables.set('staff_members', [baseStaff()]);
    const res = await req('/api/staff');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.staff).toHaveLength(1);
    expect(body.staff[0]).toMatchObject({
      id: STAFF_ID,
      name: 'Dr. Sari',
      email: 'sari@clinic.id',
      timezone: 'Asia/Jakarta',
      bufferMinutes: 15,
      isActive: true,
    });
    expect(body.staff[0].schedules).toEqual([]);
    expect(body.staff[0].timeOff).toEqual([]);
    expect(body.staff[0]).not.toHaveProperty('userId');
    expect(body.staff[0]).not.toHaveProperty('workspaceId');
  });

  it('tidak membocorkan staf workspace lain', async () => {
    dbState.tables.set('staff_members', [
      baseStaff(),
      baseStaff({ id: '33333333-3333-4333-8333-333333333333', workspaceId: 'ws-2' }),
    ]);
    const res = await req('/api/staff');
    const body = await res.json();
    expect(body.staff).toHaveLength(1);
  });
});

describe('POST /api/staff', () => {
  it('membuat staf valid → 201', async () => {
    const res = await req('/api/staff', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Dr. Budi', timezone: 'Asia/Jakarta', bufferMinutes: 10 }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.staff).toMatchObject({
      id: 'staff_members-1',
      name: 'Dr. Budi',
      color: '#f59e0b',
      timezone: 'Asia/Jakarta',
      bufferMinutes: 10,
      isActive: true,
    });
    expect(body.staff.schedules).toEqual([]);
    expect(body.staff.timeOff).toEqual([]);
  });

  it('email kosong disimpan null', async () => {
    const res = await req('/api/staff', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X', email: '  ' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.staff.email).toBeNull();
  });

  it('nama kosong → 400', async () => {
    const res = await req('/api/staff', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    });
    expect(res.status).toBe(400);
  });

  it('warna bukan hex → 400', async () => {
    const res = await req('/api/staff', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X', color: 'merah' }),
    });
    expect(res.status).toBe(400);
  });

  it('zona waktu tidak dikenal → 400', async () => {
    const res = await req('/api/staff', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X', timezone: 'Mars/Olympus' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/staff/:id', () => {
  it('staf tidak ditemukan → 404', async () => {
    const res = await req(`/api/staff/${STAFF_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X' }),
    });
    expect(res.status).toBe(404);
  });

  it('update parsial berhasil', async () => {
    dbState.tables.set('staff_members', [baseStaff()]);
    const res = await req(`/api/staff/${STAFF_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Dr. Sari Baru', bufferMinutes: 30 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.staff.name).toBe('Dr. Sari Baru');
    expect(body.staff.bufferMinutes).toBe(30);
    expect(body.staff.timezone).toBe('Asia/Jakarta');
  });

  it('isActive false diterima', async () => {
    dbState.tables.set('staff_members', [baseStaff()]);
    const res = await req(`/api/staff/${STAFF_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ isActive: false }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.staff.isActive).toBe(false);
  });
});

describe('DELETE /api/staff/:id', () => {
  it('menghapus staf → ok', async () => {
    dbState.tables.set('staff_members', [baseStaff()]);
    const res = await req(`/api/staff/${STAFF_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: STAFF_ID });
  });

  it('staf tidak ada → 404', async () => {
    const res = await req(`/api/staff/${STAFF_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('staf workspace lain tidak bisa dihapus (scoping → 404)', async () => {
    dbState.tables.set('staff_members', [baseStaff({ workspaceId: 'ws-2' })]);
    const res = await req(`/api/staff/${STAFF_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});

describe('PUT /api/staff/:id/schedules', () => {
  it('mengganti jadwal mingguan', async () => {
    dbState.tables.set('staff_members', [baseStaff()]);
    dbState.tables.set('staff_schedules', [
      { id: 'old-1', staffId: STAFF_ID, dayOfWeek: 0, startMinutes: 0, endMinutes: 60 },
    ]);
    const res = await req(`/api/staff/${STAFF_ID}/schedules`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schedules: [
          { dayOfWeek: 1, startMinutes: 9 * 60, endMinutes: 17 * 60 },
          { dayOfWeek: 3, startMinutes: 9 * 60, endMinutes: 12 * 60 },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.staff.schedules).toHaveLength(2);
    expect(body.staff.schedules[0]).toMatchObject({ dayOfWeek: 1, startMinutes: 540, endMinutes: 1020 });
  });

  it('jadwal kosong menghapus semua', async () => {
    dbState.tables.set('staff_members', [baseStaff()]);
    dbState.tables.set('staff_schedules', [
      { id: 'old-1', staffId: STAFF_ID, dayOfWeek: 1, startMinutes: 0, endMinutes: 60 },
    ]);
    const res = await req(`/api/staff/${STAFF_ID}/schedules`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schedules: [] }),
    });
    const body = await res.json();
    expect(body.staff.schedules).toEqual([]);
  });

  it('staf tidak ada → 404', async () => {
    const res = await req(`/api/staff/${STAFF_ID}/schedules`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schedules: [] }),
    });
    expect(res.status).toBe(404);
  });

  it('end <= start → 400', async () => {
    dbState.tables.set('staff_members', [baseStaff()]);
    const res = await req(`/api/staff/${STAFF_ID}/schedules`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schedules: [{ dayOfWeek: 1, startMinutes: 600, endMinutes: 600 }] }),
    });
    expect(res.status).toBe(400);
  });

  it('dayOfWeek di luar 0-6 → 400', async () => {
    dbState.tables.set('staff_members', [baseStaff()]);
    const res = await req(`/api/staff/${STAFF_ID}/schedules`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schedules: [{ dayOfWeek: 7, startMinutes: 0, endMinutes: 60 }] }),
    });
    expect(res.status).toBe(400);
  });

  it('rentang tumpang-tindih di hari sama → 400', async () => {
    dbState.tables.set('staff_members', [baseStaff()]);
    const res = await req(`/api/staff/${STAFF_ID}/schedules`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schedules: [
          { dayOfWeek: 1, startMinutes: 540, endMinutes: 1020 },
          { dayOfWeek: 1, startMinutes: 600, endMinutes: 1200 },
        ],
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/staff/:id/time-off', () => {
  it('menambah cuti → 201', async () => {
    dbState.tables.set('staff_members', [baseStaff()]);
    const res = await req(`/api/staff/${STAFF_ID}/time-off`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ startDate: '2026-03-10', endDate: '2026-03-12', reason: 'Libur lebaran' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.timeOff).toMatchObject({
      startDate: '2026-03-10T00:00:00.000Z',
      endDate: '2026-03-12T00:00:00.000Z',
      reason: 'Libur lebaran',
    });
  });

  it('endDate sebelum startDate → 400', async () => {
    dbState.tables.set('staff_members', [baseStaff()]);
    const res = await req(`/api/staff/${STAFF_ID}/time-off`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ startDate: '2026-03-12', endDate: '2026-03-10' }),
    });
    expect(res.status).toBe(400);
  });

  it('format tanggal salah → 400', async () => {
    dbState.tables.set('staff_members', [baseStaff()]);
    const res = await req(`/api/staff/${STAFF_ID}/time-off`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ startDate: '10/03/2026', endDate: '12/03/2026' }),
    });
    expect(res.status).toBe(400);
  });

  it('staf tidak ada → 404', async () => {
    const res = await req(`/api/staff/${STAFF_ID}/time-off`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ startDate: '2026-03-10', endDate: '2026-03-12' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/staff/:id/time-off/:timeOffId', () => {
  const TIME_OFF_ID = '44444444-4444-4444-8444-444444444444';

  it('menghapus cuti → ok', async () => {
    dbState.tables.set('staff_members', [baseStaff()]);
    dbState.tables.set('staff_time_off', [
      { id: TIME_OFF_ID, staffId: STAFF_ID, startDate: new Date('2026-03-10T00:00:00Z'), endDate: new Date('2026-03-12T00:00:00Z'), reason: null },
    ]);
    const res = await req(`/api/staff/${STAFF_ID}/time-off/${TIME_OFF_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: TIME_OFF_ID });
  });

  it('cuti tidak ada → 404', async () => {
    dbState.tables.set('staff_members', [baseStaff()]);
    const res = await req(`/api/staff/${STAFF_ID}/time-off/${TIME_OFF_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('cuti milik staf lain → 404 (scoping per staf)', async () => {
    dbState.tables.set('staff_members', [baseStaff()]);
    dbState.tables.set('staff_time_off', [
      { id: TIME_OFF_ID, staffId: 'other-staff', startDate: new Date('2026-03-10T00:00:00Z'), endDate: new Date('2026-03-12T00:00:00Z'), reason: null },
    ]);
    const res = await req(`/api/staff/${STAFF_ID}/time-off/${TIME_OFF_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});
