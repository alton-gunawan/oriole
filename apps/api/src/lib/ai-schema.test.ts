import { describe, expect, it } from 'vitest';

import { parseAiStructuredOutput } from './ai-schema.ts';

function valid() {
  return {
    intent: 'price_inquiry',
    answer: 'Harga scaling 150rb.',
    confidence: 0.9,
    needsHuman: false,
    reason: 'found in catalog',
    sources: [{ type: 'knowledge', id: 'kb:services' }],
  };
}

describe('parseAiStructuredOutput (validasi backend)', () => {
  it('JSON valid + skema benar → hasil ter-parse', () => {
    const result = parseAiStructuredOutput(JSON.stringify(valid()));
    expect(result).toEqual({
      intent: 'price_inquiry',
      answer: 'Harga scaling 150rb.',
      confidence: 0.9,
      needsHuman: false,
      reason: 'found in catalog',
      sources: [{ type: 'knowledge', id: 'kb:services' }],
    });
  });

  it('menerima pembungkus ```json ... ```', () => {
    const result = parseAiStructuredOutput('```json\n' + JSON.stringify(valid()) + '\n```');
    expect(result?.intent).toBe('price_inquiry');
  });

  it('bukan JSON → null', () => {
    expect(parseAiStructuredOutput('maaf saya tidak mengerti')).toBeNull();
  });

  it('field wajib hilang (intent) → null', () => {
    const { intent: _intent, ...rest } = valid();
    expect(parseAiStructuredOutput(JSON.stringify(rest))).toBeNull();
  });

  it('field wajib hilang (reason) → null', () => {
    const { reason: _reason, ...rest } = valid();
    expect(parseAiStructuredOutput(JSON.stringify(rest))).toBeNull();
  });

  it('intent bukan enum → null', () => {
    expect(
      parseAiStructuredOutput(JSON.stringify({ ...valid(), intent: 'hack_the_planet' })),
    ).toBeNull();
  });

  it('confidence di luar 0..1 → null', () => {
    expect(parseAiStructuredOutput(JSON.stringify({ ...valid(), confidence: 1.5 }))).toBeNull();
    expect(parseAiStructuredOutput(JSON.stringify({ ...valid(), confidence: -0.1 }))).toBeNull();
  });

  it('confidence string → null (tipe dijaga)', () => {
    expect(parseAiStructuredOutput(JSON.stringify({ ...valid(), confidence: '0.9' }))).toBeNull();
  });

  it('answer kosong → null', () => {
    expect(parseAiStructuredOutput(JSON.stringify({ ...valid(), answer: '   ' }))).toBeNull();
  });

  it('source knowledge tanpa id → null (grounding wajib)', () => {
    expect(
      parseAiStructuredOutput(
        JSON.stringify({ ...valid(), sources: [{ type: 'knowledge' }] }),
      ),
    ).toBeNull();
  });

  it('source tool tanpa name → null', () => {
    expect(
      parseAiStructuredOutput(
        JSON.stringify({ ...valid(), sources: [{ type: 'tool', id: 'booking-1' }] }),
      ),
    ).toBeNull();
  });

  it('source type tidak dikenal → null', () => {
    expect(
      parseAiStructuredOutput(
        JSON.stringify({ ...valid(), sources: [{ type: 'hallucination', id: 'x' }] }),
      ),
    ).toBeNull();
  });

  it('kunci tak dikenal (strict) → null', () => {
    expect(parseAiStructuredOutput(JSON.stringify({ ...valid(), extra: 'junk' }))).toBeNull();
  });

  it('sources default [] bila tidak dikirim', () => {
    const { sources: _sources, ...rest } = valid();
    const result = parseAiStructuredOutput(JSON.stringify(rest));
    expect(result?.sources).toEqual([]);
  });
});
