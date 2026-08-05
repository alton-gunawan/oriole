/**
 * Katalog paket (plan) — dipakai oleh endpoint billing untuk menghitung
 * entitlement (kuota panggilan & menit per bulan) dan untuk UI.
 */
export type PlanId = 'free' | 'pro';

export interface PlanInfo {
  id: PlanId;
  name: string;
  pricePerMonth: number;
  callsPerMonth: number;
  minutesPerMonth: number;
  features: string[];
}

export const PLANS: Record<PlanId, PlanInfo> = {
  free: {
    id: 'free',
    name: 'Free',
    pricePerMonth: 0,
    callsPerMonth: 10,
    minutesPerMonth: 30,
    features: [
      '10 panggilan AI / bulan',
      '30 menit bicara / bulan',
      'Riwayat panggilan 30 hari',
      'Dukungan komunitas',
    ],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    pricePerMonth: 29,
    callsPerMonth: 500,
    minutesPerMonth: 2000,
    features: [
      '500 panggilan AI / bulan',
      '2.000 menit bicara / bulan',
      'Riwayat panggilan tanpa batas',
      'Webhook & integrasi',
      'Dukungan prioritas',
    ],
  },
};

/** Status langganan yang dianggap sebagai paket berbayar aktif. */
export const ACTIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing']);
