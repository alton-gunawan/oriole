import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  renderAiHandoffReply,
  type BotLanguage,
} from '@oriole/messaging';
import { conversations, messages, workspaces, type AiKnowledge } from '@oriole/database';

import { db } from '../db/index.ts';
import { env } from './env.ts';
import { decryptMessageContent } from './message-encryption.ts';
import { loadServices } from './service-catalog.ts';
import { retrieveKnowledge } from './ai-rag.ts';
import type { KnowledgeChunk } from './ai-types.ts';
import { parseAiStructuredOutput } from './ai-schema.ts';
import { decideAiReply } from './ai-decision.ts';
import { buildAiBookingTools, executeAiTool, type AiToolContext } from './ai-tools.ts';
import { logAiEvent } from './ai-log.ts';
import type {
  AiIntent,
  AiRequestMeta,
  AiStructuredOutput,
  BookingChatState,
  ExecutedTool,
} from './ai-types.ts';

/* ────────────────────────────────────────────────────────────
 * AI Booking Agent WhatsApp — Q&A knowledge base + booking tools
 *
 * Pipeline (semua logika LLM terisolasi di sini — handler WhatsApp hanya
 * memanggil `tryAiChatReply`):
 *
 *   pesan → guards (key, aiEnabled, ada knowledge/katalog)
 *        → retrieval tenant-scoped (HANYA konteks relevan, bukan seluruh KB)
 *        → phase 1 LLM + tools (Groq function calling — tanpa JSON mode,
 *          karena Groq menolak kombinasi keduanya; hasil tool dieksekusi
 *          BACKEND, LLM tidak pernah mengarang)
 *        → phase 2 LLM JSON mode (output terstruktur + sources)
 *        → validasi skema backend (ai-schema)
 *        → Decision Engine (grounding + tool + confidence + intent + risiko)
 *        → balas AI / handoff
 *
 * Setiap kegagalan (tanpa key, LLM down, parse gagal, tool gagal, timeout)
 * → `null` → caller jatuh ke perilaku lama (handoff staf). AI TIDAK pernah
 * membuat WhatsApp error.
 * ──────────────────────────────────────────────────────────── */

/** Budget total panggilan LLM (ms) — jauh di bawah batas webhook 360dialog. */
const AI_CHAT_TIMEOUT_MS = 8_000;

/**
 * Konfigurasi retry LLM (objek diekspor agar test bisa menyetel jeda = 0).
 * Total panggilan ≤ `maxAttempts`, semua dalam budget `AI_CHAT_TIMEOUT_MS`.
 * Retry hanya untuk kegagalan transien: HTTP 429 (rate limit), 5xx, dan
 * error network/timeout. 4xx lain → gagal langsung.
 */
export const aiChatRetryConfig: { maxAttempts: number; delaysMs: number[] } = {
  maxAttempts: 3,
  delaysMs: [300, 700],
};

/** Jumlah pesan terakhir yang dikirim sebagai konteks ke LLM. */
const AI_CONTEXT_MESSAGES = 10;

/** Balasan AI siap kirim — `ai: true` menandai pesan AI di inbox (metadata). */
export interface AiChatReply {
  text: string;
  /** true = balasan hasil pipeline AI (jawaban ATAU handoff) — metadata ai:true. */
  ai?: boolean;
}

/** Hasil ter-parse dari LLM (kontrak legacy — lihat parseAiLlmResult). */
export interface AiLlmResult {
  answer: string;
  confidence: number;
  needsHuman: boolean;
  reason: string;
}

/** Raw hasil panggilan LLM (mendukung tool_calls). */
export interface LlmCallResult {
  content?: string;
  toolCalls?: LlmToolCall[];
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
}

/** Tool call dari provider (Groq/OpenAI shape) → bentuk datar pipeline. */
function normalizeToolCalls(
  calls: { id?: string; function?: { name?: string; arguments?: string } }[] | undefined,
): LlmToolCall[] {
  return (calls ?? [])
    .filter((call) => call.function?.name)
    .map((call) => ({
      id: call.id ?? '',
      name: call.function?.name ?? '',
      arguments: call.function?.arguments ?? '',
    }));
}

