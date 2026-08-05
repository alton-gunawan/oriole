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

  it('maps the clinically relevant categories precisely', () => {
    expect(industryForTemplateCategory('healthcare-clinics')).toBe('medical_clinic');
    expect(industryForTemplateCategory('beauty-wellness')).toBe('wellness');
    expect(industryForTemplateCategory('hospitality-events')).toBe('restaurant');
    expect(industryForTemplateCategory('professional-services')).toBe('other');
  });
});
