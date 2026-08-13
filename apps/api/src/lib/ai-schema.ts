import { z } from 'zod';

import { AI_INTENTS, type AiStructuredOutput } from './ai-types.ts';

/**
 * Validasi output terstruktur LLM di BACKEND — JSON dari model TIDAK pernah
 * dipercaya mentah. Skema menegakkan:
 *  - field wajib + tipe,
 *  - `intent` ∈ enum (bukan nilai bebas),
 *  - `confidence` 0..1,
 *  - struktur `sources` (type ∈ knowledge|tool; id/name sesuai tipe),
 *  - panjang jawaban dibatasi (anti-token-waste / anti-abuse).
 *
 * Gagal parse/validasi → `null` → caller jatuh ke handoff (perilaku lama).
 */

const AI_INTENT_ENUM = z.enum(AI_INTENTS);

export const aiSourceSchema = z
  .object({
    type: z.enum(['knowledge', 'tool']),
    id: z.string().min(1).max(200).optional(),
    name: z.string().min(1).max(60).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // type knowledge wajib punya id; type tool wajib punya name.
    if (value.type === 'knowledge' && !value.id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'knowledge source wajib punya id' });
    }
    if (value.type === 'tool' && !value.name) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'tool source wajib punya name' });
    }
  });

/** Skema ketat output LLM (fase akhir). */
export const aiStructuredOutputSchema = z
  .object({
    intent: AI_INTENT_ENUM,
    answer: z.string().trim().min(1).max(2_000),
    confidence: z.number().min(0).max(1),
    needsHuman: z.boolean(),
    reason: z.string().trim().max(300),
    sources: z.array(aiSourceSchema).max(8).default([]),
  })
  .strict();

/**
 * Parse teks output LLM → AiStructuredOutput yang tervalidasi.
 * Toleran terhadap pembungkus ```json ... ``` (sering muncul tanpa JSON mode).
 * Kembalikan null bila bukan JSON valid / tidak lolos skema.
 */
export function parseAiStructuredOutput(content: string): AiStructuredOutput | null {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned);
  } catch {
    return null;
  }
  const parsed = aiStructuredOutputSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data;
}