/**
 * Inti panggilan LLM OpenAI-compatible dengan retry terbatas + budget keras.
 * Mendukung `tools` (function calling — phase 1) dan `response_format`
 * (JSON mode — phase 2), TIDAK keduanya sekaligus (Groq menolak kombinasi).
 * Kegagalan apa pun → null (fallback aman), tidak pernah throw.
 */
async function callLlmCore(options: {
  messages: LlmMessage[];
  tools?: unknown[];
  responseFormat?: 'json_object';
  budgetMs?: number;
}): Promise<LlmCallResult | null> {
  const baseUrl = env.AI_CHAT_BASE_URL.replace(/\/+$/, '');
  const budget = options.budgetMs ?? AI_CHAT_TIMEOUT_MS;
  const deadline = Date.now() + budget;

  let lastStatus = 0;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < aiChatRetryConfig.maxAttempts; attempt++) {
    const remaining = deadline - Date.now();
    // Retry/sleep TIDAK dilakukan bila sisa waktu tidak cukup — stop, null.
    if (remaining <= 0) break;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    let retryAfterMs = 0;

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.AI_CHAT_API_KEY ?? ''}`,
        },
        body: JSON.stringify({
          model: env.AI_CHAT_MODEL,
          messages: options.messages,
          ...(options.tools ? { tools: options.tools } : {}),
          ...(options.responseFormat ? { response_format: { type: options.responseFormat } } : {}),
          temperature: 0.3,
          max_tokens: 400,
        }),
        signal: controller.signal,
      });

      if (response.ok) {
        const data = (await response.json()) as {
          choices?: {
            message?: {
              content?: string | null;
              tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
            };
          }[];
        };
        const message = data.choices?.[0]?.message;
        if (!message) return null;
        const toolCalls = normalizeToolCalls(message.tool_calls);
        return {
          ...(message.content ? { content: message.content } : {}),
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
        };
      }

      lastStatus = response.status;
      const body = await response.text().catch(() => '');
      console.warn(
        `[ai-chat] LLM HTTP ${response.status} (percobaan ${attempt + 1}/${aiChatRetryConfig.maxAttempts}): ${body.slice(0, 300)}`,
      );
      // 4xx selain 429 tidak akan berhasil diulang → gagal segera.
      if (response.status !== 429 && response.status < 500) return null;
      // 429: hormati header retry-after (detik) bila dikirim provider.
      const retryAfter = response.headers?.get?.('retry-after');
      if (response.status === 429 && retryAfter) {
        const seconds = Number.parseFloat(retryAfter);
        if (Number.isFinite(seconds) && seconds > 0) retryAfterMs = seconds * 1000;
      }
    } catch (error) {
      lastError = error;
      console.warn(
        `[ai-chat] Panggilan LLM gagal (percobaan ${attempt + 1}/${aiChatRetryConfig.maxAttempts}): ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    // Jeda antar percobaan — dibatasi agar tidak melewati deadline.
    const delay = Math.max(aiChatRetryConfig.delaysMs[attempt] ?? 0, retryAfterMs);
    const sleepMs = Math.min(delay, Math.max(0, deadline - Date.now()));
    if (sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }

  if (lastStatus) {
    console.warn(`[ai-chat] LLM menyerah setelah ${aiChatRetryConfig.maxAttempts} percobaan (HTTP terakhir ${lastStatus})`);
  } else if (lastError) {
    console.warn(
      `[ai-chat] LLM menyerah setelah ${aiChatRetryConfig.maxAttempts} percobaan: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  } else {
    console.warn(`[ai-chat] LLM menyerah: budget ${budget} ms habis`);
  }
  return null;
}

/**
 * Panggil LLM JSON mode (fase akhir — output terstruktur). Kontrak lama
 * dipertahankan: hasil di-parse via parseAiLlmResult (lenient). `budgetMs`
 * opsional agar phase 1 + phase 2 berbagi budget 8 s total.
 */
export async function callAiChatLlm(
  system: string,
  user: string,
  budgetMs?: number,
): Promise<AiLlmResult | null> {
  const raw = await callLlmCore({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    responseFormat: 'json_object',
    budgetMs,
  });
  if (!raw?.content) return null;
  return parseAiLlmResult(raw.content);
}

/** Panggil LLM dengan tools (phase 1) — tanpa JSON mode (Groq menolak kombinasi). */
export async function callAiChatLlmWithTools(
  system: string,
  user: string,
  tools: unknown[],
  budgetMs?: number,
): Promise<LlmCallResult | null> {
  return callLlmCore({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    tools,
    budgetMs,
  });
}

/**
 * Panggil LLM JSON mode → raw CONTENT (belum di-parse). Dipakai pipeline saat
 * butuh output terstruktur (intent + sources) — `callAiChatLlm` mengembalikan
 * kontrak legacy yang sudah di-parse, tidak bisa di-parse ulang.
 */
export async function callAiChatLlmRawContent(
  system: string,
  user: string,
  budgetMs?: number,
): Promise<string | null> {
  const raw = await callLlmCore({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    responseFormat: 'json_object',
    budgetMs,
  });
  return raw?.content ?? null;
}

/**
 * Parse jawaban LLM JSON → AiLlmResult (kontrak LEGACY — tanpa intent/sources,
 * dipakai callAiChatLlm & test lama). Pipeline baru memakai
 * `parseAiStructuredOutput` (ketat, dengan intent + sources).
 */
export function parseAiLlmResult(content: string): AiLlmResult | null {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    if (typeof parsed.answer !== 'string' || parsed.answer.trim().length === 0) return null;
    const confidence =
      typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
        ? Math.min(1, Math.max(0, parsed.confidence))
        : 0;
    return {
      answer: parsed.answer.trim(),
      confidence,
      needsHuman: parsed.needsHuman === true,
      reason: typeof parsed.reason === 'string' ? parsed.reason : 'unknown',
    };
  } catch {
    return null;
  }
}

/** Knowledge base dianggap terisi bila minimal satu bagian non-kosong. */
export function hasAiKnowledge(knowledge: AiKnowledge | null): boolean {
  if (!knowledge) return false;
  return Boolean(
    knowledge.description?.trim() ||
      knowledge.services?.trim() ||
      knowledge.hours?.trim() ||
      knowledge.location?.trim() ||
      knowledge.policy?.trim() ||
      (knowledge.faq && knowledge.faq.length > 0),
  );
}

/* ────────────────────────────────────────────────────────────
 * Prompt — context berlapis (system instructions / retrieved
 * knowledge / booking state / tool results / history / message)
 * ──────────────────────────────────────────────────────────── */

export interface AiChatPromptInput {
  businessName: string;
  industry: string | null;
  language?: 'en' | 'id';
  /** Konteks knowledge yang RELEVAN hasil retrieval — bukan seluruh KB. */
  knowledgeContext?: string | null;
  /** State booking terstruktur (dari conversations.state.ai). */
  bookingState?: BookingChatState | null;
  /** Riwayat percakapan (dibatasi). */
  history?: { direction: string; content: string }[];
  /** Pesan terbaru customer (fallback: pesan terakhir history). */
  userMessage?: string;
  /** Hasil tool (fase akhir) — data live dari backend. */
  toolResults?: string | null;
}

/** Render chunk retrieved → blok konteks untuk prompt (dengan id untuk grounding). */
export function renderKnowledgeContext(chunks: KnowledgeChunk[]): string {
  if (chunks.length === 0) return '';
  return chunks.map((chunk) => `- (${chunk.id}) ${chunk.content}`).join('\n');
}

/** Render state booking terstruktur → blok konteks. */
export function renderBookingState(state: BookingChatState): string {
  const lines: string[] = [];
  if (state.serviceId) lines.push(`Layanan: ${state.serviceId}`);
  if (state.date) lines.push(`Tanggal: ${state.date}`);
  if (state.timePreference) lines.push(`Waktu: ${state.timePreference}`);
  if (state.customerName) lines.push(`Nama customer: ${state.customerName}`);
  if (state.intent) lines.push(`Intent sebelumnya: ${state.intent}`);
  return lines.length > 0 ? lines.join('\n') : 'Tidak ada data booking yang tersimpan.';
}

/** Render hasil tool → blok konteks fase akhir (data live, bukan tebakan). */
export function renderToolResults(tools: ExecutedTool[]): string {
  return tools
    .map((tool) =>
      tool.ok
        ? `TOOL ${tool.name} → ${JSON.stringify(tool.summary ?? {})}`
        : `TOOL ${tool.name} → ERROR: ${tool.error ?? 'gagal'}`,
    )
    .join('\n');
}

/**
 * Prompt builder (murni — diuji unit). System prompt berisi identitas bisnis +
 * aturan keras anti-halusinasi + konteks knowledge RELEVAN + state booking;
 * user prompt berisi riwayat + pesan terbaru + (opsional) hasil tool.
 */
export function buildAiChatPrompt(input: AiChatPromptInput): { system: string; user: string } {
  const { businessName, industry, language = 'en' } = input;
  const id = language === 'id';

  const sections = [
    `Kamu adalah asisten WhatsApp ${businessName}${industry ? ` (${industry})` : ''}.`,
    '',
    'TUGAS: menjawab pertanyaan customer tentang layanan, harga, jam buka, lokasi, kebijakan, dan membantu proses booking — HANYA dari konteks yang diberikan di bawah.',
    '',
    'ATURAN SUMBER DATA (anti-halusinasi):',
    '1. Informasi bisnis (harga, layanan, durasi, jam buka, lokasi, kebijakan) HANYA boleh berasal dari bagian "KONTEKS KNOWLEDGE" di bawah. JANGAN pernah mengarang atau menebak.',
    '2. Informasi live (slot tersedia, jadwal staf, status/daftar booking customer) HANYA boleh berasal dari hasil tool. JANGAN pernah menebak ketersediaan atau mengonfirmasi booking tanpa tool.',
    '3. Bila informasi yang dibutuhkan tidak tersedia di konteks/tool → JANGAN menebak; ajukan pertanyaan klarifikasi, atau set needsHuman=true.',
    '4. Jangan pernah mengarang: harga, nama layanan, durasi, jam buka, lokasi, kebijakan, ketersediaan staf/booking, konfirmasi booking, atau id booking.',
    '',
    'ATURAN PERILAKU:',
    '5. ' + (id ? 'Bahasa Indonesia santai tapi sopan; jawaban singkat (maksimal 3 kalimat).' : 'Friendly, concise English; keep answers short (max 3 sentences).'),
    '6. Jangan pernah menyebut bahwa Anda AI/bot/model.',
    '7. Untuk membuat booking: kumpulkan layanan, tanggal, jam (dari hasil cek slot), dan pastikan customer setuju SEBELUM membuat/mengubah/membatalkan booking. Nomor telepon sudah diketahui — jangan ditanyakan.',
    '8. Customer meminta manusia / marah / di luar kemampuan → needsHuman=true.',
    '',
    'OUTPUT:',
    '9. Bila pertanyaan butuh data live → panggil tool yang tersedia. Bila tidak → balas SATU objek JSON:',
    '   {"intent":"...","answer":"...","confidence":0-1,"needsHuman":false,"reason":"...","sources":[{"type":"knowledge","id":"..."}]}',
    '   intent ∈ {faq, service_inquiry, price_inquiry, business_information, policy_inquiry, availability_inquiry, create_booking, reschedule_booking, cancel_booking, get_customer_bookings, human_request, unknown}',
    '   sources: id chunk yang benar-benar dipakai (dari KONTEKS KNOWLEDGE, mis. kb:services / service:<id>) atau tool yang dipanggil ({"type":"tool","name":"..."}). JANGAN membuat id fiktif.',
    '10. Kalau ragu / tidak ada konteks relevan → confidence rendah + needsHuman=true.',
  ];

  if (input.knowledgeContext) {
    sections.push('', 'KONTEKS KNOWLEDGE (relevan):', input.knowledgeContext);
  }
  if (input.bookingState) {
    sections.push('', 'STATUS BOOKING SAAT INI:', renderBookingState(input.bookingState));
  }
  if (input.toolResults) {
    sections.push('', 'HASIL TOOL (data live — sumber kebenaran untuk info booking):', input.toolResults);
  }

  const system = sections.join('\n');

  const history = input.history ?? [];
  const userLines = history.map(
    (message) => `${message.direction === 'inbound' ? 'Customer' : 'Staf'}: ${message.content}`,
  );
  const latest = input.userMessage ?? history[history.length - 1]?.content ?? '';
  if (latest && userLines[userLines.length - 1] !== `Customer: ${latest}`) {
    userLines.push(`Customer: ${latest}`);
  }
  const user = userLines.join('\n') || '(belum ada pesan)';

  return { system, user };
}

/* ────────────────────────────────────────────────────────────
 * Helpers DB
 * ──────────────────────────────────────────────────────────── */

async function loadWorkspace(workspaceId: string) {
  const [row] = await db
    .select({
      name: workspaces.name,
      industry: workspaces.industry,
      aiEnabled: workspaces.aiEnabled,
      aiKnowledge: workspaces.aiKnowledge,
      updatedAt: workspaces.updatedAt,
    })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)))
    .limit(1);
  return row;
}

async function loadRecentMessages(conversationId: string, workspaceId: string) {
  const rows = await db
    .select({ direction: messages.direction, content: messages.content })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(AI_CONTEXT_MESSAGES);
  // Balik ke kronologis (terbaru di akhir = pertanyaan customer saat ini).
  return rows.reverse().map((row) => ({
    direction: row.direction,
    content: decryptMessageContent(workspaceId, row.content),
  }));
}

/** Baca state booking terstruktur dari conversations.state.ai (namespaced). */
function readBookingState(state: Record<string, unknown> | null | undefined): BookingChatState {
  const ai = (state?.ai ?? {}) as Record<string, unknown>;
  return {
    intent: typeof ai.intent === 'string' ? (ai.intent as AiIntent) : undefined,
    serviceId: typeof ai.serviceId === 'string' || ai.serviceId === null ? (ai.serviceId as string | null) : undefined,
    staffId: typeof ai.staffId === 'string' || ai.staffId === null ? (ai.staffId as string | null) : undefined,
    date: typeof ai.date === 'string' ? ai.date : undefined,
    timePreference: typeof ai.timePreference === 'string' ? ai.timePreference : undefined,
    customerName: typeof ai.customerName === 'string' ? ai.customerName : undefined,
  };
}

/** Persist state booking + needsAttention — merge, tidak menimpa `step`/key lain. */
async function persistConversationState(
  conversationId: string,
  next: { ai?: BookingChatState; needsAttention?: boolean },
): Promise<void> {
  const [row] = await db
    .select({ state: conversations.state })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  const current = (row?.state ?? {}) as Record<string, unknown>;
  const state: Record<string, unknown> = { ...current };
  if (next.ai) state.ai = next.ai;
  if (next.needsAttention !== undefined) state.needsAttention = next.needsAttention;
  await db
    .update(conversations)
    .set({ state, updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));
}

/** Intent yang menyimpan/mutasi booking → state.ai dipertahankan antar pesan. */
const BOOKING_STATE_INTENTS = new Set<AiIntent>([
  'availability_inquiry',
  'create_booking',
  'reschedule_booking',
  'cancel_booking',
  'get_customer_bookings',
]);

/* ────────────────────────────────────────────────────────────
 * Orchestration — tryAiChatReply
 * ──────────────────────────────────────────────────────────── */

export interface AiChatOpts {
  /** Nomor HP customer (wa_id) — disuntikkan server-side untuk tool booking. */
  customerPhone?: string | null;
  customerName?: string | null;
  /** `conversations.state` saat ini (untuk state booking terstruktur). */
  state?: Record<string, unknown> | null;
  /** Id pesan masuk (wamid) — idempotensi create_booking terhadap retry. */
  providerEventId?: string;
}

/** Ekstrak fakta booking dari tool yang dieksekusi → state booking. */
function extractBookingStateFromTools(
  tools: ExecutedTool[],
  ctx: AiToolContext,
): Partial<BookingChatState> {
  const state: Partial<BookingChatState> = {};
  for (const tool of tools) {
    if (!tool.ok) continue;
    const result = (tool.summary ?? {}) as Record<string, unknown>;
    if (typeof result.serviceId === 'string') state.serviceId = result.serviceId as string;
    if (typeof result.date === 'string') state.date = result.date as string;
    if (typeof result.time === 'string') state.timePreference = result.time as string;
    if (typeof result.customerName === 'string') state.customerName = result.customerName as string;
  }
  if (ctx.customerName && !state.customerName) state.customerName = ctx.customerName;
  return state;
}

/**
 * Coba jawab pesan bebas dengan AI Booking Agent (RAG + tools).
 *
 * Return:
 * - `null` → AI tidak aktif / tidak ada data / LLM gagal → caller pakai
 *   perilaku lama (handoff staf + info bisnis). Tidak pernah throw.
 * - `{ text, ai: true }` → jawaban AI (grounded), kirim ke customer.
 * - `{ text, ai: true }` (handoff) → AI tidak yakin / butuh manusia; state
 *   sudah ditandai needsAttention, text = renderAiHandoffReply.
 */
export async function tryAiChatReply(
  workspaceId: string,
  conversationId: string,
  language: BotLanguage = 'en',
  opts: AiChatOpts = {},
): Promise<AiChatReply | null> {
  const startedAt = Date.now();
  const requestId = randomUUID();
  const meta: AiRequestMeta = {
    tenantId: workspaceId,
    conversationId,
    requestId,
    language: language === 'id' ? 'id' : 'en',
  };
  const lang: 'en' | 'id' = language === 'id' ? 'id' : 'en';

  const log = (fields: Parameters<typeof logAiEvent>[1]) => logAiEvent(meta, fields);

  // Guard 1: tanpa key → AI mati total (perilaku lama).
  if (!env.AI_CHAT_API_KEY) return null;

  try {
    // Guard 2: workspace aktif + AI enabled + ada knowledge ATAU katalog layanan.
    const [workspace, services] = await Promise.all([loadWorkspace(workspaceId), loadServices(workspaceId)]);
    if (!workspace?.aiEnabled) return null;
    if (!hasAiKnowledge(workspace.aiKnowledge as AiKnowledge | null) && !services.some((s) => s.isActive)) {
      return null;
    }

    const history = await loadRecentMessages(conversationId, workspaceId);
    const userMessage = history[history.length - 1]?.content ?? '';
    const bookingState = readBookingState(opts.state);

    // Retrieval tenant-scoped — HANYA konteks relevan (bukan seluruh KB).
    const retrieval = await retrieveKnowledge({
      tenantId: workspaceId,
      query: userMessage,
      knowledge: (workspace.aiKnowledge as AiKnowledge | null) ?? null,
      services,
    });

    const deadline = startedAt + AI_CHAT_TIMEOUT_MS;
    const remainingBudget = () => Math.max(0, deadline - Date.now());
    const toolCtx: AiToolContext = {
      workspaceId,
      conversationId,
      customerPhone: opts.customerPhone,
      customerName: opts.customerName ?? bookingState.customerName,
      providerEventId: opts.providerEventId,
      language: lang,
    };

    const tools = buildAiBookingTools(lang);
    const basePrompt = {
      businessName: workspace.name,
      industry: workspace.industry,
      language: lang,
      knowledgeContext: renderKnowledgeContext(retrieval.chunks),
      bookingState,
      history,
      userMessage,
    };

    // ── Phase 1: LLM + tools (function calling, tanpa JSON mode) ──
    const phase1 = buildAiChatPrompt(basePrompt);
    const raw = await callAiChatLlmWithTools(phase1.system, phase1.user, tools, remainingBudget());
    if (!raw) {
      log({ failureReason: 'llm-unavailable', latencyMs: Date.now() - startedAt });
      return null;
    }

    let output: AiStructuredOutput | null = null;
    const executedTools: ExecutedTool[] = [];

    if (raw.toolCalls && raw.toolCalls.length > 0) {
      // Backend mengeksekusi tool — LLM hanya meminta action.
      for (const call of raw.toolCalls) {
        const outcome = await executeAiTool(toolCtx, call.name, call.arguments);
        executedTools.push({
          name: call.name,
          ok: outcome.ok,
          error: outcome.ok ? undefined : outcome.error,
          bookingIds: outcome.ok ? (outcome.bookingIds ?? []) : undefined,
          summary: outcome.ok ? outcome.result : undefined,
        });
        // Tool gagal → hentikan rantai (hindari aksi lanjutan di atas data rusak).
        if (!outcome.ok) break;
      }

      // ── Phase 2: LLM JSON mode dengan hasil tool → output terstruktur ──
      const phase2 = buildAiChatPrompt({
        ...basePrompt,
        toolResults: renderToolResults(executedTools),
      });
      const finalContent = await callAiChatLlmRawContent(phase2.system, phase2.user, remainingBudget());
      output = finalContent ? parseAiStructuredOutput(finalContent) : null;
      if (!output) {
        log({
          intent: executedTools[0]?.name,
          toolUsed: executedTools[0]?.name,
          retrievalCount: retrieval.chunks.length,
          failureReason: 'llm-structured-parse-failed',
          latencyMs: Date.now() - startedAt,
        });
        return null;
      }
    } else if (raw.content) {
      output = parseAiStructuredOutput(raw.content);
      if (!output) {
        // Jawaban tanpa tools tapi bukan JSON valid → minta format ulang (JSON mode).
        const retry = await callAiChatLlmRawContent(
          phase1.system,
          `${phase1.user}\n\nFormat ulang jawabanmu sebagai SATU objek JSON sesuai skema output.`,
          remainingBudget(),
        );
        output = retry ? parseAiStructuredOutput(retry) : null;
      }
    }

    if (!output) {
      log({ failureReason: 'llm-empty', latencyMs: Date.now() - startedAt });
      return null;
    }

    // ── Decision Engine — confidence BUKAN satu-satunya otoritas ──
    const decision = decideAiReply({
      output,
      retrieved: retrieval.chunks,
      executedTools,
    });

    // State booking terstruktur — simpan hanya bila relevan (intent booking
    // atau ada fakta booking baru); jangan menimpa step/needsAttention lama.
    const nextAi: BookingChatState | undefined = (() => {
      const extracted = extractBookingStateFromTools(executedTools, toolCtx);
      // Persist hanya bila intent booking ATAU ada fakta booking baru
      // (customerName saja tidak cukup — jangan menulis state untuk FAQ).
      const hasBookingFacts = Object.entries(extracted).some(
        ([key, value]) => key !== 'customerName' && value !== undefined,
      );
      if (BOOKING_STATE_INTENTS.has(output.intent) || hasBookingFacts) {
        return {
          ...bookingState,
          ...extracted,
          intent: output.intent,
        };
      }
      return undefined;
    })();

    if (decision.allow) {
      if (nextAi) await persistConversationState(conversationId, { ai: nextAi });
      log({
        decision: 'allow',
        intent: output.intent,
        risk: decision.risk,
        retrievalCount: retrieval.chunks.length,
        toolUsed: executedTools[0]?.name,
        llmModel: env.AI_CHAT_MODEL,
        latencyMs: Date.now() - startedAt,
      });
      return { text: output.answer, ai: true };
    }

    // Handoff — pertahankan fallback existing (needsAttention + pesan handoff).
    await persistConversationState(conversationId, { ai: nextAi, needsAttention: true });
    log({
      decision: 'handoff',
      intent: output.intent,
      handoff: true,
      failureReason: decision.reason,
      retrievalCount: retrieval.chunks.length,
      toolUsed: executedTools[0]?.name,
      latencyMs: Date.now() - startedAt,
    });
    return { text: renderAiHandoffReply(lang), ai: true };
  } catch (error) {
    // Kegagalan apa pun (DB, tool, unexpected) → fallback aman, TIDAK throw.
    console.warn(`[ai-chat] Pipeline gagal: ${error instanceof Error ? error.message : String(error)}`);
    log({ handoff: true, failureReason: 'pipeline-error', latencyMs: Date.now() - startedAt });
    return null;
  }
}
