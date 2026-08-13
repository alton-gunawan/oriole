import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Fake Drizzle db (in-memory) ───────────────────────────────
const { dbState } = vi.hoisted(() => ({
  dbState: {
    tables: new Map<string, Record<string, unknown>[]>(),
    seq: 1,
  },
}));

vi.mock('../db/index.ts', async () => {
  const { workspaceChannels, customerChannels, conversations, messages } = await import(
    '@oriole/database'
  );
  const tableNames = new WeakMap<object, string>([
    [workspaceChannels, 'workspaceChannels'],
    [customerChannels, 'customerChannels'],
    [conversations, 'conversations'],
    [messages, 'messages'],
  ]);

  const NOW = new Date('2026-01-01T00:00:00.000Z');

  return {
    db: {
      select: () => ({
        from: (table: object) => {
          const name = tableNames.get(table) ?? 'unknown';
          const builder: {
            _limit?: number;
            innerJoin: () => typeof builder;
            where: () => typeof builder;
            limit: (n: number) => typeof builder;
            then: (resolve: (rows: unknown[]) => unknown) => Promise<unknown>;
          } = {
            _limit: undefined,
            innerJoin() {
              return builder;
            },
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
        },
      }),
      insert: (table: object) => ({
        values: (values: Record<string, unknown>) => ({
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
              const row = { ...values, id: `id-${dbState.seq++}`, updatedAt: NOW };
              rows.push(row);
              return [row];
            },
          }),
        }),
      }),
      update: (table: object) => {
        const name = tableNames.get(table) ?? 'unknown';
        return {
          set: (values: Record<string, unknown>) => {
            // Terapkan nilai polos; nilai sql (jsonb_set dll) tidak bisa
            // disimulasikan di fake → dilewati (providerConfig tetap utuh).
            const applyAndResolve = async (resolve: (v: unknown) => unknown) => {
              for (const row of dbState.tables.get(name) ?? []) {
                for (const [key, value] of Object.entries(values)) {
                  if (value && typeof value === 'object' && 'queryChunks' in (value as object)) {
                    continue;
                  }
                  (row as Record<string, unknown>)[key] = value;
                }
              }
              return resolve(undefined);
            };
            return {
              from: () => ({ where: () => ({ then: applyAndResolve }) }),
              where: () => ({ then: applyAndResolve }),
            };
          },
        };
      },
    },
  };
});

// ── Mock gateway WAHA ─────────────────────────────────────────
const { wahaGetSessionMock, wahaGetMeMock, WahaApiErrorMock } = vi.hoisted(() => ({
  wahaGetSessionMock: vi.fn(),
  wahaGetMeMock: vi.fn(),
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
  wahaGetSession: wahaGetSessionMock,
  wahaGetMe: wahaGetMeMock,
}));

import {
  ackToMessageStatus,
  applyWahaMessageAck,
  applyWahaSessionStatus,
  defaultWahaHealth,
  markWahaOutboundFailure,
  probeWahaChannelHealth,
  readWahaHealth,
  wahaStatusToState,
  type WahaChannelRow,
} from './waha-health';

// Re-export type agar test memakai bentuk event WAHA tanpa import sirkuler.


function wahaChannelRow(
  overrides: {
    isActive?: boolean;
    identifier?: string | null;
    providerConfig?: Record<string, unknown>;
  } = {},
): WahaChannelRow {
  const { isActive = true, identifier = null, providerConfig = {} } = overrides;
  return {
    workspaceId: 'ws-1',
    identifier,
    isActive,
    providerConfig: {
      provider: 'waha',
      baseUrl: 'http://waha.test:3000',
      gatewayApiKey: 'gw-key',
      sessionName: 'ws_ws-1',
      webhookSecret: 'secret',
      health: { ...defaultWahaHealth(), lastStatusAt: '2026-01-01T00:00:00.000Z' },
      ...providerConfig,
    },
  };
}

