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

// Inngest — booking routes memicu event reminder; mock agar tidak ada network.
vi.mock('../inngest/client.ts', () => ({
  inngest: { send: vi.fn().mockResolvedValue(undefined) },
}));

// ── Fake Drizzle db ──────────────────────────────────────────────
// Implementasi minimal chain query yang dipakai route bookings + helper
// contact-sync (select/insert/update + thenable). `where` diabaikan —
// tiap test menyiapkan state tabel yang relevan.
const { dbState } = vi.hoisted(() => ({
  dbState: {
    tables: new Map<string, unknown[]>(),
    seq: 1,
  },
}));

vi.mock('../db/index.ts', async () => {
  const { bookings, calleCalls, contacts, workspaces } = await import('@oriole/database');
  const tableNames = new WeakMap<object, string>();
  tableNames.set(bookings, 'bookings');
  tableNames.set(calleCalls, 'calleCalls');
  tableNames.set(contacts, 'contacts');
  tableNames.set(workspaces, 'workspaces');

  /** Map nama kolom DB (mis. workspace_id) → kunci baris (workspaceId). */
  function columnKeyMap(table: object): Record<string, string> {
    const map: Record<string, string> = {};
    for (const [key, col] of Object.entries(table as Record<string, unknown>)) {
      if (col && typeof col === 'object' && 'name' in col && typeof (col as { name: unknown }).name === 'string') {
        map[(col as { name: string }).name] = key;
      }
    }
    return map;
  }

  /** Chunk SQL: punya queryChunks sendiri (grup and/or atau leaf). */
  const isSqlChunk = (c: unknown): c is { queryChunks: unknown[] } =>
    !!c && typeof c === 'object' && Array.isArray((c as { queryChunks?: unknown }).queryChunks);
  /** Chunk StringChunk: {value: [string]} — operator/pemisah (' and ', ' or ', '(' …). */
  const isStringChunk = (c: unknown): c is { value: unknown[] } =>
    !!c && typeof c === 'object' && Array.isArray((c as { value?: unknown }).value) &&
    ((c as { value: unknown[] }).value.every((v) => typeof v === 'string'));
  /** Chunk kolom: punya nama DB + referensi tabel. */
  const isColumnChunk = (c: unknown): c is { name: string } =>
    !!c && typeof c === 'object' && typeof (c as { name?: unknown }).name === 'string' &&
    'table' in (c as object);

  /**
   * Bangun predikat baris dari kondisi Drizzle (queryChunks). Mendukung
   * leaf eq/ilike/isNotNull/perbandingan/in serta grup and/or bersarang
   * (drizzle membungkus grup sebagai SQL child ber-paren).
   * Dipakai mock agar `where` benar-benar memfilter — tanpa ini bug scoping
   * workspace / filter customer tidak akan ketahuan.
   */
  function buildPredicate(
    cond: unknown,
    colKey: Record<string, string>,
  ): (row: Record<string, unknown>) => boolean {
    const chunks = (cond as { queryChunks?: unknown[] } | null)?.queryChunks;
    if (!Array.isArray(chunks) || chunks.length === 0) return () => true;

    // Grup and/or: punya child SQL (sub-kondisi) → gabung per pemisah.
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

    // Leaf: [op:'', {COL}, {op}, <nilai>, op:''] — ekstrak kolom/op/nilai.
    let colName: string | null = null;
    let op = '';
    let value: unknown;
    for (const chunk of chunks) {
      if (isColumnChunk(chunk)) {
        colName = chunk.name;
        continue;
      }
      if (isStringChunk(chunk)) {
        const maybeOp = chunk.value.join('').trim();
        if (maybeOp) op = maybeOp;
        continue;
      }
      if (chunk && typeof chunk === 'object' && 'value' in (chunk as object)) {
        value = (chunk as { value: unknown }).value; // param (string/date/array)
      } else if (typeof chunk === 'string' || typeof chunk === 'number' || typeof chunk === 'boolean') {
        value = chunk; // param ilike polos (mis. '%andi%')
      }
    }
    if (!colName) return () => true;
    const key = colKey[colName];
    if (key === undefined) return () => true;

    const get = (row: Record<string, unknown>) => row[key];
    if (op.includes('ilike') || op.includes(' like ')) {
      const needle = String(value ?? '').replace(/^%/, '').replace(/%$/, '').toLowerCase();
      return (row) => String(get(row) ?? '').toLowerCase().includes(needle);
    }
    if (op.includes('is not null')) return (row) => get(row) != null;
    if (op.includes('is null')) return (row) => get(row) == null;
    if (op.includes('>=')) return (row) => (get(row) as number) >= (value as number);
    if (op.includes('<=')) return (row) => (get(row) as number) <= (value as number);
    if (op.includes('>')) return (row) => (get(row) as number) > (value as number);
    if (op.includes('<')) return (row) => (get(row) as number) < (value as number);
    if (op.includes(' in ')) {
      const list = Array.isArray(value) ? (value as unknown[]) : [];
      return (row) => list.includes(get(row));
    }
    return (row) => get(row) === value;
  }

  function makeSelectBuilder(name: string, table: object, fields?: Record<string, unknown>) {
    const colKey = columnKeyMap(table);
    const builder: {
      where: (...conds: unknown[]) => typeof builder;
      groupBy: (...cols: unknown[]) => typeof builder;
      orderBy: (...cols: unknown[]) => typeof builder;
      limit: (n: number) => typeof builder;
      then: (resolve: (rows: unknown[]) => unknown) => Promise<unknown>;
      _limit?: number;
      _groupBy?: string[];
      _filters: ((row: Record<string, unknown>) => boolean)[];
    } = {
      _limit: undefined,
      _groupBy: [],
      _filters: [],
      where(...conds) {
        builder._filters = conds.map((c) => buildPredicate(c, colKey));
        return builder;
      },
      groupBy(...cols) {
        builder._groupBy = cols
          .map((c) => colKey[(c as { name?: string } | undefined)?.name ?? ''])
          .filter((k): k is string => k !== undefined);
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
        let rows = [...(dbState.tables.get(name) ?? [])];
        if (builder._filters.length > 0) {
          rows = rows.filter((row) => builder._filters.every((pred) => pred(row as Record<string, unknown>)));
        }
        // Group by: dedupe mempertahankan baris pertama (urutan mock = insert).
        if (builder._groupBy && builder._groupBy.length > 0) {
          const seen = new Set<string>();
          rows = rows.filter((row) => {
            const rowObj = row as Record<string, unknown>;
            const key = builder._groupBy!.map((k) => String(rowObj[k] ?? '')).join('|');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        }
        if (builder._limit != null) rows = rows.slice(0, builder._limit);
        // Proyeksi select({..}): petakan alias → nilai kolom (kunci baris).
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
  }

  const now = new Date('2026-01-01T00:00:00.000Z');

  return {
    db: {
      select: (fields?: Record<string, unknown>) => ({
        from: (table: object) => makeSelectBuilder(tableNames.get(table) ?? 'unknown', table, fields),
      }),
      insert: (table: object) => {
        const name = tableNames.get(table) ?? 'unknown';
        return {
          values: (values: Record<string, unknown>) => {
            const idPrefix = name === 'bookings' ? 'booking-' : 'contact-';
            const row: Record<string, unknown> = {
              ...values,
              id: `${idPrefix}${dbState.seq++}`,
              createdAt: now,
              updatedAt: now,
            };
            if (name === 'bookings') {
              row.status ??= 'pending';
              row.contactId ??= null;
            }
            return {
              returning: async () => {
                dbState.tables.get(name)?.push(row);
                return [row];
              },
              onConflictDoNothing: () => ({
                returning: async () => {
                  const rows = dbState.tables.get(name) ?? [];
                  const duplicate = rows.some(
                    (r) =>
                      (r as Record<string, unknown>).workspaceId === values.workspaceId &&
                      (r as Record<string, unknown>).phone === values.phone,
                  );
                  if (duplicate) return [];
                  dbState.tables.get(name)?.push(row);
                  return [{ id: row.id }];
                },
              }),
            };
          },
        };
      },
      update: (table: object) => {
        const name = tableNames.get(table) ?? 'unknown';
        return {
          set: (values: Record<string, unknown>) => ({
            where: () => ({
              returning: async () => {
                const rows = dbState.tables.get(name) ?? [];
                const target = rows[0] as Record<string, unknown> | undefined;
                if (!target) return [];
                const merged = {
                  ...target,
                  ...values,
                  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
                };
                rows[0] = merged;
                return [merged];
              },
            }),
          }),
        };
      },
    },
  };
});

const AUTH_HEADER = { Authorization: 'Bearer test-jwt-token' };
const WORKSPACE_HEADER = { 'X-Workspace-Id': 'ws-1' };

const BOOKING_ID = '99999999-9999-4999-8999-999999999999';
const EXISTING_CONTACT_ID = '11111111-1111-4111-8111-111111111111';

function baseContact(overrides: Record<string, unknown> = {}) {
  return {
    id: EXISTING_CONTACT_ID,
    name: 'Budi Santoso',
    phone: '+628123456789',
    email: null,
    notes: null,
    userId: 'test-user-1',
    workspaceId: 'ws-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function baseBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    title: 'Teeth Whitening',
    description: null,
    scheduledAt: new Date('2026-02-01T10:00:00.000Z'),
    timezone: 'Asia/Jakarta',
    status: 'pending',
    customerName: 'Andi Putra',
    phone: null,
    contactId: null,
    industry: null,
    goalType: null,
    customInstruction: null,
    noShowCount: 0,
    changeRequested: false,
    calleCallId: null,
    userId: 'test-user-1',
    workspaceId: 'ws-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

// ── Setup app (env + route) sebelum semua describe ─────────────
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

  const { bookingsRoutes } = await import('./bookings.ts');
  app = new Hono().route('/api/bookings', bookingsRoutes);
});

beforeEach(() => {
  dbState.seq = 1;
  dbState.tables.set('workspaces', [{ id: 'ws-1', userId: 'test-user-1' }]);
  dbState.tables.set('bookings', []);
  dbState.tables.set('contacts', []);
  dbState.tables.set('calleCalls', []);
});

function postBooking(payload: Record<string, unknown>) {
  return app.request('/api/bookings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...AUTH_HEADER, ...WORKSPACE_HEADER },
    body: JSON.stringify(payload),
  });
}

describe('POST /api/bookings — integrasi kontak', () => {
  it('customer dengan nama+telepon, belum ada kontak → kontak baru dibuat & booking ditautkan', async () => {
    const res = await postBooking({
      title: 'Teeth Whitening — Andi Putra',
      scheduledAt: '2026-02-01T10:00:00.000Z',
      timezone: 'Asia/Jakarta',
      customerName: 'Andi Putra',
      phone: '+62 812 3456 789',
    });
    expect(res.status).toBe(201);
    const body = await res.json();

    const contactsRows = dbState.tables.get('contacts') as Record<string, unknown>[];
    expect(contactsRows).toHaveLength(1);
    // ID kontak baru = id yang disimpan (seq berbagi dengan insert booking).
    expect(body.booking.contactId).toBe((contactsRows[0] as { id: string }).id);
    expect(contactsRows[0]).toMatchObject({
      name: 'Andi Putra',
      phone: '+628123456789',
      userId: 'test-user-1',
      workspaceId: 'ws-1',
    });
  });

  it('nomor sudah ada sebagai kontak → ditautkan, tanpa kontak duplikat', async () => {
    dbState.tables.set('contacts', [baseContact()]); // phone +628123456789

    const res = await postBooking({
      title: 'Konsultasi — Budi Santoso',
      scheduledAt: '2026-02-02T10:00:00.000Z',
      customerName: 'Budi Santoso',
      phone: '+62 812 3456 789',
    });
    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body.booking.contactId).toBe(EXISTING_CONTACT_ID);
    expect(dbState.tables.get('contacts')).toHaveLength(1);
  });

  it('kontak dengan nomor sama di workspace LAIN → tidak tertaut; kontak baru dibuat di workspace ini', async () => {
    // Nomor sama tetapi workspace berbeda — harus tetap membuat kontak baru
    // di ws-1 (scoping per workspace, bukan global).
    dbState.tables.set('contacts', [baseContact({ workspaceId: 'ws-2' })]);

    const res = await postBooking({
      title: 'Isolasi workspace',
      scheduledAt: '2026-02-05T10:00:00.000Z',
      customerName: 'Budi Santoso',
      phone: '+62 812 3456 789',
    });
    expect(res.status).toBe(201);
    const body = await res.json();

    const contactsRows = dbState.tables.get('contacts') as Record<string, unknown>[];
    expect(contactsRows).toHaveLength(2);
    expect(body.booking.contactId).toBe((contactsRows[1] as { id: string }).id);
    expect((contactsRows[1] as Record<string, unknown>).workspaceId).toBe('ws-1');
  });

  it('telepon tanpa nama → tidak membuat kontak (nama wajib), booking tidak tertaut', async () => {
    const res = await postBooking({
      title: 'Tanpa nama',
      scheduledAt: '2026-02-03T10:00:00.000Z',
      phone: '+62 812 555 0101',
    });
    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body.booking.contactId).toBeNull();
    expect(dbState.tables.get('contacts')).toHaveLength(0);
  });

  it('tanpa telepon sama sekali → contactId null, tidak ada kontak dibuat', async () => {
    const res = await postBooking({
      title: 'Belum ada nomor',
      scheduledAt: '2026-02-04T10:00:00.000Z',
      customerName: 'Sari',
    });
    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body.booking.contactId).toBeNull();
    expect(dbState.tables.get('contacts')).toHaveLength(0);
  });
});

