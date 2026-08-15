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
 * Kategori dipertahankan sebagai kosakata onboarding; industri yang diturunkan
 * disederhanakan ke 6 nilai INDUSTRIES (kategori selain klinik/salon/fitness/
 * spa/dental jatuh ke `other`). Nilai harus selalu ∈ INDUSTRIES (dijamin oleh
 * tipe `Industry`). Override per-workspace/per-booking tetap didukung.
 */
export const WORKSPACE_TEMPLATE_CATEGORY_INDUSTRY: Record<WorkspaceTemplateCategory, Industry> = {
  'beauty-wellness': 'spa',
  'healthcare-clinics': 'clinic',
  fitness: 'fitness',
  'professional-services': 'other',
  'home-services': 'other',
  automotive: 'other',
  'education-coaching': 'other',
  'photography-creative': 'other',
  'hospitality-events': 'other',
  'real-estate': 'other',
  'pet-care': 'other',
  'space-rental': 'other',
};

/** Industri default untuk sebuah kategori — dipakai API saat industry tidak dikirim. */
export function industryForTemplateCategory(category: WorkspaceTemplateCategory): Industry {
  return WORKSPACE_TEMPLATE_CATEGORY_INDUSTRY[category];
}
