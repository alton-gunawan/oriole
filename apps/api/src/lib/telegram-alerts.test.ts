import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceChannels, workspaceIntegrations, workspaces } from '@oriole/database';

// ── Fake Drizzle db (select/insert/update untuk 3 tabel) ───────
const { dbState } = vi.hoisted(() => ({
  dbState: { tables: new Map<string, Record<string, unknown>[]>(), seq: 1 },
}));

vi.mock('../db/index.ts', async () => {
  const tableNames = new WeakMap<object, string>();
  tableNames.set(workspaceIntegrations, 'workspaceIntegrations');
  tableNames.set(workspaceChannels, 'workspaceChannels');
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

  /** Kumpulkan pasangan eq (kolom, nilai) dari kondisi (and(eq, eq) dll.). */
  function eqPairs(cond: unknown): { name: string; value: unknown }[] {
    const pairs: { name: string; value: unknown }[] = [];
    const walk = (node: unknown) => {
      if (!node || typeof node !== 'object') return;
      const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
      if (!Array.isArray(chunks)) return;
      chunks.forEach((chunk, i) => {
        if (chunk && typeof chunk === 'object' && typeof (chunk as { name?: unknown }).name === 'string') {
          const raw = chunks[i + 2];
          const value =
            raw && typeof raw === 'object' && 'value' in (raw as object)
              ? (raw as { value: unknown }).value
              : raw;
          pairs.push({ name: (chunk as { name: string }).name, value });
        } else {
          walk(chunk);
        }
      });
    };
    walk(cond);
    return pairs;
  }

  function matches(table: object, row: Record<string, unknown>, cond: unknown): boolean {
    const colKey = columnKeyMap(table);
    return eqPairs(cond).every((filter) => {
      const key = colKey[filter.name];
      return key === undefined || row[key] === filter.value;
    });
  }

  function selectBuilder(name: string, table: object) {
    const builder: {
      where: (cond: unknown) => typeof builder;
      limit: (n: number) => typeof builder;
      then: (resolve: (rows: unknown[]) => unknown) => Promise<unknown>;
      _cond?: unknown;
      _limit?: number;
    } = {
      _cond: undefined,
      _limit: undefined,
      where(cond) {
        builder._cond = cond;
        return builder;
      },
      limit(n) {
        builder._limit = n;
        return builder;
      },
      then(resolve) {
        let rows = [...(dbState.tables.get(name) ?? [])];
        if (builder._cond) rows = rows.filter((row) => matches(table, row, builder._cond!));
        if (builder._limit != null) rows = rows.slice(0, builder._limit);
        return Promise.resolve(resolve(rows));
      },
    };
    return builder;
  }

  return {
    db: {
      select: () => ({ from: (table: object) => selectBuilder(tableNames.get(table) ?? 'unknown', table) }),
      insert: (table: object) => ({
        values: (values: Record<string, unknown>) => ({
          onConflictDoUpdate: (opts: { set: Record<string, unknown> }) => ({
            returning: async () => {
              const name = tableNames.get(table) ?? 'unknown';
              const rows = dbState.tables.get(name) ?? [];
              const idx = rows.findIndex(
                (r) =>
                  r.workspaceId === values.workspaceId &&
                  r.integrationType === values.integrationType,
              );
              if (idx >= 0) {
                Object.assign(rows[idx], { ...values, ...opts.set });
                return [rows[idx]];
              }
              const row = {
                ...values,
                ...opts.set,
                id: values.id ?? `int-${dbState.seq++}`,
                createdAt: new Date(),
                updatedAt: new Date(),
              };
              rows.push(row);
              return [row];
            },
          }),
        }),
      }),
      update: (table: object) => ({
        set: (values: Record<string, unknown>) => ({
          where: (cond: unknown) => ({
            then: async (resolve: (v: unknown) => unknown) => {
              const name = tableNames.get(table) ?? 'unknown';
              for (const row of dbState.tables.get(name) ?? []) {
                if (matches(table, row, cond)) Object.assign(row, values);
              }
              return Promise.resolve(resolve(undefined));
            },
          }),
        }),
      }),
    },
  };
});

// ── Mocks telegram ─────────────────────────────────────────────
const { sendMessageMock, getMeMock } = vi.hoisted(() => ({
  sendMessageMock: vi.fn(),
  getMeMock: vi.fn(),
}));

