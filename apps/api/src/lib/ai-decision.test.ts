import { describe, expect, it } from 'vitest';

import { decideAiReply, type DecisionInput } from './ai-decision.ts';
import type { AiStructuredOutput, KnowledgeChunk } from './ai-types.ts';

const KNOWLEDGE_CHUNKS: KnowledgeChunk[] = [
  { id: 'kb:services', type: 'services', content: 'Scaling 150rb', score: 2 },
  { id: 'service:svc-1', type: 'service', content: 'Scaling — Rp 150.000', score: 3, serviceId: 'svc-1' },
];

function base(): DecisionInput {
  return {
    output: {
      intent: 'price_inquiry',
      answer: 'Scaling 150rb.',
      confidence: 0.9,
      needsHuman: false,
      reason: 'found in catalog',
      sources: [{ type: 'knowledge', id: 'service:svc-1' }],
    },
    retrieved: KNOWLEDGE_CHUNKS,
    executedTools: [],
  };
}

function withOutput(input: DecisionInput, patch: Partial<AiStructuredOutput>): DecisionInput {
  return { ...input, output: { ...input.output, ...patch } };
}

/** Menegaskan handoff & mengembalikan reason (narrowing TypeScript). */
function expectHandoff(d: ReturnType<typeof decideAiReply>): string {
  if (d.allow) throw new Error('diharapkan handoff, tapi keputusan ALLOW');
  return d.reason;
}

