import { type CurrencyCode } from '@paddle/paddle-node-sdk';

import { paddle } from '../services/paddle.ts';
import { env } from './env.ts';

/**
 * Global Payments (Paddle — Merchant of Record).
 *
 * Paddle dipakai untuk pembayaran customer satu kali (deposit / biaya layanan)
 * lewat hosted checkout. Berbeda dari billing subscription: pembayaran di sini
 * dibuat per-payment-link dengan NON-CATALOG PRICE (jumlah bebas per link,
 * tanpa perlu membuat product/price di dashboard Paddle).
 *
 * Semua kredensial server-side (env PADDLE_API_KEY) — workspace hanya perlu
 * "menghubungkan" integrasi di halaman Integrations, tidak memasukkan secret.
 */

/** Deteksi placeholder (.env.example) — kredensial sungguhan wajib di produksi. */
function isPlaceholder(value: string | undefined | null): boolean {
  if (!value) return true;
  return /\.\.\.|xxxx|placeholder/i.test(value);
}

/**
 * Paddle siap memproses pembayaran customer (hanya butuh API key — checkout
 * dibuat server-side, tanpa PADDLE_CLIENT_TOKEN frontend). Dinilai per
 * pemanggilan agar perubahan env tidak butuh restart (dan testable).
 */
export function isPaddlePaymentsConfigured(): boolean {
  return !isPlaceholder(env.PADDLE_API_KEY);
}

/** Mata uang default untuk payment link. */
export const DEFAULT_PAYMENT_CURRENCY: CurrencyCode = 'USD';

/**
 * Daftar mata uang yang didukung SDK Paddle (global — Merchant of Record
 * menangani pajak & metode pembayaran lokal per negara). Validasi di sini
 * memberi pesan 400 yang jelas sebelum API Paddle menolak 4xx/5xx.
 * Daftar ini SATU-SATUNYA sumber kebenaran (sinkron dengan tipe SDK).
 */
const PADDLE_CURRENCIES = [
  'USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'CLP', 'HKD', 'SGD',
  'SEK', 'ARS', 'BRL', 'CNY', 'COP', 'CZK', 'DKK', 'HUF', 'ILS', 'INR',
  'KRW', 'MXN', 'NOK', 'NZD', 'PEN', 'PLN', 'RUB', 'THB', 'TRY', 'TWD',
  'UAH', 'VND', 'ZAR',
] as const satisfies readonly CurrencyCode[];

/** Validasi kode mata uang (normalisasi ke huruf besar). */
export function isValidCurrency(currency: string): currency is CurrencyCode {
  return (PADDLE_CURRENCIES as readonly string[]).includes(currency.trim().toUpperCase());
}

/**
 * Konversi nominal major units (mis. 29.99) → minor units (2999).
 * Presisi aman: dua desimal maksimal, tanpa float rounding (parse dari string).
 */
export function toMinorUnits(amount: number): number | null {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const [whole, fraction = ''] = String(amount).split('.');
  if (!/^\d+$/.test(whole) || !/^\d{0,2}$/.test(fraction)) return null;
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

/**
 * Ekstrak pesan kesalahan asli dari error SDK Paddle (mis. detail kaya
 * "Transaction balance is less than what we can charge...") supaya kegagalan
 * checkout tidak berubah menjadi pesan generik yang membingungkan.
 */
export function paddleErrorDetail(err: unknown): string | null {
  if (err && typeof err === 'object') {
    const direct = (err as { detail?: unknown }).detail;
    if (typeof direct === 'string' && direct) return direct;
    const apiError = (err as { error?: { detail?: string } }).error;
    if (apiError?.detail) return apiError.detail;
  }
  return err instanceof Error ? err.message : null;
}

export class PaddleCheckoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaddleCheckoutError';
  }
}

/**
 * Buat transaksi one-time di Paddle dengan non-catalog price (jumlah bebas)
 * dan kembalikan URL hosted checkout. `customData` mengikat transaksi ke
 * payment link kami — webhook `transaction.completed` memakainya untuk
 * menandai link lunas (lihat onPaddleEvent di inngest/functions.ts).
 */
export async function createPaddleCheckout(input: {
  title: string;
  description: string | null;
  amountMinor: number;
  /** Sudah divalidasi via isValidCurrency sebelum dipanggil. */
  currency: CurrencyCode;
  paymentLinkId: string;
  workspaceId: string;
}): Promise<{ transactionId: string; checkoutUrl: string }> {
  const transaction = await paddle.transactions.create({
    items: [
      {
        quantity: 1,
        price: {
          description: input.description?.trim() || input.title,
          unitPrice: {
            amount: String(input.amountMinor),
            currencyCode: input.currency,
          },
          // Kategori pajak 'standard' — Paddle (MoR) menghitung & menagih
          // pajak global sesuai negara pembeli; nilai transaksi dihitung
          // dari amount yang dikirim.
          product: { name: input.title, taxCategory: 'standard' },
        },
      },
    ],
    // Kunci kontrak webhook → payment link. JANGAN ubah nama field tanpa
    // menyesuaikan onPaddleEvent (custom_data.payment_link_id).
    // Email customer TIDAK dikirim di sini — Paddle mengumpulkannya di
    // hosted checkout dan `transaction.completed` mengembalikannya
    // (payload.customer.email → disimpan oleh onPaddleEvent).
    customData: { payment_link_id: input.paymentLinkId, workspace_id: input.workspaceId },
  });

  if (!transaction.id || !transaction.checkout?.url) {
    throw new PaddleCheckoutError('Paddle tidak mengembalikan URL checkout');
  }
  return { transactionId: transaction.id, checkoutUrl: transaction.checkout.url };
}

/**
 * Batalkan transaksi Paddle (status → canceled) sehingga URL checkout yang
 * sudah dibagikan TIDAK bisa dipakai lagi. Melempar bila Paddle menolak —
 * pemanggil TIDAK boleh menandai link canceled secara lokal sebelum call ini
 * sukses (jika tidak, link yang masih hidup akan tampak mati di UI).
 */
export async function cancelPaddleTransaction(transactionId: string): Promise<void> {
  await paddle.transactions.update(transactionId, { status: 'canceled' });
}