vi.mock('./telegram.ts', () => ({
  TelegramApiError: class TelegramApiError extends Error {},
  telegramSendMessage: sendMessageMock,
  telegramGetMe: getMeMock,
}));

const { resolveChannelMock } = vi.hoisted(() => ({ resolveChannelMock: vi.fn() }));
vi.mock('./telegram-handler.ts', () => ({
  resolveTelegramChannel: resolveChannelMock,
}));

import {
  bindTelegramAlertsChat,
  buildTelegramBookingAlert,
  deliverTelegramBusinessAlert,
  ensureTelegramAlertsConfig,
  handleTelegramAlertBind,
  loadTelegramAlertsConfig,
  parseTelegramAlertBindPayload,
  sendTestTelegramAlert,
  telegramAlertsBindUrl,
} from './telegram-alerts.ts';

const WORKSPACE_ID = 'ws-1';
const CHAT_ID = '123456789';
const TOKEN = '0123456789abcdef'.repeat(3); // 48 hex
const BOT_TOKEN = '123456:ABC';

function alertsIntegration(overrides: Record<string, unknown> = {}) {
  return {
    id: 'int-alerts-1',
    workspaceId: WORKSPACE_ID,
    integrationType: 'telegram-alerts',
    identifier: null,
    providerConfig: { bindToken: TOKEN, chatId: null, chatName: null },
    isActive: true,
    lastSyncAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function telegramChannelRow() {
  return {
    id: 'chan-1',
    workspaceId: WORKSPACE_ID,
    channelType: 'telegram',
    identifier: '@OrioleBot',
    providerConfig: { botToken: BOT_TOKEN },
    isActive: true,
  };
}

beforeEach(() => {
  dbState.seq = 1;
  dbState.tables.set('workspaceIntegrations', []);
  dbState.tables.set('workspaceChannels', []);
  dbState.tables.set('workspaces', [{ id: WORKSPACE_ID, name: 'Klinik', chatLanguage: 'en' }]);
  sendMessageMock.mockReset();
  sendMessageMock.mockResolvedValue({ messageId: 1 });
  getMeMock.mockReset();
  getMeMock.mockResolvedValue({ id: 1, username: 'OrioleBot', isBot: true });
  resolveChannelMock.mockReset();
  resolveChannelMock.mockResolvedValue({ token: BOT_TOKEN, webhookSecret: null, isActive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseTelegramAlertBindPayload', () => {
  it('payload deep-link valid → token', () => {
    expect(parseTelegramAlertBindPayload(`/start oriole_${TOKEN}`)).toBe(TOKEN);
  });

  it('/start polos, format lain, atau kosong → null', () => {
    expect(parseTelegramAlertBindPayload('/start')).toBeNull();
    expect(parseTelegramAlertBindPayload('/start oriole_bukan-hex')).toBeNull();
    expect(parseTelegramAlertBindPayload('/mulai oriole_abc')).toBeNull();
    expect(parseTelegramAlertBindPayload('')).toBeNull();
    expect(parseTelegramAlertBindPayload(null)).toBeNull();
  });
});

describe('buildTelegramBookingAlert', () => {
  it('booking.created → kartu lengkap (judul, customer, waktu, telepon)', () => {
    const text = buildTelegramBookingAlert('booking.created', {
      title: 'Perawatan Gigi',
      customerName: 'Budi',
      scheduledAt: '2026-08-15T07:00:00.000Z',
      timezone: 'Asia/Jakarta',
      phone: '+6281234567890',
      status: 'pending',
    });
    expect(text).toContain('🆕 New booking');
    expect(text).toContain('Perawatan Gigi');
    expect(text).toContain('👤 Budi');
    expect(text).toContain('📞 +6281234567890');
    expect(text).toContain('• pending');
  });

  it('data minimal → hanya header + status default (tanpa baris kosong)', () => {
    const text = buildTelegramBookingAlert('booking.created', { id: 'b-1' });
    expect(text).toBe('🆕 New booking');
  });

  it('ping → pesan tes', () => {
    expect(buildTelegramBookingAlert('ping', {})).toContain('🔔 Oriole test message');
  });

  it('event tak dikenal → fallback judul event', () => {
    expect(buildTelegramBookingAlert('booking.paid', {})).toContain('🔔 booking.paid');
  });
});

describe('ensureTelegramAlertsConfig', () => {
  it('belum ada → buat row dengan bindToken baru (isActive)', async () => {
    const { integration, config } = await ensureTelegramAlertsConfig(WORKSPACE_ID);
    expect(integration.integrationType).toBe('telegram-alerts');
    expect(integration.isActive).toBe(true);
    expect(config.bindToken).toMatch(/^[0-9a-f]{48}$/);
    expect((integration.providerConfig as { chatId?: unknown }).chatId).toBeNull();
  });

  it('sudah ada + chat terikat → token baru, chatId dipertahankan', async () => {
    dbState.tables.set('workspaceIntegrations', [
      alertsIntegration({ providerConfig: { bindToken: TOKEN, chatId: CHAT_ID, chatName: 'Budi' } }),
    ]);
    const { config } = await ensureTelegramAlertsConfig(WORKSPACE_ID);
    expect(config.bindToken).not.toBe(TOKEN);
    expect(config.chatId).toBe(CHAT_ID);
  });
});

describe('bindTelegramAlertsChat', () => {
  it('token salah → ditolak, chat tidak terikat', async () => {
    dbState.tables.set('workspaceIntegrations', [alertsIntegration()]);
    const result = await bindTelegramAlertsChat({
      workspaceId: WORKSPACE_ID,
      chatId: CHAT_ID,
      chatName: 'Budi',
      token: 'f'.repeat(48),
    });
    expect(result).toEqual({ bound: false, reason: 'invalid-token' });
    const row = dbState.tables.get('workspaceIntegrations')![0];
    expect((row.providerConfig as { chatId?: unknown }).chatId).toBeNull();
  });

  it('token benar → chat terikat + token dirotasi (link bekas mati)', async () => {
    dbState.tables.set('workspaceIntegrations', [alertsIntegration()]);
    const result = await bindTelegramAlertsChat({
      workspaceId: WORKSPACE_ID,
      chatId: CHAT_ID,
      chatName: 'Budi',
      token: TOKEN,
    });
    expect(result).toEqual({ bound: true });
    const row = dbState.tables.get('workspaceIntegrations')![0];
    const config = row.providerConfig as { bindToken: string; chatId: string; chatName: string };
    expect(config.chatId).toBe(CHAT_ID);
    expect(config.chatName).toBe('Budi');
    expect(config.bindToken).not.toBe(TOKEN);
  });

  it('integrasi belum ada → not-configured', async () => {
    const result = await bindTelegramAlertsChat({
      workspaceId: WORKSPACE_ID,
      chatId: CHAT_ID,
      chatName: null,
      token: TOKEN,
    });
    expect(result).toEqual({ bound: false, reason: 'not-configured' });
  });
});

describe('deliverTelegramBusinessAlert', () => {
  it('belum diaktifkan → skipped not-configured (tanpa throw)', async () => {
    const result = await deliverTelegramBusinessAlert(WORKSPACE_ID, 'booking.created', {});
    expect(result).toEqual({ skipped: 'not-configured' });
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('diaktifkan tapi belum bind → skipped not-bound', async () => {
    dbState.tables.set('workspaceIntegrations', [alertsIntegration()]);
    const result = await deliverTelegramBusinessAlert(WORKSPACE_ID, 'booking.created', {
      title: 'Perawatan Gigi',
    });
    expect(result).toEqual({ skipped: 'not-bound' });
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('terikat + channel aktif → pesan terkirim ke chat bisnis', async () => {
    dbState.tables.set('workspaceIntegrations', [
      alertsIntegration({ providerConfig: { bindToken: TOKEN, chatId: CHAT_ID, chatName: 'Budi' } }),
    ]);
    const result = await deliverTelegramBusinessAlert(WORKSPACE_ID, 'booking.created', {
      title: 'Perawatan Gigi',
      customerName: 'Budi',
    });
    expect(result).toEqual({ delivered: true });
    expect(sendMessageMock).toHaveBeenCalledWith({
      token: BOT_TOKEN,
      chatId: CHAT_ID,
      text: expect.stringContaining('🆕 New booking'),
    });
  });

  it('channel belum dikonfigurasi → skipped no-channel', async () => {
    resolveChannelMock.mockResolvedValue(null);
    dbState.tables.set('workspaceIntegrations', [
      alertsIntegration({ providerConfig: { bindToken: TOKEN, chatId: CHAT_ID } }),
    ]);
    const result = await deliverTelegramBusinessAlert(WORKSPACE_ID, 'booking.created', {});
    expect(result).toEqual({ skipped: 'no-channel' });
  });
});

describe('sendTestTelegramAlert', () => {
  it('belum bind → TelegramAlertError (409 semantics)', async () => {
    dbState.tables.set('workspaceIntegrations', [alertsIntegration()]);
    await expect(sendTestTelegramAlert(WORKSPACE_ID)).rejects.toThrow(/Belum ada chat/);
  });

  it('terikat → ping terkirim', async () => {
    dbState.tables.set('workspaceIntegrations', [
      alertsIntegration({ providerConfig: { bindToken: TOKEN, chatId: CHAT_ID } }),
    ]);
    const result = await sendTestTelegramAlert(WORKSPACE_ID);
    expect(result).toEqual({ delivered: true });
    expect(sendMessageMock).toHaveBeenCalledWith({
      token: BOT_TOKEN,
      chatId: CHAT_ID,
      text: expect.stringContaining('🔔 Oriole test message'),
    });
  });
});

describe('telegramAlertsBindUrl', () => {
  it('deep-link t.me/<bot>?start=oriole_<token> (username dari identifier channel)', async () => {
    dbState.tables.set('workspaceChannels', [telegramChannelRow()]);
    const url = await telegramAlertsBindUrl(WORKSPACE_ID, { bindToken: TOKEN });
    expect(url).toBe(`https://t.me/OrioleBot?start=oriole_${TOKEN}`);
  });

  it('tanpa identifier → fallback getMe; bot tanpa username → null', async () => {
    dbState.tables.set('workspaceChannels', []);
    const url = await telegramAlertsBindUrl(WORKSPACE_ID, { bindToken: TOKEN });
    expect(url).toBe(`https://t.me/OrioleBot?start=oriole_${TOKEN}`);
    expect(getMeMock).toHaveBeenCalledWith(BOT_TOKEN);

    getMeMock.mockResolvedValue({ id: 1, username: null, isBot: true });
    const url2 = await telegramAlertsBindUrl(WORKSPACE_ID, { bindToken: TOKEN });
    expect(url2).toBeNull();
  });

  it('channel tidak dikonfigurasi → null', async () => {
    resolveChannelMock.mockResolvedValue(null);
    const url = await telegramAlertsBindUrl(WORKSPACE_ID, { bindToken: TOKEN });
    expect(url).toBeNull();
  });
});

describe('handleTelegramAlertBind (intercept /start)', () => {
  it('payload valid → bind + balasan sukses ke chat', async () => {
    dbState.tables.set('workspaceIntegrations', [alertsIntegration()]);
    const result = await handleTelegramAlertBind({
      workspaceId: WORKSPACE_ID,
      chatId: CHAT_ID,
      chatName: 'Budi',
      content: `/start oriole_${TOKEN}`,
      channelToken: BOT_TOKEN,
    });
    expect(result).toEqual({ handled: true, reason: 'bound' });
    expect(sendMessageMock).toHaveBeenCalledWith({
      token: BOT_TOKEN,
      chatId: CHAT_ID,
      text: expect.stringContaining('Booking alerts are now enabled'),
    });
  });

  it('token salah → balasan error, handled tetap true (jangan lanjut ke alur customer)', async () => {
    dbState.tables.set('workspaceIntegrations', [alertsIntegration()]);
    const result = await handleTelegramAlertBind({
      workspaceId: WORKSPACE_ID,
      chatId: CHAT_ID,
      chatName: null,
      content: `/start oriole_${'f'.repeat(48)}`,
      channelToken: BOT_TOKEN,
    });
    expect(result).toEqual({ handled: true, reason: 'invalid-token' });
    expect(sendMessageMock).toHaveBeenCalledWith({
      token: BOT_TOKEN,
      chatId: CHAT_ID,
      text: expect.stringContaining('invalid or expired'),
    });
  });

  it('bukan payload bind → handled false (alur customer dilanjutkan)', async () => {
    const result = await handleTelegramAlertBind({
      workspaceId: WORKSPACE_ID,
      chatId: CHAT_ID,
      chatName: null,
      content: '/start',
      channelToken: BOT_TOKEN,
    });
    expect(result).toEqual({ handled: false });
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});

describe('loadTelegramAlertsConfig', () => {
  it('row tanpa bindToken → null', async () => {
    dbState.tables.set('workspaceIntegrations', [
      alertsIntegration({ providerConfig: {} }),
    ]);
    expect(await loadTelegramAlertsConfig(WORKSPACE_ID)).toBeNull();
  });
});
