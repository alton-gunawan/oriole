import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Row workspace_channel dikendalikan test — di-set ulang per test.
const { channelRef } = vi.hoisted(() => ({ channelRef: { value: null as unknown } }));
// Env fallback dev (WHATSAPP_API_KEY) — channel BYO harus tetap memilih
// provider WAHA walau fallback ini terpasang (jika tidak, pesan BYO bisa
// terkirim lewat provider salah di dev).
const { envMock } = vi.hoisted(() => ({
  envMock: { WHATSAPP_API_KEY: 'wa_env_key', WHATSAPP_WEBHOOK_SECRET: 'wa_env_secret' },
}));

vi.mock('../db/index.ts', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [channelRef.value],
        }),
      }),
    }),
  },
}));

// Ganti env.ts seluruhnya (env.ts memanggil loadRootEnv + parseEnv saat
// import) agar test bisa mengendalikan nilai fallback tanpa proses env.
vi.mock('../lib/env.ts', () => ({ env: envMock }));

// wahaSendText di-mock; waIdToChatId tetap asli agar suffix @c.us teruji.
const { wahaSendTextMock } = vi.hoisted(() => ({ wahaSendTextMock: vi.fn() }));
vi.mock('./waha.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./waha.ts')>();
  return { ...actual, wahaSendText: wahaSendTextMock };
});

// waha-health (guard outbound) di-mock — kuota/blokir dikendalikan test;
// readWahaHealth dipakai resolveWhatsAppChannel untuk melampirkan health.
const { healthMocks } = vi.hoisted(() => ({
  healthMocks: {
    readWahaHealth: vi.fn(),
    updateWahaHealth: vi.fn(),
    hasWahaCustomerChannel: vi.fn(),
    countTodayWahaOutbound: vi.fn(),
    countTodayNewContactWahaOutbound: vi.fn(),
    markWahaOutboundFailure: vi.fn(),
    WAHA_DAILY_TOTAL_CAP: 200,
    WAHA_DAILY_NEW_CONTACT_CAP: 20,
  },
}));

vi.mock('../lib/waha-health.ts', () => healthMocks);

import {
  resolveWhatsAppChannel,
  sendWhatsAppMessage,
  WhatsAppOutboundBlockedError,
  type WahaOutboundChannelConfig,
} from './whatsapp.ts';
import type { WhatsAppChannelConfig } from './whatsapp.ts';
import type { WahaHealth } from '../lib/waha-health.ts';

/** Bentuk health default yang dikembalikan readWahaHealth (mock). */
const DEFAULT_HEALTH: WahaHealth = {
  state: 'connecting',
  lastSeenAt: null,
  lastStatusAt: null,
  reachoutTimelockUntil: null,
  lastError: null,
  lastStatus: null,
};

const FUTURE = new Date(Date.now() + 3600_000).toISOString();

function channelRow(providerConfig: Record<string, unknown>, isActive = true) {
  return { channelType: 'whatsapp', providerConfig, isActive };
}

describe('resolveWhatsAppChannel — provider-aware (360dialog | waha)', () => {
  beforeEach(() => {
    channelRef.value = null;
    envMock.WHATSAPP_API_KEY = 'wa_env_key';
    envMock.WHATSAPP_WEBHOOK_SECRET = 'wa_env_secret';
    healthMocks.readWahaHealth.mockReturnValue(DEFAULT_HEALTH);
    healthMocks.updateWahaHealth.mockResolvedValue(undefined);
    healthMocks.hasWahaCustomerChannel.mockResolvedValue(false);
    healthMocks.countTodayWahaOutbound.mockResolvedValue(0);
    healthMocks.countTodayNewContactWahaOutbound.mockResolvedValue(0);
    healthMocks.markWahaOutboundFailure.mockResolvedValue(undefined);
  });

  it('channel BYO lengkap → konfigurasi waha (bukan 360dialog, bukan env fallback)', async () => {
    channelRef.value = channelRow({
      provider: 'waha',
      baseUrl: 'http://waha.test:3000',
      gatewayApiKey: 'gw-key',
      webhookSecret: 'wa-secret',
      sessionName: 'ws_ws-1',
      consent: { version: 1 },
    });
    expect(await resolveWhatsAppChannel('ws-1')).toEqual({
      provider: 'waha',
      baseUrl: 'http://waha.test:3000',
      gatewayApiKey: 'gw-key',
      sessionName: 'ws_ws-1',
      isActive: true,
      workspaceId: 'ws-1',
      health: DEFAULT_HEALTH,
    });
  });

  it('channel BYO dengan sisa apiKey 360dialog lama → tetap waha (tidak salah provider)', async () => {
    channelRef.value = channelRow({
      provider: 'waha',
      baseUrl: 'http://waha.test:3000',
      gatewayApiKey: 'gw-key',
      sessionName: 'ws_ws-1',
      apiKey: 'old-360dialog-key',
    });
    expect(await resolveWhatsAppChannel('ws-1')).toMatchObject({ provider: 'waha' });
  });

  it('channel BYO tidak lengkap (tanpa gatewayApiKey) → null (bukan env fallback)', async () => {
    channelRef.value = channelRow({ provider: 'waha', baseUrl: 'http://waha.test:3000' });
    // Env fallback tersedia — config BYO yang rusak tetap harus null.
    expect(await resolveWhatsAppChannel('ws-1')).toBeNull();
  });

  it('channel 360dialog dengan providerConfig.apiKey → konfigurasi 360dialog', async () => {
    channelRef.value = channelRow(
      { apiKey: 'key-1', webhookSecret: 'secret-1', phoneNumberId: '123' },
      false,
    );
    expect(await resolveWhatsAppChannel('ws-1')).toEqual({
      provider: '360dialog',
      apiKey: 'key-1',
      webhookSecret: 'secret-1',
      phoneNumberId: '123',
      isActive: false,
    });
  });

  it('tanpa providerConfig.apiKey → fallback env WHATSAPP_API_KEY (dev, tagged 360dialog)', async () => {
    channelRef.value = channelRow({});
    expect(await resolveWhatsAppChannel('ws-1')).toEqual({
      provider: '360dialog',
      apiKey: 'wa_env_key',
      webhookSecret: 'wa_env_secret',
      phoneNumberId: null,
      isActive: true,
    });
  });

  it('tanpa channel & tanpa env → null', async () => {
    envMock.WHATSAPP_API_KEY = '';
    expect(await resolveWhatsAppChannel('ws-1')).toBeNull();
  });
});

