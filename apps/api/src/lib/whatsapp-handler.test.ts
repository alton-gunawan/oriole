import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WhatsAppWebhookPayload } from '@oriole/messaging';

import { handleWhatsAppUpdate } from './whatsapp-handler.ts';

// ── Mocks ───────────────────────────────────────────────────────

// Env — objek sama yang direferensikan modul (bisa diubah per test).
const { envState } = vi.hoisted(() => ({
  envState: {
    AI_CHAT_API_KEY: 'gsk_test_key',
    AI_CHAT_BASE_URL: 'https://api.groq.com/openai/v1',
    AI_CHAT_MODEL: 'llama-3.3-70b-versatile',
  } as Record<string, string | undefined>,
}));

vi.mock('../lib/env.ts', () => ({ env: envState }));

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
const { resolveChannelMock, sendMessageMock } = vi.hoisted(() => ({
  resolveChannelMock: vi.fn(),
  sendMessageMock: vi.fn(),
}));
const { inngestSendMock } = vi.hoisted(() => ({ inngestSendMock: vi.fn() }));

// Inngest client — dipakai reminders.ts (emit helpers) saat import modul.
vi.mock('../inngest/client.ts', () => ({
  inngest: { send: inngestSendMock },
}));

// Service WhatsApp — channel + outbound di-mock (tanpa network).
vi.mock('../services/whatsapp.ts', () => ({
  resolveWhatsAppChannel: resolveChannelMock,
  sendWhatsAppMessage: sendMessageMock,
  WhatsAppOutboundBlockedError: class WhatsAppOutboundBlockedError extends Error {},
}));

// Fake Drizzle db — tabel kecil yang dipakai alur handler + ai-chat.
const { dbState } = vi.hoisted(() => ({
  dbState: {} as Record<string, Record<string, unknown>[]>,
}));

vi.mock('../db/index.ts', async () => {
  const {
    bookings,
    contacts,
    conversations,
    customerChannels,
    messages,
    serviceStaff,
    services,
    staffMembers,
    staffSchedules,
    staffTimeOff,
    workspaceIntegrations,
    workspaces,
  } = await import('@oriole/database');
  const tableNames = new WeakMap<object, string>();
  tableNames.set(workspaces, 'workspaces');
  tableNames.set(conversations, 'conversations');
  tableNames.set(messages, 'messages');
  tableNames.set(customerChannels, 'customerChannels');
  tableNames.set(bookings, 'bookings');
  tableNames.set(workspaceIntegrations, 'workspaceIntegrations');
  tableNames.set(contacts, 'contacts');
  tableNames.set(services, 'services');
  tableNames.set(serviceStaff, 'serviceStaff');
  tableNames.set(staffMembers, 'staffMembers');
  tableNames.set(staffSchedules, 'staffSchedules');
  tableNames.set(staffTimeOff, 'staffTimeOff');

  /** Simulasi unique constraint penting per tabel (diproses onConflictDoNothing). */
  function isDuplicate(name: string, values: Record<string, unknown>): boolean {
    if (name === 'messages') {
      return dbState.messages.some(
        (row) =>
          row.conversationId === values.conversationId &&
          row.providerMessageId === values.providerMessageId,
      );
    }
    if (name === 'conversations') {
      return dbState.conversations.some(
        (row) =>
          row.workspaceId === values.workspaceId &&
          row.channelType === values.channelType &&
          row.externalId === values.externalId,
      );
    }
    if (name === 'customerChannels') {
      return dbState.customerChannels.some(
        (row) =>
          row.workspaceId === values.workspaceId &&
          row.channelType === values.channelType &&
          row.identifier === values.identifier,
      );
    }
    return false;
  }

  function makeSelectBuilder(name: string) {
    const builder: {
      _limit?: number;
      _ordered: boolean;
      where: () => typeof builder;
      orderBy: () => typeof builder;
      limit: (n: number) => typeof builder;
      then: (resolve: (rows: unknown[]) => unknown) => Promise<unknown>;
    } = {
      _ordered: false,
      where() {
        return builder;
      },
      orderBy() {
        builder._ordered = true;
        return builder;
      },
      limit(n: number) {
        builder._limit = n;
        return builder;
      },
      then(resolve: (rows: unknown[]) => unknown) {
        let rows = [...(dbState[name] ?? [])];
        // Dedup balasan (tanpa orderBy) menyaring pesan KELUAR — query riwayat
        // konteks AI (dengan orderBy) mengembalikan semua arah.
        if (name === 'messages' && !builder._ordered) {
          rows = rows.filter((row) => row.direction === 'outbound');
        }
        if (builder._ordered) {
          rows = rows.sort(
            (a, b) =>
              new Date((b.createdAt as Date) ?? 0).getTime() -
              new Date((a.createdAt as Date) ?? 0).getTime(),
          );
        }
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
        values: (values: Record<string, unknown>) => {
          const name = tableNames.get(table) ?? 'unknown';
          // Baris lengkap (id + values) — mirip Drizzle returning() sungguhan.
          const row = () => ({ id: values.id ?? `${name}-${dbState[name].length + 1}`, ...values });
          return {
            returning: async () => {
              const inserted = row();
              dbState[name].push(inserted);
              return [inserted];
            },
            onConflictDoNothing: () => {
              const dup = isDuplicate(name, values);
              return {
                then: (resolve: (value: unknown) => unknown) => {
                  if (!dup) dbState[name].push(row());
                  return Promise.resolve(resolve(undefined));
                },
                returning: async () => {
                  if (dup) return [];
                  const inserted = row();
                  dbState[name].push(inserted);
                  return [inserted];
                },
              };
            },
          };
        },
      }),
      update: (table: object) => ({
        set: (values: Record<string, unknown>) => ({
          where: () => {
            const name = tableNames.get(table) ?? 'unknown';
            // Target baris terakhir: percakapan tunggal / pesan outbound.
            const rows = dbState[name];
            const target = rows[rows.length - 1];
            if (target) {
              Object.assign(target, { ...values, updatedAt: new Date('2026-01-01T00:00:00Z') });
            }
          },
        }),
      }),
    },
  };
});

