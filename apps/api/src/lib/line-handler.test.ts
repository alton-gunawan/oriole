import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LineWebhookPayload } from '@oriole/messaging';

// ── Mocks ───────────────────────────────────────────────────────

const { envState } = vi.hoisted(() => ({
  envState: {
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_WEBHOOK_SECRET: '',
  } as Record<string, string | undefined>,
}));

vi.mock('../lib/env.ts', () => ({ env: envState }));

// Line API — semua panggilan network di-stub.
const { replyMock, pushMock } = vi.hoisted(() => ({
  replyMock: vi.fn(),
  pushMock: vi.fn(),
}));

vi.mock('./line.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./line.ts')>();
  return {
    ...actual,
    lineSendReply: replyMock,
    linePushMessage: pushMock,
  };
});

// Crypto — resolveLineChannel mendekripsi kredensial; di test biarkan identitas.
vi.mock('./crypto.ts', () => ({
  decryptSecret: (value: string) => value,
  encryptSecret: (value: string) => value,
}));

// Inngest client — dipakai reminders.ts (emit helpers) saat import modul.
const { inngestSendMock } = vi.hoisted(() => ({ inngestSendMock: vi.fn() }));
vi.mock('../inngest/client.ts', () => ({
  inngest: { send: inngestSendMock },
}));

// ── Fake Drizzle db (in-memory) dengan evaluasi where ───────────
// (pola sama dengan telegram-handler.test.ts — engine percakapan dipakai
// bersama, jadi kebutuhan evaluasi predikat identik.)

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

  function camel(key: string): string {
    return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  }

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
const USER_ID = 'U4af4980629abcdef0123456789';

