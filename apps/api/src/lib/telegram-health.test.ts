import { beforeEach, describe, expect, it, vi } from 'vitest';

const { selectMock } = vi.hoisted(() => ({ selectMock: vi.fn() }));
const { getWebhookInfoMock } = vi.hoisted(() => ({ getWebhookInfoMock: vi.fn() }));
const { webhookUrlForMock } = vi.hoisted(() => ({ webhookUrlForMock: vi.fn() }));

// env — TELEGRAM_BOT_TOKEN dinamis untuk uji fallback single-tenant.
const { envState } = vi.hoisted(() => {
  const state = { token: '' };
  return {
    envState: {
      get TELEGRAM_BOT_TOKEN() {
        return state.token || undefined;
      },
      setToken(v: string) {
        state.token = v;
      },
    },
  };
});

vi.mock('./env.ts', () => ({
  env: {
    NODE_ENV: 'development',
    get TELEGRAM_BOT_TOKEN() {
      return envState.TELEGRAM_BOT_TOKEN;
    },
  },
}));

vi.mock('./telegram.ts', () => ({
  telegramGetWebhookInfo: getWebhookInfoMock,
}));

vi.mock('./webhook-url.ts', () => ({
  webhookUrlFor: webhookUrlForMock,
}));

// DB → query chain: select().from().where().limit() → rows.
vi.mock('../db/index.ts', () => ({ db: { select: selectMock } }));

const EXPECTED_URL = 'https://api.example.com/api/webhooks/telegram/ws-1';

function mockDbRows(rows: unknown[]): void {
  const query: Record<string, unknown> = {
    from: () => query,
    where: () => query,
    limit: () => query,
    then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(rows)),
  };
  selectMock.mockReturnValue(query);
}

import { checkTelegramWebhookHealth } from './telegram-health.ts';

beforeEach(() => {
  selectMock.mockReset();
  getWebhookInfoMock.mockReset();
  webhookUrlForMock.mockReset();
  webhookUrlForMock.mockReturnValue(EXPECTED_URL);
  envState.setToken('');
});

describe('checkTelegramWebhookHealth', () => {
  it('tanpa channel & tanpa env token → configured false', async () => {
    mockDbRows([]);
    const health = await checkTelegramWebhookHealth('ws-1');
    expect(health.configured).toBe(false);
    expect(health.isActive).toBe(true);
    expect(getWebhookInfoMock).not.toHaveBeenCalled();
  });

  it('URL cocok → urlMatches true + pending count', async () => {
    mockDbRows([{ providerConfig: { botToken: 'tok', webhookSecret: 's' }, isActive: true }]);
    getWebhookInfoMock.mockResolvedValue({
      url: EXPECTED_URL,
      pendingUpdateCount: 7,
      lastError: null,
    });
    const health = await checkTelegramWebhookHealth('ws-1');
    expect(health).toMatchObject({
      configured: true,
      isActive: true,
      expectedUrl: EXPECTED_URL,
      actualUrl: EXPECTED_URL,
      urlMatches: true,
      pendingUpdateCount: 7,
    });
  });

  it('URL berbeda → urlMatches false', async () => {
    mockDbRows([{ providerConfig: { botToken: 'tok', webhookSecret: 's' }, isActive: true }]);
    getWebhookInfoMock.mockResolvedValue({
      url: 'https://stale.example.com/old',
      pendingUpdateCount: 0,
      lastError: null,
    });
    const health = await checkTelegramWebhookHealth('ws-1');
    expect(health.urlMatches).toBe(false);
  });

  it('getWebhookInfo error → providerError terisi, bukan throw', async () => {
    mockDbRows([{ providerConfig: { botToken: 'tok', webhookSecret: 's' }, isActive: true }]);
    getWebhookInfoMock.mockRejectedValue(new Error('401 Unauthorized'));
    const health = await checkTelegramWebhookHealth('ws-1');
    expect(health.configured).toBe(true);
    expect(health.actualUrl).toBeNull();
    expect(health.urlMatches).toBeNull();
    expect(health.providerError).toContain('401');
  });

  it('fallback env token bila row tanpa botToken', async () => {
    envState.setToken('env-token');
    mockDbRows([]);
    getWebhookInfoMock.mockResolvedValue({
      url: EXPECTED_URL,
      pendingUpdateCount: 0,
      lastError: null,
    });
    const health = await checkTelegramWebhookHealth('ws-1');
    expect(health.configured).toBe(true);
    expect(health.urlMatches).toBe(true);
    expect(getWebhookInfoMock).toHaveBeenCalledWith('env-token');
  });

  it('channel dijeda → isActive false tetap dilaporkan', async () => {
    mockDbRows([{ providerConfig: { botToken: 'tok', webhookSecret: 's' }, isActive: false }]);
    getWebhookInfoMock.mockResolvedValue({
      url: null,
      pendingUpdateCount: 0,
      lastError: null,
    });
    const health = await checkTelegramWebhookHealth('ws-1');
    expect(health.isActive).toBe(false);
    expect(health.urlMatches).toBe(false);
  });
});
