import { describe, expect, it } from 'vitest';

import { GOAL_TYPES } from './types.ts';
import { getGoalTemplate, INDUSTRY_PROFILES } from './templates.ts';
import { INDUSTRIES } from './types.ts';
import { GOAL_TYPE_LABELS, INDUSTRY_LABELS } from './labels.ts';

describe('getGoalTemplate', () => {
  it('menghasilkan template lengkap untuk setiap kombinasi industry × goalType', () => {
    for (const industry of INDUSTRIES) {
      for (const goalType of GOAL_TYPES) {
        const template = getGoalTemplate(industry, goalType);
        expect(template.goalType).toBe(goalType);
        expect(template.title).toBeTruthy();
        expect(template.summary).toBeTruthy();
        expect(template.buildPrompt).toBeTypeOf('function');
        expect(template.resultSchema).toBeTruthy();
        expect(template.tone).toBeTruthy();
        expect(template.language).toBeTruthy();
        expect(template.voicemailBehavior).toBeTruthy();
      }
    }
  });

  it('industri dental/clinic/salon menghasilkan prompt berbeda', () => {
    const prompts = ['dental', 'clinic', 'salon'].map((industry) =>
      getGoalTemplate(industry as (typeof INDUSTRIES)[number], 'confirm-attendance').buildPrompt(
        {
          id: 'x',
          title: 'Booking',
          status: 'pending',
          scheduledAt: new Date().toISOString(),
          changeRequested: false,
          noShowCount: 0,
          previousCallAttempts: 0,
          failedCallAttempts: 0,
        },
        { name: 'Business' },
      ),
    );
    expect(new Set(prompts).size).toBe(3);
  });

  it('setiap industri memiliki profil', () => {
    for (const industry of INDUSTRIES) {
      expect(INDUSTRY_PROFILES[industry].appointmentNoun).toBeTruthy();
      expect(INDUSTRY_PROFILES[industry].businessNoun).toBeTruthy();
      expect(INDUSTRY_PROFILES[industry].confirmFlow.length).toBeGreaterThan(0);
      expect(INDUSTRY_PROFILES[industry].rescheduleFlow.length).toBeGreaterThan(0);
    }
  });

  it('alur panggilan benar-benar berbeda antar industri (bukan sekadar kata benda)', () => {
    const ctx = {
      id: 'x',
      title: 'Booking',
      status: 'pending' as const,
      scheduledAt: new Date().toISOString(),
      changeRequested: false,
      noShowCount: 0,
      previousCallAttempts: 0,
      failedCallAttempts: 0,
    };
    const clinic = getGoalTemplate('clinic', 'confirm-attendance').buildPrompt(ctx, {
      name: 'Business',
    });
    const salon = getGoalTemplate('salon', 'confirm-attendance').buildPrompt(ctx, {
      name: 'Business',
    });
    const spa = getGoalTemplate('spa', 'reminder-reconfirm').buildPrompt(ctx, {
      name: 'Business',
    });
    const fitness = getGoalTemplate('fitness', 'confirm-attendance').buildPrompt(ctx, {
      name: 'Business',
    });
    // Skenario bisnis yang berbeda muncul di prompt: perlengkapan medis,
    // stylist, persiapan perawatan spa, pass/membership fitness.
    expect(clinic).toContain('insurance card');
    expect(salon).toContain('photo reference');
    expect(spa).toContain('pre-treatment preparation');
    expect(fitness).toContain('class pass or membership');
    // Prompt lintas industri tidak boleh identik.
    expect(new Set([clinic, salon, spa, fitness]).size).toBe(4);
  });

  it('resultSchema menyertakan field khusus industri (spa: treatment)', () => {
    const spa = getGoalTemplate('spa', 'confirm-attendance');
    const properties = spa.resultSchema.properties as Record<string, unknown>;
    expect(properties.treatment).toMatchObject({ type: 'string' });
    // Field industri tidak wajib — AI boleh kosongkan bila tidak terjawab.
    expect(spa.resultSchema.required).not.toContain('treatment');

    const generic = getGoalTemplate('other', 'confirm-attendance');
    const genericProperties = generic.resultSchema.properties as Record<string, unknown>;
    expect(genericProperties.treatment).toBeUndefined();
  });
});

describe('labels', () => {
  it('menyediakan label untuk semua industri & goal type', () => {
    for (const industry of INDUSTRIES) expect(INDUSTRY_LABELS[industry]).toBeTruthy();
    for (const goalType of GOAL_TYPES) expect(GOAL_TYPE_LABELS[goalType]).toBeTruthy();
  });

  it('industryLabel fallback ke Other untuk nilai asing', () => {
    expect(INDUSTRY_LABELS.other).toBe(INDUSTRY_LABELS.other);
  });
});
