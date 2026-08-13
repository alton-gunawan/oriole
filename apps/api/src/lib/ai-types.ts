/**
 * Tipe bersama pipeline AI Booking Agent (WhatsApp).
 *
 * Semua modul AI (rag, schema, decision, tools, agent) berbagi kontrak di
 * sini agar satu sama lain tidak saling tahu struktur internal. Kontrak
 * output LLM, state booking chat, dan hasil tool didefinisikan di sini —
 * diuji unit di ai-schema.test.ts / ai-decision.test.ts.
 */

/** Intent yang dikenali pipeline — menentukan routing (RAG vs tools vs handoff). */
export const AI_INTENTS = [
  // Knowledge intents → jawab dari retrieved knowledge (tenant-scoped).
  'faq',
  'service_inquiry',
  'price_inquiry',
  'business_information',
  'policy_inquiry',
  // Tool intents → jalankan booking tool (live backend), jangan menebak.
  'availability_inquiry',
  'create_booking',
  'reschedule_booking',
  'cancel_booking',
  'get_customer_bookings',
  // Handoff.
  'human_request',
  'unknown',
] as const;

export type AiIntent = (typeof AI_INTENTS)[number];

/** Sumber jawaban yang diklaim LLM — divalidasi backend (grounding). */
export interface AiSource {
  /** 'knowledge' = chunk retrieved (tenant-scoped), 'tool' = tool yang dieksekusi. */
  type: 'knowledge' | 'tool';
  /** Id chunk knowledge (mis. 'kb:services', 'service:<uuid>') — wajib untuk type knowledge. */
  id?: string;
  /** Nama tool (mis. 'check_availability') — wajib untuk type tool. */
  name?: string;
}

/** Output terstruktur LLM (fase akhir) — divalidasi ketat di ai-schema.ts. */
export interface AiStructuredOutput {
  intent: AiIntent;
  answer: string;
  /** 0..1 — sinyal LLM; BUKAN satu-satunya otoritas (lihat ai-decision.ts). */
  confidence: number;
  needsHuman: boolean;
  reason: string;
  sources: AiSource[];
}

/** Knowledge chunk hasil retrieval — tenant-scoped (dibangun dari data workspace). */
export interface KnowledgeChunk {
  /** Id stabil untuk grounding (mis. 'kb:services', 'service:<uuid>'). */
  id: string;
  type: 'description' | 'services' | 'hours' | 'location' | 'policy' | 'faq' | 'service';
  /** Teks yang dikirim ke LLM (relevan saja, bukan seluruh KB). */
  content: string;
  /** Skor relevansi (0..) — dipakai pengurutan & threshold retrieval. */
  score: number;
  /** Id entitas katalog (untuk type 'service') — dipakai grounding + validasi tenant. */
  serviceId?: string;
}

/** Hasil retrieval untuk satu query. */
export interface RetrievalResult {
  /** Chunk relevan teratas (sudah diurutkan, tenant workspace ini saja). */
  chunks: KnowledgeChunk[];
  /** Jumlah chunk yang diberi skor > 0 (relevansi non-nol). */
  relevantCount: number;
  /** Apakah ada chunk relevan (skor di atas ambang). */
  hasRelevant: boolean;
}

/**
 * State booking terstruktur per percakapan — disimpan di
 * `conversations.state.ai` (namespaced agar tidak mengganggu `step` /
 * `needsAttention` yang sudah dipakai state machine existing).
 * History chat tetap dipakai, tetapi fakta booking yang sudah diketahui
 * TIDAK ditebak ulang LLM — dibaca dari sini.
 */
export interface BookingChatState {
  intent?: AiIntent;
  serviceId?: string | null;
  staffId?: string | null;
  /** Tanggal lokal YYYY-MM-DD. */
  date?: string;
  /** Preferensi waktu (HH:MM) atau bebas ('sore', 'setelah jam 3'). */
  timePreference?: string;
  customerName?: string;
}

/** Hasil satu tool yang dieksekusi backend — bahan grounding & decision engine. */
export interface ExecutedTool {
  name: string;
  ok: boolean;
  /** Error singkat (aman-log) bila gagal — tanpa data customer. */
  error?: string;
  /** Id booking yang dibuat/diubah/dibatalkan (bila relevan) — grounding. */
  bookingIds?: string[];
  /** Data pokok hasil (slots, service, dll) — aman log, tanpa PII. */
  summary?: Record<string, unknown>;
}

/** Konteks satu permintaan AI (tanpa plaintext pesan — hanya metadata). */
export interface AiRequestMeta {
  tenantId: string;
  conversationId: string;
  requestId: string;
  language?: 'en' | 'id';
}
