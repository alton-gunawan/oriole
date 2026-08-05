import type { TranslationKey } from '../i18n';

export interface Workspace {
  id: string;
  name: string;
  templateCategory: string;
  industry?: string | null;
  /** Menit sebelum jadwal reminder otomatis dikirim (default 120). */
  reminderLeadMinutes?: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Kategori template bisnis — single source of truth id-nya di
 * `WORKSPACE_TEMPLATE_CATEGORY_IDS` (@oriole/config). Industri CALL-E
 * diturunkan otomatis dari kategori di level API, jadi user hanya memilih
 * sekali. Label & deskripsi user-facing dipetakan ke kunci i18n
 * (workspaceCategory.<id>.*) agar mengikuti bahasa aktif.
 */
export const RECOMMENDED_TEMPLATE_CATEGORIES = [
  {
    id: 'beauty-wellness',
    labelKey: 'workspaceCategory.beauty-wellness.label',
    descriptionKey: 'workspaceCategory.beauty-wellness.description',
    emoji: '✦',
  },
  {
    id: 'healthcare-clinics',
    labelKey: 'workspaceCategory.healthcare-clinics.label',
    descriptionKey: 'workspaceCategory.healthcare-clinics.description',
    emoji: '✚',
  },
  {
    id: 'fitness',
    labelKey: 'workspaceCategory.fitness.label',
    descriptionKey: 'workspaceCategory.fitness.description',
    emoji: '↗',
  },
  {
    id: 'professional-services',
    labelKey: 'workspaceCategory.professional-services.label',
    descriptionKey: 'workspaceCategory.professional-services.description',
    emoji: '◌',
  },
  {
    id: 'home-services',
    labelKey: 'workspaceCategory.home-services.label',
    descriptionKey: 'workspaceCategory.home-services.description',
    emoji: '⌂',
  },
  {
    id: 'automotive',
    labelKey: 'workspaceCategory.automotive.label',
    descriptionKey: 'workspaceCategory.automotive.description',
    emoji: '◇',
  },
  {
    id: 'education-coaching',
    labelKey: 'workspaceCategory.education-coaching.label',
    descriptionKey: 'workspaceCategory.education-coaching.description',
    emoji: '▱',
  },
  {
    id: 'photography-creative',
    labelKey: 'workspaceCategory.photography-creative.label',
    descriptionKey: 'workspaceCategory.photography-creative.description',
    emoji: '○',
  },
  {
    id: 'hospitality-events',
    labelKey: 'workspaceCategory.hospitality-events.label',
    descriptionKey: 'workspaceCategory.hospitality-events.description',
    emoji: '✧',
  },
  {
    id: 'real-estate',
    labelKey: 'workspaceCategory.real-estate.label',
    descriptionKey: 'workspaceCategory.real-estate.description',
    emoji: '▣',
  },
  {
    id: 'pet-care',
    labelKey: 'workspaceCategory.pet-care.label',
    descriptionKey: 'workspaceCategory.pet-care.description',
    emoji: '♡',
  },
  {
    id: 'space-rental',
    labelKey: 'workspaceCategory.space-rental.label',
    descriptionKey: 'workspaceCategory.space-rental.description',
    emoji: '▦',
  },
] as const;

/** Kunci i18n label kategori — null bila id tidak dikenal (caller tampilkan mentah). */
export function getTemplateCategoryLabelKey(categoryId: string): TranslationKey | null {
  const category = RECOMMENDED_TEMPLATE_CATEGORIES.find((item) => item.id === categoryId);
  return category?.labelKey ?? null;
}
