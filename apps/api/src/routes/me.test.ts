import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// ── Mocks ───────────────────────────────────────────────────────

// Mock jose agar requireAuth tidak perlu JWKS remote (network).
const { jwtVerifyMock } = vi.hoisted(() => ({
  jwtVerifyMock: vi.fn(),
}));

vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => vi.fn()),
  jwtVerify: jwtVerifyMock,
}));

// Mock env — requireAuth (middleware/auth.ts) memvalidasi env saat import.
vi.mock('../lib/env.ts', () => ({
  env: {
    API_URL: 'http://localhost:3000',
    NEON_AUTH_URL: 'https://ep-test.neon.tech/neondb/auth',
  },
}));

// ── Fake Drizzle db (select + insert upsert) ────────────────────
const { dbState } = vi.hoisted(() => ({
  dbState: {
    tables: new Map<string, Record<string, unknown>[]>(),
  },
}));

vi.mock('../db/index.ts', async () => {
  const { profiles, workspaces } = await import('@oriole/database');
  const tableNames = new WeakMap<object, string>();
  tableNames.set(profiles, 'profiles');
  tableNames.set(workspaces, 'workspaces');

  const NOW = new Date('2026-01-01T00:00:00.000Z');

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

  return {
    db: {
      select: () => ({
        from: (table: object) => makeSelectBuilder(tableNames.get(table) ?? 'unknown'),
      }),
      insert: (table: object) => ({
        values: (values: Record<string, unknown>) => {
          const name = tableNames.get(table) ?? 'unknown';
          return {
            onConflictDoUpdate: async () => {
              const rows = dbState.tables.get(name) ?? [];
              const idx = rows.findIndex((r) => r.id === values.id);
              if (idx >= 0) {
                rows[idx] = { ...rows[idx], ...values, updatedAt: NOW };
              } else {
                rows.push({ ...values, createdAt: NOW, updatedAt: NOW });
              }
            },
            returning: async () => {
              const rows = dbState.tables.get(name) ?? [];
              const row = { ...values, createdAt: NOW, updatedAt: NOW };
              rows.push(row);
              return [row];
            },
          };
        },
      }),
      update: (table: object) => ({
        set: (values: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => {
              const name = tableNames.get(table) ?? 'unknown';
              const rows = dbState.tables.get(name) ?? [];
              const target = rows[0] as Record<string, unknown> | undefined;
              if (!target) return [];
              const merged = { ...target, ...values, updatedAt: NOW };
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

// ── Setup app ───────────────────────────────────────────────────
const AUTH_HEADER = { Authorization: 'Bearer test-jwt-token' };

let app: Hono;

beforeAll(async () => {
  jwtVerifyMock.mockReset();
  jwtVerifyMock.mockResolvedValue({ payload: { sub: 'test-user-1', email: 'user@example.com' } });

  const { meRoutes } = await import('./me.ts');
  app = new Hono().route('/api/me', meRoutes);
});

beforeEach(() => {
  dbState.tables.set('profiles', []);
  dbState.tables.set('workspaces', []);
});

describe('GET /api/me — nama tampilan dari tabel profiles', () => {
  it('tanpa token → 401', async () => {
    const res = await app.request('/api/me');
    expect(res.status).toBe(401);
  });

  it('belum ada profil → name null', async () => {
    const res = await app.request('/api/me', { headers: AUTH_HEADER });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string; email?: string; name: string | null };
    expect(body.userId).toBe('test-user-1');
    expect(body.email).toBe('user@example.com');
    expect(body.name).toBeNull();
  });

  it('ada profil → name terisi (display_name)', async () => {
    dbState.tables.set('profiles', [{ id: 'test-user-1', displayName: 'Alice' }]);
    const res = await app.request('/api/me', { headers: AUTH_HEADER });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string | null };
    expect(body.name).toBe('Alice');
  });
});

describe('PATCH /api/me — simpan nama tampilan (upsert profiles)', () => {
  it('tanpa auth → 401', async () => {
    const res = await app.request('/api/me', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Alice' }),
    });
    expect(res.status).toBe(401);
  });

  it('profil baru → dibuat dengan display_name (di-trim)', async () => {
    const res = await app.request('/api/me', {
      method: 'PATCH',
      headers: { ...AUTH_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '  Alice  ' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string };
    expect(body.name).toBe('Alice');

    const rows = dbState.tables.get('profiles') ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'test-user-1', displayName: 'Alice' });
  });

  it('profil sudah ada → di-update, bukan duplikat', async () => {
    dbState.tables.set('profiles', [{ id: 'test-user-1', displayName: 'Alice' }]);
    const res = await app.request('/api/me', {
      method: 'PATCH',
      headers: { ...AUTH_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Budi' }),
    });
    expect(res.status).toBe(200);

    const rows = dbState.tables.get('profiles') ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'test-user-1', displayName: 'Budi' });
  });

  it('nama kosong / hanya spasi → 400', async () => {
    const res = await app.request('/api/me', {
      method: 'PATCH',
      headers: { ...AUTH_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    });
    expect(res.status).toBe(400);
    const rows = dbState.tables.get('profiles') ?? [];
    expect(rows).toHaveLength(0);
  });
});

describe('POST /api/me/workspaces — avatar bisnis (DiceBear / upload 1:1)', () => {
  const postWorkspace = (payload: Record<string, unknown>) =>
    app.request('/api/me/workspaces', {
      method: 'POST',
      headers: { ...AUTH_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

  it('avatarUrl planet DiceBear tersimpan', async () => {
    const res = await postWorkspace({
      name: 'Northside Studio',
      templateCategory: 'beauty-wellness',
      avatarUrl: 'https://api.dicebear.com/10.x/planets/svg?seed=ws-abc123',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { workspace: { avatarUrl?: string } };
    expect(body.workspace.avatarUrl).toBe('https://api.dicebear.com/10.x/planets/svg?seed=ws-abc123');
  });

  it('avatarUrl data URL gambar (upload) diterima', async () => {
    const res = await postWorkspace({
      name: 'Northside Studio',
      templateCategory: 'beauty-wellness',
      avatarUrl: 'data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vuUAAA=',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { workspace: { avatarUrl?: string } };
    expect(body.workspace.avatarUrl).toMatch(/^data:image\//);
  });

  it('avatarUrl bukan DiceBear / data image → 400', async () => {
    const res = await postWorkspace({
      name: 'Northside Studio',
      templateCategory: 'beauty-wellness',
      avatarUrl: 'https://evil.example.com/avatar.png',
    });
    expect(res.status).toBe(400);
    const rows = dbState.tables.get('workspaces') ?? [];
    expect(rows).toHaveLength(0);
  });

  it('tanpa avatarUrl → default null (planet otomatis dari nama)', async () => {
    const res = await postWorkspace({ name: 'Northside Studio', templateCategory: 'beauty-wellness' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { workspace: { avatarUrl?: string | null } };
    expect(body.workspace.avatarUrl).toBeUndefined();
  });
});

describe('PATCH /api/me/workspaces/:id — pengaturan AI chat (toggle + knowledge base)', () => {
  const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
  const baseWorkspace = (overrides: Record<string, unknown> = {}) => ({
    id: WORKSPACE_ID,
    userId: 'test-user-1',
    name: 'Northside Studio',
    templateCategory: 'beauty-wellness',
    aiEnabled: false,
    aiKnowledge: null,
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

  const patchAi = (payload: Record<string, unknown>) =>
    app.request(`/api/me/workspaces/${WORKSPACE_ID}`, {
      method: 'PATCH',
      headers: { ...AUTH_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

  it('toggle aiEnabled → tersimpan di row workspace', async () => {
    dbState.tables.set('workspaces', [baseWorkspace()]);
    const res = await patchAi({ aiEnabled: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspace: { aiEnabled?: boolean } };
    expect(body.workspace.aiEnabled).toBe(true);

    const rows = dbState.tables.get('workspaces') ?? [];
    expect(rows[0]).toMatchObject({ aiEnabled: true });
  });

  it('knowledge base lengkap (layanan/jam/lokasi/FAQ) → tersimpan', async () => {
    dbState.tables.set('workspaces', [baseWorkspace()]);
    const aiKnowledge = {
      description: 'Salon rambut & perawatan.',
      services: 'Cuci 50rb\nPoles 150rb',
      hours: 'Sen–Sab 08.00–20.00',
      location: 'Jl. Merdeka No. 1, Jakarta',
      policy: 'Deposit 50% untuk reschedule < 24 jam.',
      faq: [
        { q: 'Terima kartu?', a: 'Ya, debit & kredit.' },
        { q: 'Bisa booking online?', a: 'Ya, lewat WhatsApp.' },
      ],
    };
    const res = await patchAi({ aiEnabled: true, aiKnowledge });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspace: { aiEnabled?: boolean; aiKnowledge?: unknown } };
    expect(body.workspace.aiEnabled).toBe(true);
    expect(body.workspace.aiKnowledge).toEqual(aiKnowledge);

    const rows = dbState.tables.get('workspaces') ?? [];
    expect(rows[0]).toMatchObject({ aiEnabled: true, aiKnowledge });
  });

  it('aiKnowledge null → hapus knowledge base', async () => {
    dbState.tables.set('workspaces', [
      baseWorkspace({
        aiEnabled: true,
        aiKnowledge: { services: 'Cuci 50rb', hours: '08.00–20.00' },
      }),
    ]);
    const res = await patchAi({ aiKnowledge: null });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspace: { aiKnowledge?: unknown } };
    expect(body.workspace.aiKnowledge).toBeNull();

    const rows = dbState.tables.get('workspaces') ?? [];
    expect(rows[0]).toMatchObject({ aiKnowledge: null });
  });

  it('FAQ dengan jawaban kosong → 400, row tidak berubah', async () => {
    dbState.tables.set('workspaces', [baseWorkspace()]);
    const res = await patchAi({ aiKnowledge: { faq: [{ q: 'Terima kartu?', a: '   ' }] } });
    expect(res.status).toBe(400);

    const rows = dbState.tables.get('workspaces') ?? [];
    expect(rows[0]).toMatchObject({ aiEnabled: false, aiKnowledge: null });
  });

  it('tanpa field AI / field lain → 400 (tidak ada yang diubah)', async () => {
    dbState.tables.set('workspaces', [baseWorkspace()]);
    const res = await patchAi({});
    expect(res.status).toBe(400);
  });

  it('workspace bukan milik user / tidak ada → 404', async () => {
    dbState.tables.set('workspaces', []);
    const res = await patchAi({ aiEnabled: true });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/me/workspaces/:id — bahasa balasan chat (chatLanguage)', () => {
  const WORKSPACE_ID = '33333333-3333-4333-8333-333333333333';
  const baseWorkspace = (overrides: Record<string, unknown> = {}) => ({
    id: WORKSPACE_ID,
    userId: 'test-user-1',
    name: 'Northside Studio',
    templateCategory: 'beauty-wellness',
    chatLanguage: 'en',
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

  const patchChat = (payload: Record<string, unknown>) =>
    app.request(`/api/me/workspaces/${WORKSPACE_ID}`, {
      method: 'PATCH',
      headers: { ...AUTH_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

  it('chatLanguage id → tersimpan di row workspace', async () => {
    dbState.tables.set('workspaces', [baseWorkspace()]);
    const res = await patchChat({ chatLanguage: 'id' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspace: { chatLanguage?: string } };
    expect(body.workspace.chatLanguage).toBe('id');

    const rows = dbState.tables.get('workspaces') ?? [];
    expect(rows[0]).toMatchObject({ chatLanguage: 'id' });
  });

  it('nilai di luar en/id → 400', async () => {
    dbState.tables.set('workspaces', [baseWorkspace()]);
    const res = await patchChat({ chatLanguage: 'fr' });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/me/workspaces/:id — soft delete bisnis', () => {
  const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
  const baseWorkspace = (overrides: Record<string, unknown> = {}) => ({
    id: WORKSPACE_ID,
    userId: 'test-user-1',
    name: 'Northside Studio',
    templateCategory: 'beauty-wellness',
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

  it('soft delete: baris TETAP ada, deletedAt disetel, respons ok', async () => {
    dbState.tables.set('workspaces', [baseWorkspace()]);
    const res = await app.request(`/api/me/workspaces/${WORKSPACE_ID}`, {
      method: 'DELETE',
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: string; deletedAt: string | null };
    expect(body.ok).toBe(true);
    expect(body.id).toBe(WORKSPACE_ID);
    expect(body.deletedAt).not.toBeNull();

    // Baris tidak dihapus — hanya ditandai soft-deleted.
    const rows = dbState.tables.get('workspaces') ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: WORKSPACE_ID, deletedAt: expect.any(Date) });
  });

  it('workspace bukan milik user / tidak ada → 404', async () => {
    dbState.tables.set('workspaces', []);
    const res = await app.request(`/api/me/workspaces/${WORKSPACE_ID}`, {
      method: 'DELETE',
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(404);
  });
});
