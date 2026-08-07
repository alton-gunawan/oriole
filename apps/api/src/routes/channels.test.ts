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

// Mock env — TELEGRAM_BOT_TOKEN dibaca dinamis via getter agar test bisa
// toggle satu-klik mode tanpa rebuild modul.
const { envState } = vi.hoisted(() => {
  const state: { token: string } = { token: '' };
  return {
    envState: {
      get TELEGRAM_BOT_TOKEN() {
        return state.token;
      },
      setToken(v: string) {
        state.token = v;
      },
    },
  };
});

vi.mock('../lib/env.ts', () => ({
  env: {
    API_URL: 'http://localhost:3000',
    NEON_AUTH_URL: 'https://ep-test.neon.tech/neondb/auth',
    get TELEGRAM_BOT_TOKEN() {
      return envState.TELEGRAM_BOT_TOKEN;
    },
  },
}));

// Mock Telegram API — semua panggilan network (getMe/setWebhook) di-stub.
const { getMeMock, setWebhookMock, TelegramApiErrorMock } = vi.hoisted(() => ({
  getMeMock: vi.fn(),
  setWebhookMock: vi.fn(),
  TelegramApiErrorMock: class extends Error {
    constructor(
      message: string,
      readonly code?: number,
    ) {
      super(message);
    }
  },
}));

vi.mock('../lib/telegram.ts', () => ({
  TelegramApiError: TelegramApiErrorMock,
  telegramGetMe: getMeMock,
  telegramSetWebhook: setWebhookMock,
  telegramDeleteWebhook: vi.fn(),
}));

// ── Fake Drizzle db ─────────────────────────────────────────────
const { dbState } = vi.hoisted(() => ({
  dbState: {
    tables: new Map<string, Record<string, unknown>[]>(),
    seq: 1,
  },
}));

vi.mock('../db/index.ts', async () => {
  const { workspaceChannels, workspaces } = await import('@oriole/database');
  const tableNames = new WeakMap<object, string>();
  tableNames.set(workspaceChannels, 'workspaceChannels');
  tableNames.set(workspaces, 'workspaces');

  const NOW = new Date('2026-01-01T00:00:00.000Z');

  function makeSelectBuilder(name: string) {
    const builder: {
      where: (...conds: unknown[]) => typeof builder;
      limit: (n: number) => typeof builder;
      then: (resolve: (rows: unknown[]) => unknown) => Promise<unknown>;
      _limit?: number;
    } = {
      _limit: undefined,
      where() {
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
        values: (values: Record<string, unknown>) => ({
          returning: async () => {
            const name = tableNames.get(table) ?? 'unknown';
            const row = { ...values, id: `ch-${dbState.seq++}`, createdAt: NOW, updatedAt: NOW };
            dbState.tables.get(name)?.push(row);
            return [row];
          },
          onConflictDoUpdate: () => ({
            returning: async () => {
              const name = tableNames.get(table) ?? 'unknown';
              const rows = dbState.tables.get(name) ?? [];
              const idx = rows.findIndex(
                (r) =>
                  r.workspaceId === values.workspaceId &&
                  r.channelType === values.channelType,
              );
              if (idx >= 0) {
                const merged = { ...rows[idx], ...values, updatedAt: NOW };
                rows[idx] = merged;
                return [merged];
              }
              const row = { ...values, id: `ch-${dbState.seq++}`, createdAt: NOW, updatedAt: NOW };
              rows.push(row);
              return [row];
            },
          }),
        }),
      }),
    },
  };
});

// ── Setup app ───────────────────────────────────────────────────
const AUTH_HEADER = { Authorization: 'Bearer test-jwt-token' };
const WORKSPACE_HEADER = { 'X-Workspace-Id': 'ws-1' };

let app: Hono;

function baseTelegramChannel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tg-1',
    workspaceId: 'ws-1',
    channelType: 'telegram',
    identifier: '@mybot',
    providerConfig: { botToken: 'custom-token', webhookSecret: 'secret-1' },
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

beforeAll(async () => {
  jwtVerifyMock.mockReset();
  jwtVerifyMock.mockResolvedValue({ payload: { sub: 'test-user-1', email: 'user@example.com' } });

  const { channelsRoutes } = await import('./channels.ts');
  app = new Hono().route('/api/channels', channelsRoutes);
});

beforeEach(() => {
  envState.setToken('');
  dbState.tables.set('workspaces', [{ id: 'ws-1', userId: 'test-user-1' }]);
  dbState.tables.set('workspaceChannels', []);
  getMeMock.mockReset();
  setWebhookMock.mockReset();
});