describe('GET /api/bookings — filter daftar', () => {
  function listBookings(query: string) {
    return app.request(`/api/bookings${query}`, { headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER } });
  }

  it('filter customer: substring nama case-insensitive', async () => {
    dbState.tables.set('bookings', [
      baseBooking({ id: 'aaaa0001-0000-4000-8000-000000000001', customerName: 'Andi Putra', phone: '+6281111111', title: 'Teeth Whitening' }),
      baseBooking({ id: 'aaaa0002-0000-4000-8000-000000000002', customerName: 'Sari Andini', phone: '+6282222222', title: 'Facial' }),
      baseBooking({ id: 'aaaa0003-0000-4000-8000-000000000003', customerName: 'Budi Santoso', phone: '+6283333333', title: 'Checkup' }),
    ]);

    const res = await listBookings('?customer=andi');
    expect(res.status).toBe(200);
    const body = await res.json();
    const names = (body.bookings as { customerName: string | null }[]).map((b) => b.customerName).sort();
    expect(names).toEqual(['Andi Putra', 'Sari Andini']);
  });

  it('filter customer: mencocokkan nomor telepon', async () => {
    dbState.tables.set('bookings', [
      baseBooking({ id: 'aaaa0001-0000-4000-8000-000000000001', customerName: 'Andi Putra', phone: '+628123456789', title: 'Teeth Whitening' }),
      baseBooking({ id: 'aaaa0002-0000-4000-8000-000000000002', customerName: 'Budi Santoso', phone: '+6283333333', title: 'Checkup' }),
    ]);

    const res = await listBookings('?customer=8123456');
    expect(res.status).toBe(200);
    const body = await res.json();
    const names = (body.bookings as { customerName: string | null }[]).map((b) => b.customerName);
    expect(names).toEqual(['Andi Putra']);
  });

  it('filter title (kolom Booking): substring case-insensitive', async () => {
    dbState.tables.set('bookings', [
      baseBooking({ id: 'aaaa0001-0000-4000-8000-000000000001', title: 'Teeth Whitening — Andi' }),
      baseBooking({ id: 'aaaa0002-0000-4000-8000-000000000002', title: 'Haircut' }),
      baseBooking({ id: 'aaaa0003-0000-4000-8000-000000000003', title: 'Teeth Cleaning' }),
    ]);

    const res = await listBookings('?title=teeth');
    expect(res.status).toBe(200);
    const body = await res.json();
    const titles = (body.bookings as { title: string }[]).map((b) => b.title).sort();
    expect(titles).toEqual(['Teeth Cleaning', 'Teeth Whitening — Andi']);
  });

  it('filter gabungan title + customer', async () => {
    dbState.tables.set('bookings', [
      baseBooking({ id: 'aaaa0001-0000-4000-8000-000000000001', title: 'Teeth Whitening', customerName: 'Andi Putra' }),
      baseBooking({ id: 'aaaa0002-0000-4000-8000-000000000002', title: 'Teeth Whitening', customerName: 'Budi Santoso' }),
      baseBooking({ id: 'aaaa0003-0000-4000-8000-000000000003', title: 'Facial', customerName: 'Andi Putra' }),
    ]);

    const res = await listBookings('?title=teeth&customer=andi');
    expect(res.status).toBe(200);
    const body = await res.json();
    const rows = body.bookings as { title: string; customerName: string | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: 'Teeth Whitening', customerName: 'Andi Putra' });
  });

  it('tanpa filter → semua booking workspace kembali', async () => {
    dbState.tables.set('bookings', [
      baseBooking({ id: 'aaaa0001-0000-4000-8000-000000000001', title: 'Satu' }),
      baseBooking({ id: 'aaaa0002-0000-4000-8000-000000000002', title: 'Dua' }),
    ]);

    const res = await listBookings('');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.bookings).toHaveLength(2);
  });
});

