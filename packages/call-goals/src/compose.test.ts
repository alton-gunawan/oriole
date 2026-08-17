import { describe, expect, it } from 'vitest';

import { composeCallGoal, formatKnowledge } from './compose.ts';
import { determineCallGoal } from './determine-call-goal.ts';
import type { BookingGoalContext } from './types.ts';

const BASE: BookingGoalContext = {
  id: 'b1',
  title: 'Teeth Whitening',
  status: 'pending',
  scheduledAt: new Date(Date.now() + 72 * 3_600_000).toISOString(),
  timezone: 'UTC',
  customerName: 'Alex',
  phone: '+1 555 0001',
  changeRequested: false,
  noShowCount: 0,
  previousCallAttempts: 0,
  failedCallAttempts: 0,
};

const BUSINESS = { id: 'w1', name: 'Bright Smile Dental', industry: 'dental' as const };

describe('composeCallGoal', () => {
  it('auto: memakai hasil determineCallGoal', () => {
    const decision = determineCallGoal(BASE);
    const config = composeCallGoal({ booking: BASE, business: BUSINESS }, decision);
    expect(config).not.toBeNull();
    expect(config!.goalType).toBe(decision.goalType);
    expect(config!.prompt).toContain('Bright Smile Dental');
    expect(config!.prompt).toContain('dental appointment');
    expect(config!.resultSchema).toBeTruthy();
  });

  it('override goalType eksplisit menggantikan keputusan', () => {
    const config = composeCallGoal({
      booking: BASE,
      business: BUSINESS,
      customization: { goalType: 'reschedule-assistance' },
    });
    expect(config!.goalType).toBe('reschedule-assistance');
  });

  it("goalType 'auto' tidak dianggap override", () => {
    const config = composeCallGoal({
      booking: BASE,
      business: BUSINESS,
      customization: { goalType: 'auto' },
    });
    expect(config!.goalType).toBe(determineCallGoal(BASE).goalType);
  });

  it('custom instruction ditambahkan sebagai paragraf terpisah', () => {
    const config = composeCallGoal({
      booking: BASE,
      business: BUSINESS,
      customization: { customInstruction: 'Mention the 20% first-visit discount.' },
    });
    expect(config!.prompt).toContain('Extra instruction from the business:');
    expect(config!.prompt).toContain('20% first-visit discount');
  });

  it('knowledge base disisipkan ke prompt (dan tidak muncul bila kosong)', () => {
    const withKb = composeCallGoal({
      booking: BASE,
      business: {
        ...BUSINESS,
        knowledge: {
          services: 'Teeth whitening 500k, Cleaning 250k',
          hours: 'Mon–Sat 09.00–18.00',
          faq: [{ q: 'Do you accept insurance?', a: 'Yes.' }],
        },
      },
    })!;
    expect(withKb.prompt).toContain('Business information you can use');
    expect(withKb.prompt).toContain('Teeth whitening 500k');
    expect(withKb.prompt).toContain('Mon–Sat 09.00–18.00');
    expect(withKb.prompt).toContain('Do you accept insurance?');

    const withoutKb = composeCallGoal({ booking: BASE, business: BUSINESS })!;
    expect(withoutKb.prompt).not.toContain('Business information you can use');
  });

  it('formatKnowledge: mengabaikan field kosong dan FAQ kosong', () => {
    expect(formatKnowledge({ services: '  ', description: 'X' })).toContain('About the business: X');
    expect(formatKnowledge({ services: '  ' })).not.toContain('Services');
    expect(formatKnowledge(null)).toBe('');
  });

  it('null saat tidak perlu panggilan (dibatalkan)', () => {
    const config = composeCallGoal({
      booking: { ...BASE, status: 'cancelled' },
      business: BUSINESS,
    });
    expect(config).toBeNull();
  });

  it('industri kosong/tidak dikenal → fallback ke template other (tidak crash)', () => {
    const config = composeCallGoal({ booking: BASE, business: { name: 'X' } });
    expect(config).not.toBeNull();
    expect(config!.prompt).toContain('appointment');
  });

  it('industri memengaruhi vocabularies prompt', () => {
    const dental = composeCallGoal({ booking: BASE, business: BUSINESS })!;
    const salon = composeCallGoal({
      booking: BASE,
      business: { name: 'Hair House', industry: 'salon' },
    })!;
    expect(dental.prompt).toContain('dental appointment');
    expect(salon.prompt).toContain('hair appointment');
  });

  it('bahasa panggilan mengikuti setting workspace (default en)', () => {
    const defaulted = composeCallGoal({ booking: BASE, business: BUSINESS })!;
    expect(defaulted.language).toBe('en');

    const id = composeCallGoal({
      booking: BASE,
      business: { ...BUSINESS, language: 'id' },
    })!;
    expect(id.language).toBe('id');
  });

  it('spa menghasilkan result schema dengan field treatment', () => {
    const spa = composeCallGoal({
      booking: BASE,
      business: { name: 'Glow Spa', industry: 'spa' },
    })!;
    const properties = spa.resultSchema.properties as Record<string, unknown>;
    expect(properties.treatment).toMatchObject({ type: 'string' });
    expect(spa.prompt).toContain('pre-treatment preparation');
  });
});
