import { and, desc, eq, gte } from 'drizzle-orm';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { calleCalls, subscriptions } from '@oriole/database';

import { db } from '../db/index.ts';
import { extractCallSeconds } from './calls.ts';
import { ACTIVE_SUBSCRIPTION_STATUSES, planFromPriceId, type PlanId } from './plans.ts';

/**
 * Paket dari status subscription + Paddle price ID (pure — mudah diuji):
 * subscription aktif/trialing → 'pro'; tanpa subscription → 'free'.
 */
export function planFromSubscription(
  status: string | null | undefined,
  priceId?: string | null | undefined,
): PlanId {
  if (!status || !ACTIVE_SUBSCRIPTION_STATUSES.has(status)) return 'free';
  return planFromPriceId(priceId) ?? 'pro';
}

/** Paket aktif user: subscription terbaru yang aktif/trialing. */
export async function resolvePlanId(userId: string): Promise<PlanId> {
  const [latest] = await db
    .select({ status: subscriptions.status, planId: subscriptions.planId })
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .orderBy(desc(subscriptions.createdAt))
    .limit(1);
  return planFromSubscription(latest?.status, latest?.planId);
}

export interface MonthlyUsage {
  calls: number;
  seconds: number;
}

/**
 * Pemakaian bulan berjalan (sejak awal bulan, zona server): jumlah panggilan
 * dan total durasi (detik) dari `calleCalls.result`.
 */
export async function getMonthlyUsage(
  userId: string,
  now: Date = new Date(),
): Promise<MonthlyUsage> {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const rows = await db
    .select({ result: calleCalls.result })
    .from(calleCalls)
    .where(and(eq(calleCalls.userId, userId), gte(calleCalls.createdAt, monthStart)));
  return {
    calls: rows.length,
    seconds: rows.reduce((acc, row) => acc + extractCallSeconds(row.result), 0),
  };
}

export type QuotaCheck =
  | { ok: true }
  | { ok: false; status: ContentfulStatusCode; message: string };

/**
 * Periksa hak panggilan user terhadap paketnya:
 * - Membutuhkan langganan aktif / masa trial aktif ($15/bulan).
 * - Selama masa trial 7 hari: pengguna mendapatkan gratis $5 kredit panggilan suara (~2000 detik / ~33 menit).
 * - Setelah masa aktif berbayar: panggilan suara tanpa batas kuota dengan model bayar sesuai pemakaian (pay as you use).
 */
export async function checkCallQuota(userId: string): Promise<QuotaCheck> {
  const [latest] = await db
    .select({ status: subscriptions.status, planId: subscriptions.planId })
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .orderBy(desc(subscriptions.createdAt))
    .limit(1);

  const plan = planFromSubscription(latest?.status, latest?.planId);
  if (plan === 'free') {
    return {
      ok: false,
      status: 402,
      message: 'Langganan aktif ($15/bulan) diperlukan untuk melakukan panggilan AI. Silakan mulai trial 7 hari gratis (termasuk gratis $5 kredit suara) untuk melanjutkan.',
    };
  }

  // Jika status masih dalam masa trial (trialing), batasi pemakaian sesuai $5 kredit suara (~2000 detik).
  if (latest?.status === 'trialing') {
    const usage = await getMonthlyUsage(userId);
    const maxTrialSeconds = 2000; // $5 kredit @ ~$0.15/menit (~33.3 menit)
    if (usage.seconds >= maxTrialSeconds) {
      return {
        ok: false,
        status: 402,
        message: 'Kredit panggilan suara gratis $5 masa trial sudah terpakai. Panggilan berikutnya akan diproses setelah masa trial selesai atau saat langganan aktif.',
      };
    }
  }

  return { ok: true };
}