const wahaBase: WahaOutboundChannelConfig = {
  provider: 'waha',
  baseUrl: 'http://waha.test:3000',
  gatewayApiKey: 'gw-key',
  sessionName: 'ws_ws-1',
  isActive: true,
  workspaceId: 'ws-1',
  health: DEFAULT_HEALTH,
};
const wahaChannel: WhatsAppChannelConfig = wahaBase;

const dialogChannel: WhatsAppChannelConfig = {
  provider: '360dialog',
  apiKey: 'key-1',
  webhookSecret: null,
  phoneNumberId: null,
  isActive: true,
};

describe('sendWhatsAppMessage — dispatch provider-aware', () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);

  afterEach(() => {
    fetchMock.mockReset();
    wahaSendTextMock.mockReset();
  });

  it('channel waha → wahaSendText dengan chatId @c.us + session + reply_to', async () => {
    wahaSendTextMock.mockResolvedValue({ messageId: 'true_abc' });

    const result = await sendWhatsAppMessage({
      channel: wahaChannel,
      to: '6281234567890',
      text: 'Halo!',
      replyTo: 'evt_inbound_1',
    });

    expect(result).toEqual({ messageId: 'true_abc' });
    expect(wahaSendTextMock).toHaveBeenCalledWith({
      baseUrl: 'http://waha.test:3000',
      apiKey: 'gw-key',
      session: 'ws_ws-1',
      chatId: '6281234567890@c.us',
      text: 'Halo!',
      replyTo: 'evt_inbound_1',
    });
  });

  it('channel waha dengan buttons → fallback teks polos (tanpa interactive)', async () => {
    wahaSendTextMock.mockResolvedValue({ messageId: null });

    await sendWhatsAppMessage({
      channel: wahaChannel,
      to: '6281234567890',
      text: 'Ya atau tidak?',
      buttons: [{ id: 'yes', label: 'Ya' }],
    });

    expect(wahaSendTextMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('channel 360dialog tanpa opsi → whatsappSendText (body type text)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: 'wamid-1' }] }),
    } as unknown as Response);

    const result = await sendWhatsAppMessage({ channel: dialogChannel, to: '6281234567890', text: 'Halo!' });

    expect(result).toMatchObject({ messageId: 'wamid-1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://waba.360dialog.io/v1/messages');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ messaging_product: 'whatsapp', to: '6281234567890', type: 'text' });
  });

  it('channel 360dialog dengan buttons → interactive body', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: 'wamid-2' }] }),
    } as unknown as Response);

    await sendWhatsAppMessage({
      channel: dialogChannel,
      to: '6281234567890',
      text: 'Pilih:',
      buttons: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.type).toBe('interactive');
  });

  it('channel 360dialog dengan template → template body', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: 'wamid-3' }] }),
    } as unknown as Response);

    await sendWhatsAppMessage({
      channel: dialogChannel,
      to: '6281234567890',
      text: '',
      template: { name: 'booking_reminder', language: 'id', components: [] },
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.type).toBe('template');
    expect(body.template).toMatchObject({ name: 'booking_reminder' });
  });

  it('channel waha error → error gateway diteruskan + kegagalan dicatat ke health', async () => {
    wahaSendTextMock.mockRejectedValue(Object.assign(new Error('reachout timelock'), { status: 463 }));

    await expect(
      sendWhatsAppMessage({ channel: wahaChannel, to: '6281234567890', text: 'Halo!' }),
    ).rejects.toMatchObject({ status: 463 });
    expect(healthMocks.markWahaOutboundFailure).toHaveBeenCalledWith('ws-1', {
      status: 463,
      message: 'reachout timelock',
    });
  });

  it('channel 360dialog error → WhatsAppApiError dengan status', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'bad request' } }),
    } as unknown as Response);

    await expect(
      sendWhatsAppMessage({ channel: dialogChannel, to: '6281234567890', text: 'Halo!' }),
    ).rejects.toMatchObject({ code: 400 });
  });
});

