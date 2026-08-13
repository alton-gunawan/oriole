import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelegramUpdate } from '@oriole/messaging';

// ── Mocks ───────────────────────────────────────────────────────

const { envState } = vi.hoisted(() => ({
  envState: {
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_WEBHOOK_SECRET: '',
  } as Record<string, string | undefined>,
}));

vi.mock('../lib/env.ts', () => ({ env: envState }));

// Telegram API — semua panggilan network di-stub.
const { sendMessageMock, answerCallbackMock, editReplyMarkupMock } = vi.hoisted(() => ({
  sendMessageMock: vi.fn(),
  answerCallbackMock: vi.fn(),
  editReplyMarkupMock: vi.fn(),
}));

vi.mock('../lib/telegram.ts', () => ({
  TelegramApiError: class TelegramApiError extends Error {},
  telegramSendMessage: sendMessageMock,
  telegramAnswerCallbackQuery: answerCallbackMock,
  telegramEditMessageReplyMarkup: editReplyMarkupMock,
  telegramGetMe: vi.fn(),
  telegramSetWebhook: vi.fn(),
  telegramDeleteWebhook: vi.fn(),
}));

// Inngest client — dipakai reminders.ts (emit helpers) saat import modul.
const { inngestSendMock } = vi.hoisted(() => ({ inngestSendMock: vi.fn() }));
vi.mock('../inngest/client.ts', () => ({
  inngest: { send: inngestSendMock },
}));

// ── Fake Drizzle db (in-memory) dengan evaluasi where ───────────
//
// Handler Telegram butuh filter by where yang benar (multi-turn:
// dedup balasan by metadata, update row by id), jadi fake ini
// mengevaluasi predikat eq/isNull/isNotNull/in terhadap baris.

const { dbState } = vi.hoisted(() => ({
  dbState: {} as Record<string, Record<string, unknown>[]>,
}));

