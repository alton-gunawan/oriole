/**
 * Katalog paket (plan) — dipakai oleh endpoint billing untuk menghitung
 * status langganan dan untuk UI.
 *
 * Model langganan: 1 subscription plan ($19/bulan)
 * - 7-day free trial, cancel anytime
 * - Pay only for the voice calls you use
 * - Unlimited bookings, no setup fee, semua fitur otomatisasi booking & staf.
 */
import { env } from './env.ts';

export type PlanId = 'free' | 'pro';

export interface PlanInfo {
  id: PlanId;
  name: string;
  pricePerMonth: number;
  trialDays: number;
  trialCreditUsd: number;
  creditCardRequired: boolean;
  usagePricing: string;
  cancelAnytime: boolean;
  features: string[];
}

export const PLANS: Record<PlanId, PlanInfo> = {
  free: {
    id: 'free',
    name: 'Free',
    pricePerMonth: 0,
    trialDays: 0,
    trialCreditUsd: 0,
    creditCardRequired: false,
    usagePricing: '',
    cancelAnytime: false,
    features: ['Belum ada langganan aktif'],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    pricePerMonth: 19,
    trialDays: 7,
    trialCreditUsd: 5,
    creditCardRequired: true,
    usagePricing: '+ pay only for the voice calls you use',
    cancelAnytime: true,
    features: [
      'Book appointments',
      'Confirm appointments',
      'Handle rescheduling',
      'Handle cancellations',
      'Manage staff & services',
      'Keep your existing phone number',
      'Unlimited bookings',
      'No setup fee',
    ],
  },
};

/** Urutan tampilan paket di UI. */
export const PLAN_ORDER: PlanId[] = ['pro'];

/** Status langganan yang dianggap sebagai paket berbayar aktif. */
export const ACTIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing']);

/**
 * Peta Paddle price ID (dari env) → PlanId.
 */
const PRICE_TO_PLAN: Record<string, PlanId> = {};
if (env.PADDLE_PRO_PRICE_ID) PRICE_TO_PLAN[env.PADDLE_PRO_PRICE_ID] = 'pro';
if (env.PADDLE_BUSINESS_PRICE_ID) PRICE_TO_PLAN[env.PADDLE_BUSINESS_PRICE_ID] = 'pro';

/** Paddle price ID → PlanId; null bila price ID tidak dikenal / kosong. */
export function planFromPriceId(priceId: string | null | undefined): PlanId | null {
  return priceId ? (PRICE_TO_PLAN[priceId] ?? null) : null;
}

/** PlanId → Paddle price ID (dari env); null bila belum dikonfigurasi. */
export function priceIdForPlan(plan: PlanId): string | null {
  switch (plan) {
    case 'pro':
      return env.PADDLE_PRO_PRICE_ID ?? null;
    default:
      return null;
  }
}
