import { describe, expect, it } from 'vitest';

import { composeCallGoal } from './compose.ts';
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
      business: { name: 'Hair House', industry: 'hair_salon' },
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

  it('restaurant menghasilkan result schema dengan field party size', () => {
    const restaurant = composeCallGoal({
      booking: BASE,
      business: { name: 'Nonna', industry: 'restaurant' },
    })!;
    const properties = restaurant.resultSchema.properties as Record<string, unknown>;
    expect(properties.partySize).toMatchObject({ type: 'integer' });
    expect(restaurant.prompt).toContain('number of guests');
  });
});
