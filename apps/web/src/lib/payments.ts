import { activeLocale } from '../i18n/format';

/** Status payment link — mirror GET /api/payments. */
export type PaymentLinkStatus = 'pending' | 'paid' | 'canceled';

/** Payment link — mirror GET/POST /api/payments. */
export interface PaymentLinkRecord {
  id: string;
  title: string;
  description: string | null;
  /** Jumlah dalam minor units (sen) — dibagi 100 untuk tampilan. */
  amountMinor: number;
  currency: string;
  status: PaymentLinkStatus;
  checkoutUrl: string | null;
  customerName: string | null;
  customerEmail: string | null;
  bookingId: string | null;
  bookingTitle: string | null;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Respons GET /api/payments. */
export interface PaymentsListResponse {
  payments: PaymentLinkRecord[];
}

/** Respons POST /api/payments & POST /api/payments/:id/cancel. */
export interface PaymentLinkResponse {
  payment: PaymentLinkRecord;
}

/**
 * Format jumlah minor units → string mata uang (Intl, locale aktif).
 * Contoh: (25000, 'USD') → "$250.00" (en) / "US$250,00" (id).
 */
export function formatPaymentAmount(amountMinor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(activeLocale(), {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amountMinor / 100);
  } catch {
    // Mata uang yang tidak dikenal Intl — fallback manual (minor → major).
    return `${(amountMinor / 100).toFixed(2)} ${currency}`;
  }
}
