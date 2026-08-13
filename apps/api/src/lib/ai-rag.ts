import { and, eq, isNull } from 'drizzle-orm';
import { workspaces, type AiKnowledge } from '@oriole/database';

import { db } from '../db/index.ts';
import type { KnowledgeChunk, RetrievalResult } from './ai-types.ts';
import { loadServices, type ServiceSnapshot } from './service-catalog.ts';

/**
 * Retrieval RAG ringan — tenant-scoped, tanpa vector store.
 *
 * Kenapa bukan pgvector / vector DB:
 *  - Knowledge base disimpan sebagai JSONB kecil di `workspaces.ai_knowledge`
 *    + katalog `services` — keduanya sudah tenant-scoped by design.
 *  - Vector search butuh embedding provider; Groq (LLM default) tidak punya
 *    endpoint embeddings, dan menambah DB/ekstensi baru tanpa kebutuhan nyata
 *    melanggar batasan "prefer pgvector jika memungkinkan / tanpa kebutuhan
 *    jangan tambah database baru".
 *  - Retrieval memakai lexical ranking (token overlap + boost per tipe chunk)
 *    atas chunk yang dibangun dari sumber kebenaran — murni, deterministik,
 *    dan sangat cepat (<1 ms), sehingga tidak menambah latensi pipeline.
 *
 * Kontrak `retrieveKnowledge({ tenantId, query })` dipatuhi: SEMUA query DB
 * difilter `workspaceId = tenantId` — Tenant A tidak pernah membaca knowledge
 * Tenant B (retrieval result pun sudah pasti milik tenant itu).
 */

/** Ambang skor relevansi — chunk di bawah ini dianggap tidak relevan. */
const RELEVANCE_THRESHOLD = 1;

/** Kata-kata yang mengindikasikan pertanyaan harga (untuk boost chunk harga). */
const PRICE_KEYWORDS = new Set(['harga', 'price', 'biaya', 'cost', 'berapa', 'tarif', 'rate']);

/** Kata-kata yang mengindikasikan pertanyaan jam buka. */
const HOURS_KEYWORDS = new Set(['jam', 'buka', 'tutup', 'hours', 'open', 'close', 'kapan']);

/** Kata-kata yang mengindikasikan pertanyaan lokasi/alamat. */
const LOCATION_KEYWORDS = new Set(['lokasi', 'alamat', 'dimana', 'di mana', 'location', 'address', 'maps']);

/** Stopwords umum (id/en) — tidak dihitung sebagai token relevansi. */
const STOPWORDS = new Set([
  'yang', 'dan', 'di', 'ke', 'dari', 'pada', 'untuk', 'dengan', 'apa', 'berapa',
  'saya', 'kami', 'kamu', 'anda', 'itu', 'ini', 'atau', 'karena', 'jika', 'kalau',
  'tolong', 'mau', 'ingin', 'bisa', 'apakah', 'kak', 'min', 'mas', 'mbak', 'pak', 'bu',
  'the', 'a', 'an', 'of', 'to', 'in', 'for', 'on', 'with', 'is', 'are', 'do', 'does',
  'please', 'can', 'want', 'need', 'what', 'how', 'when', 'where', 'hi', 'hello',
]);

/** Normalisasi teks → token (huruf kecil, tanpa tanda baca/angka-satuan). */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 0 && !STOPWORDS.has(token));
}

/** Boost per tipe chunk — jenis yang paling sering ditanya diberi bobot lebih. */
const TYPE_BOOST: Record<KnowledgeChunk['type'], number> = {
  service: 2,
  services: 1.5,
  faq: 1.4,
  hours: 1.3,
  location: 1.3,
  policy: 1.2,
  description: 1,
};

