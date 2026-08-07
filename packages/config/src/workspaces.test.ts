import { describe, expect, it } from 'vitest';

import { INDUSTRIES } from '@oriole/call-goals';

import {
  industryForTemplateCategory,
  WORKSPACE_TEMPLATE_CATEGORY_IDS,
  WORKSPACE_TEMPLATE_CATEGORY_INDUSTRY,
} from './workspaces.ts';

describe('industryForTemplateCategory', () => {
  it('covers every registered template category', () => {
    expect(Object.keys(WORKSPACE_TEMPLATE_CATEGORY_INDUSTRY).sort()).toEqual(
      [...WORKSPACE_TEMPLATE_CATEGORY_IDS].sort(),
    );
  });

  it('maps every category to a valid, registered CALL-E industry', () => {
    for (const category of WORKSPACE_TEMPLATE_CATEGORY_IDS) {
      expect(INDUSTRIES, `category "${category}"`).toContain(
        industryForTemplateCategory(category),
      );
    }
  });

  it('maps every category to its own dedicated industry (1:1)', () => {
    expect(industryForTemplateCategory('healthcare-clinics')).toBe('medical_clinic');
    expect(industryForTemplateCategory('beauty-wellness')).toBe('wellness');
    expect(industryForTemplateCategory('hospitality-events')).toBe('restaurant');
    expect(industryForTemplateCategory('professional-services')).toBe('professional_services');
    expect(industryForTemplateCategory('home-services')).toBe('home_services');
    expect(industryForTemplateCategory('automotive')).toBe('automotive');
    expect(industryForTemplateCategory('education-coaching')).toBe('education_coaching');
    expect(industryForTemplateCategory('photography-creative')).toBe('photography_creative');
    expect(industryForTemplateCategory('real-estate')).toBe('real_estate');
    expect(industryForTemplateCategory('pet-care')).toBe('pet_care');
    expect(industryForTemplateCategory('space-rental')).toBe('space_rental');
    expect(industryForTemplateCategory('fitness')).toBe('fitness');
    // Setiap kategori memetakan ke industri yang BERBEDA — tidak ada dua
    // kategori yang berbagi template panggilan generik.
    const values = Object.values(WORKSPACE_TEMPLATE_CATEGORY_INDUSTRY);
    expect(new Set(values).size).toBe(values.length);
  });
});
