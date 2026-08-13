import { createHash } from 'node:crypto';

/**
 * Kontrak consent ter-version untuk channel WhatsApp BYO (unofficial).
 *
 * Teks copy yang DITAMPILKAN ke user hidup di i18n web
 * (apps/web/src/i18n/locales/{en,id}/translation.json) — di sini hanya
 * konstanta version + kunci checklist risiko + copy kanonik untuk fingerprint
 * (copyHash) yang disimpan di providerConfig sebagai jejak audit.
 *
 * Bila copy risiko berubah → naikkan WAHA_CONSENT_VERSION → user lama yang
 * belum re-consent ditolak setup-nya (409) sampai menyetujui versi baru.
 *
 * ATURAN WAJIB: menambah/mengubah/menghapus kunci di WAHA_CONSENT_RISK_ITEMS
 * adalah perubahan copy → WAJIB bareng dengan bump WAHA_CONSENT_VERSION.
 * Tanpa bump, klien lama gagal dengan 400 "kotak risiko" yang membingungkan
 * (bukan alur re-consent 409) karena every() menuntut set kunci baru.
 */

export const WAHA_CONSENT_VERSION = 2;

/** Satu catatan consent (append-only — riwayat disimpan di providerConfig.consentHistory). */
export interface WahaConsentRecord {
  version: number;
  copyHash: string;
  acceptedAt: string;
  acceptedByUserId: string;
}

/**
 * Kunci checklist risiko v2 — user harus mencentang SEMUA item untuk setuju.
 * Kunci bersifat stabil (identitas kontrak, bukan teks): teks yang tampil
 * hidup di i18n (byoRiskItem*), backend hanya memverifikasi bahwa set kunci
 * lengkap terkirim. Kunci TIDAK boleh diubah setelah dirilis.
 */
export const WAHA_CONSENT_RISK_ITEMS = ['ban', 'tos', 'expendable', 'optin'] as const;

/** Copy risiko kanonik v1 — copyHash dihitung dari string ini (audit only). */
export const WAHA_CONSENT_COPY_V1 = [
  'Unofficial WhatsApp — your number can be banned.',
  'Connecting a number through an unofficial gateway violates WhatsApp Terms of Service.',
  'Use a number you can afford to lose — never a customer number.',
].join(' ');

/** Copy risiko kanonik v2 — fingerprint checklist 4 item (audit only). */
export const WAHA_CONSENT_COPY_V2 = [
  'Unofficial WhatsApp — my number can be permanently banned without appeal.',
  'Connecting via an unofficial gateway violates WhatsApp Terms of Service.',
  'I will only use a number I can afford to lose — never a customer number or my main business line.',
  'Reminders and form sends only go to customers who messaged me first (opted in).',
].join(' ');

/** Apakah versi consent ini dikenal (copy aktif saat ini)? */
export function isWahaConsentVersionKnown(version: number): boolean {
  return version === WAHA_CONSENT_VERSION;
}

/**
 * Apakah checklist consent sah — SEMUA kunci risiko wajib dicentang.
 * Item ekstra diizinkan (forward-compatible saat item baru ditambahkan);
 * set yang tidak lengkap (termasuk array kosong / bukan array) ditolak.
 * Satu-satunya sumber kebenaran: array kosong TIDAK boleh lolos di sini
 * (zod tidak lagi menerapkan .min(1) — lihat channels.ts).
 */
export function isWahaConsentChecklistValid(checked: unknown): checked is string[] {
  return (
    Array.isArray(checked) && WAHA_CONSENT_RISK_ITEMS.every((key) => checked.includes(key))
  );
}

/** Fingerprint SHA-256 dari copy kanonik versi tertentu (jejak audit). */
export function wahaConsentCopyHash(version: number = WAHA_CONSENT_VERSION): string {
  const copy =
    version === 1
      ? WAHA_CONSENT_COPY_V1
      : version === 2
        ? WAHA_CONSENT_COPY_V2
        : '';
  return createHash('sha256').update(copy).digest('hex');
}