describe('sendWhatsAppMessage — guard outbound BYO (banned / restricted / kuota)', () => {
  beforeEach(() => {
    wahaSendTextMock.mockReset();
    healthMocks.hasWahaCustomerChannel.mockResolvedValue(false);
    healthMocks.countTodayWahaOutbound.mockResolvedValue(0);
    healthMocks.countTodayNewContactWahaOutbound.mockResolvedValue(0);
  });

  it('health banned → WhatsAppOutboundBlockedError, tanpa kirim', async () => {
    const channel: WahaOutboundChannelConfig = {
      ...wahaBase,
      health: { ...DEFAULT_HEALTH, state: 'banned' },
    };

    await expect(
      sendWhatsAppMessage({ channel, to: '6281234567890', text: 'Halo!' }),
    ).rejects.toBeInstanceOf(WhatsAppOutboundBlockedError);
    expect(wahaSendTextMock).not.toHaveBeenCalled();
  });

  it('restricted + kontak baru (belum pernah chat) → blocked', async () => {
    healthMocks.hasWahaCustomerChannel.mockResolvedValue(false);
    const channel: WahaOutboundChannelConfig = {
      ...wahaBase,
      health: {
        ...DEFAULT_HEALTH,
        state: 'restricted',
        reachoutTimelockUntil: FUTURE,
      },
    };

    await expect(
      sendWhatsAppMessage({ channel, to: '6281234567890', text: 'Halo!' }),
    ).rejects.toBeInstanceOf(WhatsAppOutboundBlockedError);
    expect(wahaSendTextMock).not.toHaveBeenCalled();
  });

  it('restricted + kontak lama (pernah chat) → tetap boleh kirim', async () => {
    healthMocks.hasWahaCustomerChannel.mockResolvedValue(true);
    wahaSendTextMock.mockResolvedValue({ messageId: 'true_ok' });
    const channel: WahaOutboundChannelConfig = {
      ...wahaBase,
      health: { ...DEFAULT_HEALTH, state: 'restricted', reachoutTimelockUntil: FUTURE },
    };

    const result = await sendWhatsAppMessage({
      channel,
      to: '6281234567890',
      text: 'Halo!',
    });
    expect(result).toEqual({ messageId: 'true_ok' });
    expect(wahaSendTextMock).toHaveBeenCalledTimes(1);
  });

  it('restricted dengan timelock sudah lewat → self-heal ke connected + kirim', async () => {
    healthMocks.hasWahaCustomerChannel.mockResolvedValue(false);
    wahaSendTextMock.mockResolvedValue({ messageId: 'true_ok' });
    const channel: WahaOutboundChannelConfig = {
      ...wahaBase,
      health: {
        ...DEFAULT_HEALTH,
        state: 'restricted',
        reachoutTimelockUntil: '2020-01-01T00:00:00.000Z', // sudah lewat
      },
    };

    await sendWhatsAppMessage({ channel, to: '6281234567890', text: 'Halo!' });
    expect(healthMocks.updateWahaHealth).toHaveBeenCalledWith('ws-1', {
      state: 'connected',
      reachoutTimelockUntil: null,
    });
    expect(wahaSendTextMock).toHaveBeenCalledTimes(1);
  });

  it('kuota total harian (200) tercapai → blocked', async () => {
    healthMocks.countTodayWahaOutbound.mockResolvedValue(200);

    await expect(
      sendWhatsAppMessage({ channel: wahaChannel, to: '6281234567890', text: 'Halo!' }),
    ).rejects.toBeInstanceOf(WhatsAppOutboundBlockedError);
    expect(wahaSendTextMock).not.toHaveBeenCalled();
  });

  it('kuota kontak baru harian (20) tercapai untuk penerima baru → blocked', async () => {
    healthMocks.hasWahaCustomerChannel.mockResolvedValue(false);
    healthMocks.countTodayWahaOutbound.mockResolvedValue(0);
    healthMocks.countTodayNewContactWahaOutbound.mockResolvedValue(20);

    await expect(
      sendWhatsAppMessage({ channel: wahaChannel, to: '6281234567890', text: 'Halo!' }),
    ).rejects.toBeInstanceOf(WhatsAppOutboundBlockedError);
    expect(wahaSendTextMock).not.toHaveBeenCalled();
  });

  it('kuota kontak baru tidak menghalangi kiriman ke kontak lama', async () => {
    healthMocks.hasWahaCustomerChannel.mockResolvedValue(true);
    healthMocks.countTodayNewContactWahaOutbound.mockResolvedValue(20);
    wahaSendTextMock.mockResolvedValue({ messageId: 'true_ok' });

    const result = await sendWhatsAppMessage({
      channel: wahaChannel,
      to: '6281234567890',
      text: 'Halo!',
    });
    expect(result).toEqual({ messageId: 'true_ok' });
  });
});
