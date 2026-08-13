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

// Mock env — TELEGRAM_BOT_TOKEN + WAHA_GATEWAY_* dibaca dinamis via getter
// agar test bisa toggle mode (satu-klik Telegram, gateway managed) tanpa
// rebuild modul.
const { envState } = vi.hoisted(() => {
  const state: { token: string; wahaUrl: string; wahaKey: string; webhookBase: string } = {
    token: '',
    wahaUrl: '',
    wahaKey: '',
    webhookBase: '',
  };
  return {
    envState: {
      get TELEGRAM_BOT_TOKEN() {
        return state.token;
      },
      setToken(v: string) {
        state.token = v;
      },
      get WAHA_GATEWAY_URL() {
        return state.wahaUrl;
      },
      get WAHA_GATEWAY_API_KEY() {
        return state.wahaKey;
      },
      setWahaGateway(url: string, key: string) {
        state.wahaUrl = url;
        state.wahaKey = key;
      },
      clearWahaGateway() {
        state.wahaUrl = '';
        state.wahaKey = '';
      },
      // '' (kosong) → undefined, sama seperti preprocess di env.ts → fallback API_URL.
      get WEBHOOK_BASE_URL() {
        return state.webhookBase || undefined;
      },
      setWebhookBase(v: string) {
        state.webhookBase = v;
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
    get WAHA_GATEWAY_URL() {
      return envState.WAHA_GATEWAY_URL;
    },
    get WAHA_GATEWAY_API_KEY() {
      return envState.WAHA_GATEWAY_API_KEY;
    },
    get WEBHOOK_BASE_URL() {
      return envState.WEBHOOK_BASE_URL;
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

// Mock layanan WAHA (gateway unofficial) — semua network di-stub.
const {
  wahaListSessionsMock,
  wahaCreateSessionMock,
  wahaUpdateSessionMock,
  wahaGetQrMock,
  wahaGetMeMock,
  wahaGetSessionMock,
  wahaStartSessionMock,
  WahaApiErrorMock,
} = vi.hoisted(() => ({
  wahaListSessionsMock: vi.fn(),
  wahaCreateSessionMock: vi.fn(),
  wahaUpdateSessionMock: vi.fn(),
  wahaGetQrMock: vi.fn(),
  wahaGetMeMock: vi.fn(),
  wahaGetSessionMock: vi.fn(),
  wahaStartSessionMock: vi.fn(),
  WahaApiErrorMock: class extends Error {
    constructor(
      message: string,
      readonly status?: number,
    ) {
      super(message);
    }
  },
}));

vi.mock('../services/waha.ts', () => ({
  WahaApiError: WahaApiErrorMock,
  wahaListSessions: wahaListSessionsMock,
  wahaCreateSession: wahaCreateSessionMock,
  wahaUpdateSession: wahaUpdateSessionMock,
  wahaGetQr: wahaGetQrMock,
  wahaGetMe: wahaGetMeMock,
  wahaGetSession: wahaGetSessionMock,
  wahaStartSession: wahaStartSessionMock,
  // Predikat logika (bukan mock) — route bergantung pada semantik aslinya.
  isWahaSessionAlreadyExistsError: (error: { status?: number; message: string }) =>
    error.status === 409 || (error.status === 422 && /already exists/i.test(error.message)),
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
  envState.setWebhookBase('');
  envState.clearWahaGateway();
  dbState.tables.set('workspaces', [{ id: 'ws-1', userId: 'test-user-1' }]);
  dbState.tables.set('workspaceChannels', []);
  getMeMock.mockReset();
  setWebhookMock.mockReset();
  wahaListSessionsMock.mockReset();
  wahaCreateSessionMock.mockReset();
  wahaUpdateSessionMock.mockReset();
  wahaGetQrMock.mockReset();
  wahaGetMeMock.mockReset();
  wahaGetSessionMock.mockReset();
  wahaStartSessionMock.mockReset();
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
    envState.setWebhookBase('https://api.example.com');
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
      expect.objectContaining({ url: 'https://api.example.com/api/webhooks/telegram/ws-1' }),
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
    envState.setWebhookBase('https://api.example.com');
    getMeMock.mockRejectedValue(new TelegramApiErrorMock('Unauthorized'));

    const res = await app.request('/api/channels/telegram/connect', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('ditolak');
  });

  it('base URL webhook bukan HTTPS publik → 400 pesan jelas, Telegram TIDAK dipanggil', async () => {
    envState.setToken('123:abc');
    envState.setWebhookBase(''); // fallback API_URL http://localhost:3000

    const res = await app.request('/api/channels/telegram/connect', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('HTTPS');
    expect(body.error).toContain('WEBHOOK_BASE_URL');
    expect(getMeMock).not.toHaveBeenCalled();
    expect(setWebhookMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/channels/telegram/setup — token manual', () => {
  it('base HTTPS publik → 201, webhook didaftarkan dengan URL benar', async () => {
    envState.setWebhookBase('https://api.example.com');
    getMeMock.mockResolvedValue({ id: 1, username: 'mybot', isBot: true });
    setWebhookMock.mockResolvedValue(undefined);

    const res = await app.request('/api/channels/telegram/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...AUTH_HEADER, ...WORKSPACE_HEADER },
      body: JSON.stringify({ token: '111:manual-token' }),
    });
    expect(res.status).toBe(201);
    expect(setWebhookMock).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://api.example.com/api/webhooks/telegram/ws-1' }),
    );
    const rows = dbState.tables.get('workspaceChannels') ?? [];
    expect(rows).toHaveLength(1);
    expect((rows[0].providerConfig as { botToken: string }).botToken).toBe('111:manual-token');
  });

  it('base HTTP (localhost) → 400 pesan jelas, getMe tidak dipanggil', async () => {
    envState.setWebhookBase('');

    const res = await app.request('/api/channels/telegram/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...AUTH_HEADER, ...WORKSPACE_HEADER },
      body: JSON.stringify({ token: '111:manual-token' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('HTTPS');
    expect(body.error).toContain('WEBHOOK_BASE_URL');
    expect(getMeMock).not.toHaveBeenCalled();
    expect(setWebhookMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/channels/whatsapp/waha/setup — BYO (unofficial) consent', () => {
  // Kredensial gateway SELALU dari env server (bukan body) — lihat handler.
  const GATEWAY_ENV = {
    baseUrl: 'http://waha.test:3000',
    apiKey: '0123456789abcdef0123456789abcdef',
  };
  const BYO_BODY = {
    consentVersion: 2,
    checked: ['ban', 'tos', 'expendable', 'optin'],
  };
  const validRequest = (overrides: Record<string, unknown> = {}) =>
    app.request('/api/channels/whatsapp/waha/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...AUTH_HEADER, ...WORKSPACE_HEADER },
      body: JSON.stringify({ ...BYO_BODY, ...overrides }),
    });

  // Test yang berhasil memakai kredensial env — set default di sini; test
  // yang membutuhkan env kosong menimpa dengan clearWahaGateway() sendiri.
  beforeEach(() => {
    envState.setWahaGateway(GATEWAY_ENV.baseUrl, GATEWAY_ENV.apiKey);
  });

  it('tanpa token → 401', async () => {
    const res = await app.request('/api/channels/whatsapp/waha/setup', {
      method: 'POST',
      body: JSON.stringify(BYO_BODY),
    });
    expect(res.status).toBe(401);
    expect(wahaListSessionsMock).not.toHaveBeenCalled();
  });

  it('versi consent tidak dikenal → 409, tanpa efek samping', async () => {
    const res = await validRequest({ consentVersion: 999 });
    expect(res.status).toBe(409);
    expect(wahaListSessionsMock).not.toHaveBeenCalled();
    expect(dbState.tables.get('workspaceChannels') ?? []).toHaveLength(0);
  });

  it('versi consent lama (v1) → 409 — wajib re-consent copy baru', async () => {
    const res = await validRequest({ consentVersion: 1 });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('diperbarui');
    expect(wahaListSessionsMock).not.toHaveBeenCalled();
  });

  it('checklist tidak lengkap → 400, tanpa efek samping', async () => {
    const res = await validRequest({ checked: ['ban', 'tos'] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('kotak risiko');
    expect(wahaListSessionsMock).not.toHaveBeenCalled();
  });

  it('checklist kosong / bukan array → 400', async () => {
    const empty = await validRequest({ checked: [] });
    expect(empty.status).toBe(400);
    const notArray = await validRequest({ checked: 'ban' });
    expect(notArray.status).toBe(400);
    expect(wahaListSessionsMock).not.toHaveBeenCalled();
  });

  it('semua kotak dicentang (urutan acak + item ekstra) diterima', async () => {
    wahaListSessionsMock.mockResolvedValue([{ name: 'ws_ws-1', status: 'STOPPED' }]);
    wahaCreateSessionMock.mockResolvedValue({ name: 'ws_ws-1', status: 'STARTING' });
    const res = await validRequest({ checked: ['optin', 'ban', 'expendable', 'extra-future-item', 'tos'] });
    expect(res.status).toBe(201);
  });

  it('API key default docker-compose spike di env → 400', async () => {
    envState.setWahaGateway(
      GATEWAY_ENV.baseUrl,
      'spike-waha-change-me-00000000000000000000000000000000',
    );
    const res = await validRequest();
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('default');
    expect(wahaListSessionsMock).not.toHaveBeenCalled();
  });

  it('probe gateway gagal → 400, channel tidak tersimpan', async () => {
    wahaListSessionsMock.mockRejectedValue(new WahaApiErrorMock('Gateway WAHA menolak: 401', 401));
    const res = await validRequest();
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('401');
    expect(dbState.tables.get('workspaceChannels') ?? []).toHaveLength(0);
  });

  it('gateway TIDAK terjangkau (raw TypeError, non-WahaApiError) saat probe → 400 dengan pesan jelas, bukan 500 generik', async () => {
    // Simulasi persis bug produksi: fetch ke hostname compose yang tidak bisa
    // di-resolve dari host (ENOTFOUND) — fetch melempar TypeError, BUKAN
    // WahaApiError. Sebelumnya ini rethrow → 500 "Terjadi kesalahan internal".
    wahaListSessionsMock.mockRejectedValue(new TypeError('fetch failed'));
    const res = await validRequest();
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('tidak dapat dijangkau');
    expect(body.error).toContain('http://waha.test:3000');
    expect(dbState.tables.get('workspaceChannels') ?? []).toHaveLength(0);
  });

  it('gateway TIDAK terjangkau (raw TypeError) saat CREATE session → 400 dengan pesan jelas', async () => {
    wahaListSessionsMock.mockResolvedValue([{ name: 'ws_ws-1', status: 'STOPPED' }]);
    wahaCreateSessionMock.mockRejectedValue(new TypeError('fetch failed'));
    const res = await validRequest();
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('tidak dapat dijangkau');
    expect(dbState.tables.get('workspaceChannels') ?? []).toHaveLength(0);
  });

  it('sukses → 201: consent + providerConfig tersimpan, kredensial tidak bocor', async () => {
    const { wahaConsentCopyHash } = await import('../lib/waha-consent.ts');
    wahaListSessionsMock.mockResolvedValue([{ name: 'ws_ws-1', status: 'STOPPED' }]);
    wahaCreateSessionMock.mockResolvedValue({ name: 'ws_ws-1', status: 'STARTING' });

    const res = await validRequest();
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      channel: { channelType: string; isActive: boolean; provider?: string; healthState?: string };
      session: { name: string; status: string };
    };
    expect(body.channel).toMatchObject({
      channelType: 'whatsapp',
      isActive: true,
      provider: 'waha',
      healthState: 'connecting',
    });
    expect(body.session).toEqual({ name: 'ws_ws-1', status: 'STARTING' });

    // Kredensial privat / consent audit tidak pernah keluar di payload publik.
    expect(JSON.stringify(body)).not.toContain(GATEWAY_ENV.apiKey);
    expect(JSON.stringify(body)).not.toContain('acceptedByUserId');

    // Row tersimpan dengan consent versi + copyHash + ack user.
    const rows = dbState.tables.get('workspaceChannels') ?? [];
    expect(rows).toHaveLength(1);
    const config = rows[0].providerConfig as {
      provider: string;
      gatewayApiKey: string;
      consent: { version: number; copyHash: string; acceptedByUserId: string; acceptedAt: string };
      health: { state: string };
      webhookSecret: string;
    };
    expect(config.provider).toBe('waha');
    expect(config.gatewayApiKey).toBe(GATEWAY_ENV.apiKey);
    expect(config.consent).toMatchObject({
      version: 2,
      copyHash: wahaConsentCopyHash(2),
      acceptedByUserId: 'test-user-1',
    });
    expect(config.health.state).toBe('connecting');

    // Session WAHA dibuat dengan webhook adapter + HMAC secret (SHA-512) yang sama.
    expect(wahaCreateSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'ws_ws-1',
        workspaceId: 'ws-1',
        webhookUrl: 'http://localhost:3000/api/webhooks/waha/ws-1',
        webhookSecret: config.webhookSecret,
      }),
    );
  });

  it('session sudah ada (409 WAHA lama) → PUT update config + 201', async () => {
    wahaListSessionsMock.mockResolvedValue([{ name: 'ws_ws-1', status: 'STOPPED' }]);
    wahaCreateSessionMock.mockRejectedValue(new WahaApiErrorMock('duplicate', 409));
    wahaUpdateSessionMock.mockResolvedValue({ name: 'ws_ws-1', status: 'STARTING' });
    // Channel lama sudah ada → webhookSecret lama HARUS dipertahankan (HMAC
    // adapter stabil) dan diteruskan ke PUT.
    dbState.tables.set('workspaceChannels', [
      {
        id: 'wa-1',
        workspaceId: 'ws-1',
        channelType: 'whatsapp',
        identifier: null,
        providerConfig: { webhookSecret: 'keep-me' },
        isActive: true,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);

    const res = await validRequest();
    expect(res.status).toBe(201);
    const body = (await res.json()) as { session: { status: string } };
    expect(body.session.status).toBe('STARTING');
    // PUT dipanggil persis sekali, memakai webhookSecret lama.
    expect(wahaUpdateSessionMock).toHaveBeenCalledTimes(1);
    expect(wahaUpdateSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'ws_ws-1', workspaceId: 'ws-1', webhookSecret: 'keep-me' }),
    );
  });

  it('session sudah ada (422 "already exists" WAHA 2026.x) → PUT update + 201', async () => {
    wahaListSessionsMock.mockResolvedValue([{ name: 'ws_ws-1', status: 'STOPPED' }]);
    wahaCreateSessionMock.mockRejectedValue(
      new WahaApiErrorMock(
        `WAHA gagal membuat session: 422 {"message":"Session 'ws_ws-1' already exists. Use PUT to update it."}`,
        422,
      ),
    );
    wahaUpdateSessionMock.mockResolvedValue({ name: 'ws_ws-1', status: 'EXISTS' });

    const res = await validRequest();
    expect(res.status).toBe(201);
    const body = (await res.json()) as { session: { status: string } };
    expect(body.session.status).toBe('EXISTS');
    expect(wahaUpdateSessionMock).toHaveBeenCalledTimes(1);
  });

  it('422 yang BUKAN already-exists → 400, tanpa PUT', async () => {
    wahaListSessionsMock.mockResolvedValue([{ name: 'ws_ws-1', status: 'STOPPED' }]);
    wahaCreateSessionMock.mockRejectedValue(
      new WahaApiErrorMock('WAHA gagal membuat session: 422 {"message":"name too long"}', 422),
    );

    const res = await validRequest();
    expect(res.status).toBe(400);
    expect(wahaUpdateSessionMock).not.toHaveBeenCalled();
  });

  it('session ada tapi PUT gagal → tetap 201 dengan status EXISTS', async () => {
    wahaListSessionsMock.mockResolvedValue([{ name: 'ws_ws-1', status: 'STOPPED' }]);
    wahaCreateSessionMock.mockRejectedValue(new WahaApiErrorMock('duplicate', 409));
    wahaUpdateSessionMock.mockRejectedValue(new WahaApiErrorMock('gateway sibuk', 500));

    const res = await validRequest();
    expect(res.status).toBe(201);
    const body = (await res.json()) as { session: { status: string } };
    expect(body.session.status).toBe('EXISTS');
  });

  it('422 already-exists + PUT gagal → tetap 201 dengan status EXISTS', async () => {
    wahaListSessionsMock.mockResolvedValue([{ name: 'ws_ws-1', status: 'STOPPED' }]);
    wahaCreateSessionMock.mockRejectedValue(
      new WahaApiErrorMock(
        `WAHA gagal membuat session: 422 {"message":"Session 'ws_ws-1' already exists. Use PUT to update it."}`,
        422,
      ),
    );
    wahaUpdateSessionMock.mockRejectedValue(new WahaApiErrorMock('gateway sibuk', 500));

    const res = await validRequest();
    expect(res.status).toBe(201);
    const body = (await res.json()) as { session: { status: string } };
    expect(body.session.status).toBe('EXISTS');
  });

  it('re-setup mempertahankan webhookSecret lama (HMAC adapter stabil)', async () => {
    wahaListSessionsMock.mockResolvedValue([{ name: 'ws_ws-1', status: 'STOPPED' }]);
    wahaCreateSessionMock.mockResolvedValue({ name: 'ws_ws-1', status: 'STARTING' });
    dbState.tables.set('workspaceChannels', [
      {
        id: 'wa-1',
        workspaceId: 'ws-1',
        channelType: 'whatsapp',
        identifier: '6281111111111',
        providerConfig: { apiKey: 'old-360dialog-key', webhookSecret: 'keep-me' },
        isActive: true,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);

    const res = await validRequest();
    expect(res.status).toBe(201);
    expect(wahaCreateSessionMock).toHaveBeenCalledWith(expect.objectContaining({ webhookSecret: 'keep-me' }));
  });

  it('GET gateway-info tanpa token → 401', async () => {
    const res = await app.request('/api/channels/whatsapp/waha/gateway-info');
    expect(res.status).toBe(401);
  });

  it('GET gateway-info tanpa env → managed:false, tanpa baseUrl', async () => {
    envState.clearWahaGateway();
    const res = await app.request('/api/channels/whatsapp/waha/gateway-info', {
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { managed: boolean; baseUrl?: string };
    expect(body.managed).toBe(false);
    expect(body.baseUrl).toBeUndefined();
  });

  it('GET gateway-info dengan env → managed:true + baseUrl, API key tidak bocor', async () => {
    envState.setWahaGateway('http://waha.test:3000', 'managed-secret-key-123456789');
    const res = await app.request('/api/channels/whatsapp/waha/gateway-info', {
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { managed: boolean; baseUrl?: string };
    expect(body.managed).toBe(true);
    expect(body.baseUrl).toBe('http://waha.test:3000');
    expect(JSON.stringify(body)).not.toContain('managed-secret-key-123456789');
  });

  it('env gateway TIDAK dikonfigurasi → 400 dengan pesan jelas, tanpa efek samping', async () => {
    envState.clearWahaGateway();
    const res = await validRequest();
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('belum dikonfigurasi');
    expect(wahaListSessionsMock).not.toHaveBeenCalled();
  });

  it('setup tanpa kredensial dari klien → 201, kredensial env dipakai', async () => {
    envState.setWahaGateway('http://waha-managed.test:3000', 'managed-secret-key-123456789');
    wahaListSessionsMock.mockResolvedValue([{ name: 'ws_ws-1', status: 'STOPPED' }]);
    wahaCreateSessionMock.mockResolvedValue({ name: 'ws_ws-1', status: 'STARTING' });

    const res = await validRequest();
    expect(res.status).toBe(201);

    // Probe + create memakai kredensial ENV, bukan body.
    expect(wahaListSessionsMock).toHaveBeenCalledWith(
      'http://waha-managed.test:3000',
      'managed-secret-key-123456789',
    );
    expect(wahaCreateSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'http://waha-managed.test:3000',
        apiKey: 'managed-secret-key-123456789',
      }),
    );

    // Tersimpan di providerConfig, tidak pernah bocor ke payload publik.
    const rows = dbState.tables.get('workspaceChannels') ?? [];
    const config = rows[0].providerConfig as { baseUrl: string; gatewayApiKey: string };
    expect(config.baseUrl).toBe('http://waha-managed.test:3000');
    expect(config.gatewayApiKey).toBe('managed-secret-key-123456789');
    const body = (await res.json()) as { channel: { provider?: string } };
    expect(body.channel.provider).toBe('waha');
    expect(JSON.stringify(body)).not.toContain('managed-secret-key-123456789');
  });

  it('managed mode: kredensial env menang walau klien kirim key terlarang', async () => {
    envState.setWahaGateway('http://waha-managed.test:3000', 'managed-secret-key-123456789');
    wahaListSessionsMock.mockResolvedValue([{ name: 'ws_ws-1', status: 'STOPPED' }]);
    wahaCreateSessionMock.mockResolvedValue({ name: 'ws_ws-1', status: 'STARTING' });
    // Klien mengirim key default spike — TIDAK boleh menimpa kredensial env.
    const res = await validRequest({
      baseUrl: 'http://evil.test:9999',
      apiKey: 'spike-waha-change-me-00000000000000000000000000000000',
    });
    expect(res.status).toBe(201);
    expect(wahaListSessionsMock).toHaveBeenCalledWith(
      'http://waha-managed.test:3000',
      'managed-secret-key-123456789',
    );
    const rows = dbState.tables.get('workspaceChannels') ?? [];
    const config = rows[0].providerConfig as { gatewayApiKey: string };
    expect(config.gatewayApiKey).toBe('managed-secret-key-123456789');
  });

  it('GET /api/channels menampilkan provider + healthState tanpa kredensial', async () => {
    dbState.tables.set('workspaceChannels', [
      {
        id: 'wa-1',
        workspaceId: 'ws-1',
        channelType: 'whatsapp',
        identifier: null,
        providerConfig: {
          provider: 'waha',
          baseUrl: 'http://waha.test:3000',
          gatewayApiKey: 'secret-gateway-key-123',
          sessionName: 'ws_ws-1',
          webhookSecret: 'secret-webhook',
          consent: { version: 1 },
          health: { state: 'connecting' },
        },
        isActive: true,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);

    const res = await app.request('/api/channels', {
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      channels: { channelType: string; provider?: string; healthState?: string; healthStatus?: string }[];
    };
    const whatsapp = body.channels.find((ch) => ch.channelType === 'whatsapp');
    expect(whatsapp).toMatchObject({ provider: 'waha', healthState: 'connecting' });
    expect(JSON.stringify(body)).not.toContain('secret-gateway-key-123');
    expect(JSON.stringify(body)).not.toContain('secret-webhook');
  });

  it('GET /api/channels mengekspos healthStatus (raw FAILED) untuk hint LID re-pair', async () => {
    dbState.tables.set('workspaceChannels', [
      {
        id: 'wa-2',
        workspaceId: 'ws-1',
        channelType: 'whatsapp',
        identifier: '6281111111111',
        providerConfig: {
          provider: 'waha',
          baseUrl: 'http://waha.test:3000',
          gatewayApiKey: 'secret-gateway-key-123',
          sessionName: 'ws_ws-1',
          webhookSecret: 'secret-webhook',
          health: { state: 'disconnected', lastStatus: 'FAILED' },
        },
        isActive: true,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);

    const res = await app.request('/api/channels', {
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      channels: { channelType: string; healthState?: string; healthStatus?: string; identifier: string | null }[];
    };
    const whatsapp = body.channels.find((ch) => ch.channelType === 'whatsapp');
    expect(whatsapp).toMatchObject({
      healthState: 'disconnected',
      healthStatus: 'FAILED',
      identifier: '6281111111111',
    });
  });

  it('re-setup menyimpan riwayat consent (append-only, spec §4)', async () => {
    wahaListSessionsMock.mockResolvedValue([{ name: 'ws_ws-1', status: 'STOPPED' }]);
    wahaCreateSessionMock.mockResolvedValue({ name: 'ws_ws-1', status: 'STARTING' });
    dbState.tables.set('workspaceChannels', [
      {
        id: 'wa-1',
        workspaceId: 'ws-1',
        channelType: 'whatsapp',
        identifier: null,
        providerConfig: {
          provider: 'waha',
          gatewayApiKey: 'old-key',
          webhookSecret: 'keep-me',
          consent: {
            version: 1,
            copyHash: 'old-hash',
            acceptedAt: '2026-01-01T00:00:00.000Z',
            acceptedByUserId: 'user-a',
          },
        },
        isActive: true,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);

    const res = await validRequest();
    expect(res.status).toBe(201);
    const rows = dbState.tables.get('workspaceChannels') ?? [];
    const config = rows[0].providerConfig as {
      consent: { acceptedByUserId: string };
      consentHistory: { version: number; copyHash: string; acceptedByUserId: string }[];
    };
    // Catatan baru menjadi consent aktif; catatan lama tidak hilang.
    expect(config.consent.acceptedByUserId).toBe('test-user-1');
    expect(config.consentHistory).toEqual([
      expect.objectContaining({ version: 1, copyHash: 'old-hash', acceptedByUserId: 'user-a' }),
    ]);
  });

  it('ganti provider 360dialog → waha menyimpan konfigurasi lama di providerHistory', async () => {
    wahaListSessionsMock.mockResolvedValue([{ name: 'ws_ws-1', status: 'STOPPED' }]);
    wahaCreateSessionMock.mockResolvedValue({ name: 'ws_ws-1', status: 'STARTING' });
    dbState.tables.set('workspaceChannels', [
      {
        id: 'wa-1',
        workspaceId: 'ws-1',
        channelType: 'whatsapp',
        identifier: '6281111111111',
        providerConfig: {
          apiKey: 'old-360dialog-key',
          webhookSecret: 'keep-me',
          phoneNumberId: '123',
        },
        isActive: true,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);

    const res = await validRequest();
    expect(res.status).toBe(201);
    const rows = dbState.tables.get('workspaceChannels') ?? [];
    const config = rows[0].providerConfig as {
      provider: string;
      providerHistory: { provider: string; config: Record<string, unknown>; replacedAt: string }[];
    };
    // Provider lama (360dialog) masuk riwayat; config aktif menjadi waha.
    expect(config.provider).toBe('waha');
    expect(config.providerHistory).toHaveLength(1);
    expect(config.providerHistory[0].provider).toBe('360dialog');
    expect(config.providerHistory[0].config).toMatchObject({ apiKey: 'old-360dialog-key' });
  });

  it('re-setup sesama waha TIDAK menambah providerHistory (riwayat dipertahankan)', async () => {
    wahaListSessionsMock.mockResolvedValue([{ name: 'ws_ws-1', status: 'STOPPED' }]);
    wahaCreateSessionMock.mockResolvedValue({ name: 'ws_ws-1', status: 'STARTING' });
    dbState.tables.set('workspaceChannels', [
      {
        id: 'wa-1',
        workspaceId: 'ws-1',
        channelType: 'whatsapp',
        identifier: null,
        providerConfig: {
          provider: 'waha',
          gatewayApiKey: 'old-key',
          webhookSecret: 'keep-me',
          providerHistory: [
            {
              provider: '360dialog',
              config: { apiKey: 'legacy' },
              replacedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        },
        isActive: true,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);

    const res = await validRequest();
    expect(res.status).toBe(201);
    const rows = dbState.tables.get('workspaceChannels') ?? [];
    const history = (rows[0].providerConfig as { providerHistory: unknown[] }).providerHistory;
    expect(history).toHaveLength(1); // tidak bertambah
  });
});

describe('POST /api/channels/whatsapp/waha/refresh-qr — QR pairing + health', () => {
  const baseWahaChannel = (overrides: Record<string, unknown> = {}) => ({
    id: 'wa-1',
    workspaceId: 'ws-1',
    channelType: 'whatsapp',
    identifier: null,
    providerConfig: {
      provider: 'waha',
      baseUrl: 'http://waha.test:3000',
      gatewayApiKey: 'secret-gateway-key-123',
      sessionName: 'ws_ws-1',
      webhookSecret: 'secret-webhook',
      consent: { version: 1 },
      health: { state: 'connecting', lastSeenAt: null, lastStatusAt: '2026-01-01T00:00:00.000Z' },
    },
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

  const refreshRequest = (body: Record<string, unknown> = {}) =>
    app.request('/api/channels/whatsapp/waha/refresh-qr', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...AUTH_HEADER, ...WORKSPACE_HEADER },
      body: JSON.stringify(body),
    });

  it('tanpa token → 401', async () => {
    const res = await app.request('/api/channels/whatsapp/waha/refresh-qr', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
    expect(wahaGetQrMock).not.toHaveBeenCalled();
  });

  it('tanpa channel whatsapp → 404', async () => {
    const res = await refreshRequest();
    expect(res.status).toBe(404);
    expect(wahaGetQrMock).not.toHaveBeenCalled();
  });

  it('channel 360dialog (bukan waha) → 404', async () => {
    dbState.tables.set('workspaceChannels', [
      {
        ...baseWahaChannel(),
        providerConfig: { apiKey: '360-key', webhookSecret: 's' },
      },
    ]);
    const res = await refreshRequest();
    expect(res.status).toBe(404);
    expect(wahaGetQrMock).not.toHaveBeenCalled();
  });

  it('konfigurasi waha tidak lengkap → 400', async () => {
    dbState.tables.set('workspaceChannels', [
      {
        ...baseWahaChannel(),
        providerConfig: { provider: 'waha', baseUrl: 'http://waha.test:3000' }, // tanpa gatewayApiKey
      },
    ]);
    const res = await refreshRequest();
    expect(res.status).toBe(400);
    expect(wahaGetQrMock).not.toHaveBeenCalled();
  });

  it('channel dijeda → 400, tanpa probe', async () => {
    dbState.tables.set('workspaceChannels', [baseWahaChannel({ isActive: false })]);
    const res = await refreshRequest();
    expect(res.status).toBe(400);
    expect(wahaGetQrMock).not.toHaveBeenCalled();
  });

  it('{ expired: true } → health qr-expired dipersist, TANPA probe gateway', async () => {
    dbState.tables.set('workspaceChannels', [baseWahaChannel()]);

    const res = await refreshRequest({ expired: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ qr: null, healthState: 'qr-expired' });
    expect(wahaGetQrMock).not.toHaveBeenCalled();
    const rows = dbState.tables.get('workspaceChannels') ?? [];
    const health = (rows[0].providerConfig as { health: { state: string } }).health;
    expect(health.state).toBe('qr-expired');
  });

  it('SCAN_QR_CODE → 200: QR segar + health connecting dipersist', async () => {
    dbState.tables.set('workspaceChannels', [baseWahaChannel()]);
    wahaGetQrMock.mockResolvedValue({
      status: 'SCAN_QR_CODE',
      url: 'data:image/png;base64,iVBORw0KGgo=',
      expected: 'CQTG-XJXL-4BD6',
      ttl: 20,
    });

    const res = await refreshRequest();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      qr: { url: string; expected: string; ttl: number };
      healthState: string;
      sessionName: string;
    };
    expect(body).toEqual({
      qr: { url: 'data:image/png;base64,iVBORw0KGgo=', expected: 'CQTG-XJXL-4BD6', ttl: 20 },
      healthState: 'connecting',
      sessionName: 'ws_ws-1',
    });
    expect(wahaGetQrMock).toHaveBeenCalledWith({
      baseUrl: 'http://waha.test:3000',
      apiKey: 'secret-gateway-key-123',
      session: 'ws_ws-1',
    });
    // Kredensial gateway / webhook secret tidak bocor ke payload.
    expect(JSON.stringify(body)).not.toContain('secret-gateway-key-123');
    const rows = dbState.tables.get('workspaceChannels') ?? [];
    const health = (rows[0].providerConfig as { health: { state: string } }).health;
    expect(health.state).toBe('connecting');
  });

  it('PNG mode (status null) + session SCAN_QR_CODE → QR segar ditampilkan', async () => {
    // WAHA baru: wahaGetQr mengembalikan data-URI PNG tanpa status — route
    // probe wahaGetSession untuk tahu sesi masih menunggu scan.
    dbState.tables.set('workspaceChannels', [baseWahaChannel()]);
    wahaGetQrMock.mockResolvedValue({
      status: null,
      url: 'data:image/png;base64,iVBORw0KGgo=',
      expected: null,
      ttl: null,
    });
    wahaGetSessionMock.mockResolvedValue({ name: 'ws_ws-1', status: 'SCAN_QR_CODE' });

    const res = await refreshRequest();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      qr: { url: string; expected: string | null; ttl: number | null };
      healthState: string;
    };
    expect(body).toEqual({
      qr: { url: 'data:image/png;base64,iVBORw0KGgo=', expected: null, ttl: null },
      healthState: 'connecting',
      sessionName: 'ws_ws-1',
    });
    expect(wahaGetSessionMock).toHaveBeenCalledWith(
      'http://waha.test:3000',
      'secret-gateway-key-123',
      'ws_ws-1',
    );
  });

  it('PNG mode + session WORKING → connected (pairing selesai tanpa status di QR)', async () => {
    dbState.tables.set('workspaceChannels', [baseWahaChannel()]);
    wahaGetQrMock.mockResolvedValue({
      status: null,
      url: 'data:image/png;base64,iVBORw0KGgo=',
      expected: null,
      ttl: null,
    });
    wahaGetSessionMock.mockResolvedValue({ name: 'ws_ws-1', status: 'WORKING' });
    wahaGetMeMock.mockResolvedValue({ id: '6281111111111@c.us', pushName: 'Oriole' });

    const res = await refreshRequest();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ qr: null, healthState: 'connected' });
    const rows = dbState.tables.get('workspaceChannels') ?? [];
    const health = (rows[0].providerConfig as { health: { state: string } }).health;
    expect(health.state).toBe('connected');
  });

  it('gateway WORKING → 200: qr null + health connected (pairing selesai) + identifier', async () => {
    dbState.tables.set('workspaceChannels', [baseWahaChannel()]);
    wahaGetQrMock.mockResolvedValue({ status: 'WORKING', url: null, expected: null, ttl: null });
    wahaGetMeMock.mockResolvedValue({ id: '6281111111111@c.us', pushName: 'Oriole' });

    const res = await refreshRequest();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ qr: null, healthState: 'connected' });
    const rows = dbState.tables.get('workspaceChannels') ?? [];
    const health = (rows[0].providerConfig as { health: { state: string; lastSeenAt: string | null } }).health;
    expect(health.state).toBe('connected');
    expect(health.lastSeenAt).not.toBeNull();
    // Nomor sendiri (wa_id) tersimpan sebagai identifier untuk badge kartu.
    expect((rows[0] as { identifier: string | null }).identifier).toBe('6281111111111');
  });

  it('gateway error → 400, health tidak berubah', async () => {
    dbState.tables.set('workspaceChannels', [baseWahaChannel()]);
    wahaGetQrMock.mockRejectedValue(new WahaApiErrorMock('WAHA gagal mengambil QR', 502));

    const res = await refreshRequest();
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('QR');
    const rows = dbState.tables.get('workspaceChannels') ?? [];
    const health = (rows[0].providerConfig as { health: { state: string } }).health;
    expect(health.state).toBe('connecting');
  });

  it('session STOPPED (QR kadaluarsa) → auto-start + QR segar, health connecting', async () => {
    dbState.tables.set('workspaceChannels', [baseWahaChannel()]);
    // QR gagal (session berhenti → auth/qr 422/404); probe status → STOPPED;
    // setelah di-start, QR kedua berhasil.
    wahaGetQrMock
      .mockRejectedValueOnce(new WahaApiErrorMock('WAHA gagal mengambil QR (GET+POST)', 404))
      .mockResolvedValueOnce({ status: null, url: 'data:image/png;base64,xxx', expected: null, ttl: 60 });
    wahaGetSessionMock.mockResolvedValue({ name: 'ws_ws-1', status: 'STOPPED' });
    wahaStartSessionMock.mockResolvedValue({ name: 'ws_ws-1', status: 'SCAN_QR_CODE' });

    const res = await refreshRequest();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { qr: { url: string }; healthState: string };
    expect(body.qr.url).toBe('data:image/png;base64,xxx');
    expect(body.healthState).toBe('connecting');
    // Session di-start persis sekali dengan path baru /api/sessions/{session}/start.
    expect(wahaStartSessionMock).toHaveBeenCalledTimes(1);
    expect(wahaStartSessionMock).toHaveBeenCalledWith(
      'http://waha.test:3000',
      'secret-gateway-key-123',
      'ws_ws-1',
    );
    // Health tetap connecting (QR ditampilkan, belum dipindai).
    const rows = dbState.tables.get('workspaceChannels') ?? [];
    const health = (rows[0].providerConfig as { health: { state: string } }).health;
    expect(health.state).toBe('connecting');
  });

  it('session STOPPED tapi health banned → TIDAK auto-start (docs: jangan restart untuk perbaiki ban)', async () => {
    dbState.tables.set('workspaceChannels', [
      baseWahaChannel({
        providerConfig: {
          ...baseWahaChannel().providerConfig,
          health: { state: 'banned' },
        },
      }),
    ]);
    wahaGetQrMock.mockRejectedValue(new WahaApiErrorMock('WAHA gagal mengambil QR (GET+POST)', 404));
    wahaGetSessionMock.mockResolvedValue({ name: 'ws_ws-1', status: 'STOPPED' });

    const res = await refreshRequest();
    expect(res.status).toBe(400);
    expect(wahaStartSessionMock).not.toHaveBeenCalled();
  });

  it('session hilang dari gateway (start 404) → 400 dengan pesan re-connect', async () => {
    dbState.tables.set('workspaceChannels', [baseWahaChannel()]);
    wahaGetQrMock.mockRejectedValue(new WahaApiErrorMock('WAHA gagal mengambil QR (GET+POST)', 404));
    wahaGetSessionMock.mockResolvedValue({ name: 'ws_ws-1', status: 'STOPPED' });
    wahaStartSessionMock.mockRejectedValue(new WahaApiErrorMock('Not Found', 404));

    const res = await refreshRequest();
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('hubungkan ulang');
    expect(wahaGetQrMock).toHaveBeenCalledTimes(1); // tidak retry QR setelah start gagal
  });

  it('QR tetap gagal walau session di-start → 400 dengan error asli', async () => {
    dbState.tables.set('workspaceChannels', [baseWahaChannel()]);
    wahaGetQrMock.mockRejectedValue(new WahaApiErrorMock('WAHA gagal mengambil QR (GET+POST)', 422));
    wahaGetSessionMock.mockResolvedValue({ name: 'ws_ws-1', status: 'STOPPED' });
    wahaStartSessionMock.mockResolvedValue({ name: 'ws_ws-1', status: 'SCAN_QR_CODE' });

    const res = await refreshRequest();
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('QR');
  });
});
