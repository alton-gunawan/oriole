import { and, eq, isNull } from 'drizzle-orm';
import {
  composeCallGoal,
  determineCallGoal,
  type BookingGoalContext,
  type BusinessGoalContext,
  type GoalCustomization,
  type GoalType,
} from '@oriole/call-goals';
import { bookings, calleCalls, workspaces } from '@oriole/database';

import { db } from '../db/index.ts';
import { env } from './env.ts';
import { calle } from '../services/calle.ts';
import { countCallAttempts } from './booking-goal.ts';
import { checkCallQuota } from './quota.ts';

/**
 * Susun goal & jalankan panggilan CALL-E untuk sebuah booking — dipakai fungsi
 * Inngest `autoCallBooking` (satu-satunya pemanggil saat ini). Idempotency key
 * berbasis (bookingId, goalType) mencegah panggilan ganda saat Inngest retry.
 */
export interface PlaceAutoCallInput {
  workspaceId: string;
  bookingId: string;
  userId?: string | null;
  /** Override window reminder workspace — menentukan keputusan goal. */
  reminderWindowHours?: number;
  /**
   * Waktu auto-call terjadwal (ISO) — ikut dalam idempotency key agar panggilan
   * dari run yang berbeda (mis. setelah re-schedule) tidak saling dedupe.
   */
  autoCallAt?: string;
}

export type PlaceAutoCallResult =
  | { status: 'placed'; callId: string; goalType: GoalType; calleStatus: string }
  | { status: 'skipped'; reason: string };

/** Map bahasa panggilan → locale recipient CALL-E. */
function localeFor(language: string): string {
  return language === 'id' ? 'id-ID' : 'en-US';
}

export async function placeAutoCall(input: PlaceAutoCallInput): Promise<PlaceAutoCallResult> {
  const [booking] = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.id, input.bookingId), eq(bookings.workspaceId, input.workspaceId)))
    .limit(1);
  if (!booking) return { status: 'skipped', reason: 'booking-not-found' };
  if (booking.status !== 'pending' && booking.status !== 'confirmed') {
    return { status: 'skipped', reason: `status-${booking.status}` };
  }
  if (!booking.phone) return { status: 'skipped', reason: 'no-phone' };

  const [workspace] = await db
    .select({
      name: workspaces.name,
      industry: workspaces.industry,
      callGoalLanguage: workspaces.callGoalLanguage,
    })
    .from(workspaces)
    .where(and(eq(workspaces.id, input.workspaceId), isNull(workspaces.deletedAt)))
    .limit(1);
  if (!workspace) return { status: 'skipped', reason: 'workspace-not-found' };

  const calls = await db
    .select({ status: calleCalls.status })
    .from(calleCalls)
    .where(eq(calleCalls.bookingId, booking.id));
  const attempts = countCallAttempts(calls);

  const context: BookingGoalContext = {
    id: booking.id,
    title: booking.title,
    status: booking.status,
    scheduledAt: booking.scheduledAt.toISOString(),
    timezone: booking.timezone,
    customerName: booking.customerName,
    phone: booking.phone,
    changeRequested: booking.changeRequested,
    noShowCount: booking.noShowCount,
    previousCallAttempts: attempts.total,
    failedCallAttempts: attempts.failed,
  };

  const decision = determineCallGoal(context, {
    reminderWindowHours: input.reminderWindowHours,
  });
  const business: BusinessGoalContext = {
    id: input.workspaceId,
    name: workspace.name,
    industry: booking.industry ?? workspace.industry,
    language: workspace.callGoalLanguage === 'id' ? 'id' : 'en',
  };

  // Kustomisasi tersimpan di booking (override goal type / instruksi) tetap
  // dihormati pada panggilan otomatis.
  const customization: GoalCustomization | undefined =
    booking.goalType || booking.customInstruction
      ? {
          goalType: booking.goalType as GoalType | undefined,
          customInstruction: booking.customInstruction,
        }
      : undefined;

  const config = composeCallGoal({ booking: context, business, customization }, decision);
  if (!config) return { status: 'skipped', reason: 'no-goal' };

  const quota = await checkCallQuota(input.userId ?? booking.userId);
  if (!quota.ok) {
    return { status: 'skipped', reason: `quota-${quota.status}` };
  }

  // `booking.phone` sudah di-narrow non-null oleh guard di atas.
  const createdCall = await calle.calls.create(
    {
      task: config.prompt,
      recipient: { phone: booking.phone, locale: localeFor(config.language) },
      resultSchema: config.resultSchema,
      metadata: {
        bookingId: booking.id,
        workspaceId: input.workspaceId,
        userId: input.userId ?? booking.userId,
        goalType: config.goalType,
        source: 'auto-call',
      },
      webhookUrl: `${env.API_URL}/api/webhooks/calle`,
    },
    // Idempotency: retry Inngest yang sama tidak boleh membuat panggilan baru.
    // AutoCallAt ikut dalam key — panggilan baru dari run baru (re-schedule)
    // tidak ter-dedupe ke panggilan run lama.
    {
      idempotencyKey: `booking:${booking.id}:${config.goalType}:${input.autoCallAt ?? 'manual'}`,
    },
  );

  await db.insert(calleCalls).values({
    calleCallId: createdCall.id,
    userId: input.userId ?? booking.userId,
    workspaceId: input.workspaceId,
    bookingId: booking.id,
    phone: booking.phone,
    task: config.prompt,
    goalType: config.goalType,
    status: createdCall.status,
  }).onConflictDoNothing({ target: calleCalls.calleCallId });
  await db
    .update(bookings)
    .set({ calleCallId: createdCall.id, updatedAt: new Date() })
    .where(eq(bookings.id, booking.id));

  return { status: 'placed', callId: createdCall.id, goalType: config.goalType, calleStatus: createdCall.status };
}
