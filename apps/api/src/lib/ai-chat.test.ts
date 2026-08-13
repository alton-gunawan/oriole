import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  aiChatRetryConfig,
  buildAiChatPrompt,
  callAiChatLlm,
  hasAiKnowledge,
  parseAiLlmResult,
  tryAiChatReply,
} from './ai-chat.ts';

// ── Mocks ───────────────────────────────────────────────────────

// Env AI chat — objek yang sama direferensikan modul (bisa diubah per test).
const { envState } = vi.hoisted(() => ({
  envState: {
    AI_CHAT_API_KEY: 'gsk_test_key',
    AI_CHAT_BASE_URL: 'https://api.groq.com/openai/v1',
    AI_CHAT_MODEL: 'llama-3.3-70b-versatile',
  } as Record<string, string | undefined>,
}));

vi.mock('../lib/env.ts', () => ({ env: envState }));

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

// Fake Drizzle db — tabel kecil: workspaces, messages, conversations.
const { dbState } = vi.hoisted(() => ({
  dbState: {} as Record<string, Record<string, unknown>[]>,
}));

vi.mock('../db/index.ts', async () => {
  const { conversations, messages, workspaces } = await import('@oriole/database');
  const tableNames = new WeakMap<object, string>();
  tableNames.set(workspaces, 'workspaces');
  tableNames.set(messages, 'messages');
  tableNames.set(conversations, 'conversations');

  function makeSelectBuilder(name: string) {
    const builder: {
      _limit?: number;
      _order?: 'asc' | 'desc';
      where: () => typeof builder;
      orderBy: () => typeof builder;
      limit: (n: number) => typeof builder;
      then: (resolve: (rows: unknown[]) => unknown) => Promise<unknown>;
    } = {
      where() {
        return builder;
      },
      orderBy() {
        builder._order = 'desc';
        return builder;
      },
      limit(n: number) {
        builder._limit = n;
        return builder;
      },
      then(resolve: (rows: unknown[]) => unknown) {
        let rows = [...(dbState[name] ?? [])];
        if (builder._order === 'desc') {
          rows = rows.sort(
            (a, b) => new Date(b.createdAt as Date).getTime() - new Date(a.createdAt as Date).getTime(),
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
      update: (table: object) => ({
        set: (values: Record<string, unknown>) => ({
          where: () => {
            const name = tableNames.get(table) ?? 'unknown';
            const target = dbState[name]?.[0];
            if (target) Object.assign(target, values);
          },
        }),
      }),
    },
  };
});

// ── Fixtures ────────────────────────────────────────────────────

const WORKSPACE_ID = 'ws-1';
const CONVERSATION_ID = 'conv-1';

const baseWorkspace = (overrides: Record<string, unknown> = {}) => ({
  id: WORKSPACE_ID,
  name: 'Klinik Gigi Sehat',
  industry: 'Kesehatan',
  aiEnabled: true,
  aiKnowledge: {
    description: 'Klinik gigi di Jakarta.',
    services: 'Scaling 150rb, Behel 5jt',
    hours: 'Sen–Sab 08.00–20.00',
    location: 'Jl. Merdeka No. 1, Jakarta',
    faq: [{ q: 'Terima kartu?', a: 'Ya, debit & kredit.' }],
  },
  deletedAt: null,
  updatedAt: new Date('2026-08-01T00:00:00Z'),
  ...overrides,
});

function llmResponse(content: string) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

/** Balasan grounded — kontrak output baru (intent + sources). */
function groundedAnswer(intent: string, answer: string, sourceId: string) {
  return JSON.stringify({
    intent,
    answer,
    confidence: 0.95,
    needsHuman: false,
    reason: 'answered-from-context',
    sources: [{ type: 'knowledge', id: sourceId }],
  });
}

function buildPrompt(overrides: {
  history?: { direction: string; content: string }[];
  knowledgeContext?: string;
}) {
  return buildAiChatPrompt({
    businessName: 'Klinik Gigi Sehat',
    industry: 'Kesehatan',
    language: 'id',
    // Konteks knowledge yang RELEVAN (hasil retrieval) — bukan seluruh KB.
    ...(overrides.knowledgeContext !== undefined
      ? { knowledgeContext: overrides.knowledgeContext }
      : { knowledgeContext: 'Scaling 150rb' }),
    history: overrides.history ?? [{ direction: 'inbound', content: 'Halo' }],
  });
}

beforeEach(() => {
  dbState.workspaces = [];
  dbState.messages = [];
  dbState.conversations = [];
  fetchMock.mockReset();
  envState.AI_CHAT_API_KEY = 'gsk_test_key';
  envState.AI_CHAT_BASE_URL = 'https://api.groq.com/openai/v1';
  envState.AI_CHAT_MODEL = 'llama-3.3-70b-versatile';
  // Retry tanpa jeda agar test cepat; dikembalikan ke default di afterEach.
  (aiChatRetryConfig as { delaysMs: number[] }).delaysMs = [0, 0];
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  (aiChatRetryConfig as { delaysMs: number[] }).delaysMs = [300, 700];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── buildAiChatPrompt ───────────────────────────────────────────

describe('buildAiChatPrompt (context berlapis)', () => {
  it('system prompt memuat identitas bisnis + aturan anti-halusinasi + JSON output contract', () => {
    const { system } = buildPrompt({});
    expect(system).toContain('Klinik Gigi Sehat');
    expect(system).toContain('Kesehatan');
    expect(system).toContain('JANGAN pernah mengarang');
    expect(system).toContain('KONTEKS KNOWLEDGE');
    expect(system).toContain('confidence');
    expect(system).toContain('sources');
    expect(system).toContain('intent');
  });

  it('hanya knowledge RELEVAN yang dikirim — bukan seluruh KB', () => {
    const { system } = buildPrompt({ knowledgeContext: 'Scaling 150rb' });
    expect(system).toContain('Scaling 150rb');
    // Jam buka / lokasi TIDAK ikut dikirim (retrieval memilih konteks relevan).
    expect(system).not.toContain('Sen–Sab 08.00–20.00');
    expect(system).not.toContain('Jl. Merdeka');
  });

  it('tanpa konteks knowledge → tidak ada blok KONTEKS KNOWLEDGE (agent tahu harus handoff)', () => {
    const { system } = buildPrompt({ knowledgeContext: '' });
    expect(system).not.toContain('KONTEKS KNOWLEDGE (relevan)');
  });

  it('user prompt memformat riwayat kronologis (terbaru di akhir)', () => {
    const { user } = buildPrompt({
      history: [
        { direction: 'inbound', content: 'Halo' },
        { direction: 'outbound', content: 'Halo! Ada yang bisa dibantu?' },
        { direction: 'inbound', content: 'Berapa harga scaling?' },
      ],
    });
    expect(user).toContain('Customer: Halo');
    expect(user).toContain('Staf: Halo! Ada yang bisa dibantu?');
    expect(user.indexOf('Berapa harga scaling?')).toBeGreaterThan(
      user.indexOf('Halo! Ada yang bisa dibantu?'),
    );
  });

  it('system prompt tetap valid tanpa field opsional (KB parsial)', () => {
    const { system } = buildPrompt({ knowledgeContext: '08.00–20.00' });
    expect(system).toContain('08.00–20.00');
    expect(system).not.toContain('undefined');
  });

  it('hasil tool dirender sebagai blok HASIL TOOL (data live)', () => {
    const { system } = buildAiChatPrompt({
      businessName: 'Klinik Gigi Sehat',
      industry: null,
      language: 'id',
      knowledgeContext: '',
      toolResults: 'TOOL get_available_slots → {"slots":["14:00","15:00"]}',
    });
    expect(system).toContain('HASIL TOOL');
    expect(system).toContain('14:00');
  });
});

// ── parseAiLlmResult (kontrak legacy — lenient) ────────────────

describe('parseAiLlmResult', () => {
  it('mem-parse JSON valid', () => {
    const result = parseAiLlmResult(
      '{"answer": "Harga scaling 150rb.", "confidence": 0.95, "needsHuman": false, "reason": "answered-from-kb"}',
    );
    expect(result).toEqual({
      answer: 'Harga scaling 150rb.',
      confidence: 0.95,
      needsHuman: false,
      reason: 'answered-from-kb',
    });
  });

  it('menerima pembungkus ```json ... ```', () => {
    const result = parseAiLlmResult('```json\n{"answer": "08.00–20.00", "confidence": 0.9}\n```');
    expect(result?.answer).toBe('08.00–20.00');
    expect(result?.confidence).toBe(0.9);
  });

  it('clamp confidence ke [0,1]', () => {
    expect(parseAiLlmResult('{"answer": "a", "confidence": 2.5}')?.confidence).toBe(1);
    expect(parseAiLlmResult('{"answer": "a", "confidence": -1}')?.confidence).toBe(0);
  });

  it('JSON tidak valid / answer kosong → null', () => {
    expect(parseAiLlmResult('bukan json')).toBeNull();
    expect(parseAiLlmResult('{"confidence": 0.9}')).toBeNull();
    expect(parseAiLlmResult('{"answer": "   "}')).toBeNull();
  });
});

// ── hasAiKnowledge ──────────────────────────────────────────────

describe('hasAiKnowledge', () => {
  it('null / kosong / hanya spasi → false', () => {
    expect(hasAiKnowledge(null)).toBe(false);
    expect(hasAiKnowledge({})).toBe(false);
    expect(hasAiKnowledge({ services: '   ' })).toBe(false);
  });

  it('satu bagian terisi → true', () => {
    expect(hasAiKnowledge({ hours: '08.00–20.00' })).toBe(true);
    expect(hasAiKnowledge({ faq: [{ q: 'a?', a: 'b.' }] })).toBe(true);
  });
});

// ── callAiChatLlm ───────────────────────────────────────────────

describe('callAiChatLlm', () => {
  it('memanggil endpoint dengan header + JSON mode, lalu mengembalikan hasil ter-parse', async () => {
    fetchMock.mockResolvedValue(
      llmResponse('{"answer": "Harga scaling 150rb.", "confidence": 0.95, "needsHuman": false}'),
    );
    const result = await callAiChatLlm('system', 'user');
    expect(result?.answer).toBe('Harga scaling 150rb.');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer gsk_test_key');
    const body = JSON.parse(init.body as string) as {
      response_format: unknown;
      model: string;
      max_tokens: number;
    };
    expect(body.model).toBe('llama-3.3-70b-versatile');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.max_tokens).toBe(400);
  });

  it('4xx non-retryable (mis. 400) → null langsung, tanpa retry', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, text: async () => 'bad request' });
    expect(await callAiChatLlm('system', 'user')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('429 rate limit → dicoba ulang maks 3×, lalu null (fallback aman)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, text: async () => 'rate limited' });
    expect(await callAiChatLlm('system', 'user')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('429 dengan header retry-after → tetap dicoba ulang, lalu sukses pada percobaan kedua', async () => {
    const rateLimited = {
      ok: false,
      status: 429,
      text: async () => 'rate limited',
      headers: { get: () => '0.02' },
    };
    fetchMock
      .mockResolvedValueOnce(rateLimited)
      .mockResolvedValueOnce(
        llmResponse('{"answer": "Scaling 150rb.", "confidence": 0.95, "needsHuman": false}'),
      );
    const result = await callAiChatLlm('system', 'user');
    expect(result?.answer).toBe('Scaling 150rb.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('5xx lalu sukses pada percobaan kedua → jawaban dikembalikan', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'overloaded' })
      .mockResolvedValueOnce(
        llmResponse('{"answer": "Scaling 150rb.", "confidence": 0.95, "needsHuman": false}'),
      );
    const result = await callAiChatLlm('system', 'user');
    expect(result?.answer).toBe('Scaling 150rb.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('network error lalu sukses pada percobaan kedua → jawaban dikembalikan', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(
        llmResponse('{"answer": "08.00–20.00", "confidence": 0.9, "needsHuman": false}'),
      );
    const result = await callAiChatLlm('system', 'user');
    expect(result?.answer).toBe('08.00–20.00');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('network error → null (tidak throw)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await callAiChatLlm('system', 'user')).toBeNull();
  });

  it('konten bukan JSON → null', async () => {
    fetchMock.mockResolvedValue(llmResponse('maaf saya tidak mengerti'));
    expect(await callAiChatLlm('system', 'user')).toBeNull();
  });
});

// ── tryAiChatReply ──────────────────────────────────────────────

describe('tryAiChatReply', () => {
  it('tanpa API key → null, LLM tidak dipanggil', async () => {
    envState.AI_CHAT_API_KEY = undefined;
    dbState.workspaces = [baseWorkspace()];
    expect(await tryAiChatReply(WORKSPACE_ID, CONVERSATION_ID)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aiEnabled false → null', async () => {
    dbState.workspaces = [baseWorkspace({ aiEnabled: false })];
    expect(await tryAiChatReply(WORKSPACE_ID, CONVERSATION_ID)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('AI aktif tapi knowledge base kosong & tanpa katalog layanan → null', async () => {
    dbState.workspaces = [baseWorkspace({ aiKnowledge: null })];
    expect(await tryAiChatReply(WORKSPACE_ID, CONVERSATION_ID)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('jawaban grounded (intent + source valid) → jawaban AI (ai: true), tanpa needsAttention', async () => {
    dbState.workspaces = [baseWorkspace()];
    dbState.messages = [
      {
        conversationId: CONVERSATION_ID,
        direction: 'inbound',
        content: 'Halo',
        createdAt: new Date('2026-08-01T00:00:00Z'),
      },
      {
        conversationId: CONVERSATION_ID,
        direction: 'inbound',
        content: 'Berapa harga scaling?',
        createdAt: new Date('2026-08-01T00:00:05Z'),
      },
    ];
    fetchMock.mockResolvedValue(llmResponse(groundedAnswer('price_inquiry', 'Scaling 150rb.', 'kb:services')));

    const reply = await tryAiChatReply(WORKSPACE_ID, CONVERSATION_ID);
    expect(reply).toEqual({ text: 'Scaling 150rb.', ai: true });
    // Phase 1 memakai tools (function calling) — tanpa response_format.
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as { tools?: unknown[]; response_format?: unknown };
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.response_format).toBeUndefined();
    // Jawaban grounded → tidak ada handoff (conversations tidak disentuh).
    expect(dbState.conversations ?? []).toHaveLength(0);
  });

  it('source fiktif (tidak ada di retrieval) → handoff + needsAttention', async () => {
    dbState.workspaces = [baseWorkspace()];
    dbState.conversations = [{ id: CONVERSATION_ID, state: null }];
    // Model mengklaim source 'service:999' yang TIDAK pernah di-retrieve.
    fetchMock.mockResolvedValue(
      llmResponse(
        JSON.stringify({
          intent: 'price_inquiry',
          answer: 'Harga treatment Rp500.000.',
          confidence: 0.97,
          needsHuman: false,
          reason: 'price found',
          sources: [{ type: 'knowledge', id: 'service:999' }],
        }),
      ),
    );

    const reply = await tryAiChatReply(WORKSPACE_ID, CONVERSATION_ID);
    expect(reply?.ai).toBe(true);
    expect(reply?.text).toContain('our team');
    const state = dbState.conversations?.[0]?.state as { needsAttention?: boolean };
    expect(state.needsAttention).toBe(true);
  });

  it('intent unknown → handoff + needsAttention (bukan jawaban AI)', async () => {
    dbState.workspaces = [baseWorkspace()];
    dbState.conversations = [{ id: CONVERSATION_ID, state: null }];
    fetchMock.mockResolvedValue(
      llmResponse(
        '{"intent": "unknown", "answer": "Tidak yakin.", "confidence": 0.4, "needsHuman": false, "reason": "out-of-kb"}',
      ),
    );

    const reply = await tryAiChatReply(WORKSPACE_ID, CONVERSATION_ID);
    expect(reply?.ai).toBe(true);
    expect(reply?.text).toContain('our team');
    const state = dbState.conversations?.[0]?.state as { needsAttention?: boolean };
    expect(state.needsAttention).toBe(true);
  });

  it('needsHuman true → handoff + needsAttention walau confidence tinggi', async () => {
    dbState.workspaces = [baseWorkspace()];
    dbState.conversations = [{ id: CONVERSATION_ID, state: null }];
    fetchMock.mockResolvedValue(
      llmResponse('{"intent": "human_request", "answer": "Saya hubungkan dengan tim.", "confidence": 0.9, "needsHuman": true, "reason": "customer-requested-human"}'),
    );

    const reply = await tryAiChatReply(WORKSPACE_ID, CONVERSATION_ID);
    expect(reply?.text).toContain('our team');
    expect((dbState.conversations?.[0]?.state as { needsAttention?: boolean }).needsAttention).toBe(true);
  });

  it('jawaban confidence tinggi TAPI tanpa source → handoff (ungrounded)', async () => {
    dbState.workspaces = [baseWorkspace()];
    dbState.conversations = [{ id: CONVERSATION_ID, state: null }];
    fetchMock.mockResolvedValue(
      llmResponse(
        '{"intent": "price_inquiry", "answer": "Scaling 150rb.", "confidence": 0.97, "needsHuman": false, "reason": "answered-from-kb", "sources": []}',
      ),
    );

    const reply = await tryAiChatReply(WORKSPACE_ID, CONVERSATION_ID);
    expect(reply?.text).toContain('our team');
    expect((dbState.conversations?.[0]?.state as { needsAttention?: boolean }).needsAttention).toBe(true);
  });

  it('LLM gagal (network) → null → caller pakai perilaku lama', async () => {
    dbState.workspaces = [baseWorkspace()];
    fetchMock.mockRejectedValue(new Error('timeout'));
    expect(await tryAiChatReply(WORKSPACE_ID, CONVERSATION_ID)).toBeNull();
  });

  it('LLM jawaban bukan JSON valid → null → fallback lama', async () => {
    dbState.workspaces = [baseWorkspace()];
    fetchMock.mockResolvedValue(llmResponse('maaf saya tidak mengerti'));
    expect(await tryAiChatReply(WORKSPACE_ID, CONVERSATION_ID)).toBeNull();
  });
});