vi.mock('../db/index.ts', async () => {
  const {
    bookings,
    conversations,
    customerChannels,
    messages,
    services,
    workspaceChannels,
    workspaceIntegrations,
    workspaces,
  } = await import('@oriole/database');
  const tableNames = new WeakMap<object, string>();
  tableNames.set(workspaces, 'workspaces');
  tableNames.set(workspaceChannels, 'workspaceChannels');
  tableNames.set(workspaceIntegrations, 'workspaceIntegrations');
  tableNames.set(conversations, 'conversations');
  tableNames.set(messages, 'messages');
  tableNames.set(customerChannels, 'customerChannels');
  tableNames.set(bookings, 'bookings');
  tableNames.set(services, 'services');

  /** snake_case (drizzle) → camelCase (kunci baris fake). */
  function camel(key: string): string {
    return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  }

  /** Ekstrak predikat dari kondisi drizzle: [{ column, op, value }].
   *  Menangani `and(eq...)` maupun `eq` tunggal (tanpa pembungkus and). */
  function extractPredicates(cond: unknown): { column: string; op: string; value?: unknown }[] {
    const out: { column: string; op: string; value?: unknown }[] = [];
    if (!cond || typeof cond !== 'object') return out;
    const root = cond as Record<string, unknown>;
    const chunksArr = root.queryChunks as unknown[] | undefined;
    const isAnd = Array.isArray(chunksArr) && (chunksArr[0] as { value?: string[] } | undefined)?.value?.[0] === '(';
    const inner = isAnd ? ((chunksArr?.[1] as { queryChunks?: unknown[] } | undefined)?.queryChunks ?? null) : null;
    const chunks = inner ?? [root];
    const bins = chunks.filter((_, i) => i % 2 === 0) as { queryChunks: unknown[] }[];
    for (const bin of bins) {
      const c = bin.queryChunks ?? [];
      const opStr = (c[2] as { value?: string[] } | undefined)?.value?.join('') ?? '';
      const col = (() => {
        const stack: unknown[] = [c[1]];
        while (stack.length) {
          const cur = stack.pop();
          if (!cur || typeof cur !== 'object') continue;
          const obj = cur as Record<string, unknown>;
          if (typeof obj.name === 'string' && obj.config && typeof obj.config === 'object') {
            return obj.name;
          }
          for (const v of Object.values(obj)) {
            if (v && typeof v === 'object') stack.push(v);
          }
        }
        return null;
      })();
      if (!col) continue;
      if (opStr.includes(' = ')) {
        out.push({ column: col, op: 'eq', value: (c[3] as { value?: unknown })?.value });
      } else if (opStr.includes(' is not null')) {
        out.push({ column: col, op: 'isNotNull' });
      } else if (opStr.includes(' is null')) {
        out.push({ column: col, op: 'isNull' });
      } else if (opStr.includes(' in ')) {
        const arr = (c[3] as { value?: unknown }[] | undefined) ?? [];
        out.push({ column: col, op: 'in', value: arr.map((v) => v.value) });
      }
    }
    return out;
  }

  function matches(row: Record<string, unknown>, preds: { column: string; op: string; value?: unknown }[]): boolean {
    return preds.every((p) => {
      const rv = row[camel(p.column)];
      if (p.op === 'isNull') return rv === null || rv === undefined;
      if (p.op === 'isNotNull') return rv !== null && rv !== undefined;
      if (p.op === 'in') return Array.isArray(p.value) && p.value.includes(rv);
      // eq — deep compare untuk object (metadata jsonb)
      if (p.value && typeof p.value === 'object') {
        return JSON.stringify(rv) === JSON.stringify(p.value);
      }
      return rv === p.value;
    });
  }

  function whereFilter(name: string, cond: unknown): Record<string, unknown>[] {
    const preds = extractPredicates(cond);
    return (dbState[name] ?? []).filter((row) => matches(row, preds));
  }

  /** Unique constraint (conversationId, providerMessageId) pada messages. */
  function isDuplicateMessage(values: Record<string, unknown>): boolean {
    return (dbState.messages ?? []).some(
      (row) =>
        row.conversationId === values.conversationId &&
        row.providerMessageId === values.providerMessageId,
    );
  }

  return {
    db: {
      select: () => ({
        from: (table: object) => {
          const name = tableNames.get(table) ?? 'unknown';
          const builder: {
            _cond?: unknown;
            _limit?: number;
            where: (c: unknown) => typeof builder;
            limit: (n: number) => typeof builder;
            orderBy: () => typeof builder;
            then: (resolve: (rows: unknown[]) => unknown) => Promise<unknown>;
          } = {
            where(c: unknown) {
              builder._cond = c;
              return builder;
            },
            limit(n: number) {
              builder._limit = n;
              return builder;
            },
            // Ordering tidak disimulasikan (test tidak bergantung urutan).
            orderBy: () => builder,
            then(resolve: (rows: unknown[]) => unknown) {
              let rows = builder._cond
                ? whereFilter(name, builder._cond)
                : [...(dbState[name] ?? [])];
              if (builder._limit != null) rows = rows.slice(0, builder._limit);
              return Promise.resolve(resolve(rows));
            },
          };
          return builder;
        },
      }),
      insert: (table: object) => ({
        values: (values: Record<string, unknown>) => {
          const name = tableNames.get(table) ?? 'unknown';
          return {
            returning: async () => {
              const row = { ...values, id: values.id ?? `${name}-${(dbState[name]?.length ?? 0) + 1}` };
              dbState[name].push(row);
              return [row];
            },
            onConflictDoNothing: () => {
              const dup =
                (name === 'messages' && isDuplicateMessage(values)) ||
                (name === 'conversations' &&
                  (dbState.conversations ?? []).some(
                    (r) =>
                      r.workspaceId === values.workspaceId &&
                      r.channelType === values.channelType &&
                      r.externalId === values.externalId,
                  )) ||
                (name === 'customerChannels' &&
                  (dbState.customerChannels ?? []).some(
                    (r) =>
                      r.workspaceId === values.workspaceId &&
                      r.channelType === values.channelType &&
                      r.identifier === values.identifier,
                  ));
              return {
                then: (resolve: (v: unknown) => unknown) => {
                  if (!dup) dbState[name].push({ ...values });
                  return Promise.resolve(resolve(undefined));
                },
                returning: async () => {
                  if (dup) return [];
                  dbState[name].push({ ...values });
                  return [{ id: values.id ?? `${name}-${dbState[name].length}` }];
                },
              };
            },
            onConflictDoUpdate: (opts: { set: Record<string, unknown> }) => {
              const rows = dbState[name] ?? [];
              const idx = rows.findIndex(
                (r) =>
                  r.workspaceId === values.workspaceId &&
                  r.channelType === values.channelType &&
                  r.identifier === values.identifier,
              );
              if (idx >= 0) {
                Object.assign(rows[idx], { ...values, ...opts.set });
              } else {
                rows.push({ ...values, ...opts.set, id: `${name}-${rows.length + 1}` });
              }
              return { then: (resolve: (v: unknown) => unknown) => Promise.resolve(resolve(undefined)) };
            },
          };
        },
      }),
      update: (table: object) => {
        const name = tableNames.get(table) ?? 'unknown';
        return {
          set: (values: Record<string, unknown>) => ({
            where: (cond: unknown) => ({
              then: (resolve: (v: unknown) => unknown) => {
                const rows = cond ? whereFilter(name, cond) : [...(dbState[name] ?? [])];
                for (const row of rows) {
                  for (const [key, value] of Object.entries(values)) {
                    // Nilai SQL (mis. unreadCount + 1) tidak bisa disimulasikan.
                    if (value && typeof value === 'object' && 'queryChunks' in (value as object)) continue;
                    row[key] = value;
                  }
                }
                return Promise.resolve(resolve(undefined));
              },
            }),
          }),
        };
      },
    },
  };
});

