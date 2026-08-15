import { beforeEach, describe, expect, it, vi } from 'vitest';

const { selectMock } = vi.hoisted(() => ({ selectMock: vi.fn() }));
const { getWebhookInfoMock, setWebhookMock } = vi.hoisted(() => ({
  getWebhookInfoMock: vi.fn(),
  setWebhookMock: vi.fn(),
}));
const { webhookUrlForMock, assertPublicHttpsMock } = vi.hoisted(() => ({
  webhookUrlForMock: vi.fn(),
  assertPublicHttpsMock: vi.fn(),
}));

// env → NODE_ENV 'development' agar reconcile berjalan (bukan early-return test).
vi.mock('./env.ts', () => ({ env: { NODE_ENV: 'development' } }));

vi.mock('./telegram.ts', () => ({
  telegramGetWebhookInfo: getWebhookInfoMock,
  telegramSetWebhook: setWebhookMock,
}));

vi.mock('./webhook-url.ts', () => ({
  webhookUrlFor: webhookUrlForMock,
  assertPublicHttpsWebhookUrl: assertPublicHttpsMock,
  WebhookUrlError: class WebhookUrlError extends Error {},
}));

// DB → query chain sederhana: select().from().innerJoin().where() → rows.
vi.mock('../db/index.ts', () => ({ db: { select: selectMock } }));

const EXPECTED_URL = 'https://tunnel.example.com/api/webhooks/telegram/ws-1';

function mockDbRows(rows: unknown[]): void {
  const query: Record<string, unknown> = {
    from: () => query,
    innerJoin: () => query,
    where: () => Promise.resolve(rows),
  };
  selectMock.mockReturnValue(query);
}

function channelRow(overrides: { token?: unknown; secret?: unknown } = {}): unknown {
  const token = 'token' in overrides ? overrides.token : '123:ABC';
  const secret = 'secret' in overrides ? overrides.secret : 'sec';
  return {
    workspaceId: 'ws-1',
    providerConfig: { botToken: token, webhookSecret: secret },
  };
}

import { reconcileTelegramWebhooks } from './telegram-reconcile.ts';

beforeEach(() => {
  selectMock.mockReset();
  getWebhookInfoMock.mockReset();
  setWebhookMock.mockReset();
  webhookUrlForMock.mockReset();
  webhookUrlForMock.mockReturnValue(EXPECTED_URL);
  assertPublicHttpsMock.mockReset();
  assertPublicHttpsMock.mockImplementation(() => undefined);
  getWebhookInfoMock.mockResolvedValue({ url: EXPECTED_URL, pendingUpdateCount: 0, lastError: null });
  setWebhookMock.mockResolvedValue(undefined);
});

describe('reconcileTelegramWebhooks', () => {
  it('URL webhook sudah cocok → tidak memanggil setWebhook (no-op)', async () => {
    mockDbRows([channelRow()]);
    await reconcileTelegramWebhooks();
    expect(getWebhookInfoMock).toHaveBeenCalledTimes(1);
    expect(setWebhookMock).not.toHaveBeenCalled();
  });

  it('URL berbeda / webhook hilang → daftarkan ulang dengan secret lama', async () => {
    mockDbRows([channelRow()]);
    getWebhookInfoMock.mockResolvedValue({ url: null, pendingUpdateCount: 0, lastError: null });
    await reconcileTelegramWebhooks();
    expect(setWebhookMock).toHaveBeenCalledTimes(1);
    expect(setWebhookMock).toHaveBeenCalledWith({
      token: '123:ABC',
      url: EXPECTED_URL,
      secretToken: 'sec',
    });
  });

  it('URL bukan HTTPS publik → lewati (tanpa panggilan Telegram)', async () => {
    mockDbRows([channelRow()]);
    const { WebhookUrlError } = await import('./webhook-url.ts');
    assertPublicHttpsMock.mockImplementation(() => {
      throw new WebhookUrlError('bukan https publik');
    });
    await reconcileTelegramWebhooks();
    expect(getWebhookInfoMock).not.toHaveBeenCalled();
    expect(setWebhookMock).not.toHaveBeenCalled();
  });

  it('channel tanpa token/secret → lewati', async () => {
    mockDbRows([channelRow({ token: undefined, secret: undefined })]);
    await reconcileTelegramWebhooks();
    expect(getWebhookInfoMock).not.toHaveBeenCalled();
    expect(setWebhookMock).not.toHaveBeenCalled();
  });

  it('getWebhookInfo error → resolve tanpa crash (warning saja)', async () => {
    mockDbRows([channelRow()]);
    getWebhookInfoMock.mockRejectedValue(new Error('network down'));
    await expect(reconcileTelegramWebhooks()).resolves.toBeUndefined();
    expect(setWebhookMock).not.toHaveBeenCalled();
  });

  it('query DB gagal → resolve tanpa crash', async () => {
    selectMock.mockReturnValue({
      from: () => {
        throw new Error('db down');
      },
    });
    await expect(reconcileTelegramWebhooks()).resolves.toBeUndefined();
  });
});
