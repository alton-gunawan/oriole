import { and, eq } from 'drizzle-orm';
import type { BookingGoalContext } from '@oriole/call-goals';
import { calleCalls, type Database } from '@oriole/database';

const FAILED_STATUSES = new Set(['failed', 'error']);

/** Status panggilan yang masih berjalan (belum terminal) — Vapi & legacy CALL-E. */
const IN_FLIGHT_STATUSES = new Set([
  'scheduled',
  'queued',
  'ringing',
  'in-progress',
  'forwarding',
  'pending',
]);

/** Hitung jumlah attempt & attempt gagal dari baris calle_calls. */
export function countCallAttempts(calls: { status: string | null }[]): {
  total: number;
  failed: number;
} {
  return {
    total: calls.length,
    failed: calls.filter((call) => call.status && FAILED_STATUSES.has(call.status)).length,
  };
}

/**
 * Guard anti-panggilan-ganda: cek apakah sudah ada panggilan yang masih
 * berjalan (non-terminal) untuk (booking, goalType) yang sama. Dipakai
 * `placeBookingCall` (lib/place-call.ts) sebelum menempatkan panggilan —
 * retry Inngest / klik ganda tidak boleh membuat panggilan paralel.
 * Mengembalikan row bila ada.
 */
export async function findInFlightCall(
  db: Database,
  bookingId: string,
  goalType: string,
): Promise<{ id: string; calleCallId: string } | undefined> {
  const rows = await db
    .select({
      id: calleCalls.id,
      calleCallId: calleCalls.calleCallId,
      status: calleCalls.status,
    })
    .from(calleCalls)
    .where(and(eq(calleCalls.bookingId, bookingId), eq(calleCalls.goalType, goalType)));
  return rows.find((row) => row.status && IN_FLIGHT_STATUSES.has(row.status));
}

/**
 * Bangun `BookingGoalContext` (input `determineCallGoal`) dari row booking +
 * riwayat panggilan yang tertaut ke booking itu.
 */
export async function buildBookingGoalContext(
  db: Database,
  booking: {
    id: string;
    title: string;
    status: BookingGoalContext['status'];
    scheduledAt: Date;
    timezone?: string | null;
    customerName?: string | null;
    phone?: string | null;
    changeRequested: boolean;
    noShowCount: number;
  },
): Promise<BookingGoalContext> {
  const calls = await db
    .select({ status: calleCalls.status })
    .from(calleCalls)
    .where(eq(calleCalls.bookingId, booking.id));
  const attempts = countCallAttempts(calls);

  return {
    id: booking.id,
    title: booking.title,
    status: booking.status,
    scheduledAt: booking.scheduledAt.toISOString(),
    timezone: booking.timezone ?? null,
    customerName: booking.customerName ?? null,
    phone: booking.phone ?? null,
    changeRequested: booking.changeRequested,
    noShowCount: booking.noShowCount,
    previousCallAttempts: attempts.total,
    failedCallAttempts: attempts.failed,
  };
}