// ── Fixtures ────────────────────────────────────────────────────

const WORKSPACE_ID = 'ws-1';
const BOOKING_ID = '550e8400-e29b-41d4-a716-446655440000';
const CHAT_ID = '123456789';
const TOKEN = '123456:ABC';

function telegramChannel(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: WORKSPACE_ID,
    channelType: 'telegram',
    isActive: true,
    providerConfig: { botToken: TOKEN, webhookSecret: 'secret' },
    ...overrides,
  };
}

function booking(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    workspaceId: WORKSPACE_ID,
    userId: 'user-1',
    phone: '081234567890',
    status: 'pending',
    serviceId: 'svc-gigi',
    customerName: 'Budi',
    timezone: 'Asia/Jakarta',
    scheduledAt: new Date('2026-08-15T07:00:00.000Z'),
    ...overrides,
  };
}

function textUpdate(text: string, updateId = 1001): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1755000000,
      chat: { id: Number(CHAT_ID), first_name: 'Budi', type: 'private' },
      text,
    },
  };
}

function callbackUpdate(action: string, updateId = 2001): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { first_name: 'Budi' },
      message: { message_id: 900, chat: { id: Number(CHAT_ID), type: 'private' } },
      data: `bk:${BOOKING_ID}:${action}`,
    },
  };
}

function contactUpdate(phone: string, updateId = 2001): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1755000000,
      chat: { id: Number(CHAT_ID), first_name: 'Budi', type: 'private' },
      contact: { phone_number: phone, first_name: 'Budi', last_name: 'Santoso', user_id: 98765 },
    },
  };
}