describe('decideAiReply (Decision Engine — multi-sinyal)', () => {
  it('grounded + confidence tinggi → ALLOW', () => {
    const d = decideAiReply(base());
    expect(d).toEqual({ allow: true, reply: 'Scaling 150rb.', risk: 'medium' });
  });

  it('needsHuman true → handoff walau confidence tinggi & grounded', () => {
    const d = decideAiReply(withOutput(base(), { needsHuman: true }));
    expect(d.allow).toBe(false);
  });

  it('intent human_request → handoff', () => {
    const d = decideAiReply(withOutput(base(), { intent: 'human_request' }));
    expect(d.allow).toBe(false);
    expect(expectHandoff(d)).toBe('human-request');
  });

  it('intent unknown → handoff', () => {
    const d = decideAiReply(withOutput(base(), { intent: 'unknown' }));
    expect(d.allow).toBe(false);
    expect(expectHandoff(d)).toBe('unknown-intent');
  });

  it('source fiktif (id tidak ada di retrieval) → handoff — BUKAN hanya confidence', () => {
    // Harga dibuat-buat + confidence 0.97 tetap harus ditolak: source tidak
    // pernah di-retrieve (kasus halusinasi yang dulu lolos confidence gate).
    const d = decideAiReply(
      withOutput(base(), {
        answer: 'Harga treatment Rp500.000.',
        confidence: 0.97,
        sources: [{ type: 'knowledge', id: 'service:999' }],
      }),
    );
    expect(d.allow).toBe(false);
    expect(expectHandoff(d)).toContain('source knowledge fiktif');
  });

  it('jawaban tanpa source (ungrounded) → handoff walau confidence 0.97', () => {
    const d = decideAiReply(withOutput(base(), { sources: [] }));
    expect(d.allow).toBe(false);
    expect(expectHandoff(d)).toBe('ungrounded-answer');
  });

  it('tidak ada knowledge relevan → handoff', () => {
    const d = decideAiReply({ ...base(), retrieved: [] });
    expect(d.allow).toBe(false);
    expect(expectHandoff(d)).toBe('no-relevant-knowledge');
  });

  it('price_inquiry tanpa chunk berharga → handoff (jangan menyebut harga)', () => {
    const d = decideAiReply({
      ...base(),
      retrieved: [{ id: 'kb:location', type: 'location', content: 'Jl. Merdeka', score: 1 }],
      output: {
        ...base().output,
        sources: [{ type: 'knowledge', id: 'kb:location' }],
      },
    });
    expect(d.allow).toBe(false);
    expect(expectHandoff(d)).toBe('no-price-source');
  });

  it('reason menyebut contradiction → handoff', () => {
    const d = decideAiReply(withOutput(base(), { reason: 'knowledge contradiction detected' }));
    expect(d.allow).toBe(false);
  });

  it('confidence rendah untuk risiko medium → handoff', () => {
    const d = decideAiReply(withOutput(base(), { confidence: 0.55 }));
    expect(d.allow).toBe(false);
    expect(expectHandoff(d)).toBe('low-confidence');
  });

  it('risiko rendah (faq) dengan confidence 0.5 → ALLOW (ambang lebih longgar)', () => {
    const d = decideAiReply(
      withOutput(base(), {
        intent: 'faq',
        confidence: 0.5,
        sources: [{ type: 'knowledge', id: 'kb:services' }],
      }),
    );
    expect(d.allow).toBe(true);
  });

  it('availability_inquiry: tool sukses + grounded → ALLOW', () => {
    const d = decideAiReply({
      output: {
        intent: 'availability_inquiry',
        answer: 'Ada slot 14:00 dan 15:00.',
        confidence: 0.9,
        needsHuman: false,
        reason: 'tool result',
        sources: [{ type: 'tool', name: 'get_available_slots' }],
      },
      retrieved: [],
      executedTools: [{ name: 'get_available_slots', ok: true, summary: { slots: ['14:00', '15:00'] } }],
    });
    expect(d.allow).toBe(true);
  });

  it('availability_inquiry: tool TIDAK dieksekusi → handoff (jangan menebak slot)', () => {
    const d = decideAiReply({
      output: {
        intent: 'availability_inquiry',
        answer: 'Besok jam 3 tersedia.',
        confidence: 0.95,
        needsHuman: false,
        reason: 'guessed',
        sources: [{ type: 'tool', name: 'get_available_slots' }],
      },
      retrieved: [],
      executedTools: [],
    });
    expect(d.allow).toBe(false);
    expect(expectHandoff(d)).toBe('tool-get_available_slots-not-executed');
  });

  it('create_booking: tool gagal → handoff', () => {
    const d = decideAiReply({
      output: {
        intent: 'create_booking',
        answer: 'Booking berhasil.',
        confidence: 0.95,
        needsHuman: false,
        reason: 'tool result',
        sources: [{ type: 'tool', name: 'create_booking' }],
      },
      retrieved: [],
      executedTools: [{ name: 'create_booking', ok: false, error: 'Slot sudah terisi' }],
    });
    expect(d.allow).toBe(false);
    expect(expectHandoff(d)).toBe('tool-create_booking-failed');
  });

  it('source tool diklaim tapi tidak pernah dieksekusi → handoff', () => {
    const d = decideAiReply({
      output: {
        intent: 'faq',
        answer: 'Booking anda sudah dibuat.',
        confidence: 0.9,
        needsHuman: false,
        reason: 'tool',
        sources: [{ type: 'tool', name: 'create_booking' }],
      },
      retrieved: [KNOWLEDGE_CHUNKS[0]],
      executedTools: [],
    });
    expect(d.allow).toBe(false);
    expect(expectHandoff(d)).toContain('source tool tidak dieksekusi');
  });

  it('booking id fiktif dalam source tool → handoff', () => {
    const d = decideAiReply({
      output: {
        intent: 'cancel_booking',
        answer: 'Booking 123 dibatalkan.',
        confidence: 0.9,
        needsHuman: false,
        reason: 'tool result',
        sources: [{ type: 'tool', name: 'cancel_booking', id: 'booking-fake' }],
      },
      retrieved: [],
      executedTools: [{ name: 'cancel_booking', ok: true, bookingIds: ['booking-real'] }],
    });
    expect(d.allow).toBe(false);
    if (d.allow) throw new Error('harus handoff');
    expect(expectHandoff(d)).toContain('booking id fiktif');
  });
});
