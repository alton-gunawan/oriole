import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock env — mutable per-test (platform configured vs tidak) ──
const { envState } = vi.hoisted(() => ({
  envState: {
    META_WHATSAPP_APP_ID: 'app-12345678',
    META_WHATSAPP_APP_SECRET: 'app-secret-123',
    META_WHATSAPP_CONFIG_ID: 'config-id-123',
    META_WHATSAPP_VERIFY_TOKEN: 'verify-token-123',
    META_WHATSAPP_SYSTEM_USER_TOKEN: 'sys-token-123',
    META_GRAPH_API_VERSION: 'v21.0',
    API_URL: 'https://api.example.com',
    APP_URL: 'https://app.example.com',
  } as Record<string, string | undefined>,
}));

vi.mock('./env.ts', () => ({ env: envState }));

// ── Mock crypto — enkripsi deterministik untuk assert secret-at-rest ──
vi.mock('./crypto.ts', () => ({
  encryptSecret: (value: string) => `enc:${value}`,
  decryptSecret: (value: string) => (value.startsWith('enc:') ? value.slice(4) : value),
}));

// ── Mock Meta API client ──
const meta = vi.hoisted(() => {
  class MetaWhatsAppApiError extends Error {
    constructor(message: string, readonly status?: number) {
      super(message);
      this.name = 'MetaWhatsAppApiError';
    }
  }
  return {
    MetaWhatsAppApiError,
    exchangeWhatsappCode: vi.fn(),
    resolveWabaIdByToken: vi.fn(),
    getWabaInfo: vi.fn(),
    getWabaPhoneNumbers: vi.fn(),
    subscribeAppToWaba: vi.fn(),
    registerPhoneNumber: vi.fn(),
  };
});

vi.mock('../services/meta-whatsapp.ts', () => ({
  buildMetaWhatsappSignupUrl: (input: {
    version: string;
    appId: string;
    configId: string;
    state: string;
    redirectUri: string;
  }) =>
    `https://www.facebook.com/${input.version}/dialog/whatsapp_business_signup?state=${encodeURIComponent(input.state)}`,
  ...meta,
  MetaWhatsAppApiError: meta.MetaWhatsAppApiError,
}));

// ── Fake Drizzle db (where-filtering penuh) — pola sama dengan vapi-inbound.test.ts ──
const { dbState } = vi.hoisted(() => ({
  dbState: { tables: new Map<string, Record<string, unknown>[]>(), seq: 1 },
}));