// ── Fixtures ────────────────────────────────────────────────────

const WORKSPACE_ID = 'ws-1';
const BOOKING_ID = '550e8400-e29b-41d4-a716-446655440000';
const WA_ID = '6281234567890';
const WAMID = 'wamid.HBgLNTYyMDAwMDAwMDAwFQIAERgSMjAyNi0wOC0xNQo';

const baseWorkspace = (overrides: Record<string, unknown> = {}) => ({
  id: WORKSPACE_ID,
  name: 'Klinik Gigi Sehat',
  industry: 'Kesehatan',
  aiEnabled: true,
  aiKnowledge: {
    description: 'Klinik gigi di Jakarta.',
    services: 'Scaling 150rb',
    hours: 'Sen–Sab 08.00–20.00',
    location: 'Jl. Merdeka No. 1, Jakarta',
    faq: [{ q: 'Terima kartu?', a: 'Ya, debit & kredit.' }],
  },
  deletedAt: null,
  ...overrides,
});

function textPayload(body: string): WhatsAppWebhookPayload {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '1234567890',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: WA_ID, phone_number_id: '0987654321' },
              contacts: [{ profile: { name: 'Budi' }, wa_id: WA_ID }],
              messages: [
                { from: WA_ID, id: WAMID, timestamp: '1755000000', type: 'text', text: { body } },
              ],
            },
          },
        ],
      },
    ],
  };
}

function llmResponse(content: string) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

function toolCallsResponse(toolCalls: { name: string; arguments: string }[]) {
  return {
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            tool_calls: toolCalls.map((call, index) => ({
              id: `call-${index}`,
              type: 'function',
              function: { name: call.name, arguments: call.arguments },
            })),
          },
        },
      ],
    }),
  };
}

