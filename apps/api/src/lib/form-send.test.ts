import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────

const {
  resolveWhatsAppChannelMock,
  sendWhatsAppMessageMock,
  WhatsAppApiErrorMock,
  WhatsAppOutboundBlockedErrorMock,
} = vi.hoisted(() => {
  class WhatsAppApiErrorMock extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'WhatsAppApiError';
    }
  }
  class WhatsAppOutboundBlockedErrorMock extends WhatsAppApiErrorMock {
    constructor(message: string) {
      super(message);
      this.name = 'WhatsAppOutboundBlockedError';
    }
  }
  return {
    resolveWhatsAppChannelMock: vi.fn(),
    sendWhatsAppMessageMock: vi.fn(),
    WhatsAppApiErrorMock,
    WhatsAppOutboundBlockedErrorMock,
  };
});

vi.mock('../services/whatsapp.ts', () => ({
  resolveWhatsAppChannel: resolveWhatsAppChannelMock,
  sendWhatsAppMessage: sendWhatsAppMessageMock,
  WhatsAppApiError: WhatsAppApiErrorMock,
  WhatsAppOutboundBlockedError: WhatsAppOutboundBlockedErrorMock,
}));

const { WahaApiErrorMock } = vi.hoisted(() => ({
  WahaApiErrorMock: class extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'WahaApiError';
    }
  },
}));

vi.mock('../services/waha.ts', () => ({
  WahaApiError: WahaApiErrorMock,
}));

const { telegramSendMessageMock, TelegramApiErrorMock } = vi.hoisted(() => ({
  telegramSendMessageMock: vi.fn(),
  TelegramApiErrorMock: class extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'TelegramApiError';
    }
  },
}));

vi.mock('./telegram.ts', () => ({
  telegramSendMessage: telegramSendMessageMock,
  TelegramApiError: TelegramApiErrorMock,
}));

const { resendSendMock } = vi.hoisted(() => ({
  resendSendMock: vi.fn(),
}));

vi.mock('../services/email.ts', () => ({
  resend: { emails: { send: resendSendMock } },
}));

// ── Fake Drizzle db ─────────────────────────────────────────────
const { dbState } = vi.hoisted(() => ({
  dbState: {
    tables: new Map<string, Record<string, unknown>[]>(),
    seq: 1,
  },
}));

vi.mock('../db/index.ts', async () => {
  const {
    contacts,
    conversations,
    customerChannels,
    messages,
    workspaceChannels,
    workspaces,
  } = await import('@oriole/database');
  const tableNames = new WeakMap<object, string>();
  tableNames.set(contacts, 'contacts');
  tableNames.set(conversations, 'conversations');
  tableNames.set(customerChannels, 'customerChannels');
  tableNames.set(messages, 'messages');
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
            const row = { ...values, id: `row-${dbState.seq++}`, createdAt: NOW, updatedAt: NOW };
            (dbState.tables.get(name) ?? []).push(row);
            return [row];
          },
          onConflictDoNothing: async () => {
            const name = tableNames.get(table) ?? 'unknown';
            (dbState.tables.get(name) ?? []).push({ ...values, id: `row-${dbState.seq++}`, createdAt: NOW, updatedAt: NOW });
            return [];
          },
        }),
      }),
      update: (table: object) => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            const name = tableNames.get(table) ?? 'unknown';
            const rows = dbState.tables.get(name) ?? [];
            for (const row of rows) Object.assign(row, values, { updatedAt: NOW });
            return rows;
          },
        }),
      }),
      delete: () => ({ where: () => ({}) }),
    },
  };
});

// ── Setup ───────────────────────────────────────────────────────

const CONTACT_ID = '550e8400-e29b-41d4-a716-446655440000';
const FORM_ID = 'form-abc';

function contact(overrides: Record<string, unknown> = {}) {
  return {
    id: CONTACT_ID,
    userId: 'test-user-1',
    workspaceId: 'ws-1',
    name: 'Budi',
    phone: '081234567890',
    email: 'budi@example.com',
    notes: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function optedInChannel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cc-1',
    workspaceId: 'ws-1',
    channelType: 'whatsapp',
    identifier: '6281234567890',
    contactPhone: '081234567890',
    isOptedIn: true,
    ...overrides,
  };
}

let dispatchFormInvitation: typeof import('./form-send.ts').dispatchFormInvitation;

beforeAll(async () => {
  ({ dispatchFormInvitation } = await import('./form-send.ts'));
});