vi.mock('../db/index.ts', async () => {
  const { whatsappConnections, workspaces } = await import('@oriole/database');
  const tableNames = new WeakMap<object, string>();
  tableNames.set(whatsappConnections, 'whatsapp_connections');
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
    !!c &&
    typeof c === 'object' &&
    Array.isArray((c as { value?: unknown }).value) &&
    ((c as { value: unknown[] }).value.every((v) => typeof v === 'string'));
  const isColumnChunk = (c: unknown): c is { name: string } =>
    !!c && typeof c === 'object' && typeof (c as { name?: unknown }).name === 'string';

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
    const params: unknown[] = [];
    for (const chunk of chunks) {
      if (isColumnChunk(chunk)) {
        colName = chunk.name;
        continue;
      }
      if (isStringChunk(chunk)) continue;
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
    const value = params[0];
    return (row) => row[key] === value;
  }

  function filterRows(name: string, conds: unknown[], table: object) {
    const colKey = columnKeyMap(table);
    const predicates = conds.map((c) => buildPredicate(c, colKey));
    return (dbState.tables.get(name) ?? []).filter((row) =>
      predicates.every((pred) => pred(row as Record<string, unknown>)),
    );
  }

  const NOW = new Date('2026-01-01T00:00:00.000Z');
  const NOW2 = new Date('2026-01-02T00:00:00.000Z');

  function project(rows: Record<string, unknown>[], fields: Record<string, unknown> | undefined, colKey: Record<string, string>) {
    if (!fields) return rows;
    return rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const [alias, col] of Object.entries(fields)) {
        const colName = (col as { name?: string } | undefined)?.name;
        const key = colName ? colKey[colName] : undefined;
        out[alias] = key !== undefined ? row[key] : undefined;
      }
      return out;
    });
  }

  return {
    db: {
      select: (fields?: Record<string, unknown>) => ({
        from: (table: object) => {
          const name = tableNames.get(table) ?? 'unknown';
          const colKey = columnKeyMap(table);
          const builder: {
            where: (...conds: unknown[]) => typeof builder;
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
            limit(n: number) {
              builder._limit = n;
              return builder;
            },
            then(resolve) {
              let rows = filterRows(name, builder._conds, table);
              if (builder._limit != null) rows = rows.slice(0, builder._limit);
              return Promise.resolve(resolve(project(rows as Record<string, unknown>[], fields, colKey)));
            },
          };
          return builder;
        },
      }),
      insert: (table: object) => {
        const name = tableNames.get(table) ?? 'unknown';
        const colKey = columnKeyMap(table);
        const insertRows = (
          values: Record<string, unknown> | Record<string, unknown>[],
          conflictCols: object[],
          onConflictSet?: Record<string, unknown>,
        ) => {
          const list = Array.isArray(values) ? values : [values];
          const store = dbState.tables.get(name) ?? [];
          const conflictKeys = conflictCols.map((c) => colKey[(c as { name: string }).name]);
          const out: Record<string, unknown>[] = [];
          for (const value of list) {
            const existing = conflictKeys.length
              ? store.find((r) => conflictKeys.every((k) => r[k] === value[k]))
              : undefined;
            if (existing) {
              const merged = { ...existing, ...value, ...(onConflictSet ?? {}), updatedAt: NOW2 };
              const idx = store.indexOf(existing);
              store[idx] = merged;
              out.push(merged);
            } else {
              const row: Record<string, unknown> = {
                ...value,
                id: `${name}-${dbState.seq++}`,
                createdAt: NOW,
                updatedAt: NOW,
              };
              store.push(row);
              out.push(row);
            }
          }
          return out;
        };
        const makeChain = (values: Record<string, unknown>) => ({
          onConflictDoUpdate: (opts: { target: object[]; set: Record<string, unknown> }) => ({
            then(resolve: (rows: unknown[]) => unknown) {
              return Promise.resolve(resolve(insertRows(values, opts.target, opts.set)));
            },
          }),
          returning: async (fields?: Record<string, unknown>) =>
            project(insertRows(values, [], undefined), fields, colKey),
          then(resolve: (rows: unknown[]) => unknown) {
            return Promise.resolve(resolve(insertRows(values, [], undefined)));
          },
        });
        return { values: makeChain };
      },
      update: (table: object) => {
        const name = tableNames.get(table) ?? 'unknown';
        const doUpdate = (values: Record<string, unknown>, conds: unknown[]) => {
          const matched = filterRows(name, conds, table);
          const store = dbState.tables.get(name) as Record<string, unknown>[] | undefined;
          const updated: Record<string, unknown>[] = [];
          for (const target of matched) {
            const idx = store?.indexOf(target) ?? -1;
            if (idx < 0) continue;
            const merged = { ...target, ...values, updatedAt: NOW2 };
            (store as Record<string, unknown>[])[idx] = merged;
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
    },
  };
});

import {
  checkWhatsAppBusinessStatus,
  completeWhatsAppBusinessConnect,
  disconnectWhatsAppBusiness,
  frontendReturnUrl,
  getWhatsAppBusinessConnection,
  metaWhatsAppPlatformConfig,
  resolveWorkspaceByPhoneNumberId,
  startWhatsAppBusinessConnect,
  whatsappBusinessCallbackUrl,
  WhatsAppBusinessError,
} from './whatsapp-business.ts';

function connectionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'conn-1',
    workspaceId: 'ws-1',
    wabaId: 'waba-1',
    phoneNumberId: 'pn-1',
    displayPhoneNumber: '+62 812-3456-7890',
    businessName: 'Klinik Gigi Sehat',
    status: 'connected',
    errorMessage: null,
    accessTokenEncrypted: 'enc:token-1',
    signupState: null,
    metadata: {},
    connectedAt: new Date('2026-01-01T00:00:00.000Z'),
    lastSyncAt: new Date('2026-01-01T00:00:00.000Z'),
    disconnectedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  dbState.tables.clear();
  dbState.seq = 1;
  dbState.tables.set('whatsapp_connections', []);
  dbState.tables.set('workspaces', [{ id: 'ws-1', aiEnabled: true }]);
  meta.exchangeWhatsappCode.mockReset();
  meta.resolveWabaIdByToken.mockReset();
  meta.getWabaInfo.mockReset();
  meta.getWabaPhoneNumbers.mockReset();
  meta.subscribeAppToWaba.mockReset();
  meta.registerPhoneNumber.mockReset();
});

/* ────────────────────────────────────────────────────────────
 * Konfigurasi platform + URL
 * ──────────────────────────────────────────────────────────── */
describe('metaWhatsAppPlatformConfig', () => {
  it('null bila salah satu env Meta belum disetel', () => {
    const prev = envState.META_WHATSAPP_APP_SECRET;
    envState.META_WHATSAPP_APP_SECRET = undefined;
    expect(metaWhatsAppPlatformConfig()).toBeNull();
    envState.META_WHATSAPP_APP_SECRET = prev;
  });

  it('mengembalikan konfigurasi lengkap bila semua env ada', () => {
    expect(metaWhatsAppPlatformConfig()).toEqual({
      appId: 'app-12345678',
      appSecret: 'app-secret-123',
      configId: 'config-id-123',
      verifyToken: 'verify-token-123',
      systemUserToken: 'sys-token-123',
    });
  });
});