beforeEach(() => {
  dbState.workspaces = [];
  dbState.workspaceChannels = [];
  dbState.workspaceIntegrations = [];
  dbState.conversations = [];
  dbState.messages = [];
  dbState.customerChannels = [];
  dbState.bookings = [];
  // Title booking diturunkan dari katalog — seed layanan 'Scaling Gigi'.
  dbState.services = [
    { id: 'svc-gigi', name: 'Scaling Gigi', workspaceId: WORKSPACE_ID, userId: 'user-1' },
  ];
  sendMessageMock.mockReset();
  sendMessageMock.mockResolvedValue({ messageId: 777 });
  answerCallbackMock.mockReset();
  answerCallbackMock.mockResolvedValue(undefined);
  editReplyMarkupMock.mockReset();
  editReplyMarkupMock.mockResolvedValue(undefined);
  inngestSendMock.mockReset();
  inngestSendMock.mockResolvedValue(undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Test: import handler setelah mock siap ──────────────────────

import { dispatchTelegramReminder, handleTelegramUpdate, TelegramDispatchError } from './telegram-handler.ts';

describe('handleTelegramUpdate — pesan teks baru (belum terhubung)', () => {
  it('user baru → minta nomor HP (state awaiting-phone), balasan + percakapan dibuat', async () => {
    dbState.workspaceChannels = [telegramChannel()];

    const result = await handleTelegramUpdate(WORKSPACE_ID, textUpdate('Halo'));
    expect(result).toEqual({ handled: true });

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const sent = sendMessageMock.mock.calls[0][0];
    expect(sent.token).toBe(TOKEN);
    expect(sent.chatId).toBe(CHAT_ID);
    expect(sent.text).toContain('share your phone number');
    // Balasan membawa keyboard request_contact (tombol "Bagikan Nomor").
    expect(sent.requestContact).toEqual({ label: '📱 Share phone number' });

    const conv = dbState.conversations[0];
    expect(conv?.state).toEqual({ step: 'awaiting-phone' });
    expect(conv?.status).toBe('waiting_input');
    expect(conv?.externalId).toBe(CHAT_ID);
    expect(conv?.bookingId).toBeNull();

    // Pesan masuk + keluar tercatat, dedup metadata replyToUpdateId.
    const inbound = dbState.messages.filter((m) => m.direction === 'inbound');
    const outbound = dbState.messages.filter((m) => m.direction === 'outbound');
    expect(inbound).toHaveLength(1);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].metadata).toEqual({ replyToUpdateId: '1001' });
  });

  it('nomor HP cocok dengan booking aktif → terhubung, customerChannel dibuat', async () => {
    dbState.workspaceChannels = [telegramChannel()];
    dbState.bookings = [booking()];

    // Turn 1: minta nomor
    await handleTelegramUpdate(WORKSPACE_ID, textUpdate('Halo', 1001));
    // Turn 2: kirim nomor
    await handleTelegramUpdate(WORKSPACE_ID, textUpdate('081234567890', 1002));

    // Balasan ke-2 = terhubung (bukan minta nomor lagi — bug guard tetap).
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    const second = sendMessageMock.mock.calls[1][0];
    expect(second.text).toContain('has been linked');

    const channel = dbState.customerChannels[0];
    expect(channel?.identifier).toBe(CHAT_ID);
    // contactPhone disimpan KANONIK (kode negara, tanpa 0 depan) agar cocok
    // dengan format booking mana pun (+62 / 62 / 0812).
    expect(channel?.contactPhone).toBe('6281234567890');
    expect(channel?.isOptedIn).toBe(true);

    const conv = dbState.conversations[0];
    expect(conv?.state).toBeNull();
    expect(conv?.status).toBe('active');
    expect(conv?.customerName).toBe('Budi');
  });

  it('format nomor berbeda (booking +62…, user ketik 0812…) tetap terhubung — bukan "tidak cocok"', async () => {
    dbState.workspaceChannels = [telegramChannel()];
    dbState.bookings = [booking({ phone: '+6281234567890' })];

    // Turn 1: minta nomor
    await handleTelegramUpdate(WORKSPACE_ID, textUpdate('Halo', 1001));
    // Turn 2: kirim nomor format lokal — sama dengan booking (+62…)
    await handleTelegramUpdate(WORKSPACE_ID, textUpdate('081234567890', 1002));

    // Harus TERHUBUNG, bukan mismatch.
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    expect(sendMessageMock.mock.calls[1][0].text).toContain('has been linked');
    expect(dbState.customerChannels[0]?.contactPhone).toBe('6281234567890');
  });

  it('nomor tidak punya booking aktif → arahkan ke booking baru (bukan loop "tidak cocok"), needsAttention', async () => {
    dbState.workspaceChannels = [telegramChannel()];
    dbState.bookings = [booking({ phone: '081199999999' })];

    await handleTelegramUpdate(WORKSPACE_ID, textUpdate('Halo', 1001));
    await handleTelegramUpdate(WORKSPACE_ID, textUpdate('081234567890', 1002));

    // Bukan pesan mismatch — tanpa form terhubung: handoff staf (no form).
    const reply = sendMessageMock.mock.calls[1][0];
    expect(reply.text).toContain('not accepting online bookings');
    expect(dbState.customerChannels).toHaveLength(0);
    // Tetap di state awaiting-phone (bisa coba lagi), TAPI ditandai handoff
    // agar staf melihatnya di inbox.
    expect((dbState.conversations[0]?.state as { step?: string })?.step).toBe('awaiting-phone');
    expect((dbState.conversations[0]?.state as { needsAttention?: boolean })?.needsAttention).toBe(true);
  });

  it('nomor tanpa booking aktif + form terhubung → balasan menyertakan tautan form booking', async () => {
    dbState.workspaceChannels = [telegramChannel()];
    dbState.workspaceIntegrations = [
      {
        workspaceId: WORKSPACE_ID,
        integrationType: 'google-forms',
        isActive: true,
        providerConfig: { formId: 'abc123', formName: 'Formulir Pendaftaran' },
      },
    ];

    await handleTelegramUpdate(WORKSPACE_ID, textUpdate('Halo', 1001));
    await handleTelegramUpdate(WORKSPACE_ID, textUpdate('081234567890', 1002));

    const reply = sendMessageMock.mock.calls[1][0];
    expect(reply.text).toContain('active booking');
    // Customer langsung bisa booking dari awal lewat form.
    expect(reply.text).toContain('https://docs.google.com/forms/d/e/abc123/viewform');
    expect(dbState.customerChannels).toHaveLength(0);
  });

  it('input bukan nomor valid → minta ulang dengan keyboard request_contact (bukan "tidak cocok")', async () => {
    dbState.workspaceChannels = [telegramChannel()];

    await handleTelegramUpdate(WORKSPACE_ID, textUpdate('Halo', 1001));
    await handleTelegramUpdate(WORKSPACE_ID, textUpdate('Bukan nomor', 1002));

    const reply = sendMessageMock.mock.calls[1][0];
    expect(reply.text).toContain('share your phone number');
    expect(reply.requestContact).toEqual({ label: '📱 Share phone number' });
    expect(dbState.customerChannels).toHaveLength(0);
  });

  it('nomor HP langsung tanpa pesan awal → tetap diminta nomor (state belum awaiting-phone)', async () => {
    dbState.workspaceChannels = [telegramChannel()];
    dbState.bookings = [booking()];

    await handleTelegramUpdate(WORKSPACE_ID, textUpdate('081234567890', 1001));

    expect(sendMessageMock.mock.calls[0][0].text).toContain('share your phone number');
    expect(dbState.customerChannels).toHaveLength(0);
  });

  it('workspace chatLanguage=id → balasan bahasa Indonesia (setting terpisah dari callGoalLanguage)', async () => {
    dbState.workspaceChannels = [telegramChannel()];
    dbState.workspaces = [{ id: WORKSPACE_ID, chatLanguage: 'id', callGoalLanguage: 'en' }];

    await handleTelegramUpdate(WORKSPACE_ID, textUpdate('Halo', 1001));

    // chatLanguage 'id' menang walau callGoalLanguage masih 'en'.
    expect(sendMessageMock.mock.calls[0][0].text).toContain('bagikan nomor HP');
    expect(sendMessageMock.mock.calls[0][0].requestContact).toEqual({ label: '📱 Bagikan Nomor' });
  });
});

describe('handleTelegramUpdate — kontak (request_contact)', () => {
  it('user membagikan kontak setelah diminta → terhubung (nomor verified dari Telegram)', async () => {
    dbState.workspaceChannels = [telegramChannel()];
    dbState.bookings = [booking({ phone: '+6281234567890' })];

    // Turn 1: minta nomor (request_contact)
    await handleTelegramUpdate(WORKSPACE_ID, textUpdate('Halo', 1001));
    // Turn 2: bagikan kontak — nomor verified dengan kode negara
    await handleTelegramUpdate(WORKSPACE_ID, contactUpdate('+6281234567890', 1002));

    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    const second = sendMessageMock.mock.calls[1][0];
    expect(second.text).toContain('has been linked');
    // Balasan link tidak membawa keyboard request_contact.
    expect(second.requestContact).toBeUndefined();

    const channel = dbState.customerChannels[0];
    expect(channel?.identifier).toBe(CHAT_ID);
    expect(channel?.contactPhone).toBe('6281234567890');
    expect(channel?.isOptedIn).toBe(true);
    expect(dbState.conversations[0]?.state).toBeNull();
  });

  it('kontak dibagikan langsung tanpa pesan awal → tetap terhubung (tindakan eksplisit)', async () => {
    dbState.workspaceChannels = [telegramChannel()];
    dbState.bookings = [booking({ phone: '081234567890' })];

    await handleTelegramUpdate(WORKSPACE_ID, contactUpdate('+6281234567890', 1001));

    expect(sendMessageMock.mock.calls[0][0].text).toContain('has been linked');
    expect(dbState.customerChannels[0]?.contactPhone).toBe('6281234567890');
  });

  it('kontak tanpa booking aktif → arahkan ke booking baru + needsAttention (bukan loop "tidak cocok")', async () => {
    dbState.workspaceChannels = [telegramChannel()];
    dbState.bookings = [booking({ phone: '081199999999' })];

    await handleTelegramUpdate(WORKSPACE_ID, textUpdate('Halo', 1001));
    await handleTelegramUpdate(WORKSPACE_ID, contactUpdate('+628111222333', 1002));

    const reply = sendMessageMock.mock.calls[1][0];
    expect(reply.text).toContain('not accepting online bookings');
    expect(dbState.customerChannels).toHaveLength(0);
    expect((dbState.conversations[0]?.state as { step?: string })?.step).toBe('awaiting-phone');
    expect((dbState.conversations[0]?.state as { needsAttention?: boolean })?.needsAttention).toBe(true);
  });

  it('kontak dengan nomor yang sama format lokal tetap cocok (kanonik)', async () => {
    dbState.workspaceChannels = [telegramChannel()];
    dbState.bookings = [booking({ phone: '081234567890' })];

    // Telegram selalu kirim kode negara pada kontak, tapi booking bisa lokal.
    await handleTelegramUpdate(WORKSPACE_ID, contactUpdate('6281234567890', 1001));

    expect(sendMessageMock.mock.calls[0][0].text).toContain('has been linked');
    expect(dbState.customerChannels[0]?.contactPhone).toBe('6281234567890');
  });
});

describe('handleTelegramUpdate — tombol booking', () => {
  it('callback confirm → booking dikonfirmasi + balasan konfirmasi', async () => {
    dbState.workspaceChannels = [telegramChannel()];
    dbState.bookings = [booking()];

    const result = await handleTelegramUpdate(WORKSPACE_ID, callbackUpdate('confirm'));
    expect(result).toEqual({ handled: true });

    expect(dbState.bookings[0]?.status).toBe('confirmed');
    expect(sendMessageMock.mock.calls[0][0].text).toContain('has been confirmed');
    // Backfill link chat → customer dari phone booking (tersimpan kanonik).
    expect(dbState.customerChannels[0]?.contactPhone).toBe('6281234567890');
    // Callback di-ack + tombol dibersihkan (cegah double-tap).
    expect(answerCallbackMock).toHaveBeenCalledWith(TOKEN, 'cb-2001');
    expect(editReplyMarkupMock).toHaveBeenCalledWith(TOKEN, CHAT_ID, 900);
  });

  it('callback cancel → booking dibatalkan + reminder di-cancel', async () => {
    dbState.workspaceChannels = [telegramChannel()];
    dbState.bookings = [booking()];

    await handleTelegramUpdate(WORKSPACE_ID, callbackUpdate('cancel'));

    expect(dbState.bookings[0]?.status).toBe('cancelled');
    expect(sendMessageMock.mock.calls[0][0].text).toContain('has been cancelled');
    expect(inngestSendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'booking/cancelled',
        data: expect.objectContaining({ bookingId: BOOKING_ID }),
      }),
    );
  });

  it('callback reschedule → minta waktu baru (state awaiting-time)', async () => {
    dbState.workspaceChannels = [telegramChannel()];
    dbState.bookings = [booking()];

    await handleTelegramUpdate(WORKSPACE_ID, callbackUpdate('reschedule'));

    expect(sendMessageMock.mock.calls[0][0].text).toContain('new time');
    expect(dbState.conversations[0]?.state).toEqual({ step: 'awaiting-time' });
  });

  it('alur reschedule lengkap: waktu baru → booking di-reschedule + reminder dijadwal ulang', async () => {
    dbState.workspaceChannels = [telegramChannel()];
    const b = booking({ scheduledAt: new Date('2026-08-15T07:00:00.000Z') });
    dbState.bookings = [b];

    await handleTelegramUpdate(WORKSPACE_ID, callbackUpdate('reschedule', 2001));
    const newTime = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const formatted = `${newTime.getFullYear()}-${String(newTime.getMonth() + 1).padStart(2, '0')}-${String(newTime.getDate()).padStart(2, '0')} ${String(newTime.getHours()).padStart(2, '0')}:${String(newTime.getMinutes()).padStart(2, '0')}`;
    await handleTelegramUpdate(WORKSPACE_ID, textUpdate(formatted, 2002));

    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    expect(sendMessageMock.mock.calls[1][0].text).toContain('Your new schedule');
    expect(dbState.bookings[0]?.scheduledAt).toBeInstanceOf(Date);
    expect(dbState.conversations[0]?.state).toBeNull();
    // Reminder lama dibatalkan + yang baru dijadwalkan.
    expect(inngestSendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'booking/cancelled',
        data: expect.objectContaining({ bookingId: BOOKING_ID }),
      }),
    );
    expect(inngestSendMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'booking/created' }),
    );
  });

  it('callback confirm untuk booking sudah confirmed → sudah diproses', async () => {
    dbState.workspaceChannels = [telegramChannel()];
    dbState.bookings = [booking({ status: 'confirmed' })];

    await handleTelegramUpdate(WORKSPACE_ID, callbackUpdate('confirm'));

    expect(sendMessageMock.mock.calls[0][0].text).toContain('already been processed');
    expect(dbState.bookings[0]?.status).toBe('confirmed');
  });
});

