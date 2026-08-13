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
