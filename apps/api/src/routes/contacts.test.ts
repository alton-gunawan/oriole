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

// ── Fake Drizzle db ──────────────────────────────────────────────
// Implementasi minimal dari chain query yang dipakai middleware
// workspace + route contacts (select/insert/update/delete + thenable).
const { dbState } = vi.hoisted(() => ({
  dbState: {
    tables: new Map<string, unknown[]>(),
    seq: 1,
  },
}));

vi.mock('../db/index.ts', async () => {
  // Nama tabel dibaca dari objek drizzle asli (tidak perlu network — hanya definisi).
  const { contacts, workspaces } = await import('@oriole/database');
  const tableNames = new WeakMap<object, string>();
  tableNames.set(contacts, 'contacts');
  tableNames.set(workspaces, 'workspaces');

  function makeSelectBuilder(name: string) {
    const builder: {
      where: (...conds: unknown[]) => typeof builder;
      orderBy: (...cols: unknown[]) => typeof builder;
      limit: (n: number) => typeof builder;
      then: (resolve: (rows: unknown[]) => unknown) => Promise<unknown>;
      _limit?: number;
    } = {
      _limit: undefined,
      where() {
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
        if (builder._limit != null) rows = rows.slice(0, builder._limit);
        return Promise.resolve(resolve(rows));
      },
    };
    return builder;
  }

  const now = new Date('2026-01-01T00:00:00.000Z');

  return {
    db: {
      select: () => ({
        from: (table: object) => makeSelectBuilder(tableNames.get(table) ?? 'unknown'),
      }),
      insert: (table: object) => ({
        values: (values: Record<string, unknown>) => ({
          returning: async () => {
            const name = tableNames.get(table) ?? 'unknown';
            const row = {
              ...values,
              id: `contact-${dbState.seq++}`,
              createdAt: now,
              updatedAt: now,
            };
            dbState.tables.get(name)?.push(row);
            return [row];
          },
        }),
      }),
      update: (table: object) => ({
        set: (values: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => {
              const name = tableNames.get(table) ?? 'unknown';
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
      }),
      delete: (table: object) => ({
        where: () => ({
          returning: async () => {
            const name = tableNames.get(table) ?? 'unknown';
            const rows = dbState.tables.get(name) ?? [];
            if (rows.length === 0) return [];
            const id = (rows[0] as { id: string }).id;
            rows.length = 0;
            return [{ id }];
          },
        }),
      }),
    },
  };
});

const AUTH_HEADER = { Authorization: 'Bearer test-jwt-token' };
const WORKSPACE_HEADER = { 'X-Workspace-Id': 'ws-1' };

const EXISTING_CONTACT_ID = '11111111-1111-4111-8111-111111111111';

function baseContact(overrides: Record<string, unknown> = {}) {
  return {
    id: EXISTING_CONTACT_ID,
    name: 'Budi Santoso',
    phone: '+628123456789',
    email: 'budi@example.com',
    notes: null,
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

  const { contactsRoutes } = await import('./contacts.ts');
  app = new Hono().route('/api/contacts', contactsRoutes);

  // State awal: workspace milik test-user-1 + kontak kosong.
  dbState.tables.set('workspaces', [{ id: 'ws-1', userId: 'test-user-1' }]);
  dbState.tables.set('contacts', []);
});

describe('GET /api/contacts', () => {
  it('tanpa token → 401', async () => {
    const res = await app.request('/api/contacts');
    expect(res.status).toBe(401);
  });

  it('dengan token tanpa header workspace → 400', async () => {
    const res = await app.request('/api/contacts', { headers: AUTH_HEADER });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Workspace wajib dipilih' });
  });

  it('workspace bukan milik user → 404', async () => {
    dbState.tables.set('workspaces', []);
    const res = await app.request('/api/contacts', {
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(404);
    dbState.tables.set('workspaces', [{ id: 'ws-1', userId: 'test-user-1' }]);
  });

  it('daftar kontak kosong → contacts kosong tanpa kursor', async () => {
    dbState.tables.set('contacts', []);
    const res = await app.request('/api/contacts', {
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ contacts: [], nextCursor: null, hasMore: false });
  });

  it('mengembalikan kontak workspace (terserialisasi, userId/workspaceId tidak bocor)', async () => {
    dbState.tables.set('contacts', [baseContact()]);
    const res = await app.request('/api/contacts', {
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contacts).toHaveLength(1);
    expect(body.contacts[0]).toEqual({
      id: EXISTING_CONTACT_ID,
      name: 'Budi Santoso',
      phone: '+628123456789',
      email: 'budi@example.com',
      notes: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(body.contacts[0]).not.toHaveProperty('userId');
    expect(body.contacts[0]).not.toHaveProperty('workspaceId');
    expect(body.nextCursor).toBeNull();
    expect(body.hasMore).toBe(false);
  });

  it('limit dalam rentang → 200', async () => {
    dbState.tables.set('contacts', [baseContact()]);
    const res = await app.request('/api/contacts?limit=5', {
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contacts).toHaveLength(1);
  });

  it('limit melebihi maksimal 200 → 400', async () => {
    const res = await app.request('/api/contacts?limit=9999', {
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(400);
  });

  it('kursor tidak valid → 400', async () => {
    const res = await app.request('/api/contacts?cursor=@@not-valid@@', {
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/contacts', () => {
  beforeEach(() => {
    dbState.tables.set('contacts', []);
  });

  it('membuat kontak valid → 201 dengan kontak terserialisasi', async () => {
    const res = await app.request('/api/contacts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...AUTH_HEADER, ...WORKSPACE_HEADER },
      body: JSON.stringify({ name: 'Sari Dewi', phone: '+628987654321', email: 'sari@example.com' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.contact).toMatchObject({
      id: 'contact-1',
      name: 'Sari Dewi',
      phone: '+628987654321',
      email: 'sari@example.com',
      notes: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(dbState.tables.get('contacts')).toHaveLength(1);
  });

  it('validasi: nama kosong → 400', async () => {
    const res = await app.request('/api/contacts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...AUTH_HEADER, ...WORKSPACE_HEADER },
      body: JSON.stringify({ name: '   ', phone: '+628111' }),
    });
    expect(res.status).toBe(400);
  });

  it('validasi: telepon kosong → 400', async () => {
    const res = await app.request('/api/contacts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...AUTH_HEADER, ...WORKSPACE_HEADER },
      body: JSON.stringify({ name: 'Sari', phone: ' ' }),
    });
    expect(res.status).toBe(400);
  });

  it('validasi: email tidak valid → 400', async () => {
    const res = await app.request('/api/contacts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...AUTH_HEADER, ...WORKSPACE_HEADER },
      body: JSON.stringify({ name: 'Sari', phone: '+628111', email: 'bukan-email' }),
    });
    expect(res.status).toBe(400);
  });

  it('email kosong disimpan sebagai null', async () => {
    const res = await app.request('/api/contacts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...AUTH_HEADER, ...WORKSPACE_HEADER },
      body: JSON.stringify({ name: 'Tanpa Email', phone: '+628222222', email: '' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.contact.email).toBeNull();
  });
});

describe('PATCH /api/contacts/:id', () => {
  it('kontak tidak ditemukan → 404', async () => {
    dbState.tables.set('contacts', []);
    const res = await app.request('/api/contacts/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...AUTH_HEADER, ...WORKSPACE_HEADER },
      body: JSON.stringify({ name: 'X' }),
    });
    expect(res.status).toBe(404);
  });

  it('id bukan UUID → 400', async () => {
    const res = await app.request('/api/contacts/not-a-uuid', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...AUTH_HEADER, ...WORKSPACE_HEADER },
      body: JSON.stringify({ name: 'X' }),
    });
    expect(res.status).toBe(400);
  });

  it('update parsial berhasil → 200 dengan data baru', async () => {
    dbState.tables.set('contacts', [baseContact()]);
    const res = await app.request(`/api/contacts/${EXISTING_CONTACT_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...AUTH_HEADER, ...WORKSPACE_HEADER },
      body: JSON.stringify({ name: 'Budi Santoso Baru' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contact.name).toBe('Budi Santoso Baru');
    expect(body.contact.phone).toBe('+628123456789');
    expect(body.contact.updatedAt).toBe('2026-01-02T00:00:00.000Z');
  });
});

describe('DELETE /api/contacts/:id', () => {
  it('menghapus kontak → 200 ok', async () => {
    dbState.tables.set('contacts', [baseContact()]);
    const res = await app.request(`/api/contacts/${EXISTING_CONTACT_ID}`, {
      method: 'DELETE',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: EXISTING_CONTACT_ID });
  });

  it('kontak tidak ditemukan → 404', async () => {
    dbState.tables.set('contacts', []);
    const res = await app.request(`/api/contacts/${EXISTING_CONTACT_ID}`, {
      method: 'DELETE',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(404);
  });
});