describe('handleTelegramUpdate — opt-out', () => {
  it('teks STOP → opt-out, channel dimatikan, percakapan ditutup', async () => {
    dbState.workspaceChannels = [telegramChannel()];
    dbState.customerChannels = [
      {
        workspaceId: WORKSPACE_ID,
        channelType: 'telegram',
        identifier: CHAT_ID,
        contactPhone: '081234567890',
        isOptedIn: true,
      },
    ];

    const result = await handleTelegramUpdate(WORKSPACE_ID, textUpdate('STOP', 3001));
    expect(result).toEqual({ handled: true });

    expect(dbState.customerChannels[0]?.isOptedIn).toBe(false);
    expect(sendMessageMock.mock.calls[0][0].text).toContain('stopped receiving');
    expect(dbState.conversations[0]?.status).toBe('closed');
  });

  it('user memblokir bot (my_chat_member kicked) → opt-out otomatis', async () => {
    dbState.workspaceChannels = [telegramChannel()];
    dbState.customerChannels = [
      {
        workspaceId: WORKSPACE_ID,
        channelType: 'telegram',
        identifier: CHAT_ID,
        contactPhone: '081234567890',
        isOptedIn: true,
      },
    ];

    await handleTelegramUpdate(WORKSPACE_ID, {
      update_id: 3002,
      my_chat_member: { chat: { id: Number(CHAT_ID), type: 'private' }, new_chat_member: { status: 'kicked' } },
    });

    expect(dbState.customerChannels[0]?.isOptedIn).toBe(false);
    expect(dbState.conversations[0]?.status).toBe('closed');
  });
});