function lineChannel(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: WORKSPACE_ID,
    channelType: 'line',
    isActive: true,
    providerConfig: {
      channelAccessToken: 'test-access-token',
      channelSecret: 'test-channel-secret',
      lineUserId: 'Ubot123',
    },
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

function textEvent(messageId: string, text: string, replyToken = `rt-${messageId}`): Record<string, unknown> {
  return {
    type: 'message',
    timestamp: 1755000000000,
    source: { type: 'user', userId: USER_ID },
    replyToken,
    message: { id: messageId, type: 'text', text },
  };
}

function postbackEvent(action: string, replyToken = 'pb-1'): Record<string, unknown> {
  return {
    type: 'postback',
    timestamp: 1755000000000,
    source: { type: 'user', userId: USER_ID },
    replyToken,
    postback: { data: `bk:${BOOKING_ID}:${action}` },
  };
}

function payload(...events: Record<string, unknown>[]): LineWebhookPayload {
  return { destination: 'Ubot123', events: events as LineWebhookPayload['events'] };
}

beforeEach(() => {
  dbState.workspaces = [];
  dbState.workspaceChannels = [];
  dbState.workspaceIntegrations = [];
  dbState.conversations = [];
  dbState.messages = [];
  dbState.customerChannels = [];
  dbState.bookings = [];
  dbState.services = [
    { id: 'svc-gigi', name: 'Scaling Gigi', workspaceId: WORKSPACE_ID, userId: 'user-1' },
  ];
  replyMock.mockReset();
  replyMock.mockResolvedValue({ sentMessages: [] });
  pushMock.mockReset();
  pushMock.mockResolvedValue(undefined);
  inngestSendMock.mockReset();
  inngestSendMock.mockResolvedValue(undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

import {
  dispatchLineConfirmation,
  dispatchLineReminder,
  handleLineUpdate,
  LineDispatchError,
} from './line-handler.ts';

describe('handleLineUpdate — pesan teks baru (belum terhubung)', () => {
  it('minta nomor HP via replyToken', async () => {
    dbState.workspaceChannels = [lineChannel()];

    const result = await handleLineUpdate(WORKSPACE_ID, payload(textEvent('325708', 'Halo')));
    expect(result).toEqual({ handled: true, events: 1 });

    expect(replyMock).toHaveBeenCalledTimes(1);
    const call = replyMock.mock.calls[0][0];
    expect(call.replyToken).toBe('rt-325708');
    expect(call.accessToken).toBe('test-access-token');
    expect(call.messages[0].text).toContain('phone number');

    // Percakapan masuk state awaiting-phone.
    expect(dbState.conversations[0]?.state).toEqual({ step: 'awaiting-phone' });
    // Pesan masuk + keluar tercatat.
    const inbound = dbState.messages.filter((m) => m.direction === 'inbound');
    const outbound = dbState.messages.filter((m) => m.direction === 'outbound');
    expect(inbound).toHaveLength(1);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].metadata).toEqual({ replyToEventId: 'msg:325708' });
  });

  it('alur lengkap: Halo → kirim nomor → terhubung ke booking', async () => {
    dbState.workspaceChannels = [lineChannel()];
    dbState.bookings = [booking()];

    await handleLineUpdate(WORKSPACE_ID, payload(textEvent('325708', 'Halo')));
    await handleLineUpdate(WORKSPACE_ID, payload(textEvent('325709', '081234567890')));

    expect(replyMock).toHaveBeenCalledTimes(2);
    expect(replyMock.mock.calls[1][0].messages[0].text).toContain('linked');
    // Chat ter-link ke booking + customerChannel dibuat (opt-in, kanonik).
    expect(dbState.customerChannels).toHaveLength(1);
    expect(dbState.customerChannels[0]).toMatchObject({
      channelType: 'line',
      identifier: USER_ID,
      contactPhone: '6281234567890',
      isOptedIn: true,
    });
    const conv = dbState.conversations[0];
    expect(conv?.state).toBeNull();
    expect(conv?.status).toBe('active');
    expect(conv?.customerName).toBe('Budi');
  });

  it('nomor valid tanpa booking aktif → no-booking reply + needsAttention', async () => {
    dbState.workspaceChannels = [lineChannel()];

    await handleLineUpdate(WORKSPACE_ID, payload(textEvent('325708', 'Halo')));
    await handleLineUpdate(WORKSPACE_ID, payload(textEvent('325709', '081299887766')));

    const last = replyMock.mock.calls[1][0].messages[0].text;
    expect(last).toContain('active booking');
    const conv = dbState.conversations[0];
    expect((conv?.state as { needsAttention?: boolean } | null)?.needsAttention).toBe(true);
  });

  it('retry event sama → balasan tidak dikirim duplikat', async () => {
    dbState.workspaceChannels = [lineChannel()];

    await handleLineUpdate(WORKSPACE_ID, payload(textEvent('325708', 'Halo')));
    await handleLineUpdate(WORKSPACE_ID, payload(textEvent('325708', 'Halo')));

    expect(replyMock).toHaveBeenCalledTimes(1);
    const outbound = dbState.messages.filter((m) => m.direction === 'outbound');
    expect(outbound).toHaveLength(1);
  });

  it('channel tidak dikonfigurasi → handled false, tidak ada balasan', async () => {
    const result = await handleLineUpdate(WORKSPACE_ID, payload(textEvent('325708', 'Halo')));
    expect(result).toEqual({ handled: false, events: 1 });
    expect(replyMock).not.toHaveBeenCalled();
  });
});

describe('handleLineUpdate — tombol booking (postback)', () => {
  it('confirm → booking di-confirm', async () => {
    dbState.workspaceChannels = [lineChannel()];
    dbState.bookings = [booking()];

    const result = await handleLineUpdate(WORKSPACE_ID, payload(postbackEvent('confirm')));
    expect(result.handled).toBe(true);

    expect(dbState.bookings[0]?.status).toBe('confirmed');
    expect(replyMock.mock.calls[0][0].messages[0].text).toContain('confirmed');
  });

  it('cancel → booking dibatalkan + reminder terjadwal dibatalkan', async () => {
    dbState.workspaceChannels = [lineChannel()];
    dbState.bookings = [booking()];

    await handleLineUpdate(WORKSPACE_ID, payload(postbackEvent('cancel')));

    expect(dbState.bookings[0]?.status).toBe('cancelled');
    expect(replyMock.mock.calls[0][0].messages[0].text).toContain('cancelled');
    expect(inngestSendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'booking/cancelled',
        data: expect.objectContaining({ bookingId: BOOKING_ID }),
      }),
    );
  });
});

describe('handleLineUpdate — opt-out', () => {
  it('teks STOP → opt-out, channel dimatikan, percakapan ditutup', async () => {
    dbState.workspaceChannels = [lineChannel()];
    dbState.customerChannels = [
      {
        workspaceId: WORKSPACE_ID,
        channelType: 'line',
        identifier: USER_ID,
        contactPhone: '081234567890',
        isOptedIn: true,
      },
    ];

    await handleLineUpdate(WORKSPACE_ID, payload(textEvent('325710', 'STOP')));

    expect(dbState.customerChannels[0]?.isOptedIn).toBe(false);
    expect(dbState.conversations[0]?.status).toBe('closed');
    expect(replyMock.mock.calls[0][0].messages[0].text).toContain('stopped receiving');
  });

  it('postback stop → opt-out', async () => {
    dbState.workspaceChannels = [lineChannel()];
    dbState.customerChannels = [
      {
        workspaceId: WORKSPACE_ID,
        channelType: 'line',
        identifier: USER_ID,
        contactPhone: '081234567890',
        isOptedIn: true,
      },
    ];

    await handleLineUpdate(WORKSPACE_ID, payload(postbackEvent('stop')));

    expect(dbState.customerChannels[0]?.isOptedIn).toBe(false);
  });
});