/** Skor satu chunk terhadap query (token overlap + boost tipe + boost keyword). */
export function scoreChunk(query: string, chunk: KnowledgeChunk): number {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 0;

  const contentTokens = new Set(tokenize(chunk.content));
  let matched = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) matched += 1;
  }
  if (matched === 0) return 0;

  // Densitas: proporsi token query yang cocok (anti spam — chunk panjang
  // dengan satu kecocokan tidak otomatis relevan).
  const density = matched / queryTokens.length;
  let score = density * TYPE_BOOST[chunk.type];

  // Boost semantik murah: keyword harga/jam/lokasi memperkuat chunk yang
  // memang mengandung data itu.
  const lower = query.toLowerCase();
  if (chunk.type === 'service' || chunk.type === 'services') {
    const hasPrice = /(rp|\$|usd|idr|ribu|jt|juta|\d{3,})/.test(chunk.content) || PRICE_KEYWORDS.has(chunk.type);
    if ([...PRICE_KEYWORDS].some((w) => lower.includes(w))) score *= hasPrice ? 1.6 : 0.8;
  }
  if (chunk.type === 'hours' && [...HOURS_KEYWORDS].some((w) => lower.includes(w))) score *= 1.5;
  if (chunk.type === 'location' && [...LOCATION_KEYWORDS].some((w) => lower.includes(w))) score *= 1.5;
  if (chunk.type === 'service' && [...PRICE_KEYWORDS].some((w) => lower.includes(w))) {
    // Pertanyaan harga → prioritaskan chunk katalog berharga.
    const lowerContent = chunk.content.toLowerCase();
    const hasPriceData = /(rp|\$|usd|idr|ribu|jt|juta)/.test(lowerContent);
    score *= hasPriceData ? 1.6 : 0.7;
  }

  return score;
}

/**
 * Bangun chunk knowledge dari workspace (KB jsonb + katalog layanan).
 * Murni — diuji unit. Setiap chunk membawa `id` stabil untuk grounding.
 */
export function buildKnowledgeChunks(input: {
  knowledge: AiKnowledge | null;
  services: ServiceSnapshot[];
}): KnowledgeChunk[] {
  const { knowledge, services } = input;
  const chunks: KnowledgeChunk[] = [];

  if (knowledge?.description?.trim()) {
    chunks.push({ id: 'kb:description', type: 'description', content: `deskripsi: ${knowledge.description.trim()}`, score: 0 });
  }
  if (knowledge?.services?.trim()) {
    chunks.push({ id: 'kb:services', type: 'services', content: `layanan: ${knowledge.services.trim()}`, score: 0 });
  }
  if (knowledge?.hours?.trim()) {
    chunks.push({ id: 'kb:hours', type: 'hours', content: `jam buka: ${knowledge.hours.trim()}`, score: 0 });
  }
  if (knowledge?.location?.trim()) {
    chunks.push({ id: 'kb:location', type: 'location', content: `lokasi: ${knowledge.location.trim()}`, score: 0 });
  }
  if (knowledge?.policy?.trim()) {
    chunks.push({ id: 'kb:policy', type: 'policy', content: `kebijakan: ${knowledge.policy.trim()}`, score: 0 });
  }
  for (const [index, item] of (knowledge?.faq ?? []).entries()) {
    if (item?.q?.trim() && item?.a?.trim()) {
      chunks.push({
        id: `faq:${index}`,
        type: 'faq',
        content: `Q: ${item.q.trim()}\nA: ${item.a.trim()}`,
        score: 0,
      });
    }
  }
  for (const service of services) {
    if (!service.isActive) continue;
    const parts = [service.name];
    if (service.durationMinutes) parts.push(`${service.durationMinutes} menit`);
    if (service.priceMinor != null) parts.push(formatPriceInline(service.priceMinor, service.currency));
    if (service.category?.length) parts.push(`kategori: ${service.category.join(', ')}`);
    if (service.description?.trim()) parts.push(service.description.trim());
    chunks.push({
      id: `service:${service.id}`,
      type: 'service',
      content: parts.join(' — '),
      score: 0,
      serviceId: service.id,
    });
  }
  return chunks;
}

