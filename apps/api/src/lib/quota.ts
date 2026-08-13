import { and, desc, eq, gte } from 'drizzle-orm';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { calleCalls, subscriptions } from '@oriole/database';

import { db } from '../db/index.ts';
import { extractCallSeconds } from './calls.ts';
import { ACTIVE_SUBSCRIPTION_STATUSES, PLANS, planFromPriceId, type PlanId } from './plans.ts';

/**
 * Paket dari status subscription + Paddle price ID (pure — mudah diuji):
 * subscription aktif/trialing → paket sesuai price ID (Business bila price
 * ID-nya terdaftar di env, selain itu 'pro'); tanpa subscription → 'free'.
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
 * Periksa kuota bulanan (jumlah panggilan DAN total menit) user terhadap
 * paketnya — mencegah abuse biaya CALL-E tanpa langganan aktif.
 *
 * Catatan: check-then-act tidak atomik (dua request konkuren bisa lolos
 * bersamaan); pemanggil (auto-call Inngest) serial per booking lewat guard
 * call-in-flight di placeBookingCall. Untuk penegakan atomik perlu tabel
 * counter + transaksi.
 */
export async function checkCallQuota(userId: string): Promise<QuotaCheck> {
  const plan = await resolvePlanId(userId);
  const usage = await getMonthlyUsage(userId);
  const planInfo = PLANS[plan];

  if (usage.calls >= planInfo.callsPerMonth) {
    return {
      ok: false,
      status: 429,
      message: `Kuota panggilan bulanan paket ${planInfo.name} (${planInfo.callsPerMonth} panggilan) sudah tercapai. Tingkatkan paket untuk melanjutkan.`,
    };
  }
  if (usage.seconds >= planInfo.minutesPerMonth * 60) {
    return {
      ok: false,
      status: 429,
      message: `Kuota menit bicara bulanan paket ${planInfo.name} (${planInfo.minutesPerMonth} menit) sudah tercapai. Tingkatkan paket untuk melanjutkan.`,
    };
  }
  return { ok: true };
}
