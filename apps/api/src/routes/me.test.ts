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
  const { authUser, profiles, workspaces } = await import('@oriole/database');
  const tableNames = new WeakMap<object, string>();
  tableNames.set(authUser, 'authUser');
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
      delete: (table: object) => {
        const name = tableNames.get(table) ?? 'unknown';
        const deleteBuilder = {
          where: () => deleteBuilder,
          returning: async () => {
            const rows = dbState.tables.get(name) ?? [];
            if (rows.length === 0) return [];
            const id = (rows[0] as { id: string }).id;
            rows.length = 0;
            return [{ id }];
          },
          then(resolve: (val: unknown) => unknown) {
            const rows = dbState.tables.get(name) ?? [];
            rows.length = 0;
            return Promise.resolve(resolve([]));
          },
        };
        return deleteBuilder;
      },
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

describe('PATCH /api/me — preferensi bahasa & zona waktu (profiles)', () => {
  const patchProfile = (payload: Record<string, unknown>) =>
    app.request('/api/me', {
      method: 'PATCH',
      headers: { ...AUTH_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

  it('language + timezone valid → tersimpan & di-echo', async () => {
    const res = await patchProfile({ name: 'Alice', language: 'id', timezone: 'Asia/Jakarta' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; language: string; timezone: string };
    expect(body).toMatchObject({ name: 'Alice', language: 'id', timezone: 'Asia/Jakarta' });

    const rows = dbState.tables.get('profiles') ?? [];
    expect(rows[0]).toMatchObject({ id: 'test-user-1', language: 'id', timezone: 'Asia/Jakarta' });
  });

  it('hanya language dikirim → timezone tersimpan tidak disentuh', async () => {
    dbState.tables.set('profiles', [
      { id: 'test-user-1', displayName: 'Alice', language: 'en', timezone: 'Asia/Jakarta' },
    ]);
    const res = await patchProfile({ name: 'Alice', language: 'id' });
    expect(res.status).toBe(200);
    const rows = dbState.tables.get('profiles') ?? [];
    expect(rows[0]).toMatchObject({ language: 'id', timezone: 'Asia/Jakarta' });
  });

  it('language/timezone null → preferensi dibersihkan (ikuti browser)', async () => {
    dbState.tables.set('profiles', [
      { id: 'test-user-1', displayName: 'Alice', language: 'id', timezone: 'Asia/Jakarta' },
    ]);
    const res = await patchProfile({ name: 'Alice', language: null, timezone: null });
    expect(res.status).toBe(200);
    const rows = dbState.tables.get('profiles') ?? [];
    expect(rows[0]).toMatchObject({ language: null, timezone: null });
  });

  it('timezone bukan IANA valid → 400', async () => {
    const res = await patchProfile({ name: 'Alice', timezone: 'Bukan/Zone' });
    expect(res.status).toBe(400);
    const rows = dbState.tables.get('profiles') ?? [];
    expect(rows).toHaveLength(0);
  });

  it('language di luar en/id → 400', async () => {
    const res = await patchProfile({ name: 'Alice', language: 'fr' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/me — preferensi bahasa & zona waktu', () => {
  it('belum ada preferensi → language/timezone null', async () => {
    const res = await app.request('/api/me', { headers: AUTH_HEADER });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { language: string | null; timezone: string | null };
    expect(body.language).toBeNull();
    expect(body.timezone).toBeNull();
  });

  it('profil punya preferensi → dikembalikan', async () => {
    dbState.tables.set('profiles', [
      { id: 'test-user-1', displayName: 'Alice', language: 'id', timezone: 'Asia/Jakarta' },
    ]);
    const res = await app.request('/api/me', { headers: AUTH_HEADER });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { language: string | null; timezone: string | null };
    expect(body.language).toBe('id');
    expect(body.timezone).toBe('Asia/Jakarta');
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

describe('PATCH /api/me/workspaces/:id — info bisnis detail (website/phone/lokasi/jam buka)', () => {
  const WORKSPACE_ID = '44444444-4444-4444-8444-444444444444';
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

  const patchInfo = (payload: Record<string, unknown>) =>
    app.request(`/api/me/workspaces/${WORKSPACE_ID}`, {
      method: 'PATCH',
      headers: { ...AUTH_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

  it('website/phone/lokasi/jam buka lengkap → tersimpan & di-echo', async () => {
    dbState.tables.set('workspaces', [baseWorkspace()]);
    const businessHours = [
      { dayOfWeek: 1, startMinutes: 9 * 60, endMinutes: 17 * 60 },
      { dayOfWeek: 2, startMinutes: 9 * 60, endMinutes: 17 * 60 },
    ];
    const res = await patchInfo({
      website: 'https://northside.example.com',
      phone: '+62 812-3456-7890',
      country: 'Indonesia',
      city: 'Jakarta',
      address: 'Jl. Merdeka No. 1',
      businessHours,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workspace: {
        website?: string;
        phone?: string;
        country?: string;
        city?: string;
        address?: string;
        businessHours?: unknown;
      };
    };
    expect(body.workspace).toMatchObject({
      website: 'https://northside.example.com',
      phone: '+62 812-3456-7890',
      country: 'Indonesia',
      city: 'Jakarta',
      address: 'Jl. Merdeka No. 1',
      businessHours,
    });

    const rows = dbState.tables.get('workspaces') ?? [];
    expect(rows[0]).toMatchObject({ website: 'https://northside.example.com', businessHours });
  });

  it('businessHours null → hapus jam buka', async () => {
    dbState.tables.set('workspaces', [
      baseWorkspace({ businessHours: [{ dayOfWeek: 1, startMinutes: 480, endMinutes: 1020 }] }),
    ]);
    const res = await patchInfo({ businessHours: null });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspace: { businessHours?: unknown } };
    expect(body.workspace.businessHours).toBeNull();
  });

  it('dayOfWeek di luar 0-6 → 400', async () => {
    dbState.tables.set('workspaces', [baseWorkspace()]);
    const res = await patchInfo({ businessHours: [{ dayOfWeek: 7, startMinutes: 480, endMinutes: 1020 }] });
    expect(res.status).toBe(400);
  });

  it('endMinutes melebihi 1440 → 400', async () => {
    dbState.tables.set('workspaces', [baseWorkspace()]);
    const res = await patchInfo({ businessHours: [{ dayOfWeek: 1, startMinutes: 480, endMinutes: 1500 }] });
    expect(res.status).toBe(400);
  });

  it('lebih dari 7 hari → 400', async () => {
    dbState.tables.set('workspaces', [baseWorkspace()]);
    const days = Array.from({ length: 8 }, (_, i) => ({
      dayOfWeek: i % 7,
      startMinutes: 480,
      endMinutes: 1020,
    }));
    const res = await patchInfo({ businessHours: days });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/me/workspaces — info bisnis detail saat buat bisnis', () => {
  const createWithInfo = (payload: Record<string, unknown>) =>
    app.request('/api/me/workspaces', {
      method: 'POST',
      headers: { ...AUTH_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

  it('website/phone/lokasi tersimpan saat buat bisnis baru', async () => {
    const res = await createWithInfo({
      name: 'Northside Studio',
      templateCategory: 'beauty-wellness',
      website: 'https://northside.example.com',
      phone: '+62 812-3456-7890',
      country: 'Indonesia',
      city: 'Jakarta',
      address: 'Jl. Merdeka No. 1',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      workspace: {
        website?: string;
        phone?: string;
        country?: string;
        city?: string;
        address?: string;
      };
    };
    expect(body.workspace).toMatchObject({
      website: 'https://northside.example.com',
      phone: '+62 812-3456-7890',
      country: 'Indonesia',
      city: 'Jakarta',
      address: 'Jl. Merdeka No. 1',
    });
  });
});

describe('PATCH /api/me/workspaces/:id — settings Voice AI (asisten/voice/max attempts)', () => {
  const WORKSPACE_ID = '55555555-5555-4555-8555-555555555555';
  const baseWorkspace = (overrides: Record<string, unknown> = {}) => ({
    id: WORKSPACE_ID,
    userId: 'test-user-1',
    name: 'Northside Studio',
    templateCategory: 'beauty-wellness',
    callAssistantName: 'Sarah',
    callVoiceId: null,
    maxCallAttempts: 2,
    autoCallEnabled: false,
    autoCallLeadHours: 24,
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

  const patchVoice = (payload: Record<string, unknown>) =>
    app.request(`/api/me/workspaces/${WORKSPACE_ID}`, {
      method: 'PATCH',
      headers: { ...AUTH_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

  it('nama asisten + voice + max attempts → tersimpan & di-echo', async () => {
    dbState.tables.set('workspaces', [baseWorkspace()]);
    const res = await patchVoice({
      callAssistantName: 'Bella',
      callVoiceId: 'EXAVITQu4vr4xnSDxMaL',
      maxCallAttempts: 3,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workspace: {
        callAssistantName?: string;
        callVoiceId?: string;
        maxCallAttempts?: number;
      };
    };
    expect(body.workspace).toMatchObject({
      callAssistantName: 'Bella',
      callVoiceId: 'EXAVITQu4vr4xnSDxMaL',
      maxCallAttempts: 3,
    });

    const rows = dbState.tables.get('workspaces') ?? [];
    expect(rows[0]).toMatchObject({
      callAssistantName: 'Bella',
      callVoiceId: 'EXAVITQu4vr4xnSDxMaL',
      maxCallAttempts: 3,
    });
  });

  it('callVoiceId null → kembali ke voice default server', async () => {
    dbState.tables.set('workspaces', [
      baseWorkspace({ callVoiceId: 'EXAVITQu4vr4xnSDxMaL' }),
    ]);
    const res = await patchVoice({ callVoiceId: null });
    expect(res.status).toBe(200);
    const rows = dbState.tables.get('workspaces') ?? [];
    expect(rows[0]).toMatchObject({ callVoiceId: null });
  });

  it('maxCallAttempts di luar 1-10 → 400', async () => {
    dbState.tables.set('workspaces', [baseWorkspace()]);
    const res = await patchVoice({ maxCallAttempts: 0 });
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

describe('GET & POST /api/me/onboarding', () => {
  it('GET /api/me/onboarding mengembalikan status default bila belum ada profil', async () => {
    dbState.tables.set('profiles', []);
    dbState.tables.set('workspaces', []);

    const res = await app.request('/api/me/onboarding', { headers: AUTH_HEADER });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { completed: boolean; step: number; workspace: unknown };
    expect(body.completed).toBe(false);
    expect(body.step).toBe(1);
    expect(body.workspace).toBeNull();
  });

  it('user lama dengan workspace (belum pernah sentuh wizard) dilewati onboarding', async () => {
    // Simulasi user yang punya workspace SEBELUM fitur onboarding: profil
    // belum ada / step masih default 1 → dianggap selesai, bukan dipaksa
    // masuk wizard lagi.
    dbState.tables.set('profiles', []);
    dbState.tables.set('workspaces', [
      { id: '22222222-2222-4222-8222-222222222222', userId: 'test-user-1' },
    ]);

    const res = await app.request('/api/me/onboarding', { headers: AUTH_HEADER });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { completed: boolean; step: number };
    expect(body.completed).toBe(true);
  });

  it('user baru yang sedang di tengah wizard (step > 1) DILANJUTKAN, bukan dianggap selesai', async () => {
    // Workspace sudah dibuat di step 1, tapi wizard belum selesai → harus
    // kembali ke langkah tersimpan, bukan dilempar ke app dengan bisnis kosong.
    dbState.tables.set('profiles', [
      { id: 'test-user-1', onboardingCompleted: false, onboardingStep: 3 },
    ]);
    dbState.tables.set('workspaces', [
      { id: '22222222-2222-4222-8222-222222222222', userId: 'test-user-1' },
    ]);

    const res = await app.request('/api/me/onboarding', { headers: AUTH_HEADER });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { completed: boolean; step: number };
    expect(body.completed).toBe(false);
    expect(body.step).toBe(3);
  });

  it('GET /api/me mengembalikan onboardingCompleted false untuk user di tengah wizard', async () => {
    dbState.tables.set('profiles', [
      { id: 'test-user-1', onboardingCompleted: false, onboardingStep: 2 },
    ]);
    dbState.tables.set('workspaces', [
      { id: '22222222-2222-4222-8222-222222222222', userId: 'test-user-1' },
    ]);

    const res = await app.request('/api/me', { headers: AUTH_HEADER });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { onboardingCompleted: boolean };
    expect(body.onboardingCompleted).toBe(false);
  });

  it('POST /api/me/onboarding menyimpan progres langkah onboarding', async () => {
    dbState.tables.set('profiles', []);

    const res = await app.request('/api/me/onboarding', {
      method: 'POST',
      headers: { ...AUTH_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: 3, completed: false }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; step: number; completed: boolean };
    expect(body.ok).toBe(true);
    expect(body.step).toBe(3);
    expect(body.completed).toBe(false);
  });

  it('POST /api/me/onboarding menyelesaikan onboarding', async () => {
    dbState.tables.set('profiles', []);

    const res = await app.request('/api/me/onboarding', {
      method: 'POST',
      headers: { ...AUTH_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ completed: true }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; completed: boolean };
    expect(body.ok).toBe(true);
    expect(body.completed).toBe(true);
  });
});

describe('DELETE /api/me — hapus akun pengguna', () => {
  it('tanpa auth token → 401', async () => {
    const res = await app.request('/api/me', { method: 'DELETE' });
    expect(res.status).toBe(401);
  });

  it('dengan auth token → berhasil menghapus data profil dan workspace', async () => {
    dbState.tables.set('profiles', [
      { id: 'test-user-1', displayName: 'Test User' },
    ]);
    dbState.tables.set('workspaces', [
      { id: 'ws-1', userId: 'test-user-1', name: 'Business 1' },
      { id: 'ws-2', userId: 'test-user-1', name: 'Business 2' },
    ]);

    const res = await app.request('/api/me', {
      method: 'DELETE',
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(dbState.tables.get('profiles')).toHaveLength(0);
    expect(dbState.tables.get('workspaces')).toHaveLength(0);
  });
});