describe('handleLineUpdate — multi-event payload', () => {
  it('dua event dalam satu payload diproses urut', async () => {
    dbState.workspaceChannels = [lineChannel()];

    await handleLineUpdate(
      WORKSPACE_ID,
      payload(textEvent('1', 'Halo'), textEvent('2', 'STOP')),
    );

    expect(replyMock).toHaveBeenCalledTimes(2);
    // Event kedua (STOP) menutup percakapan.
    expect(dbState.conversations[0]?.status).toBe('closed');
  });

  it('payload tanpa event relevan → handled false', async () => {
    dbState.workspaceChannels = [lineChannel()];
    const result = await handleLineUpdate(WORKSPACE_ID, payload({ type: 'follow', timestamp: 1, source: { type: 'user', userId: USER_ID } }));
    expect(result).toEqual({ handled: false, events: 0 });
    expect(replyMock).not.toHaveBeenCalled();
  });
});

describe('dispatchLineReminder — outbound reminder (push)', () => {
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

  it('push reminder + mencatat outbound', async () => {
    dbState.workspaceChannels = [lineChannel()];
    dbState.customerChannels = [
      {
        workspaceId: WORKSPACE_ID,
        channelType: 'line',
        identifier: USER_ID,
        contactPhone: '081234567890',
        isOptedIn: true,
      },
    ];

    const { messageId } = await dispatchLineReminder(reminderInput);
    expect(messageId).toBeNull();

    expect(pushMock).toHaveBeenCalledTimes(1);
    const call = pushMock.mock.calls[0][0];
    expect(call.to).toBe(USER_ID);
    expect(call.accessToken).toBe('test-access-token');
    expect(call.messages[0].text).toContain('Scaling Gigi');
    // Teks reminder panjang → teks penuh + template tombol dengan prompt pendek
    // (confirm/reschedule/cancel → 3 aksi postback).
    expect(call.messages[1].template.actions).toHaveLength(3);
    expect(call.messages[1].template.text).toBe('Choose an action:');

    const outbound = dbState.messages.filter((m) => m.direction === 'outbound');
    expect(outbound).toHaveLength(1);
    expect(outbound[0].metadata).toEqual({ reminderBookingId: BOOKING_ID });
    expect(outbound[0].status).toBe('sent');
  });

  it('reminder yang sama tidak dikirim dua kali (dedup reminderBookingId)', async () => {
    dbState.workspaceChannels = [lineChannel()];
    dbState.customerChannels = [
      {
        workspaceId: WORKSPACE_ID,
        channelType: 'line',
        identifier: USER_ID,
        contactPhone: '081234567890',
        isOptedIn: true,
      },
    ];

    await dispatchLineReminder(reminderInput);
    await dispatchLineReminder(reminderInput);

    expect(pushMock).toHaveBeenCalledTimes(1);
  });

  it('booking tanpa nomor → LineDispatchError', async () => {
    dbState.workspaceChannels = [lineChannel()];
    await expect(
      dispatchLineReminder({ ...reminderInput, booking: { ...reminderInput.booking, phone: null } }),
    ).rejects.toThrow(LineDispatchError);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('customer belum terhubung → LineDispatchError', async () => {
    dbState.workspaceChannels = [lineChannel()];
    await expect(dispatchLineReminder(reminderInput)).rejects.toThrow(LineDispatchError);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('channel dijeda → LineDispatchError', async () => {
    dbState.workspaceChannels = [lineChannel({ isActive: false })];
    dbState.customerChannels = [
      {
        workspaceId: WORKSPACE_ID,
        channelType: 'line',
        identifier: USER_ID,
        contactPhone: '081234567890',
        isOptedIn: true,
      },
    ];
    await expect(dispatchLineReminder(reminderInput)).rejects.toThrow(LineDispatchError);
    expect(pushMock).not.toHaveBeenCalled();
  });
});

describe('dispatchLineConfirmation — konfirmasi booking diterima', () => {
  const confirmationInput = {
    workspaceId: WORKSPACE_ID,
    booking: {
      id: BOOKING_ID,
      title: 'Scaling Gigi',
      customerName: 'Budi',
      phone: '081234567890',
      scheduledAt: new Date('2026-08-15T07:00:00.000Z'),
      timezone: 'Asia/Jakarta',
      videoLink: null,
    },
    businessName: 'Klinik Gigi Sehat',
  };

  it('push konfirmasi tanpa tombol + dedup confirmationBookingId', async () => {
    dbState.workspaceChannels = [lineChannel()];
    dbState.customerChannels = [
      {
        workspaceId: WORKSPACE_ID,
        channelType: 'line',
        identifier: USER_ID,
        contactPhone: '081234567890',
        isOptedIn: true,
      },
    ];

    await dispatchLineConfirmation(confirmationInput);

    const call = pushMock.mock.calls[0][0];
    expect(call.messages[0].text).toContain('has been received');
    expect(call.messages).toHaveLength(1); // tanpa tombol → teks saja

    const outbound = dbState.messages.filter((m) => m.direction === 'outbound');
    expect(outbound[0].metadata).toEqual({ confirmationBookingId: BOOKING_ID });
  });
});