describe('handleTelegramUpdate — teks dengan konteks booking', () => {
  it('user terhubung + booking aktif → reminder dikirim ulang + needsAttention', async () => {
    dbState.workspaceChannels = [telegramChannel()];
    dbState.workspaces = [{ id: WORKSPACE_ID, name: 'Klinik Gigi Sehat' }];
    dbState.bookings = [booking()];
    dbState.customerChannels = [
      {
        workspaceId: WORKSPACE_ID,
        channelType: 'telegram',
        identifier: CHAT_ID,
        contactPhone: '081234567890',
        isOptedIn: true,
      },
    ];

    await handleTelegramUpdate(WORKSPACE_ID, textUpdate('Terima kasih', 4001));

    const sent = sendMessageMock.mock.calls[0][0];
    expect(sent.text).toContain('Scaling Gigi');
    expect(sent.buttons).toHaveLength(3);

    const conv = dbState.conversations[0];
    expect((conv?.state as { needsAttention?: boolean } | null)?.needsAttention).toBe(true);
  });

  it('teks bebas tanpa booking → balasan umum + needsAttention', async () => {
    dbState.workspaceChannels = [telegramChannel()];
    dbState.workspaces = [{ id: WORKSPACE_ID, name: 'Klinik' }];
    dbState.customerChannels = [
      {
        workspaceId: WORKSPACE_ID,
        channelType: 'telegram',
        identifier: CHAT_ID,
        contactPhone: '081234567890',
        isOptedIn: true,
      },
    ];

    await handleTelegramUpdate(WORKSPACE_ID, textUpdate('Pertanyaan umum', 4002));

    expect(sendMessageMock.mock.calls[0][0].text).toContain('Thank you for your message');
    const conv = dbState.conversations[0];
    expect((conv?.state as { needsAttention?: boolean } | null)?.needsAttention).toBe(true);
  });
});

