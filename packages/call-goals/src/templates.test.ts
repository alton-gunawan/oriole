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

  it('industri dental/medspa/salon menghasilkan prompt berbeda', () => {
    const prompts = ['dental', 'medspa', 'hair_salon'].map((industry) =>
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
    }
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