beforeEach(() => {
  dbState.workspaces = [];
  dbState.conversations = [];
  dbState.messages = [];
  dbState.customerChannels = [];
  dbState.bookings = [];
  dbState.workspaceIntegrations = [];
  dbState.contacts = [];
  dbState.services = [];
  dbState.serviceStaff = [];
  dbState.staffMembers = [];
  dbState.staffSchedules = [];
  dbState.staffTimeOff = [];
  fetchMock.mockReset();
  resolveChannelMock.mockReset();
  sendMessageMock.mockReset();
  inngestSendMock.mockReset();
  envState.AI_CHAT_API_KEY = 'gsk_test_key';
  envState.AI_CHAT_BASE_URL = 'https://api.groq.com/openai/v1';
  envState.AI_CHAT_MODEL = 'llama-3.3-70b-versatile';
  resolveChannelMock.mockResolvedValue({
    provider: '360dialog',
    apiKey: 'wa_test',
    webhookSecret: 'test-secret',
    isActive: true,
  });
  sendMessageMock.mockResolvedValue({ messageId: 'wamid-out-1' });
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── Alur AI chat ────────────────────────────────────────────────

describe('handleWhatsAppUpdate — AI chat (teks bebas)', () => {
  it('AI aktif + KB terisi + jawaban grounded → kirim jawaban AI (metadata ai:true), tanpa needsAttention', async () => {
    dbState.workspaces = [baseWorkspace()];
    fetchMock.mockResolvedValue(
      llmResponse(
        '{"intent": "price_inquiry", "answer": "Scaling 150rb.", "confidence": 0.95, "needsHuman": false, "reason": "answered-from-kb", "sources": [{"type": "knowledge", "id": "kb:services"}]}',
      ),
    );

    const result = await handleWhatsAppUpdate(WORKSPACE_ID, textPayload('Berapa harga scaling?'));
    expect(result).toEqual({ handled: true, events: 1 });

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0][0].text).toBe('Scaling 150rb.');

    const outbound = dbState.messages.filter((m) => m.direction === 'outbound')[0];
    expect(outbound.content).toBe('Scaling 150rb.');
    expect(outbound.metadata).toEqual({ replyToWamid: WAMID, ai: true });

    // Jawaban AI → percakapan TIDAK ditandai butuh perhatian staf.
    const conv = dbState.conversations[0];
    expect(conv?.state ?? null).toBeNull();
  });

  it('intent unknown → handoff: kirim renderAiHandoffReply (ai:true) + needsAttention', async () => {
    dbState.workspaces = [baseWorkspace()];
    fetchMock.mockResolvedValue(
      llmResponse('{"intent": "unknown", "answer": "Tidak yakin.", "confidence": 0.4, "needsHuman": false, "reason": "out-of-kb"}'),
    );

    await handleWhatsAppUpdate(WORKSPACE_ID, textPayload('Apakah ada paket keluarga?'));

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0][0].text).toContain('our team');

    const conv = dbState.conversations[0];
    expect((conv?.state as { needsAttention?: boolean })?.needsAttention).toBe(true);

    const outbound = dbState.messages.filter((m) => m.direction === 'outbound')[0];
    expect(outbound.metadata).toEqual({ replyToWamid: WAMID, ai: true });
  });

  it('tanpa key AI → perilaku lama: info bisnis + needsAttention, LLM tidak dipanggil', async () => {
    envState.AI_CHAT_API_KEY = undefined;
    dbState.workspaces = [baseWorkspace()];

    await handleWhatsAppUpdate(WORKSPACE_ID, textPayload('Halo, ada yang bisa dibantu?'));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0][0].text).toContain('Klinik Gigi Sehat');

    const conv = dbState.conversations[0];
    expect((conv?.state as { needsAttention?: boolean })?.needsAttention).toBe(true);

    const outbound = dbState.messages.filter((m) => m.direction === 'outbound')[0];
    // Bukan produk pipeline AI → tanpa flag ai.
    expect(outbound.metadata).toEqual({ replyToWamid: WAMID });
  });

  it('AI aktif tapi knowledge base kosong → fallback lama (AI tidak dipanggil)', async () => {
    dbState.workspaces = [baseWorkspace({ aiKnowledge: null })];

    await handleWhatsAppUpdate(WORKSPACE_ID, textPayload('Jam buka kapan?'));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const conv = dbState.conversations[0];
    expect((conv?.state as { needsAttention?: boolean })?.needsAttention).toBe(true);
  });

  it('customer berbooking aktif → reminder dikirim, AI tidak dipanggil (prioritas reminder)', async () => {
    dbState.workspaces = [baseWorkspace()];
    // Title booking = nama layanan katalog (kolom title sudah dihapus).
    dbState.services = [
      { id: 'svc-gigi', name: 'Scaling Gigi', workspaceId: WORKSPACE_ID, userId: 'user-1' },
    ];
    dbState.bookings = [
      {
        id: BOOKING_ID,
        workspaceId: WORKSPACE_ID,
        userId: 'user-1',
        phone: WA_ID,
        status: 'pending',
        serviceId: 'svc-gigi',
        customerName: 'Budi',
        timezone: 'Asia/Jakarta',
        scheduledAt: new Date('2026-08-15T07:00:00.000Z'),
        createdAt: new Date('2026-08-01T00:00:00Z'),
      },
    ];

    await handleWhatsAppUpdate(WORKSPACE_ID, textPayload('Terima kasih'));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0][0].text).toContain('Scaling Gigi');
    expect(sendMessageMock.mock.calls[0][0].buttons).toHaveLength(3);
  });

  it('AI booking agent: tool create_booking dieksekusi BACKEND → booking dibuat (source ai-chat) + konfirmasi dikirim', async () => {
    dbState.workspaces = [baseWorkspace()];
    // Katalog layanan → mesin slot & tool booking (tenant workspace ini).
    dbState.services = [
      {
        id: 'svc-1',
        workspaceId: WORKSPACE_ID,
        userId: 'user-1',
        name: 'Potong Rambut',
        description: null,
        durationMinutes: 45,
        priceMinor: 10000,
        currency: 'IDR',
        color: '#000000',
        category: ['Haircut'],
        isActive: true,
        sortOrder: 0,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
      },
    ];

    // Phase 1: LLM meminta action lewat tool (bukan mengarang hasil).
    fetchMock
      .mockResolvedValueOnce(
        toolCallsResponse([
          {
            name: 'create_booking',
            arguments: JSON.stringify({ serviceName: 'Potong Rambut', date: '2027-01-15', time: '14:00' }),
          },
        ]),
      )
      // Phase 2: output terstruktur grounded pada hasil tool.
      .mockResolvedValueOnce(
        llmResponse(
          '{"intent": "create_booking", "answer": "Booking kamu sudah dibuat: Potong Rambut pada 2027-01-15 pukul 14:00.", "confidence": 0.9, "needsHuman": false, "reason": "tool result", "sources": [{"type": "tool", "name": "create_booking"}]}',
        ),
      );

    const result = await handleWhatsAppUpdate(WORKSPACE_ID, textPayload('mau potong rambut besok jam 3'));
    expect(result).toEqual({ handled: true, events: 1 });

    // Konfirmasi AI terkirim.
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0][0].text).toContain('Booking kamu sudah dibuat');

    // Booking NYATA dibuat oleh backend (bukan dikarang LLM).
    expect(dbState.bookings).toHaveLength(1);
    expect(dbState.bookings[0]).toMatchObject({
      workspaceId: WORKSPACE_ID,
      status: 'pending',
      source: 'ai-chat',
    });
    expect(String(dbState.bookings[0].phone)).toContain('6281234567890');

    // State booking terstruktur tersimpan di conversations.state.ai.
    const conv = dbState.conversations[0];
    const aiState = (conv?.state as { ai?: { intent?: string; serviceId?: string; date?: string } })?.ai;
    expect(aiState?.intent).toBe('create_booking');
    expect(aiState?.date).toBe('2027-01-15');

    const outbound = dbState.messages.filter((m) => m.direction === 'outbound')[0];
    expect(outbound.metadata).toEqual({ replyToWamid: WAMID, ai: true });
  });

  it('retry webhook dengan wamid sama → tidak mengirim duplikat (dedup replyToWamid)', async () => {
    dbState.workspaces = [baseWorkspace()];
    fetchMock.mockResolvedValue(
      llmResponse(
        '{"intent": "price_inquiry", "answer": "Scaling 150rb.", "confidence": 0.95, "needsHuman": false, "reason": "answered-from-kb", "sources": [{"type": "knowledge", "id": "kb:services"}]}',
      ),
    );

    await handleWhatsAppUpdate(WORKSPACE_ID, textPayload('Berapa harga scaling?'));
    await handleWhatsAppUpdate(WORKSPACE_ID, textPayload('Berapa harga scaling?'));

    // Balasan tetap SATU — pesan outbound kedua di-skip oleh dedup.
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const outbound = dbState.messages.filter((m) => m.direction === 'outbound');
    expect(outbound).toHaveLength(1);
    expect(outbound[0].metadata).toEqual({ replyToWamid: WAMID, ai: true });
  });
});