beforeEach(() => {
  dbState.tables.set('workspaces', [{ id: 'ws-1', name: 'Klinik Sehat' }]);
  dbState.tables.set('contacts', []);
  dbState.tables.set('customerChannels', []);
  dbState.tables.set('conversations', []);
  dbState.tables.set('messages', []);
  dbState.tables.set('workspaceChannels', []);
  resolveWhatsAppChannelMock.mockReset();
  sendWhatsAppMessageMock.mockReset();
  sendWhatsAppMessageMock.mockResolvedValue({ messageId: 'wamid-1' });
  telegramSendMessageMock.mockReset();
  telegramSendMessageMock.mockResolvedValue({ messageId: 42 });
  resendSendMock.mockReset();
  resendSendMock.mockResolvedValue({ data: { id: 'resend-1' }, error: null });
});

const baseInput = {
  workspaceId: 'ws-1',
  integrationType: 'google-forms' as const,
  formId: FORM_ID,
  formName: 'Lead Form',
  contactId: CONTACT_ID,
  channel: 'whatsapp' as const,
};

describe('dispatchFormInvitation', () => {
  it('kontak tidak ditemukan → FormSendError 404', async () => {
    await expect(dispatchFormInvitation(baseInput)).rejects.toMatchObject({
      name: 'FormSendError',
      status: 404,
    });
    expect(sendWhatsAppMessageMock).not.toHaveBeenCalled();
  });

  it('whatsapp tanpa nomor telepon kontak → 400', async () => {
    dbState.tables.set('contacts', [contact({ phone: null })]);
    await expect(dispatchFormInvitation(baseInput)).rejects.toMatchObject({ status: 400 });
  });

  it('whatsapp channel belum dikonfigurasi → 409', async () => {
    dbState.tables.set('contacts', [contact()]);
    resolveWhatsAppChannelMock.mockResolvedValue(null);
    await expect(dispatchFormInvitation(baseInput)).rejects.toMatchObject({ status: 409 });
  });

  it('customer belum opt-in whatsapp → 409', async () => {
    dbState.tables.set('contacts', [contact()]);
    resolveWhatsAppChannelMock.mockResolvedValue({ provider: '360dialog', apiKey: 'key-1', webhookSecret: null, phoneNumberId: null, isActive: true });
    dbState.tables.set('customerChannels', []);
    await expect(dispatchFormInvitation(baseInput)).rejects.toMatchObject({ status: 409 });
  });

  it('whatsapp sukses → terkirim + tercatat sent di unified inbox', async () => {
    dbState.tables.set('contacts', [contact()]);
    resolveWhatsAppChannelMock.mockResolvedValue({ provider: '360dialog', apiKey: 'key-1', webhookSecret: null, phoneNumberId: null, isActive: true });
    dbState.tables.set('customerChannels', [optedInChannel()]);

    const result = await dispatchFormInvitation(baseInput);

    expect(result).toMatchObject({
      sent: true,
      channel: 'whatsapp',
      formUrl: 'https://docs.google.com/forms/d/e/form-abc/viewform',
    });
    expect(sendWhatsAppMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: expect.objectContaining({ provider: '360dialog' }),
        to: '6281234567890',
      }),
    );
    const text = sendWhatsAppMessageMock.mock.calls[0][0].text as string;
    expect(text).toContain('Hello Budi! 👋');
    expect(text).toContain('Lead Form');
    expect(text).toContain('https://docs.google.com/forms/d/e/form-abc/viewform');

    const messages = dbState.tables.get('messages') ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ status: 'sent', direction: 'outbound' });
  });

  it('whatsapp ditolak Meta (di luar 24h window) → pesan jelas + ditandai failed', async () => {
    dbState.tables.set('contacts', [contact()]);
    resolveWhatsAppChannelMock.mockResolvedValue({ provider: '360dialog', apiKey: 'key-1', webhookSecret: null, phoneNumberId: null, isActive: true });
    dbState.tables.set('customerChannels', [optedInChannel()]);
    sendWhatsAppMessageMock.mockRejectedValue(new WhatsAppApiErrorMock('Message failed to send'));

    await expect(dispatchFormInvitation(baseInput)).rejects.toMatchObject({
      name: 'FormSendError',
      status: 502,
    });
    const messages = dbState.tables.get('messages') ?? [];
    expect(messages[0]).toMatchObject({ status: 'failed' });
  });

  it('telegram sukses → mengirim via chat_id yang terhubung + opt-in', async () => {
    dbState.tables.set('contacts', [contact()]);
    dbState.tables.set('customerChannels', [
      optedInChannel({ channelType: 'telegram', identifier: '123456789', contactPhone: '081234567890' }),
    ]);
    dbState.tables.set('workspaceChannels', [
      { id: 'ch-1', workspaceId: 'ws-1', channelType: 'telegram', providerConfig: { botToken: 'bot-1' } },
    ]);

    const result = await dispatchFormInvitation({ ...baseInput, channel: 'telegram' });

    expect(result.channel).toBe('telegram');
    expect(telegramSendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'bot-1', chatId: '123456789' }),
    );
    const messages = dbState.tables.get('messages') ?? [];
    expect(messages[0]).toMatchObject({ status: 'sent', channelType: 'telegram' });
  });

  it('telegram tanpa bot token → 409', async () => {
    dbState.tables.set('contacts', [contact()]);
    dbState.tables.set('customerChannels', [
      optedInChannel({ channelType: 'telegram', identifier: '123456789', contactPhone: '081234567890' }),
    ]);
    dbState.tables.set('workspaceChannels', []);

    await expect(dispatchFormInvitation({ ...baseInput, channel: 'telegram' })).rejects.toMatchObject({
      status: 409,
    });
  });

  it('email tanpa alamat kontak → 400', async () => {
    dbState.tables.set('contacts', [contact({ email: null })]);
    await expect(dispatchFormInvitation({ ...baseInput, channel: 'email' })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('email sukses → resend.emails.send dipanggil ke email kontak', async () => {
    dbState.tables.set('contacts', [contact()]);
    const result = await dispatchFormInvitation({ ...baseInput, channel: 'email' });

    expect(result).toMatchObject({ sent: true, channel: 'email' });
    expect(resendSendMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: ['budi@example.com'] }),
    );
    const messages = dbState.tables.get('messages') ?? [];
    expect(messages[0]).toMatchObject({ status: 'sent', channelType: 'email' });
  });

  it('email ditolak Resend → FormSendError 502 + failed', async () => {
    dbState.tables.set('contacts', [contact()]);
    resendSendMock.mockResolvedValue({ data: null, error: { message: 'Rate limited' } });
    await expect(dispatchFormInvitation({ ...baseInput, channel: 'email' })).rejects.toMatchObject({
      name: 'FormSendError',
      status: 502,
    });
    const messages = dbState.tables.get('messages') ?? [];
    expect(messages[0]).toMatchObject({ status: 'failed' });
  });

  it('tally → formUrl tally.so/r/{id}', async () => {
    dbState.tables.set('contacts', [contact()]);
    dbState.tables.set('customerChannels', [optedInChannel()]);
    resolveWhatsAppChannelMock.mockResolvedValue({ provider: '360dialog', apiKey: 'key-1', webhookSecret: null, phoneNumberId: null, isActive: true });

    const result = await dispatchFormInvitation({
      ...baseInput,
      integrationType: 'tally',
      formId: 'xyz123',
    });
    expect(result.formUrl).toBe('https://tally.so/r/xyz123');
  });

  it('dedup: panggilan kedua tidak mengirim ulang', async () => {
    dbState.tables.set('contacts', [contact()]);
    resolveWhatsAppChannelMock.mockResolvedValue({ provider: '360dialog', apiKey: 'key-1', webhookSecret: null, phoneNumberId: null, isActive: true });
    dbState.tables.set('customerChannels', [optedInChannel()]);

    await dispatchFormInvitation(baseInput);
    await dispatchFormInvitation(baseInput);

    expect(sendWhatsAppMessageMock).toHaveBeenCalledTimes(1);
  });

  it('whatsapp BYO (provider waha) sukses → dispatch menerima channel waha', async () => {
    dbState.tables.set('contacts', [contact()]);
    resolveWhatsAppChannelMock.mockResolvedValue({
      provider: 'waha',
      baseUrl: 'http://waha.test:3000',
      gatewayApiKey: 'gw-key',
      sessionName: 'ws_ws-1',
      isActive: true,
    });
    dbState.tables.set('customerChannels', [optedInChannel()]);

    const result = await dispatchFormInvitation(baseInput);

    expect(result).toMatchObject({ sent: true, channel: 'whatsapp' });
    expect(sendWhatsAppMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: expect.objectContaining({ provider: 'waha', sessionName: 'ws_ws-1' }),
        to: '6281234567890',
      }),
    );
  });

  it('whatsapp BYO ditolak gateway (WahaApiError) → FormSendError 502 tanpa klaim 24h', async () => {
    dbState.tables.set('contacts', [contact()]);
    resolveWhatsAppChannelMock.mockResolvedValue({
      provider: 'waha',
      baseUrl: 'http://waha.test:3000',
      gatewayApiKey: 'gw-key',
      sessionName: 'ws_ws-1',
      isActive: true,
    });
    dbState.tables.set('customerChannels', [optedInChannel()]);
    sendWhatsAppMessageMock.mockRejectedValue(new WahaApiErrorMock('reachout timelock (463)'));

    const error = await dispatchFormInvitation(baseInput).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'FormSendError', status: 502 });
    expect((error as Error).message).toContain('BYO');
    const messages = dbState.tables.get('messages') ?? [];
    expect(messages[0]).toMatchObject({ status: 'failed' });
  });
});
