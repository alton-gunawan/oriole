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

// ── Fake Drizzle db (where-filtering penuh) — mirror staff.test.ts ──────
const { dbState } = vi.hoisted(() => ({
  dbState: {
    tables: new Map<string, unknown[]>(),
    seq: 1,
  },
}));

vi.mock('../db/index.ts', async () => {
  const { services, serviceStaff, staffMembers, workspaces } = await import('@oriole/database');
  const tableNames = new WeakMap<object, string>();
  tableNames.set(services, 'services');
  tableNames.set(serviceStaff, 'service_staff');
  tableNames.set(staffMembers, 'staff_members');
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
            if (name === 'services') {
              row.durationMinutes ??= 60;
              row.currency ??= 'USD';
              row.color ??= '#f59e0b';
              row.isActive ??= true;
              row.sortOrder ??= 0;
            }
            dbState.tables.get(name)?.push(row);
            return row;
          });
          return rows;
        };
        return {
          values: (values: Record<string, unknown> | Record<string, unknown>[]) => ({
            returning: async () => insertRows(values),
            then(resolve: (rows: unknown[]) => unknown) {
              return Promise.resolve(resolve(insertRows(values)));
            },
          }),
        };
      },
      update: (table: object) => {
        const name = tableNames.get(table) ?? 'unknown';
        const doUpdate = (values: Record<string, unknown>, conds: unknown[]) => {
          const matched = filterRows(name, conds, table);
          if (matched.length === 0) return [];
          const store = dbState.tables.get(name) as unknown[] | undefined;
          const updated: Record<string, unknown>[] = [];
          for (const target of matched as Record<string, unknown>[]) {
            const index = store?.indexOf(target) ?? -1;
            if (index < 0) continue;
            const merged = {
              ...target,
              ...values,
              updatedAt: new Date('2026-01-02T00:00:00.000Z'),
            };
            (store as unknown[])[index] = merged;
            updated.push(merged);
          }
          return updated;
        };
        return {
          set: (values: Record<string, unknown>) => ({
            where: (...conds: unknown[]) => ({
              returning: async () => doUpdate(values, conds),
              then(resolve: (rows: unknown[]) => unknown) {
                return Promise.resolve(resolve(doUpdate(values, conds)));
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
            returning: async () => doDelete(conds),
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

const SERVICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STAFF_ID = '22222222-2222-4222-8222-222222222222';

function baseService(overrides: Record<string, unknown> = {}) {
  return {
    id: SERVICE_ID,
    name: 'Haircut & Styling',
    description: null,
    durationMinutes: 60,
    priceMinor: 50_000,
    currency: 'IDR',
    color: '#f59e0b',
    category: null,
    isActive: true,
    sortOrder: 0,
    userId: 'test-user-1',
    workspaceId: 'ws-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function baseStaff(overrides: Record<string, unknown> = {}) {
  return {
    id: STAFF_ID,
    name: 'Dr. Sari',
    email: null,
    phone: null,
    color: '#f59e0b',
    timezone: 'Asia/Jakarta',
    isActive: true,
    bufferMinutes: 0,
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

  const { servicesRoutes } = await import('./services.ts');
  app = new Hono().route('/api/services', servicesRoutes);
});

beforeEach(() => {
  dbState.seq = 1;
  dbState.tables.set('workspaces', [
    { id: 'ws-1', userId: 'test-user-1', aiKnowledge: null },
  ]);
  dbState.tables.set('services', []);
  dbState.tables.set('service_staff', []);
  dbState.tables.set('staff_members', []);
});

function req(path: string, init: RequestInit = {}) {
  return app.request(path, { ...init, headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, ...init.headers } });
}

describe('GET /api/services', () => {
  it('tanpa token → 401', async () => {
    const res = await app.request('/api/services');
    expect(res.status).toBe(401);
  });

  it('daftar kosong → services: []', async () => {
    const res = await req('/api/services');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ services: [] });
  });

  it('mengembalikan layanan workspace dengan staffIds', async () => {
    dbState.tables.set('services', [baseService()]);
    dbState.tables.set('service_staff', [
      { id: 'link-1', serviceId: SERVICE_ID, staffId: STAFF_ID },
    ]);
    const res = await req('/api/services');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.services).toHaveLength(1);
    expect(body.services[0]).toMatchObject({
      id: SERVICE_ID,
      name: 'Haircut & Styling',
      durationMinutes: 60,
      priceMinor: 50_000,
      currency: 'IDR',
      staffIds: [STAFF_ID],
      isActive: true,
    });
    expect(body.services[0]).not.toHaveProperty('userId');
    expect(body.services[0]).not.toHaveProperty('workspaceId');
  });

  it('tidak membocorkan layanan workspace lain', async () => {
    dbState.tables.set('services', [
      baseService(),
      baseService({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', workspaceId: 'ws-2' }),
    ]);
    const res = await req('/api/services');
    const body = await res.json();
    expect(body.services).toHaveLength(1);
  });
});

describe('POST /api/services', () => {
  it('membuat layanan valid → 201', async () => {
    const res = await req('/api/services', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Cuci & Poles',
        durationMinutes: 90,
        priceMinor: 150_000,
        currency: 'IDR',
        category: ['Perawatan', 'Paket'],
        staffIds: [],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.service).toMatchObject({
      id: 'services-1',
      name: 'Cuci & Poles',
      durationMinutes: 90,
      priceMinor: 150_000,
      currency: 'IDR',
      category: ['Perawatan', 'Paket'],
      color: '#f59e0b',
      isActive: true,
      staffIds: [],
    });
  });

  it('kategori dinormalisasi: string tunggal (legacy) & duplikat → array unik', async () => {
    const res = await req('/api/services', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Poles Kilat',
        category: ' Perawatan ',
        staffIds: [],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    // String tunggal (legacy) diterima → array 1 elemen; whitespace di-trim.
    expect(body.service.category).toEqual(['Perawatan']);

    const res2 = await req('/api/services', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Poles Kilat 2',
        category: ['Paket', ' paket ', 'Perawatan'],
        staffIds: [],
      }),
    });
    expect(res2.status).toBe(201);
    const body2 = await res2.json();
    // Duplikat case-insensitive dibuang, urutan pertama dipertahankan.
    expect(body2.service.category).toEqual(['Paket', 'Perawatan']);
  });

  it('kategori semua kosong/duplikat → null (tidak disimpan)', async () => {
    const res = await req('/api/services', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Cuci Standar',
        category: ['  ', ' ', ''],
        staffIds: [],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.service.category).toBeNull();
  });

  it('durationMinutes default 60', async () => {
    const res = await req('/api/services', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.service.durationMinutes).toBe(60);
  });

  it('priceMinor null diterima (harga belum di-set)', async () => {
    const res = await req('/api/services', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X', priceMinor: null }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.service.priceMinor).toBeNull();
  });

  it('membuat layanan dengan staf ter-assign → staffIds tersimpan', async () => {
    dbState.tables.set('staff_members', [baseStaff()]);
    const res = await req('/api/services', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X', staffIds: [STAFF_ID] }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.service.staffIds).toEqual([STAFF_ID]);
  });

  it('staf workspace lain → 400', async () => {
    dbState.tables.set('staff_members', [baseStaff({ workspaceId: 'ws-2' })]);
    const res = await req('/api/services', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X', staffIds: [STAFF_ID] }),
    });
    expect(res.status).toBe(400);
  });

  it('staf nonaktif → 400', async () => {
    dbState.tables.set('staff_members', [baseStaff({ isActive: false })]);
    const res = await req('/api/services', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X', staffIds: [STAFF_ID] }),
    });
    expect(res.status).toBe(400);
  });

  it('nama kosong → 400', async () => {
    const res = await req('/api/services', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    });
    expect(res.status).toBe(400);
  });

  it('durasi di luar 5..720 → 400', async () => {
    const res = await req('/api/services', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X', durationMinutes: 1 }),
    });
    expect(res.status).toBe(400);
  });

  it('harga negatif → 400', async () => {
    const res = await req('/api/services', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X', priceMinor: -5 }),
    });
    expect(res.status).toBe(400);
  });

  it('warna bukan hex → 400', async () => {
    const res = await req('/api/services', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X', color: 'merah' }),
    });
    expect(res.status).toBe(400);
  });

  it('mata uang tidak didukung → 400', async () => {
    const res = await req('/api/services', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X', currency: 'XYZ' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/services/:id', () => {
  it('layanan tidak ada → 404', async () => {
    const res = await req(`/api/services/${SERVICE_ID}`);
    expect(res.status).toBe(404);
  });

  it('mengembalikan detail layanan', async () => {
    dbState.tables.set('services', [baseService()]);
    const res = await req(`/api/services/${SERVICE_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.service.name).toBe('Haircut & Styling');
  });

  it('layanan workspace lain → 404', async () => {
    dbState.tables.set('services', [baseService({ workspaceId: 'ws-2' })]);
    const res = await req(`/api/services/${SERVICE_ID}`);
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/services/:id', () => {
  it('update parsial berhasil', async () => {
    dbState.tables.set('services', [baseService()]);
    const res = await req(`/api/services/${SERVICE_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Haircut Premium', durationMinutes: 75 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.service.name).toBe('Haircut Premium');
    expect(body.service.durationMinutes).toBe(75);
    expect(body.service.priceMinor).toBe(50_000);
  });

  it('priceMinor null menghapus harga', async () => {
    dbState.tables.set('services', [baseService()]);
    const res = await req(`/api/services/${SERVICE_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ priceMinor: null }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.service.priceMinor).toBeNull();
  });

  it('mengganti staff assignment (replace-all)', async () => {
    dbState.tables.set('services', [baseService()]);
    dbState.tables.set('staff_members', [baseStaff()]);
    dbState.tables.set('service_staff', [
      { id: 'link-old', serviceId: SERVICE_ID, staffId: 'some-other-staff' },
    ]);
    const res = await req(`/api/services/${SERVICE_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ staffIds: [STAFF_ID] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.service.staffIds).toEqual([STAFF_ID]);
    // Tautan lama sudah dihapus (replace-all), bukan ditumpuk.
    const links = dbState.tables.get('service_staff') ?? [];
    expect(links).toHaveLength(1);
  });

  it('isActive false diterima', async () => {
    dbState.tables.set('services', [baseService()]);
    const res = await req(`/api/services/${SERVICE_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ isActive: false }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.service.isActive).toBe(false);
  });

  it('layanan tidak ada → 404', async () => {
    const res = await req(`/api/services/${SERVICE_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X' }),
    });
    expect(res.status).toBe(404);
  });

  it('staf invalid → 400', async () => {
    dbState.tables.set('services', [baseService()]);
    dbState.tables.set('staff_members', [baseStaff({ workspaceId: 'ws-2' })]);
    const res = await req(`/api/services/${SERVICE_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ staffIds: [STAFF_ID] }),
    });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/services/:id', () => {
  it('menghapus layanan → ok', async () => {
    dbState.tables.set('services', [baseService()]);
    const res = await req(`/api/services/${SERVICE_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: SERVICE_ID });
  });

  it('layanan tidak ada → 404', async () => {
    const res = await req(`/api/services/${SERVICE_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('layanan workspace lain tidak bisa dihapus (scoping → 404)', async () => {
    dbState.tables.set('services', [baseService({ workspaceId: 'ws-2' })]);
    const res = await req(`/api/services/${SERVICE_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});
