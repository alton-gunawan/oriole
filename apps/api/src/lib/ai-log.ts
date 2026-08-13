import type { AiRequestMeta } from './ai-types.ts';

/**
 * Log terstruktur pipeline AI — HANYA metadata, tanpa konten sensitif:
 *  - TIDAK pernah log isi pesan customer (plaintext), prompt, atau jawaban.
 *  - TIDAK pernah log API key / token / data customer (nomor, nama, email).
 *  - Field opsional (mis. failureReason) berupa kode singkat, bukan teks bebas.
 *
 * Format satu baris JSON agar mudah di-filter di observability.
 */
export function logAiEvent(
  meta: AiRequestMeta,
  fields: {
    intent?: string;
    retrievalCount?: number;
    toolUsed?: string;
    llmModel?: string;
    latencyMs?: number;
    retryCount?: number;
    handoff?: boolean;
    failureReason?: string;
    decision?: 'allow' | 'handoff';
    risk?: string;
  } = {},
): void {
  const entry: Record<string, unknown> = {
    level: 'ai',
    ts: new Date().toISOString(),
    requestId: meta.requestId,
    tenantId: meta.tenantId,
    conversationId: meta.conversationId,
  };
  if (meta.language) entry.language = meta.language;
  if (fields.intent) entry.intent = fields.intent;
  if (fields.retrievalCount != null) entry.retrievalCount = fields.retrievalCount;
  if (fields.toolUsed) entry.toolUsed = fields.toolUsed;
  if (fields.llmModel) entry.llmModel = fields.llmModel;
  if (fields.latencyMs != null) entry.latencyMs = fields.latencyMs;
  if (fields.retryCount != null) entry.retryCount = fields.retryCount;
  if (fields.handoff != null) entry.handoff = fields.handoff;
  if (fields.decision) entry.decision = fields.decision;
  if (fields.risk) entry.risk = fields.risk;
  if (fields.failureReason) entry.failureReason = fields.failureReason;

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(entry));
}
