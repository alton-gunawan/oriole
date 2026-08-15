import type { TranslationKey } from '../i18n';

/**
 * Knowledge base AI chat (WhatsApp) — sumber jawaban bot untuk layanan /
 * harga / jam buka / lokasi. Bentuk sama dengan `AiKnowledge` di
 * packages/database (api) — dijaga sinkron manual.
 */
export interface AiKnowledge {
  /** Deskripsi singkat usaha (1-2 kalimat). */
  description?: string;
  /** Layanan + harga, bebas format teks. */
  services?: string;
  /** Jam buka ("Sen–Sab 08.00–20.00"). */
  hours?: string;
  /** Alamat + patokan / link maps. */
  location?: string;
  /** Kebijakan lain (opsional): deposit, pembatalan, dsb. */
  policy?: string;
  /** FAQ tambahan di luar field di atas. */
  faq?: { q: string; a: string }[];
}

export interface Workspace {
  id: string;
  name: string;
  templateCategory: string;
  industry?: string | null;
  /** Menit sebelum jadwal reminder otomatis dikirim (default 120). */
  reminderLeadMinutes?: number;
  /** Bahasa panggilan CALL-E (default 'en'). */
  callGoalLanguage?: string;
  /** Bahasa balasan bot chat — Telegram / WhatsApp / email (default 'en'). */
  chatLanguage?: string;
  /** Auto-call CALL-E aktif/mati (default mati). */
  autoCallEnabled?: boolean;
  /** Berapa jam sebelum jadwal auto-call dipicu (default 24). */
  autoCallLeadHours?: number;
  /** AI chat WhatsApp aktif/mati (default mati). */
  aiEnabled?: boolean;
  /** Knowledge base AI chat (null = belum diisi). */
  aiKnowledge?: AiKnowledge | null;
  /**
   * Avatar bisnis: URL planet DiceBear / data URL upload. null = planet
   * deterministik dari nama (default lama).
   */
  avatarUrl?: string | null;
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