describe('whatsappBusinessCallbackUrl / frontendReturnUrl', () => {
  it('callback URL memakai API_URL', () => {
    expect(whatsappBusinessCallbackUrl()).toBe(
      'https://api.example.com/api/whatsapp-business/connect/callback',
    );
  });

  it('frontendReturnUrl membangun redirect ke halaman integrations', () => {
    expect(frontendReturnUrl('connected')).toBe(
      'https://app.example.com/integrations?whatsapp=connected',
    );
    expect(frontendReturnUrl('error', 'whatsapp-connect-failed')).toBe(
      'https://app.example.com/integrations?whatsapp=error&reason=whatsapp-connect-failed',
    );
  });
});

/* ────────────────────────────────────────────────────────────
 * Status publik
 * ──────────────────────────────────────────────────────────── */
describe('getWhatsAppBusinessConnection', () => {
  it('tanpa baris koneksi → not_connected + platform configured', async () => {
    const conn = await getWhatsAppBusinessConnection('ws-1');
    expect(conn).toMatchObject({
      status: 'not_connected',
      wabaId: null,
      aiAssistantEnabled: true,
      platformConfigured: true,
    });
  });

  it('baris connected → metadata publik, token TIDAK ikut terserialisasi', async () => {
    dbState.tables.set('whatsapp_connections', [connectionRow()]);
    const conn = await getWhatsAppBusinessConnection('ws-1');
    expect(conn).toMatchObject({
      status: 'connected',
      wabaId: 'waba-1',
      phoneNumberId: 'pn-1',
      displayPhoneNumber: '+62 812-3456-7890',
      businessName: 'Klinik Gigi Sehat',
      aiAssistantEnabled: true,
      connectedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(JSON.stringify(conn)).not.toContain('token-1');
  });
});

/* ────────────────────────────────────────────────────────────
 * Start connect
 * ──────────────────────────────────────────────────────────── */
describe('startWhatsAppBusinessConnect', () => {
  it('platform belum dikonfigurasi → WhatsAppBusinessError', async () => {
    const prev = envState.META_WHATSAPP_CONFIG_ID;
    envState.META_WHATSAPP_CONFIG_ID = undefined;
    await expect(startWhatsAppBusinessConnect('ws-1')).rejects.toBeInstanceOf(
      WhatsAppBusinessError,
    );
    envState.META_WHATSAPP_CONFIG_ID = prev;
  });

  it('membuat baris connecting + mengembalikan signupUrl yang memuat state', async () => {
    const { signupUrl } = await startWhatsAppBusinessConnect('ws-1');
    expect(signupUrl).toContain('dialog/whatsapp_business_signup');
    const rows = dbState.tables.get('whatsapp_connections') ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspaceId: 'ws-1', status: 'connecting' });
    expect(rows[0].signupState).toBeTruthy();
    expect(signupUrl).toContain(encodeURIComponent(String(rows[0].signupState)));
  });

  it('reconnect: baris existing di-update ke connecting dengan state baru', async () => {
    dbState.tables.set('whatsapp_connections', [connectionRow({ status: 'disconnected' })]);
    await startWhatsAppBusinessConnect('ws-1');
    const rows = dbState.tables.get('whatsapp_connections') ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'connecting', id: 'conn-1' });
    expect(rows[0].signupState).toBeTruthy();
  });
});

/* ────────────────────────────────────────────────────────────
 * Complete connect (callback)
 * ──────────────────────────────────────────────────────────── */