describe('GET /api/bookings/customers — saran customer untuk filter', () => {
  function listCustomers(query: string) {
    return app.request(`/api/bookings/customers${query}`, {
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
  }

  it('mengembalikan nama customer unik (dedupe), tanpa nama null', async () => {
    dbState.tables.set('bookings', [
      baseBooking({ id: 'aaaa0001-0000-4000-8000-000000000001', customerName: 'Andi Putra', phone: '+6281111111' }),
      baseBooking({ id: 'aaaa0002-0000-4000-8000-000000000002', customerName: 'Andi Putra', phone: '+6289999999' }),
      baseBooking({ id: 'aaaa0003-0000-4000-8000-000000000003', customerName: 'Budi Santoso', phone: '+6283333333' }),
      baseBooking({ id: 'aaaa0004-0000-4000-8000-000000000004', customerName: null, phone: '+6280000000' }),
    ]);

    const res = await listCustomers('');
    expect(res.status).toBe(200);
    const body = await res.json();
    const names = (body.customers as { name: string }[]).map((c) => c.name).sort();
    expect(names).toEqual(['Andi Putra', 'Budi Santoso']);
  });

  it('q memfilter nama customer (case-insensitive)', async () => {
    dbState.tables.set('bookings', [
      baseBooking({ id: 'aaaa0001-0000-4000-8000-000000000001', customerName: 'Andi Putra', phone: '+6281111111' }),
      baseBooking({ id: 'aaaa0002-0000-4000-8000-000000000002', customerName: 'Budi Santoso', phone: '+6283333333' }),
    ]);

    const res = await listCustomers('?q=budi');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.customers).toEqual([{ name: 'Budi Santoso' }]);
  });

  it('q mencocokkan nomor telepon', async () => {
    dbState.tables.set('bookings', [
      baseBooking({ id: 'aaaa0001-0000-4000-8000-000000000001', customerName: 'Andi Putra', phone: '+628123456789' }),
    ]);

    const res = await listCustomers('?q=8123456');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.customers).toEqual([{ name: 'Andi Putra' }]);
  });

  it('limit membatasi jumlah hasil', async () => {
    dbState.tables.set('bookings', [
      baseBooking({ id: 'aaaa0001-0000-4000-8000-000000000001', customerName: 'Andi Putra' }),
      baseBooking({ id: 'aaaa0002-0000-4000-8000-000000000002', customerName: 'Budi Santoso' }),
      baseBooking({ id: 'aaaa0003-0000-4000-8000-000000000003', customerName: 'Citra' }),
    ]);

    const res = await listCustomers('?limit=2');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.customers).toHaveLength(2);
  });
});

