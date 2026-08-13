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
import { withBookingTitle } from './booking-title.ts';
import { placeBookingCall } from './place-call.ts';
import { countCallAttempts } from './booking-goal.ts';
import { checkCallQuota } from './quota.ts';

/**
 * Susun goal & jalankan panggilan Vapi untuk sebuah booking — dipakai fungsi
 * Inngest `autoCallBooking` (satu-satunya pemanggil saat ini). Penempatan
 * panggilan lewat `placeBookingCall` (reserve → reconcile → create → commit)
 * agar retry Inngest tidak menggandakan panggilan dan crash di tengah tidak
 * menghilangkan panggilan.
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
  | { status: 'placed'; callId: string; goalType: GoalType; calleStatus: string | null }
  | { status: 'skipped'; reason: string };


export async function placeAutoCall(input: PlaceAutoCallInput): Promise<PlaceAutoCallResult> {
  const [row] = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.id, input.bookingId), eq(bookings.workspaceId, input.workspaceId)))
    .limit(1);
  if (!row) return { status: 'skipped', reason: 'booking-not-found' };
  // Title booking = nama layanan katalog (kolom title sudah dihapus).
  const booking = await withBookingTitle(input.workspaceId, row);
  if (booking.status !== 'pending' && booking.status !== 'confirmed') {
    return { status: 'skipped', reason: `status-${booking.status}` };
  }
  // Snapshot lokal agar narrowing non-null bertahan (TS me-reset narrowing
  // property setelah pemanggilan async lain).
  const phone = booking.phone;
  if (!phone) return { status: 'skipped', reason: 'no-phone' };

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

  // `booking.phone` sudah di-narrow non-null oleh guard di atas. Nama
  // panggilan = jejak audit + basis parse webhook (parseCallName). AutoCallAt
  // ikut agar panggilan dari run baru (re-schedule) tidak tertukar dengan
  // run lama (dan reservasi retry tidak saling dedupe).
  const placed = await placeBookingCall({
    workspaceId: input.workspaceId,
    bookingId: booking.id,
    userId: input.userId ?? booking.userId,
    phone,
    prompt: config.prompt,
    language: config.language,
    businessName: workspace.name,
    customerName: booking.customerName,
    goalType: config.goalType,
    callName: `booking:${booking.id}:${config.goalType}:auto-call:${input.autoCallAt ?? 'now'}`,
  });

  if (placed.status === 'skipped') {
    return { status: 'skipped', reason: placed.reason };
  }
  return { status: 'placed', callId: placed.callId, goalType: placed.goalType, calleStatus: placed.calleStatus };
}
