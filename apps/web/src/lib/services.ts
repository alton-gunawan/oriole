/** Mirrors GET /api/services — baris layanan katalog + staf ter-assign. */
export interface ServiceRecord {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  /** Harga dalam minor units (sen) — null = belum di-set. */
  priceMinor: number | null;
  currency: string;
  color: string;
  /** Kategori/tag layanan — beberapa kategori per layanan. */
  category: string[] | null;
  isActive: boolean;
  sortOrder: number;
  staffIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ServicesListResponse {
  services: ServiceRecord[];
}

export interface ServiceResponse {
  service: ServiceRecord;
}

export interface CreateServicePayload {
  name: string;
  description?: string;
  durationMinutes?: number;
  priceMinor?: number | null;
  currency?: string;
  color?: string;
  category?: string[];
  isActive?: boolean;
  sortOrder?: number;
  staffIds?: string[];
}

export interface UpdateServicePayload {
  name?: string;
  description?: string | null;
  durationMinutes?: number;
  priceMinor?: number | null;
  currency?: string;
  color?: string;
  category?: string[] | null;
  isActive?: boolean;
  sortOrder?: number;
  staffIds?: string[];
}

/** Mata uang umum — opsi picker (harus sinkron dengan backend SUPPORTED_CURRENCIES). */
export const SERVICE_CURRENCIES = [
  'USD',
  'IDR',
  'EUR',
  'GBP',
  'SGD',
  'MYR',
  'AUD',
  'JPY',
  'THB',
  'VND',
  'PHP',
  'INR',
  'BRL',
  'CAD',
] as const;

/** Format harga minor units → string lokal (mis. "Rp 50.000"). */
export function formatServicePrice(
  priceMinor: number | null,
  currency: string,
): string | null {
  if (priceMinor === null || priceMinor === undefined) return null;
  try {
    return new Intl.NumberFormat('id-ID', {
      style: 'currency',
      currency,
      maximumFractionDigits: currency === 'JPY' ? 0 : 2,
    }).format(priceMinor / 100);
  } catch {
    return `${priceMinor / 100} ${currency}`;
  }
}

/** Durasi → label menit ("60 mnt") — konsisten dengan tampilan booking. */
export function formatServiceDuration(durationMinutes: number): string {
  return `${durationMinutes} mnt`;
}

export interface IndustryTemplateService {
  name: string;
  duration: number;
  price: number;
}

export interface IndustryConfig {
  id: string;
  label: string;
  emoji: string;
  templateCategory: string;
  defaultServices: IndustryTemplateService[];
}

export const INDUSTRY_CONFIGS: IndustryConfig[] = [
  {
    id: 'barbershop',
    label: 'Barbershop',
    emoji: '✂️',
    templateCategory: 'beauty-wellness',
    defaultServices: [
      { name: 'Haircut', duration: 45, price: 40 },
      { name: 'Beard Trim', duration: 30, price: 25 },
      { name: 'Haircut & Beard', duration: 60, price: 60 },
    ],
  },
  {
    id: 'salon',
    label: 'Hair & Beauty Salon',
    emoji: '💇‍♀️',
    templateCategory: 'beauty-wellness',
    defaultServices: [
      { name: 'Women Haircut & Blowdry', duration: 60, price: 75 },
      { name: 'Color & Highlights', duration: 90, price: 150 },
      { name: 'Hair Treatment', duration: 45, price: 65 },
    ],
  },
  {
    id: 'nail-salon',
    label: 'Nail Salon',
    emoji: '💅',
    templateCategory: 'beauty-wellness',
    defaultServices: [
      { name: 'Classic Manicure', duration: 45, price: 35 },
      { name: 'Gel Pedicure', duration: 60, price: 55 },
      { name: 'Nail Art & Extension', duration: 90, price: 85 },
    ],
  },
  {
    id: 'massage-spa',
    label: 'Massage & Spa',
    emoji: '💆',
    templateCategory: 'beauty-wellness',
    defaultServices: [
      { name: 'Full Body Relaxation Massage', duration: 60, price: 80 },
      { name: 'Deep Tissue Massage', duration: 90, price: 120 },
      { name: 'Aromatherapy Session', duration: 60, price: 95 },
    ],
  },
  {
    id: 'pet-grooming',
    label: 'Pet Grooming',
    emoji: '🐾',
    templateCategory: 'home-services',
    defaultServices: [
      { name: 'Full Dog Grooming', duration: 60, price: 65 },
      { name: 'Bath & Brush', duration: 45, price: 40 },
      { name: 'Nail Clipping & Ear Cleaning', duration: 30, price: 25 },
    ],
  },
  {
    id: 'car-detailing',
    label: 'Car Detailing',
    emoji: '🚗',
    templateCategory: 'automotive',
    defaultServices: [
      { name: 'Interior Deep Clean', duration: 90, price: 120 },
      { name: 'Full Exterior Polish & Wax', duration: 120, price: 180 },
      { name: 'Express Wash & Vacuum', duration: 45, price: 50 },
    ],
  },
  {
    id: 'yoga-pilates',
    label: 'Yoga & Pilates',
    emoji: '🧘',
    templateCategory: 'fitness',
    defaultServices: [
      { name: 'Private Pilates Session', duration: 60, price: 85 },
      { name: '1-on-1 Yoga Alignment', duration: 60, price: 75 },
    ],
  },
  {
    id: 'personal-trainer',
    label: 'Personal Training',
    emoji: '🏋️‍♂️',
    templateCategory: 'fitness',
    defaultServices: [
      { name: 'Personal Training Session', duration: 60, price: 70 },
      { name: 'Fitness & Nutrition Consultation', duration: 45, price: 50 },
    ],
  },
  {
    id: 'clinic',
    label: 'Clinic & Healthcare',
    emoji: '🩺',
    templateCategory: 'healthcare-clinics',
    defaultServices: [
      { name: 'General Consultation', duration: 30, price: 60 },
      { name: 'Follow-up Checkup', duration: 20, price: 40 },
    ],
  },
  {
    id: 'photography-studio',
    label: 'Photography Studio',
    emoji: '📸',
    templateCategory: 'photography-creative',
    defaultServices: [
      { name: 'Studio Portrait Session', duration: 60, price: 150 },
      { name: 'Product Shoot (10 items)', duration: 120, price: 250 },
    ],
  },
  {
    id: 'other',
    label: 'General Appointment Business',
    emoji: '🏢',
    templateCategory: 'professional-services',
    defaultServices: [
      { name: 'Standard Appointment', duration: 45, price: 60 },
      { name: 'Consultation Session', duration: 60, price: 90 },
    ],
  },
];

export function getTemplateServicesForIndustry(
  industry?: string | null,
  templateCategory?: string | null,
): IndustryTemplateService[] {
  if (industry) {
    const match = INDUSTRY_CONFIGS.find((ind) => ind.id === industry);
    if (match && match.defaultServices.length > 0) return match.defaultServices;
  }
  if (templateCategory) {
    const match = INDUSTRY_CONFIGS.find((ind) => ind.templateCategory === templateCategory);
    if (match && match.defaultServices.length > 0) return match.defaultServices;
  }
  return INDUSTRY_CONFIGS[0].defaultServices;
}
