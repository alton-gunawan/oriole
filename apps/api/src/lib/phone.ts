import { z } from 'zod';

/**
 * Normalisasi nomor telepon: buang semua karakter non-digit, pertahankan
 * awalan `+` bila ada. Contoh:
 *   "0812-3456-7890" → "081234567890"
 *   "+62 812 3456 7890" → "+628123456789"
 *   "(021) 555-0100" → "0215550100"
 */
export function normalizePhone(value: string): string {
  const trimmed = value.trim();
  const plus = trimmed.startsWith('+') ? '+' : '';
  const digits = trimmed.replace(/[^\d]/g, '');
  return `${plus}${digits}`;
}

/** Panjang digit mengikuti rentang E.164 (8–15 digit), `+` opsional. */
export function isValidPhone(value: string): boolean {
  return /^\+?\d{8,15}$/.test(value);
}

/**
 * Schema zod untuk field nomor telepon — menormalkan input dan menolak
 * nilai yang jelas-jelas bukan nomor (mencegah data sampah masuk ke
 * CALL-E & kontak). Sifatnya pragmatis: format lokal (08xx) tetap
 * diterima karena tidak memaksa country code.
 */
export const phoneField = z
  .string()
  .trim()
  .min(1, 'Nomor telepon wajib diisi')
  .max(50, 'Nomor telepon terlalu panjang')
  .transform(normalizePhone)
  .refine(isValidPhone, {
    message: 'Nomor telepon tidak valid (8–15 digit, boleh diawali +)',
  });