describe('PATCH /api/bookings/:id — integrasi kontak', () => {
  it('nomor ditambahkan belakangan → kontak dibuat & ditautkan', async () => {
    dbState.tables.set('bookings', [baseBooking()]); // phone null

    const res = await app.request(`/api/bookings/${BOOKING_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...AUTH_HEADER, ...WORKSPACE_HEADER },
      body: JSON.stringify({ phone: '+62 812 3456 789' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.booking.contactId).toBe('contact-1');
    expect(dbState.tables.get('contacts')).toHaveLength(1);
  });

  it('telepon dihapus → tautan kontak dilepas, kontak tetap ada', async () => {
    dbState.tables.set('bookings', [
      baseBooking({ phone: '+628123456789', contactId: EXISTING_CONTACT_ID }),
    ]);
    dbState.tables.set('contacts', [baseContact()]);

    const res = await app.request(`/api/bookings/${BOOKING_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...AUTH_HEADER, ...WORKSPACE_HEADER },
      body: JSON.stringify({ phone: null }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.booking.contactId).toBeNull();
    expect(dbState.tables.get('contacts')).toHaveLength(1);
  });

  it('ubah nama customer dengan nomor yang sudah jadi kontak → ditautkan tanpa duplikat', async () => {
    dbState.tables.set('bookings', [baseBooking({ phone: '+628123456789' })]);
    dbState.tables.set('contacts', [baseContact()]);

    const res = await app.request(`/api/bookings/${BOOKING_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...AUTH_HEADER, ...WORKSPACE_HEADER },
      body: JSON.stringify({ customerName: 'Budi Santoso Baru' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.booking.contactId).toBe(EXISTING_CONTACT_ID);
    expect(dbState.tables.get('contacts')).toHaveLength(1);
  });

  it('ubah hanya status → tautan kontak tidak disentuh', async () => {
    dbState.tables.set('bookings', [
      baseBooking({ phone: '+628123456789', contactId: EXISTING_CONTACT_ID }),
    ]);
    dbState.tables.set('contacts', [baseContact()]);

    const res = await app.request(`/api/bookings/${BOOKING_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...AUTH_HEADER, ...WORKSPACE_HEADER },
      body: JSON.stringify({ status: 'confirmed' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.booking.contactId).toBe(EXISTING_CONTACT_ID);
    expect(body.booking.status).toBe('confirmed');
    expect(dbState.tables.get('contacts')).toHaveLength(1);
  });
});
