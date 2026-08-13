/**
 * Katalog paket (plan) — dipakai oleh endpoint billing untuk menghitung
 * entitlement (kuota panggilan & menit per bulan) dan untuk UI.
 *
 * Harga & kuota (global, USD):
 *   Free      $0   — 10 panggilan AI / 30 menit
 *   Pro       $19  — 50 panggilan AI / 150 menit
 *   Business  $49  — 150 panggilan AI / 450 menit + 1 nomor masuk AI
 *
 * Kuota menit proporsional dengan harga agar COGS Vapi (~$0.10–0.15/menit)
 * tetap di bawah harga paket: Pro 150 menit × $0.15 = $22 (≈ harga, dan
 * pemakaian realistis jauh di bawah kapasitas), Business 450 menit × $0.15
 * = $67 — masih di bawah harga kompetitor resepsionis AI ($79–129) untuk
 * fitur unggulannya (nomor masuk), dan pemakaian penuh jarang tercapai.
 */
import { env } from './env.ts';

export type PlanId = 'free' | 'pro' | 'business';

export interface PlanInfo {
  id: PlanId;
  name: string;
  pricePerMonth: number;
  callsPerMonth: number;
  minutesPerMonth: number;
  /** Nomor telepon masuk (resepsionis AI) yang disertakan, 0 = tidak ada. */
  inboundNumbersIncluded: number;
  features: string[];
}

export const PLANS: Record<PlanId, PlanInfo> = {
  free: {
    id: 'free',
    name: 'Free',
    pricePerMonth: 0,
    callsPerMonth: 10,
    minutesPerMonth: 30,
    inboundNumbersIncluded: 0,
    features: [
      '1 staf & layanan tak terbatas',
      '10 panggilan AI / bulan',
      '30 menit bicara / bulan',
      'Riwayat panggilan 30 hari',
      'Dukungan komunitas',
    ],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    pricePerMonth: 19,
    callsPerMonth: 50,
    minutesPerMonth: 150,
    inboundNumbersIncluded: 0,
    features: [
      'Staf & layanan tak terbatas',
      'Semua channel & integrasi',
      'Sinkronisasi kalender',
      '50 panggilan AI / bulan',
      '150 menit bicara / bulan',
      'Riwayat panggilan tanpa batas',
      'Webhook & integrasi',
      'Dukungan prioritas',
    ],
  },
  business: {
    id: 'business',
    name: 'Business',
    pricePerMonth: 49,
    callsPerMonth: 150,
    minutesPerMonth: 450,
    inboundNumbersIncluded: 1,
    features: [
      'Semua fitur Pro',
      '150 panggilan AI / bulan',
      '450 menit bicara / bulan',
      '1 nomor masuk (resepsionis AI) termasuk',
      'Nomor tambahan $29/bulan',
      'Dukungan prioritas',
    ],
  },
};

/** Urutan tampilan paket di UI (dari termurah ke termahal). */
export const PLAN_ORDER: PlanId[] = ['free', 'pro', 'business'];

/** Status langganan yang dianggap sebagai paket berbayar aktif. */
export const ACTIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing']);

/**
 * Peta Paddle price ID (dari env) → PlanId. Dipakai untuk menentukan paket
 * user dari langganan Paddle-nya (subscriptions.planId = price ID Paddle).
 */
const PRICE_TO_PLAN: Record<string, PlanId> = {};
if (env.PADDLE_PRO_PRICE_ID) PRICE_TO_PLAN[env.PADDLE_PRO_PRICE_ID] = 'pro';
if (env.PADDLE_BUSINESS_PRICE_ID) PRICE_TO_PLAN[env.PADDLE_BUSINESS_PRICE_ID] = 'business';

/** Paddle price ID → PlanId; null bila price ID tidak dikenal / kosong. */
export function planFromPriceId(priceId: string | null | undefined): PlanId | null {
  return priceId ? (PRICE_TO_PLAN[priceId] ?? null) : null;
}

/** PlanId → Paddle price ID (dari env); null bila belum dikonfigurasi. */
export function priceIdForPlan(plan: PlanId): string | null {
  switch (plan) {
    case 'pro':
      return env.PADDLE_PRO_PRICE_ID ?? null;
    case 'business':
      return env.PADDLE_BUSINESS_PRICE_ID ?? null;
    default:
      return null;
  }
}
