import type {
  AiIntent,
  AiStructuredOutput,
  ExecutedTool,
  KnowledgeChunk,
} from './ai-types.ts';
import { chunkHasPrice } from './ai-rag.ts';

/**
 * Decision Engine — menentukan apakah jawaban LLM BOLEH dikirim ke customer.
 *
 * Confidence LLM TIDAK lagi menjadi satu-satunya otoritas (masalah lama:
 * model bisa menjawab "harga Rp500.000" dengan confidence 0.97 padahal tidak
 * ada di knowledge base). Keputusan memakai beberapa sinyal:
 *
 *   LLM confidence  +  retrieval relevance  +  source grounding
 *   +  intent support  +  tool result validity  +  risk level
 *
 * Rule:
 *  - needsHuman / human_request / unknown intent → handoff.
 *  - Intent knowledge (faq/service/price/business/policy):
 *      • retrieval harus menghasilkan chunk relevan (hasRelevant),
 *      • setiap source knowledge yang diklaim harus ADA di chunk retrieved
 *        (source fiktif → handoff),
 *      • minimal satu source diklaim (jawaban tanpa dasar → handoff),
 *      • price_inquiry: wajib ada chunk berisi harga di retrieval,
 *      • confidence ≥ minimum sesuai level risiko.
 *  - Intent tool (availability/create/reschedule/cancel/get_customer_bookings):
 *      • tool yang sesuai intent harus dieksekusi DAN sukses,
 *      • setiap source tool yang diklaim harus ada di executed tools,
 *      • confidence ≥ minimum sesuai level risiko.
 *  - Konflik pengetahuan (model mengklaim kontradiksi / tidak konsisten)
 *    → handoff (indikasi awal: reason menyebut contradiction, lihat #reason).
 */

/** Level risiko per intent — menaikkan ambang confidence minimal. */
export type RiskLevel = 'low' | 'medium' | 'high';

const RISK_BY_INTENT: Record<AiIntent, RiskLevel> = {
  faq: 'low',
  business_information: 'low',
  policy_inquiry: 'low',
  service_inquiry: 'medium',
  price_inquiry: 'medium',
  availability_inquiry: 'high',
  create_booking: 'high',
  reschedule_booking: 'high',
  cancel_booking: 'high',
  get_customer_bookings: 'high',
  human_request: 'high',
  unknown: 'high',
};

/** Confidence minimal per risiko — sinyal sekunder, dicek SETELAH grounding. */
const MIN_CONFIDENCE_BY_RISK: Record<RiskLevel, number> = {
  low: 0.5,
  medium: 0.6,
  high: 0.65,
};

/** Intent yang dijawab dari retrieved knowledge (bukan tool). */
const KNOWLEDGE_INTENTS: ReadonlySet<AiIntent> = new Set<AiIntent>([
  'faq',
  'service_inquiry',
  'price_inquiry',
  'business_information',
  'policy_inquiry',
]);

/** Intent yang WAJIB lewat tool backend. */
const TOOL_INTENTS: Record<AiIntent, string> = {
  availability_inquiry: 'get_available_slots',
  create_booking: 'create_booking',
  reschedule_booking: 'reschedule_booking',
  cancel_booking: 'cancel_booking',
  get_customer_bookings: 'get_customer_bookings',
  // Intent lain tidak butuh tool.
  faq: '',
  service_inquiry: '',
  price_inquiry: '',
  business_information: '',
  policy_inquiry: '',
  human_request: '',
  unknown: '',
};

export interface DecisionInput {
  output: AiStructuredOutput;
  /** Chunk retrieved untuk query ini (tenant-scoped). */
  retrieved: KnowledgeChunk[];
  /** Tool yang benar-benar dieksekusi backend pada pipeline ini. */
  executedTools: ExecutedTool[];
}

export type Decision =
  | { allow: true; reply: string; risk: RiskLevel }
  | { allow: false; reason: string };

/** Set id chunk retrieved (untuk grounding). */
function retrievedIds(chunks: KnowledgeChunk[]): Set<string> {
  return new Set(chunks.map((chunk) => chunk.id));
}