// Catatan: envBotIdentityCache (modul) bertahan antar-test — test yang
// mengubah hasil getMe untuk GET harus memperhitungkan cache 10 menit.
describe('GET /api/channels — virtual channel bot bersama (env)', () => {
  it('tanpa token → 401', async () => {
    const res = await app.request('/api/channels');
    expect(res.status).toBe(401);
  });

  it('env token kosong → tidak ada virtual channel telegram', async () => {
    const res = await app.request('/api/channels', {
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channels: unknown[] };
    expect(body.channels).toEqual([]);
    expect(getMeMock).not.toHaveBeenCalled();
  });

  it('env token ada + belum ada row → virtual channel isEnvShared (token tidak bocor)', async () => {
    envState.setToken('123:abc');
    getMeMock.mockResolvedValue({ id: 1, username: 'sharedbot', isBot: true });

    const res = await app.request('/api/channels', {
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      channels: { channelType: string; isEnvShared?: boolean; identifier: string | null; isActive: boolean }[];
    };
    const telegram = body.channels.find((ch) => ch.channelType === 'telegram');
    expect(telegram).toMatchObject({
      isEnvShared: true,
      identifier: '@sharedbot',
      isActive: false,
      channelType: 'telegram',
    });
    // Kredensial privat tidak boleh ada di payload apa pun.
    expect(JSON.stringify(body)).not.toContain('123:abc');
  });

  it('env token ada + row telegram sudah ada → tanpa virtual channel', async () => {
    envState.setToken('123:abc');
    dbState.tables.set('workspaceChannels', [baseTelegramChannel()]);

    const res = await app.request('/api/channels', {
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      channels: { channelType: string; identifier: string | null; isEnvShared?: boolean }[];
    };
    expect(body.channels).toHaveLength(1);
    expect(body.channels[0]).toMatchObject({ channelType: 'telegram', identifier: '@mybot' });
    expect(body.channels[0].isEnvShared).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('custom-token');
  });

  it('env token ada + getMe gagal → virtual channel tetap muncul (graceful degradation)', async () => {
    // Identifier bergantung cache getMe (bisa '@sharedbot' dari test sebelumnya) —
    // yang dipastikan di sini hanya bahwa channel tetap muncul walau Telegram down.
    envState.setToken('123:abc');
    getMeMock.mockRejectedValue(new TelegramApiErrorMock('Telegram down'));

    const res = await app.request('/api/channels', {
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      channels: { channelType: string; isEnvShared?: boolean }[];
    };
    const telegram = body.channels.find((ch) => ch.channelType === 'telegram');
    expect(telegram).toBeDefined();
    expect(telegram).toMatchObject({ isEnvShared: true, channelType: 'telegram' });
  });
});

describe('POST /api/channels/telegram/connect — one-click connect', () => {
  it('env token kosong → 400', async () => {
    const res = await app.request('/api/channels/telegram/connect', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(400);
    expect(getMeMock).not.toHaveBeenCalled();
  });

  it('sukses → 201, channel aktif, row tersimpan dengan token env', async () => {
    envState.setToken('123:abc');
    getMeMock.mockResolvedValue({ id: 1, username: 'sharedbot', isBot: true });
    setWebhookMock.mockResolvedValue(undefined);

    const res = await app.request('/api/channels/telegram/connect', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      channel: { channelType: string; identifier: string | null; isActive: boolean; isEnvShared?: boolean };
    };
    expect(body.channel).toMatchObject({
      channelType: 'telegram',
      identifier: '@sharedbot',
      isActive: true,
    });
    expect(body.channel.isEnvShared).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('123:abc');

    const rows = dbState.tables.get('workspaceChannels') ?? [];
    expect(rows).toHaveLength(1);
    expect((rows[0].providerConfig as { botToken: string }).botToken).toBe('123:abc');
    expect(setWebhookMock).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'http://localhost:3000/api/webhooks/telegram/ws-1' }),
    );
  });

  it('row dengan bot custom berbeda → 409, tidak menimpa', async () => {
    envState.setToken('123:abc');
    dbState.tables.set('workspaceChannels', [baseTelegramChannel()]);

    const res = await app.request('/api/channels/telegram/connect', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(409);
    expect(getMeMock).not.toHaveBeenCalled();

    const rows = dbState.tables.get('workspaceChannels') ?? [];
    expect((rows[0].providerConfig as { botToken: string }).botToken).toBe('custom-token');
  });

  it('token env ditolak Telegram → 400', async () => {
    envState.setToken('123:abc');
    getMeMock.mockRejectedValue(new TelegramApiErrorMock('Unauthorized'));

    const res = await app.request('/api/channels/telegram/connect', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('ditolak');
  });
});
