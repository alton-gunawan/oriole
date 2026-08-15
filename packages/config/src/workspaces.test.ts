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

  it('maps every category to its (simplified) industry', () => {
    // Kategori dengan industri khusus → nilai sempitnya.
    expect(industryForTemplateCategory('healthcare-clinics')).toBe('clinic');
    expect(industryForTemplateCategory('beauty-wellness')).toBe('spa');
    expect(industryForTemplateCategory('fitness')).toBe('fitness');
    // Kategori lain jatuh ke industri generik `other` (daftar disederhanakan).
    expect(industryForTemplateCategory('hospitality-events')).toBe('other');
    expect(industryForTemplateCategory('professional-services')).toBe('other');
    expect(industryForTemplateCategory('home-services')).toBe('other');
    expect(industryForTemplateCategory('automotive')).toBe('other');
    expect(industryForTemplateCategory('education-coaching')).toBe('other');
    expect(industryForTemplateCategory('photography-creative')).toBe('other');
    expect(industryForTemplateCategory('real-estate')).toBe('other');
    expect(industryForTemplateCategory('pet-care')).toBe('other');
    expect(industryForTemplateCategory('space-rental')).toBe('other');
  });
});
