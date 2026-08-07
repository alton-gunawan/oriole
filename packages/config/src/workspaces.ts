import type { Industry } from '@oriole/call-goals';

export const WORKSPACE_TEMPLATE_CATEGORY_IDS = [
  'beauty-wellness',
  'healthcare-clinics',
  'fitness',
  'professional-services',
  'home-services',
  'automotive',
  'education-coaching',
  'photography-creative',
  'hospitality-events',
  'real-estate',
  'pet-care',
  'space-rental',
] as const;

export type WorkspaceTemplateCategory = (typeof WORKSPACE_TEMPLATE_CATEGORY_IDS)[number];

/**
 * Peta kategori template → industri CALL-E. Single source of truth: user cukup
 * memilih satu kategori (UX), `industry` diturunkan otomatis di level API agar
 * prompt AI call selalu relevan — tanpa menanyakan hal yang sama dua kali.
 *
 * Nilai harus selalu ∈ INDUSTRIES (dijamin oleh tipe `Industry`).
 * Override per-workspace/per-booking tetap didukung di level data.
 */
export const WORKSPACE_TEMPLATE_CATEGORY_INDUSTRY: Record<WorkspaceTemplateCategory, Industry> = {
  'beauty-wellness': 'wellness',
  'healthcare-clinics': 'medical_clinic',
  fitness: 'fitness',
  'professional-services': 'professional_services',
  'home-services': 'home_services',
  automotive: 'automotive',
  'education-coaching': 'education_coaching',
  'photography-creative': 'photography_creative',
  'hospitality-events': 'restaurant',
  'real-estate': 'real_estate',
  'pet-care': 'pet_care',
  'space-rental': 'space_rental',
};

/** Industri default untuk sebuah kategori — dipakai API saat industry tidak dikirim. */
export function industryForTemplateCategory(category: WorkspaceTemplateCategory): Industry {
  return WORKSPACE_TEMPLATE_CATEGORY_INDUSTRY[category];
}