/** Format harga minor units → "Rp 250000" (tanpa simbol mata uang kompleks). */
function formatPriceInline(priceMinor: number, currency: string): string {
  try {
    return new Intl.NumberFormat('id-ID', {
      style: 'currency',
      currency: currency || 'USD',
      maximumFractionDigits: 0,
    }).format(priceMinor / 100);
  } catch {
    return `${(priceMinor / 100).toFixed(0)} ${currency}`;
  }
}

/** Apakah sebuah chunk memuat informasi harga (untuk gate price_inquiry). */
export function chunkHasPrice(chunk: KnowledgeChunk): boolean {
  if (chunk.type === 'service' || chunk.type === 'services') {
    return /(rp|idr|\$|usd|ribu|jt|juta|\d{3,})/.test(chunk.content);
  }
  return false;
}

/**
 * Retrieval tenant-scoped:
 * 1. Muat data workspace (`workspaceId = tenantId`) + katalog layanan aktif
 *    (bila tidak disuntikkan pemanggil — pipeline menyuntikkan hasil muatannya
 *    sendiri agar tidak ada query DB duplikat).
 * 2. Bangun chunk, beri skor terhadap query, ambil top-K relevan.
 * 3. Kembalikan HANYA chunk tenant ini (query DB sudah difilter tenant).
 *
 * Catatan caching: retrieval ini murni CPU (<1 ms) di atas data yang pemanggil
 * sudah muat; data live (availability/booking) TIDAK pernah di-cache — selalu
 * query sumber terpercaya. Karena itu tidak ada cache di sini.
 */
export async function retrieveKnowledge(input: {
  tenantId: string;
  query: string;
  limit?: number;
  /** Suntikan data workspace + layanan bila pemanggil sudah memuatnya (hindari query ganda). */
  knowledge?: AiKnowledge | null;
  services?: ServiceSnapshot[];
}): Promise<RetrievalResult> {
  const { tenantId, query, limit = 6 } = input;

  if (input.knowledge === undefined || input.services === undefined) {
    const [workspace, services] = await Promise.all([
      loadWorkspaceKnowledge(tenantId),
      loadServicesSafe(tenantId),
    ]);
    return rankChunks(
      buildKnowledgeChunks({
        knowledge: input.knowledge === undefined ? workspace : input.knowledge,
        services: input.services === undefined ? services : input.services,
      }),
      query,
      limit,
    );
  }

  return rankChunks(
    buildKnowledgeChunks({ knowledge: input.knowledge, services: input.services }),
    query,
    limit,
  );
}

/** Murni: skor + urut + potong chunk. Dipisah agar mudah diuji tanpa DB. */
export function rankChunks(chunks: KnowledgeChunk[], query: string, limit: number): RetrievalResult {
  const scored = chunks
    .map((chunk) => ({ ...chunk, score: scoreChunk(query, chunk) }))
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score);
  return {
    chunks: scored.slice(0, limit),
    relevantCount: scored.length,
    hasRelevant: scored.length > 0 && scored[0].score >= RELEVANCE_THRESHOLD,
  };
}

/** Muat `aiKnowledge` workspace (tenant-scoped). null bila tidak ada. */
async function loadWorkspaceKnowledge(tenantId: string): Promise<AiKnowledge | null> {
  const [row] = await db
    .select({ aiKnowledge: workspaces.aiKnowledge })
    .from(workspaces)
    .where(and(eq(workspaces.id, tenantId), isNull(workspaces.deletedAt)))
    .limit(1);
  return (row?.aiKnowledge as AiKnowledge | null) ?? null;
}

/** Muat katalog layanan workspace (tenant-scoped). */
async function loadServicesSafe(tenantId: string): Promise<ServiceSnapshot[]> {
  return loadServices(tenantId);
}