function seedWahaRow(row: WahaChannelRow) {
  dbState.tables.set('workspaceChannels', [
    {
      id: 'wa-1',
      workspaceId: row.workspaceId,
      channelType: 'whatsapp',
      identifier: row.identifier,
      providerConfig: row.providerConfig,
      isActive: row.isActive,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  ]);
}

function storedConfig(): Record<string, unknown> {
  return (dbState.tables.get('workspaceChannels')?.[0]?.providerConfig ?? {}) as Record<
    string,
    unknown
  >;
}

beforeEach(() => {
  dbState.tables.set('workspaceChannels', []);
  dbState.tables.set('messages', []);
  dbState.tables.set('conversations', []);
  dbState.tables.set('customerChannels', []);
  wahaGetSessionMock.mockReset();
  wahaGetMeMock.mockReset();
});

describe('wahaStatusToState — status session → health state', () => {
  it('WORKING → connected; FAILED/STOPPED → disconnected; SCAN_QR_CODE → connecting', () => {
    expect(wahaStatusToState('WORKING', 'connecting')).toBe('connected');
    expect(wahaStatusToState('FAILED', 'connected')).toBe('disconnected');
    expect(wahaStatusToState('STOPPED', 'restricted')).toBe('disconnected');
    expect(wahaStatusToState('SCAN_QR_CODE', 'disconnected')).toBe('connecting');
  });

  it('status transisi tidak menurunkan session yang sudah connected', () => {
    expect(wahaStatusToState('STARTING', 'connected')).toBe('connected');
    expect(wahaStatusToState('STOPPING', 'connected')).toBe('connected');
  });

  it('status tidak dikenal → null (jangan ubah apa pun)', () => {
    expect(wahaStatusToState('PASSKEY_REQUIRED', 'connecting')).toBeNull();
    expect(wahaStatusToState(undefined, 'connecting')).toBeNull();
  });
});

describe('ackToMessageStatus — ack WAHA → status pesan', () => {
  it('ack ≥ 2 → delivered; ack 1 → sent; ack < 0 → failed; 0/undefined → null', () => {
    expect(ackToMessageStatus(3)).toBe('delivered');
    expect(ackToMessageStatus(2)).toBe('delivered');
    expect(ackToMessageStatus(1)).toBe('sent');
    expect(ackToMessageStatus(-1)).toBe('failed');
    expect(ackToMessageStatus(0)).toBeNull();
    expect(ackToMessageStatus(undefined)).toBeNull();
  });
});

describe('readWahaHealth — parse defensif providerConfig.health', () => {
  it('field rusak / hilang jatuh ke default', () => {
    const health = readWahaHealth({});
    expect(health).toEqual(defaultWahaHealth());
    expect(readWahaHealth({ health: { state: 'banned' } }).state).toBe('banned');
    expect(readWahaHealth({ health: { state: 'nonsense' } }).state).toBe('connecting');
  });
});

describe('applyWahaSessionStatus — webhook real-time', () => {
  it('WORKING → connected + identifier dari me.id', async () => {
    seedWahaRow(wahaChannelRow());
    await applyWahaSessionStatus('ws-1', {
      id: 'evt_1',
      event: 'session.status',
      me: { id: '6281111111111@c.us' },
      payload: { status: 'WORKING', data: null },
    });
    const health = storedConfig().health as { state: string };
    expect(health.state).toBe('connected');
    // Identifier (nomor sendiri) ikut tersimpan saat connected.
    const row = dbState.tables.get('workspaceChannels')?.[0] as Record<string, unknown>;
    expect(row.identifier).toBe('6281111111111');
  });

  it('reachoutTimelock aktif → restricted + timelock disimpan', async () => {
    seedWahaRow(wahaChannelRow());
    await applyWahaSessionStatus('ws-1', {
      id: 'evt_2',
      event: 'session.status',
      payload: {
        status: 'WORKING',
        data: {
          reachoutTimelock: { isActive: true, timeEnforcementEnds: 1900000000 },
        },
      },
    });
    const health = storedConfig().health as {
      state: string;
      reachoutTimelockUntil: string | null;
    };
    expect(health.state).toBe('restricted');
    expect(health.reachoutTimelockUntil).toBe(new Date(1900000000 * 1000).toISOString());
  });

  it('timelock isActive=false → kembali connected + timelock dibersihkan', async () => {
    seedWahaRow(
      wahaChannelRow({
        providerConfig: {
          health: {
            ...defaultWahaHealth(),
            state: 'restricted',
            reachoutTimelockUntil: '2026-01-02T00:00:00.000Z',
          },
        },
      }),
    );
    await applyWahaSessionStatus('ws-1', {
      id: 'evt_3',
      event: 'session.status',
      payload: {
        status: 'WORKING',
        data: { reachoutTimelock: { isActive: false, timeEnforcementEnds: null } },
      },
    });
    const health = storedConfig().health as {
      state: string;
      reachoutTimelockUntil: string | null;
    };
    expect(health.state).toBe('connected');
    expect(health.reachoutTimelockUntil).toBeNull();
  });

  it('FAILED → disconnected + lastStatus mentah disimpan (untuk hint LID re-pair)', async () => {
    seedWahaRow(wahaChannelRow());
    await applyWahaSessionStatus('ws-1', {
      id: 'evt_4',
      event: 'session.status',
      payload: { status: 'FAILED' },
    });
    const health = storedConfig().health as { state: string; lastStatus: string | null };
    expect(health.state).toBe('disconnected');
    expect(health.lastStatus).toBe('FAILED');
  });

  it('FAILED + timelock aktif → tetap disconnected (timelock tidak menimpa session mati)', async () => {
    seedWahaRow(wahaChannelRow());
    await applyWahaSessionStatus('ws-1', {
      id: 'evt_5',
      event: 'session.status',
      payload: {
        status: 'FAILED',
        data: { reachoutTimelock: { isActive: true, timeEnforcementEnds: 1900000000 } },
      },
    });
    const health = storedConfig().health as { state: string };
    expect(health.state).toBe('disconnected');
  });
});

describe('applyWahaMessageAck — status outbound + heartbeat', () => {
  it('ack 3 → delivered pada pesan keluar dengan providerMessageId cocok', async () => {
    const conversationId = 'conv-1';
    dbState.tables.set('conversations', [
      { id: conversationId, workspaceId: 'ws-1', channelType: 'whatsapp' },
    ]);
    dbState.tables.set('messages', [
      {
        id: 'msg-1',
        conversationId,
        channelType: 'whatsapp',
        direction: 'outbound',
        providerMessageId: 'true_6281234567890@c.us_3EB0C',
        status: 'sent',
        content: 'Halo',
      },
    ]);
    seedWahaRow(wahaChannelRow());

    await applyWahaMessageAck('ws-1', {
      id: 'true_6281234567890@c.us_3EB0C',
      ack: 3,
      fromMe: true,
    });

    expect(dbState.tables.get('messages')?.[0]?.status).toBe('delivered');
    // Heartbeat lastSeenAt lewat jalur jsonb_set (touchWahaHeartbeat) —
    // diuji terpisah agar fake yang tidak bisa mensimulasikan jsonb_set
    // tidak menutupi perilaku ack.
  });
});

describe('touchWahaHeartbeat — update atomik (tanpa menimpa providerConfig)', () => {
  it('memakai jalur db.update (bukan read-modify-write seluruh config)', async () => {
    seedWahaRow(
      wahaChannelRow({
        providerConfig: {
          health: { ...defaultWahaHealth(), state: 'banned', lastSeenAt: null },
        },
      }),
    );
    const { touchWahaHeartbeat } = await import('./waha-health');
    await touchWahaHeartbeat('ws-1');
    // providerConfig utuh (nilai sql dilewati fake) — state tidak berubah.
    const health = storedConfig().health as { state: string };
    expect(health.state).toBe('banned');
  });
});

describe('probeWahaChannelHealth — watchdog poll', () => {
  it('WORKING → connected + identifier dari me.id', async () => {
    seedWahaRow(wahaChannelRow());
    wahaGetSessionMock.mockResolvedValue({ name: 'ws_ws-1', status: 'WORKING' });
    wahaGetMeMock.mockResolvedValue({ id: '6281111111111@c.us', pushName: 'Oriole' });

    const result = await probeWahaChannelHealth(wahaChannelRow());
    expect(result.state).toBe('connected');
    const row = dbState.tables.get('workspaceChannels')?.[0] as Record<string, unknown>;
    expect(row.identifier).toBe('6281111111111');
  });

  it('FAILED → disconnected + lastStatus mentah dari probe', async () => {
    seedWahaRow(wahaChannelRow());
    wahaGetSessionMock.mockResolvedValue({ name: 'ws_ws-1', status: 'FAILED' });
    const result = await probeWahaChannelHealth(wahaChannelRow());
    expect(result.state).toBe('disconnected');
    const health = storedConfig().health as { state: string; lastStatus: string | null };
    expect(health.lastStatus).toBe('FAILED');
  });

  it('gateway tak terjangkau dari connected → disconnected + lastError', async () => {
    seedWahaRow(
      wahaChannelRow({
        providerConfig: { health: { ...defaultWahaHealth(), state: 'connected' } },
      }),
    );
    wahaGetSessionMock.mockRejectedValue(new WahaApiErrorMock('connection refused', 502));
    const result = await probeWahaChannelHealth(wahaChannelRow());
    expect(result).toMatchObject({ state: 'disconnected', reason: 'unreachable' });
    const health = storedConfig().health as { state: string; lastError: { code: number } };
    expect(health.state).toBe('disconnected');
    expect(health.lastError?.code).toBe(502);
  });

  it('gateway tak terjangkau → lastStatus di-null (jangan tinggalkan FAILED basi)', async () => {
    // Session tadinya FAILED (lastStatus 'FAILED') lalu gateway mati — status
    // mentah lama tidak boleh tertinggal, atau hint LID re-pair tampil salah.
    seedWahaRow(
      wahaChannelRow({
        providerConfig: {
          health: {
            ...defaultWahaHealth(),
            state: 'connected',
            lastStatus: 'FAILED',
          },
        },
      }),
    );
    wahaGetSessionMock.mockRejectedValue(new WahaApiErrorMock('connection refused', 502));
    await probeWahaChannelHealth(wahaChannelRow());
    const health = storedConfig().health as { lastStatus: string | null };
    expect(health.lastStatus).toBeNull();
  });

  it('gateway tak terjangkau saat masih connecting → state tetap, hanya lastError', async () => {
    seedWahaRow(
      wahaChannelRow({
        providerConfig: { health: { ...defaultWahaHealth(), state: 'connecting' } },
      }),
    );
    wahaGetSessionMock.mockRejectedValue(new WahaApiErrorMock('connection refused', 502));
    const result = await probeWahaChannelHealth(wahaChannelRow());
    expect(result).toMatchObject({ state: 'connecting', reason: 'unreachable' });
    const health = storedConfig().health as { state: string; lastError: { code: number } };
    expect(health.state).toBe('connecting');
    expect(health.lastError?.code).toBe(502);
  });

  it('channel dijeda user → skip tanpa probe', async () => {
    seedWahaRow(wahaChannelRow());
    const result = await probeWahaChannelHealth(wahaChannelRow({ isActive: false }));
    expect(result).toMatchObject({ state: null, reason: 'paused' });
    expect(wahaGetSessionMock).not.toHaveBeenCalled();
  });
});

describe('markWahaOutboundFailure — 463/402/403 → health', () => {
  it('463 dalam jendela timelock → restricted + timelock 24 jam', async () => {
    seedWahaRow(wahaChannelRow());
    await markWahaOutboundFailure('ws-1', { status: 463, message: 'reachout timelock' });
    const health = storedConfig().health as {
      state: string;
      reachoutTimelockUntil: string | null;
      lastError: { code: number } | null;
    };
    expect(health.state).toBe('restricted');
    expect(health.reachoutTimelockUntil).not.toBeNull();
    expect(health.lastError?.code).toBe(463);
  });

  it('463 di luar jendela timelock → banned', async () => {
    seedWahaRow(
      wahaChannelRow({
        providerConfig: {
          health: {
            ...defaultWahaHealth(),
            state: 'restricted',
            reachoutTimelockUntil: '2020-01-01T00:00:00.000Z', // sudah lewat
          },
        },
      }),
    );
    await markWahaOutboundFailure('ws-1', { status: 463, message: 'reachout timelock' });
    const health = storedConfig().health as { state: string; reachoutTimelockUntil: string | null };
    expect(health.state).toBe('banned');
    expect(health.reachoutTimelockUntil).toBeNull();
  });

  it('403 → banned (auto-pause outbound)', async () => {
    seedWahaRow(wahaChannelRow());
    await markWahaOutboundFailure('ws-1', { status: 403, message: 'forbidden' });
    expect((storedConfig().health as { state: string }).state).toBe('banned');
  });

  it('error lain → hanya lastError, state tidak berubah', async () => {
    seedWahaRow(wahaChannelRow());
    await markWahaOutboundFailure('ws-1', { status: 500, message: 'boom' });
    const health = storedConfig().health as { state: string; lastError: { code: number } };
    expect(health.state).toBe('connecting');
    expect(health.lastError?.code).toBe(500);
  });
});