describe('completeWhatsAppBusinessConnect', () => {
  function mockMetaHappyPath() {
    meta.exchangeWhatsappCode.mockResolvedValue('business-token');
    meta.resolveWabaIdByToken.mockResolvedValue('waba-9');
    meta.getWabaInfo.mockResolvedValue({ name: 'Sehat Bersama' });
    meta.getWabaPhoneNumbers.mockResolvedValue([
      {
        id: 'pn-9',
        displayPhoneNumber: '+62 811 2222 3333',
        verifiedName: 'Sehat Bersama',
        qualityRating: 'GREEN',
        codeVerificationStatus: 'VERIFIED',
        nameStatus: 'APPROVED',
      },
    ]);
    meta.subscribeAppToWaba.mockResolvedValue(undefined);
    meta.registerPhoneNumber.mockResolvedValue(undefined);
  }

  it('state tidak dikenal → WhatsAppBusinessError', async () => {
    await expect(
      completeWhatsAppBusinessConnect({ code: 'c', state: 'ghost' }),
    ).rejects.toBeInstanceOf(WhatsAppBusinessError);
  });

  it('happy path: subscribe webhook + register nomor + simpan (token terenkripsi)', async () => {
    dbState.tables.set('whatsapp_connections', [
      connectionRow({ status: 'connecting', signupState: 'state-1', wabaId: null, phoneNumberId: null }),
    ]);
    mockMetaHappyPath();

    const result = await completeWhatsAppBusinessConnect({ code: 'auth-code', state: 'state-1' });
    expect(result).toEqual({ workspaceId: 'ws-1', alreadyConnected: false });

    expect(meta.exchangeWhatsappCode).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'app-12345678', appSecret: 'app-secret-123', code: 'auth-code' }),
    );
    expect(meta.subscribeAppToWaba).toHaveBeenCalledWith(
      expect.objectContaining({ businessToken: 'business-token', wabaId: 'waba-9' }),
    );
    expect(meta.registerPhoneNumber).toHaveBeenCalledWith(
      expect.objectContaining({ businessToken: 'business-token', phoneNumberId: 'pn-9' }),
    );

    const row = (dbState.tables.get('whatsapp_connections') ?? [])[0];
    expect(row).toMatchObject({
      status: 'connected',
      wabaId: 'waba-9',
      phoneNumberId: 'pn-9',
      displayPhoneNumber: '+62 811 2222 3333',
      businessName: 'Sehat Bersama',
      signupState: null,
    });
    expect(row.accessTokenEncrypted).toBe('enc:business-token');
    expect(String((row.metadata as Record<string, unknown>).verifiedName)).toBe('Sehat Bersama');
  });

  it('gagal tukar code → status error + pesan tersimpan', async () => {
    dbState.tables.set('whatsapp_connections', [
      connectionRow({ status: 'connecting', signupState: 'state-1' }),
    ]);
    meta.exchangeWhatsappCode.mockRejectedValue(new meta.MetaWhatsAppApiError('Invalid code'));

    await expect(
      completeWhatsAppBusinessConnect({ code: 'bad', state: 'state-1' }),
    ).rejects.toBeTruthy();

    const row = (dbState.tables.get('whatsapp_connections') ?? [])[0];
    expect(row.status).toBe('error');
    expect(row.errorMessage).toBe('Invalid code');
    expect(row.signupState).toBeNull();
  });
});

/* ────────────────────────────────────────────────────────────
 * Resolve tenant dari phone_number_id (webhook masuk)
 * ──────────────────────────────────────────────────────────── */
describe('resolveWorkspaceByPhoneNumberId', () => {
  it('mencocokkan nomor connected → workspaceId', async () => {
    dbState.tables.set('whatsapp_connections', [connectionRow({ phoneNumberId: 'pn-42' })]);
    await expect(resolveWorkspaceByPhoneNumberId('pn-42')).resolves.toBe('ws-1');
  });

  it('nomor tidak dikenal / tidak connected → null', async () => {
    dbState.tables.set('whatsapp_connections', [
      connectionRow({ phoneNumberId: 'pn-42', status: 'disconnected' }),
    ]);
    await expect(resolveWorkspaceByPhoneNumberId('pn-42')).resolves.toBeNull();
  });
});

/* ────────────────────────────────────────────────────────────
 * Disconnect / check status
 * ──────────────────────────────────────────────────────────── */
describe('disconnectWhatsAppBusiness', () => {
  it('menghapus token + menandai disconnected, metadata dipertahankan', async () => {
    dbState.tables.set('whatsapp_connections', [connectionRow()]);
    await disconnectWhatsAppBusiness('ws-1');
    const row = (dbState.tables.get('whatsapp_connections') ?? [])[0];
    expect(row.status).toBe('disconnected');
    expect(row.accessTokenEncrypted).toBeNull();
    expect(row.phoneNumberId).toBe('pn-1'); // metadata dipertahankan
  });
});

describe('checkWhatsAppBusinessStatus', () => {
  it('connected + token valid → tetap connected', async () => {
    dbState.tables.set('whatsapp_connections', [connectionRow()]);
    meta.getWabaPhoneNumbers.mockResolvedValue([]);
    const conn = await checkWhatsAppBusinessStatus('ws-1');
    expect(conn.status).toBe('connected');
  });

  it('token invalid → status error + ajakan reconnect', async () => {
    dbState.tables.set('whatsapp_connections', [connectionRow()]);
    meta.getWabaPhoneNumbers.mockRejectedValue(new meta.MetaWhatsAppApiError('Token expired'));
    const conn = await checkWhatsAppBusinessStatus('ws-1');
    expect(conn.status).toBe('error');
    expect(conn.errorMessage).toBe('Token WhatsApp kedaluwarsa — hubungkan ulang.');
  });
});