describe('handleTelegramUpdate — idempotensi & keamanan', () => {
  it('retry update_id sama → balasan tidak dikirim duplikat', async () => {
    dbState.workspaceChannels = [telegramChannel()];

    await handleTelegramUpdate(WORKSPACE_ID, textUpdate('Halo', 5001));
    await handleTelegramUpdate(WORKSPACE_ID, textUpdate('Halo', 5001));

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const outbound = dbState.messages.filter((m) => m.direction === 'outbound');
    expect(outbound).toHaveLength(1);
  });

  it('channel tidak dikonfigurasi → handled false, tidak ada balasan', async () => {
    const result = await handleTelegramUpdate(WORKSPACE_ID, textUpdate('Halo'));
    expect(result).toEqual({ handled: false, reason: 'no-channel' });
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('pesan dari group chat → diabaikan (no-event)', async () => {
    dbState.workspaceChannels = [telegramChannel()];
    const result = await handleTelegramUpdate(WORKSPACE_ID, {
      update_id: 6001,
      message: {
        message_id: 1,
        date: 1755000000,
        chat: { id: -100123, type: 'supergroup' },
        text: 'Halo',
      },
    });
    expect(result).toEqual({ handled: false, reason: 'no-event' });
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});

describe('dispatchTelegramReminder — outbound reminder', () => {
  const reminderInput = {
    workspaceId: WORKSPACE_ID,
    booking: {
      id: BOOKING_ID,
      title: 'Scaling Gigi',
      customerName: 'Budi',
      phone: '081234567890',
      scheduledAt: new Date('2026-08-15T07:00:00.000Z'),
      timezone: 'Asia/Jakarta',
      videoLink: 'https://zoom.us/j/123456789',
    },
    businessName: 'Klinik Gigi Sehat',
  };

  it('mengirim reminder dengan tombol + mencatat outbound', async () => {
    dbState.workspaceChannels = [telegramChannel()];
    dbState.customerChannels = [
      {
        workspaceId: WORKSPACE_ID,
        channelType: 'telegram',
        identifier: CHAT_ID,
        contactPhone: '081234567890',
        isOptedIn: true,
      },
    ];

    const { messageId } = await dispatchTelegramReminder(reminderInput);
    expect(messageId).toBe(777);

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const sent = sendMessageMock.mock.calls[0][0];
    expect(sent.chatId).toBe(CHAT_ID);
    expect(sent.text).toContain('Scaling Gigi');
    expect(sent.buttons).toHaveLength(3);

    const outbound = dbState.messages.filter((m) => m.direction === 'outbound');
    expect(outbound).toHaveLength(1);
    expect(outbound[0].metadata).toEqual({ reminderBookingId: BOOKING_ID });
    expect(outbound[0].status).toBe('sent');
  });

  it('reminder yang sama tidak dikirim dua kali (dedup reminderBookingId)', async () => {
    dbState.workspaceChannels = [telegramChannel()];
    dbState.customerChannels = [
      {
        workspaceId: WORKSPACE_ID,
        channelType: 'telegram',
        identifier: CHAT_ID,
        contactPhone: '081234567890',
        isOptedIn: true,
      },
    ];

    await dispatchTelegramReminder(reminderInput);
    await dispatchTelegramReminder(reminderInput);

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const outbound = dbState.messages.filter((m) => m.direction === 'outbound');
    expect(outbound).toHaveLength(1);
  });

  it('booking tanpa nomor → TelegramDispatchError', async () => {
    dbState.workspaceChannels = [telegramChannel()];
    await expect(
      dispatchTelegramReminder({ ...reminderInput, booking: { ...reminderInput.booking, phone: null } }),
    ).rejects.toThrow(TelegramDispatchError);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('customer belum terhubung ke bot → TelegramDispatchError', async () => {
    dbState.workspaceChannels = [telegramChannel()];
    await expect(dispatchTelegramReminder(reminderInput)).rejects.toThrow(TelegramDispatchError);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('channel dijeda → TelegramDispatchError', async () => {
    dbState.workspaceChannels = [telegramChannel({ isActive: false })];
    dbState.customerChannels = [
      {
        workspaceId: WORKSPACE_ID,
        channelType: 'telegram',
        identifier: CHAT_ID,
        contactPhone: '6281234567890',
        isOptedIn: true,
      },
    ];
    await expect(dispatchTelegramReminder(reminderInput)).rejects.toThrow(TelegramDispatchError);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});
