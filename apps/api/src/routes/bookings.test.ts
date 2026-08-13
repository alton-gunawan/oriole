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
  const {
    bookings,
    calleCalls,
    contacts,
    staffMembers,
    staffSchedules,
    staffTimeOff,
    services,
    serviceStaff,
    workspaceIntegrations,
    workspaces,
  } = await import('@oriole/database');
  const tableNames = new WeakMap<object, string>();
  tableNames.set(bookings, 'bookings');
  tableNames.set(calleCalls, 'calleCalls');
  tableNames.set(contacts, 'contacts');
  tableNames.set(staffMembers, 'staff_members');
  tableNames.set(staffSchedules, 'staff_schedules');
  tableNames.set(staffTimeOff, 'staff_time_off');
  tableNames.set(services, 'services');
  tableNames.set(serviceStaff, 'service_staff');
  tableNames.set(workspaceIntegrations, 'workspace_integrations');
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

    // Leaf: [op:'', {COL}, {op}, <nilai...>, op:''] — ekstrak kolom/op/param.
    // inArray menghasilkan SATU chunk param per nilai (bukan array) — kumpulkan
    // semua param agar `in (...)` benar-benar memfilter.
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
      // Parameter Drizzle: objek {value} (string/date) ATAU satu chunk Array
      // berisi daftar nilai inArray (Parameter/mentah).
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
        params.push((chunk as { value: unknown }).value); // param (string/date)
      } else if (typeof chunk === 'string' || typeof chunk === 'number' || typeof chunk === 'boolean') {
        params.push(chunk); // param ilike polos (mis. '%andi%')
      }
    }
    if (!colName) return () => true;
    const key = colKey[colName];
    if (key === undefined) return () => true;

    // Operator = string chunk yang dikenali (paren/koma diabaikan). Ruang
    // putih dinormalkan agar 'is not null' / ' is not null' cocok sama-sama.
    const joined = stringParts.join('').replace(/\s+/g, ' ').trim();
    // inArray dirender sebagai 'in' (tanpa spasi) — ' in ' juga ditangani.
    const OP_CANDIDATES = ['ilike', ' like ', 'is not null', 'is null', '>=', '<=', '!=', '<>', ' in ', 'in', '>', '<', '='];
    const op = OP_CANDIDATES.find((candidate) => joined.includes(candidate)) ?? '';

    const get = (row: Record<string, unknown>) => row[key];
    const value = params[0];
    if (op.includes('!=') || op.includes('<>')) return (row) => get(row) !== value;
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
    if (op === 'in' || op.includes(' in ')) {
      // inArray: semua chunk param adalah anggota list.
      return (row) => params.includes(get(row));
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
        const doUpdate = (values: Record<string, unknown>, conds: unknown[]) => {
          const colKey = columnKeyMap(table);
          const matched = (dbState.tables.get(name) ?? []).filter((row) =>
            conds.every((c) => buildPredicate(c, colKey)(row as Record<string, unknown>)),
          );
          if (matched.length === 0) return [];
          const store = dbState.tables.get(name) as unknown[] | undefined;
          const updated = [];
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
              // update().where().returning() — route yang butuh baris balik.
              returning: async () => doUpdate(values, conds),
              // update().where() TANPA returning — route cukup await; tulis tetap jalan.
              then(resolve: (rows: unknown[]) => unknown) {
                return Promise.resolve(resolve(doUpdate(values, conds)));
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
    staffId: null,
    serviceId: null,
    durationMinutes: 60,
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
  process.env.VAPI_API_KEY = 'vapi_test';
  process.env.VAPI_PHONE_NUMBER_ID = 'phone-number-test';

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
  dbState.tables.set('staff_members', []);
  dbState.tables.set('staff_schedules', []);
  dbState.tables.set('staff_time_off', []);
  dbState.tables.set('services', []);
  dbState.tables.set('service_staff', []);
  dbState.tables.set('workspace_integrations', []);
});

function postBooking(payload: Record<string, unknown>) {
  // Booking WAJIB berasal dari layanan katalog: bila payload tidak menyebut
  // serviceId, suntik layanan default (dan seed katalog bila kosong) agar test
  // tetap fokus pada perilaku yang diuji. Payload dengan serviceId eksplisit
  // (termasuk null) dibiarkan apa adanya.
  if (payload.serviceId === undefined) {
    if ((dbState.tables.get('services') ?? []).length === 0) {
      dbState.tables.set('services', [baseService()]);
    }
    payload = { ...payload, serviceId: SERVICE_ID };
  }
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

describe('POST /api/bookings/:id/ensure-contact — link-on-demand', () => {
  it('booking tidak ditemukan → 404', async () => {
    const res = await app.request(`/api/bookings/${BOOKING_ID}/ensure-contact`, {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(404);
  });

  it('booking dengan nama+telepon, kontak belum ada → kontak dibuat & contactId dikembalikan', async () => {
    dbState.tables.set('bookings', [baseBooking({ phone: '+628123456789' })]);
    const res = await app.request(`/api/bookings/${BOOKING_ID}/ensure-contact`, {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    const contactsRows = dbState.tables.get('contacts') as Record<string, unknown>[];
    expect(contactsRows).toHaveLength(1);
    expect(body.contactId).toBe((contactsRows[0] as { id: string }).id);
    expect(contactsRows[0]).toMatchObject({
      name: 'Andi Putra',
      phone: '+628123456789',
      userId: 'test-user-1',
      workspaceId: 'ws-1',
    });
    // Booking ditautkan ke kontak yang sama.
    const bookingRow = (dbState.tables.get('bookings') as Record<string, unknown>[])[0];
    expect(bookingRow.contactId).toBe(body.contactId);
  });

  it('nomor sudah ada sebagai kontak → contactId sama, tanpa duplikat', async () => {
    dbState.tables.set('bookings', [baseBooking({ phone: '+628123456789' })]);
    dbState.tables.set('contacts', [baseContact()]); // phone +628123456789
    const res = await app.request(`/api/bookings/${BOOKING_ID}/ensure-contact`, {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contactId).toBe(EXISTING_CONTACT_ID);
    expect(dbState.tables.get('contacts')).toHaveLength(1);
  });

  it('booking tanpa telepon → contactId null, tidak ada kontak dibuat', async () => {
    dbState.tables.set('bookings', [baseBooking()]); // phone null
    const res = await app.request(`/api/bookings/${BOOKING_ID}/ensure-contact`, {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contactId).toBeNull();
    expect(dbState.tables.get('contacts')).toHaveLength(0);
  });

  it('id bukan UUID → 400', async () => {
    const res = await app.request('/api/bookings/not-a-uuid/ensure-contact', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(400);
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

  it('filter title (label UI: Service): substring nama layanan case-insensitive', async () => {
    dbState.tables.set('services', [
      baseService({ id: 'svc-teeth-1', name: 'Teeth Whitening — Andi' }),
      baseService({ id: 'svc-hair', name: 'Haircut' }),
      baseService({ id: 'svc-clean', name: 'Teeth Cleaning' }),
    ]);
    dbState.tables.set('bookings', [
      baseBooking({ id: 'aaaa0001-0000-4000-8000-000000000001', serviceId: 'svc-teeth-1' }),
      baseBooking({ id: 'aaaa0002-0000-4000-8000-000000000002', serviceId: 'svc-hair' }),
      baseBooking({ id: 'aaaa0003-0000-4000-8000-000000000003', serviceId: 'svc-clean' }),
    ]);

    const res = await listBookings('?title=teeth');
    expect(res.status).toBe(200);
    const body = await res.json();
    const titles = (body.bookings as { title: string }[]).map((b) => b.title).sort();
    expect(titles).toEqual(['Teeth Cleaning', 'Teeth Whitening — Andi']);
  });

  it('filter gabungan layanan + customer', async () => {
    dbState.tables.set('services', [
      baseService({ id: 'svc-teeth', name: 'Teeth Whitening' }),
      baseService({ id: 'svc-facial', name: 'Facial' }),
    ]);
    dbState.tables.set('bookings', [
      baseBooking({ id: 'aaaa0001-0000-4000-8000-000000000001', serviceId: 'svc-teeth', customerName: 'Andi Putra' }),
      baseBooking({ id: 'aaaa0002-0000-4000-8000-000000000002', serviceId: 'svc-teeth', customerName: 'Budi Santoso' }),
      baseBooking({ id: 'aaaa0003-0000-4000-8000-000000000003', serviceId: 'svc-facial', customerName: 'Andi Putra' }),
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

  it('serviceName diisi dari katalog (tenant-scoped) — null bila tidak tertaut', async () => {
    dbState.tables.set('services', [baseService()]);
    dbState.tables.set('bookings', [
      baseBooking({
        id: 'aaaa0001-0000-4000-8000-000000000001',
        title: 'Haircut & Styling',
        serviceId: SERVICE_ID,
        durationMinutes: 60,
      }),
      baseBooking({ id: 'aaaa0002-0000-4000-8000-000000000002', title: 'Manual lama' }),
    ]);

    const res = await listBookings('');
    expect(res.status).toBe(200);
    const body = await res.json();
    const byId = new Map((body.bookings as { id: string; serviceName: string | null }[]).map((b) => [b.id, b]));
    expect(byId.get('aaaa0001-0000-4000-8000-000000000001')).toMatchObject({ serviceName: 'Haircut & Styling' });
    expect(byId.get('aaaa0002-0000-4000-8000-000000000002')).toMatchObject({ serviceName: null });
  });

  it('serviceName hanya dari workspace sendiri (cross-tenant tidak bocor)', async () => {
    // Layanan milik ws-2 — booking ws-1 yang menautkannya harus tetap null.
    dbState.tables.set('services', [baseService({ workspaceId: 'ws-2' })]);
    dbState.tables.set('bookings', [
      baseBooking({ id: 'aaaa0001-0000-4000-8000-000000000001', serviceId: SERVICE_ID }),
    ]);

    const res = await listBookings('');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect((body.bookings as { serviceName: string | null }[])[0].serviceName).toBeNull();
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

/* ────────────────────────────────────────────────────────────
 * Staf & durasi — assignment, validasi, double-booking, recurrence
 * ──────────────────────────────────────────────────────────── */

const STAFF_ID = '55555555-5555-4555-8555-555555555555';

function baseStaff(overrides: Record<string, unknown> = {}) {
  return {
    id: STAFF_ID,
    name: 'Dr. Sari',
    timezone: 'UTC',
    bufferMinutes: 0,
    isActive: true,
    userId: 'test-user-1',
    workspaceId: 'ws-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('POST /api/bookings — assignment staf & durasi', () => {
  it('dengan staffId valid → booking tertaut + durasi default 60', async () => {
    dbState.tables.set('staff_members', [baseStaff()]);
    const res = await postBooking({
      title: 'Konsultasi Dr. Sari',
      scheduledAt: '2026-02-02T10:00:00.000Z',
      staffId: STAFF_ID,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.booking.staffId).toBe(STAFF_ID);
    expect(body.booking.durationMinutes).toBe(60);
  });

  it('durasi kustom 90 menit disimpan', async () => {
    const res = await postBooking({
      title: 'Perawatan panjang',
      scheduledAt: '2026-02-02T10:00:00.000Z',
      durationMinutes: 90,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.booking.durationMinutes).toBe(90);
  });

  it('staffId workspace lain → 400', async () => {
    dbState.tables.set('staff_members', [baseStaff({ workspaceId: 'ws-2' })]);
    const res = await postBooking({
      title: 'X',
      scheduledAt: '2026-02-02T10:00:00.000Z',
      staffId: STAFF_ID,
    });
    expect(res.status).toBe(400);
  });

  it('staffId tidak dikenal → 400', async () => {
    const res = await postBooking({
      title: 'X',
      scheduledAt: '2026-02-02T10:00:00.000Z',
      staffId: STAFF_ID,
    });
    expect(res.status).toBe(400);
  });

  it('staffId nonaktif → 400', async () => {
    dbState.tables.set('staff_members', [baseStaff({ isActive: false })]);
    const res = await postBooking({
      title: 'X',
      scheduledAt: '2026-02-02T10:00:00.000Z',
      staffId: STAFF_ID,
    });
    expect(res.status).toBe(400);
  });
});

/* ── Layanan katalog (serviceId) — auto-fill title/durasi/staf ── */

const SERVICE_ID = '66666666-6666-4666-8666-666666666666';

function baseService(overrides: Record<string, unknown> = {}) {
  return {
    id: SERVICE_ID,
    name: 'Haircut & Styling',
    description: null,
    // Default 60 menit = durasi lama saat booking tanpa service; test yang
    // menguji auto-fill durasi meng-override eksplisit (mis. 45).
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

describe('POST /api/bookings — layanan katalog (serviceId)', () => {
  it('tanpa title, dengan serviceId → title & durasi auto-fill dari katalog', async () => {
    dbState.tables.set('services', [baseService({ durationMinutes: 45 })]); // durasi 45 menit
    const res = await postBooking({
      serviceId: SERVICE_ID,
      scheduledAt: '2026-02-02T10:00:00.000Z',
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.booking.title).toBe('Haircut & Styling');
    expect(body.booking.durationMinutes).toBe(45);
    expect(body.booking.serviceId).toBe(SERVICE_ID);
  });

  it('title tidak lagi diterima — title selalu nama layanan katalog', async () => {
    dbState.tables.set('services', [baseService()]);
    const res = await postBooking({
      title: 'Judul custom', // diabaikan (zod strip) — title dari katalog
      serviceId: SERVICE_ID,
      scheduledAt: '2026-02-02T10:00:00.000Z',
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.booking.title).toBe('Haircut & Styling');
    expect(body.booking.serviceId).toBe(SERVICE_ID);
  });

  it('layanan dengan satu staf → staf auto-assign', async () => {
    dbState.tables.set('services', [baseService()]);
    dbState.tables.set('staff_members', [baseStaff()]);
    dbState.tables.set('service_staff', [
      { id: 'link-1', serviceId: SERVICE_ID, staffId: STAFF_ID },
    ]);
    const res = await postBooking({
      serviceId: SERVICE_ID,
      scheduledAt: '2026-02-02T10:00:00.000Z',
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.booking.staffId).toBe(STAFF_ID);
  });

  it('layanan dengan banyak staf → tidak auto-assign', async () => {
    const OTHER_STAFF_ID = '77777777-7777-4777-8777-777777777777';
    dbState.tables.set('services', [baseService()]);
    dbState.tables.set('staff_members', [
      baseStaff(),
      baseStaff({ id: OTHER_STAFF_ID }),
    ]);
    dbState.tables.set('service_staff', [
      { id: 'link-1', serviceId: SERVICE_ID, staffId: STAFF_ID },
      { id: 'link-2', serviceId: SERVICE_ID, staffId: OTHER_STAFF_ID },
    ]);
    const res = await postBooking({
      serviceId: SERVICE_ID,
      scheduledAt: '2026-02-02T10:00:00.000Z',
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.booking.staffId).toBeNull();
  });

  it('serviceId workspace lain → 400 (scoping)', async () => {
    dbState.tables.set('services', [baseService({ workspaceId: 'ws-2' })]);
    const res = await postBooking({
      serviceId: SERVICE_ID,
      scheduledAt: '2026-02-02T10:00:00.000Z',
    });
    expect(res.status).toBe(400);
  });

  it('serviceId tidak dikenal → 400', async () => {
    const res = await postBooking({
      serviceId: SERVICE_ID,
      scheduledAt: '2026-02-02T10:00:00.000Z',
    });
    expect(res.status).toBe(400);
  });

  it('tanpa serviceId → 400 (booking wajib dari layanan katalog)', async () => {
    const res = await postBooking({ serviceId: null, scheduledAt: '2026-02-02T10:00:00.000Z' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/bookings — double-booking prevention', () => {
  it('slot bertabrakan dengan booking aktif → 409, tanpa insert', async () => {
    dbState.tables.set('bookings', [baseBooking()]); // 2026-02-01T10:00Z, 60 menit
    const res = await postBooking({
      title: 'Tabrakan',
      scheduledAt: '2026-02-01T10:00:00.000Z',
    });
    expect(res.status).toBe(409);
    expect(dbState.tables.get('bookings')).toHaveLength(1);
  });

  it('slot bersentuhan (mulai tepat saat booking lain selesai) → 201', async () => {
    dbState.tables.set('bookings', [baseBooking()]); // 10:00-11:00Z
    const res = await postBooking({
      title: 'Berurutan',
      scheduledAt: '2026-02-01T11:00:00.000Z',
    });
    expect(res.status).toBe(201);
  });

  it('booking dibatalkan tidak memblokir slot → 201', async () => {
    dbState.tables.set('bookings', [baseBooking({ status: 'cancelled' })]);
    const res = await postBooking({
      title: 'Slot kosong',
      scheduledAt: '2026-02-01T10:00:00.000Z',
    });
    expect(res.status).toBe(201);
  });

  it('staf berbeda → slot tidak bertabrakan → 201', async () => {
    dbState.tables.set('bookings', [baseBooking({ staffId: 'staff-A' })]);
    dbState.tables.set('staff_members', [baseStaff()]);
    const res = await postBooking({
      title: 'Staf lain',
      scheduledAt: '2026-02-01T10:00:00.000Z',
      staffId: STAFF_ID,
    });
    expect(res.status).toBe(201);
  });

  it('staf sama → slot bertabrakan → 409', async () => {
    dbState.tables.set('bookings', [baseBooking({ staffId: STAFF_ID })]);
    dbState.tables.set('staff_members', [baseStaff()]);
    const res = await postBooking({
      title: 'Staf sama',
      scheduledAt: '2026-02-01T10:00:00.000Z',
      staffId: STAFF_ID,
    });
    expect(res.status).toBe(409);
  });

  it('di luar jam kerja staf (ada jadwal) → 409', async () => {
    dbState.tables.set('staff_members', [baseStaff()]);
    dbState.tables.set('staff_schedules', [{ staffId: STAFF_ID, dayOfWeek: 0, startMinutes: 9 * 60, endMinutes: 17 * 60 }]);
    // 2026-02-01 = Minggu → jadwal Minggu 09:00-17:00 UTC; booking 07:00 di luar.
    const res = await postBooking({
      title: 'Di luar jam',
      scheduledAt: '2026-02-01T07:00:00.000Z',
      staffId: STAFF_ID,
    });
    expect(res.status).toBe(409);
  });

  it('staf tanpa jadwal → 24/7, booking diterima', async () => {
    dbState.tables.set('staff_members', [baseStaff()]);
    const res = await postBooking({
      title: 'Staf tanpa jadwal',
      scheduledAt: '2026-02-01T07:00:00.000Z',
      staffId: STAFF_ID,
    });
    expect(res.status).toBe(201);
  });
});

describe('POST /api/bookings — recurring appointments', () => {
  it('weekly [Sen, Rab] count 3 → 3 instance satu seri', async () => {
    const res = await postBooking({
      title: 'Fisioterapi mingguan',
      scheduledAt: '2026-02-02T10:00:00.000Z', // Senin
      recurrence: { frequency: 'weekly', interval: 1, weekdays: [1, 3], count: 3 },
    });
    expect(res.status).toBe(201);
    const body = await res.json();

    const rows = dbState.tables.get('bookings') as Record<string, unknown>[];
    expect(rows).toHaveLength(3);
    const seriesIds = new Set(rows.map((r) => r.recurrenceSeriesId));
    expect(seriesIds.size).toBe(1);
    expect(seriesIds.has(null)).toBe(false);
    expect(body.recurrence).toMatchObject({ occurrences: 3 });
    expect(body.recurrence.seriesId).toBe(rows[0].recurrenceSeriesId);

    // Instance mengikuti ekspansi (Sen 2, Rab 4, Sen 9) — UTC.
    const starts = rows.map((r) => (r.scheduledAt as Date).toISOString()).sort();
    expect(starts).toEqual([
      '2026-02-02T10:00:00.000Z',
      '2026-02-04T10:00:00.000Z',
      '2026-02-09T10:00:00.000Z',
    ]);
    // Semua instance berbagi recurrence + durasi + status.
    for (const row of rows) {
      expect(row.recurrence).toMatchObject({ frequency: 'weekly', count: 3 });
      expect(row.durationMinutes).toBe(60);
    }
  });

  it('tanpa recurrence → satu instance, recurrenceSeriesId null', async () => {
    const res = await postBooking({
      title: 'Sekali saja',
      scheduledAt: '2026-02-02T10:00:00.000Z',
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.booking.recurrenceSeriesId).toBeNull();
    expect(body.recurrence).toBeUndefined();
    expect(dbState.tables.get('bookings')).toHaveLength(1);
  });

  it('salah satu instance bertabrakan → 409 total, tidak ada insert sama sekali', async () => {
    dbState.tables.set('bookings', [baseBooking({ scheduledAt: new Date('2026-02-04T10:00:00.000Z') })]);
    const res = await postBooking({
      title: 'Seri tabrakan',
      scheduledAt: '2026-02-02T10:00:00.000Z',
      recurrence: { frequency: 'weekly', interval: 1, weekdays: [1, 3], count: 3 },
    });
    expect(res.status).toBe(409);
    expect(dbState.tables.get('bookings')).toHaveLength(1); // tidak bertambah
  });
});

describe('PATCH /api/bookings/:id — double-booking prevention saat pindah slot', () => {
  const SECOND_ID = '88888888-8888-4888-8888-888888888888';

  function patchBooking(id: string, payload: Record<string, unknown>) {
    return app.request(`/api/bookings/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...AUTH_HEADER, ...WORKSPACE_HEADER },
      body: JSON.stringify(payload),
    });
  }

  it('pindah ke slot yang sudah terisi → 409', async () => {
    dbState.tables.set('bookings', [
      baseBooking(), // 10:00-11:00Z
      baseBooking({ id: SECOND_ID, scheduledAt: new Date('2026-02-01T12:00:00.000Z') }),
    ]);
    const res = await patchBooking(SECOND_ID, { scheduledAt: '2026-02-01T10:30:00.000Z' });
    expect(res.status).toBe(409);
    // Tidak berubah.
    const rows = dbState.tables.get('bookings') as Record<string, unknown>[];
    expect((rows[1] as { scheduledAt: Date }).scheduledAt.toISOString()).toBe('2026-02-01T12:00:00.000Z');
  });

  it('pindah ke slot kosong → 200', async () => {
    dbState.tables.set('bookings', [
      baseBooking(), // 10:00-11:00Z
      baseBooking({ id: SECOND_ID, scheduledAt: new Date('2026-02-01T12:00:00.000Z') }),
    ]);
    const res = await patchBooking(SECOND_ID, { scheduledAt: '2026-02-01T14:00:00.000Z' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.booking.scheduledAt).toBe('2026-02-01T14:00:00.000Z');
  });

  it('ubah durasi ke nilai yang membuat tabrakan → 409', async () => {
    dbState.tables.set('bookings', [
      baseBooking({ scheduledAt: new Date('2026-02-01T10:30:00.000Z') }), // 10:30-11:30
      baseBooking({ id: SECOND_ID, scheduledAt: new Date('2026-02-01T11:00:00.000Z'), durationMinutes: 30 }),
    ]);
    const res = await patchBooking(SECOND_ID, { durationMinutes: 60 }); // 11:00-12:00 menabrak 10:30-11:30
    expect(res.status).toBe(409);
  });

  it('pindah ke slot sendiri (exclude self) → 200', async () => {
    dbState.tables.set('bookings', [
      baseBooking(),
      baseBooking({ id: SECOND_ID, scheduledAt: new Date('2026-02-01T12:00:00.000Z') }),
    ]);
    const res = await patchBooking(SECOND_ID, { scheduledAt: '2026-02-01T12:00:00.000Z' });
    expect(res.status).toBe(200);
  });
});

describe('PATCH /api/bookings/:id — ganti layanan katalog (serviceId)', () => {
  function patchBooking(id: string, payload: Record<string, unknown>) {
    return app.request(`/api/bookings/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...AUTH_HEADER, ...WORKSPACE_HEADER },
      body: JSON.stringify(payload),
    });
  }

  it('ganti serviceId → title & durasi mengikuti layanan baru (tanpa override)', async () => {
    dbState.tables.set('bookings', [baseBooking()]); // title 'Teeth Whitening', 60 mnt
    dbState.tables.set('services', [baseService({ name: 'Haircut Premium', durationMinutes: 75 })]);
    const res = await patchBooking(BOOKING_ID, { serviceId: SERVICE_ID });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.booking.serviceId).toBe(SERVICE_ID);
    expect(body.booking.title).toBe('Haircut Premium');
    expect(body.booking.durationMinutes).toBe(75);
  });

  it('ganti serviceId → title selalu mengikuti layanan baru (title tidak dikirim lagi)', async () => {
    dbState.tables.set('bookings', [baseBooking()]);
    dbState.tables.set('services', [baseService({ name: 'Haircut Premium' })]);
    const res = await patchBooking(BOOKING_ID, {
      serviceId: SERVICE_ID,
      title: 'Paket spesial', // diabaikan (zod strip)
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.booking.serviceId).toBe(SERVICE_ID);
    expect(body.booking.title).toBe('Haircut Premium');
  });

  it('serviceId null → lepas dari katalog; title fallback, durasi tetap', async () => {
    dbState.tables.set('bookings', [baseBooking({ serviceId: SERVICE_ID })]);
    dbState.tables.set('services', [baseService()]);
    const res = await patchBooking(BOOKING_ID, { serviceId: null });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.booking.serviceId).toBeNull();
    // Tanpa layanan → title memakai fallback netral (Appointment).
    expect(body.booking.title).toBe('Appointment');
    expect(body.booking.durationMinutes).toBe(60);
  });

  it('serviceId tidak dikenal → 400', async () => {
    dbState.tables.set('bookings', [baseBooking()]);
    const res = await patchBooking(BOOKING_ID, { serviceId: SERVICE_ID });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/bookings/:id — cancel seluruh seri pengulangan', () => {
  const SERIES_ID = '77777777-7777-4777-8777-777777777777';
  const INSTANCE_2 = '88888888-8888-4888-8888-888888888888';

  it('applyToSeries + status cancelled membatalkan semua instance', async () => {
    dbState.tables.set('bookings', [
      baseBooking({ recurrenceSeriesId: SERIES_ID }),
      baseBooking({ id: INSTANCE_2, scheduledAt: new Date('2026-02-04T10:00:00.000Z'), recurrenceSeriesId: SERIES_ID }),
      baseBooking({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', scheduledAt: new Date('2026-02-05T10:00:00.000Z') }),
    ]);
    const res = await app.request(`/api/bookings/${BOOKING_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...AUTH_HEADER, ...WORKSPACE_HEADER },
      body: JSON.stringify({ status: 'cancelled', applyToSeries: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.seriesCancelled).toBe(1);

    const rows = dbState.tables.get('bookings') as Record<string, unknown>[];
    const seriesRows = rows.filter((r) => r.recurrenceSeriesId === SERIES_ID);
    expect(seriesRows).toHaveLength(2);
    expect(seriesRows.every((r) => r.status === 'cancelled')).toBe(true);
    // Booking di luar seri tetap utuh.
    expect((rows[2] as { status: string }).status).toBe('pending');
  });

  it('tanpa applyToSeries → hanya instance yang dibatalkan', async () => {
    dbState.tables.set('bookings', [
      baseBooking({ recurrenceSeriesId: SERIES_ID }),
      baseBooking({ id: INSTANCE_2, scheduledAt: new Date('2026-02-04T10:00:00.000Z'), recurrenceSeriesId: SERIES_ID }),
    ]);
    const res = await app.request(`/api/bookings/${BOOKING_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...AUTH_HEADER, ...WORKSPACE_HEADER },
      body: JSON.stringify({ status: 'cancelled' }),
    });
    expect(res.status).toBe(200);
    const rows = dbState.tables.get('bookings') as Record<string, unknown>[];
    expect(rows[0].status).toBe('cancelled');
    expect(rows[1].status).toBe('pending');
  });
});