/** Set nama tool yang sukses dieksekusi. */
function executedToolNames(tools: ExecutedTool[]): Set<string> {
  return new Set(tools.filter((tool) => tool.ok).map((tool) => tool.name));
}

/** Semua booking id hasil tool yang sukses (grounding booking claims). */
function executedBookingIds(tools: ExecutedTool[]): Set<string> {
  const ids = new Set<string>();
  for (const tool of tools) {
    if (!tool.ok) continue;
    for (const id of tool.bookingIds ?? []) ids.add(id);
  }
  return ids;
}

/** Validasi setiap source yang diklaim LLM terhadap fakta backend. */
function validateSources(input: DecisionInput): string | null {
  const { output, retrieved, executedTools } = input;
  const knownChunks = retrievedIds(retrieved);
  const knownTools = executedToolNames(executedTools);
  const knownBookings = executedBookingIds(executedTools);

  for (const source of output.sources) {
    if (source.type === 'knowledge') {
      if (!source.id || !knownChunks.has(source.id)) {
        return `source knowledge fiktif: ${source.id ?? '(tanpa id)'}`;
      }
    } else {
      if (!source.name || !knownTools.has(source.name)) {
        return `source tool tidak dieksekusi: ${source.name ?? '(tanpa nama)'}`;
      }
      // Booking id yang diklaim (dalam id source) harus dari hasil tool nyata.
      if (source.id && !knownBookings.has(source.id)) {
        return `booking id fiktif: ${source.id}`;
      }
    }
  }
  return null;
}

/**
 * Keputusan akhir: boleh kirim jawaban AI, atau handoff (dengan alasan untuk
 * logging — alasan tidak pernah berisi data customer).
 */
export function decideAiReply(input: DecisionInput): Decision {
  const { output, retrieved, executedTools } = input;

  // 1. Sinyal eksplisit dari LLM — selalu dihormati.
  if (output.needsHuman) return { allow: false, reason: 'needs-human' };
  if (output.intent === 'human_request') return { allow: false, reason: 'human-request' };
  if (output.intent === 'unknown') return { allow: false, reason: 'unknown-intent' };

  // 2. Kontradiksi yang dilaporkan model → jangan paksa jawab.
  if (/contradict/i.test(output.reason)) return { allow: false, reason: 'knowledge-contradiction' };

  const risk = RISK_BY_INTENT[output.intent];

  // 3. Intent knowledge tanpa konteks relevan → handoff (sebelum grounding —
  //    tidak mungkin ground source terhadap retrieval kosong).
  if (KNOWLEDGE_INTENTS.has(output.intent) && retrieved.length === 0) {
    return { allow: false, reason: 'no-relevant-knowledge' };
  }

  // 4. Intent tool → tool WAJIB dieksekusi & sukses (jangan pernah menebak
  //    slot/booking dari jawaban LLM).
  const requiredTool = TOOL_INTENTS[output.intent];
  if (requiredTool) {
    const executed = executedTools.find((tool) => tool.name === requiredTool);
    if (!executed) return { allow: false, reason: `tool-${requiredTool}-not-executed` };
    if (!executed.ok) return { allow: false, reason: `tool-${requiredTool}-failed` };
  }

  // 5. Grounding — source fiktif / tidak tervalidasi → handoff.
  const sourceError = validateSources(input);
  if (sourceError) return { allow: false, reason: sourceError };

  // 6. Intent knowledge → grounding knowledge (minimal satu source valid).
  if (KNOWLEDGE_INTENTS.has(output.intent)) {
    if (output.sources.length === 0) return { allow: false, reason: 'ungrounded-answer' };
    // price_inquiry tanpa chunk berharga → tidak boleh menyebut harga.
    if (output.intent === 'price_inquiry' && !retrieved.some(chunkHasPrice)) {
      return { allow: false, reason: 'no-price-source' };
    }
  }

  // 7. Confidence — sinyal SEKUNDER (hanya setelah grounding/tool lolos).
  const minConfidence = MIN_CONFIDENCE_BY_RISK[risk];
  if (output.confidence < minConfidence) {
    return { allow: false, reason: 'low-confidence' };
  }

  return { allow: true, reply: output.answer, risk };
}
