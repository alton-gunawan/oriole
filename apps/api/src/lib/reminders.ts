import { eq } from 'drizzle-orm';
import { workspaces } from '@oriole/database';

import { db } from '../db/index.ts';
import { inngest } from '../inngest/client.ts';

/**
 * Automatic reminders (P1) — lapisan penjadwalan berbasis event Inngest.
 *
 * Alur: booking dibuat / dijadwal ulang → `booking/created` (berisi
 * `reminderAt`) → fungsi `remindBooking` tidur sampai reminderAt lalu
 * mengirim ke semua channel yang terhubung. Booking dibatalkan/selesai
 * → `booking/cancelled` / `booking/completed` membatalkan run (cancelOn).
 *
 * Emit helper sengaja menelan error (log warn): kegagalan queue Inngest
 * (mis. event key belum disetel di dev) TIDAK boleh menggagalkan operasi
 * booking utama. Guard ulang status di dalam fungsi tetap menjadi jaring
 * pengaman bila event cancel hilang.
 */

export const DEFAULT_REMINDER_LEAD_MINUTES = 120;

/** Lead time (menit sebelum jadwal) dari workspace, fallback default. */
export async function resolveReminderLeadMinutes(workspaceId: string): Promise<number> {
  const [workspace] = await db
    .select({ lead: workspaces.reminderLeadMinutes })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  const lead = workspace?.lead ?? DEFAULT_REMINDER_LEAD_MINUTES;
  return Number.isFinite(lead) && lead > 0 ? lead : DEFAULT_REMINDER_LEAD_MINUTES;
}

/** Hitung waktu kirim reminder: scheduledAt − lead minutes. */
export function computeReminderAt(scheduledAt: Date, leadMinutes: number): Date {
  return new Date(scheduledAt.getTime() - leadMinutes * 60_000);
}

export interface BookingEventData {
  bookingId: string;
  workspaceId: string;
  scheduledAt: string;
  reminderAt?: string;
  timezone?: string | null;
}

async function safeSend(name: string, data: BookingEventData): Promise<void> {
  try {
    await inngest.send({ name, data });
  } catch (error) {
    // Event hilang = reminder tidak pernah terkirim (senyap di produksi) —
    // log di level ERROR agar terlihat di monitoring.
    console.error(`[reminders] GAGAL mengirim event ${name}:`, error);
  }
}

/**
 * Jadwalkan reminder untuk booking. Lewat-lewat (reminderAt di masa lalu)
 * di-skip — tidak ada gunanya menidurkan run untuk waktu yang sudah lewat.
 */
export async function emitBookingCreated(input: {
  workspaceId: string;
  bookingId: string;
  scheduledAt: Date;
  timezone?: string | null;
  leadMinutes?: number;
}): Promise<void> {
  const lead = input.leadMinutes ?? (await resolveReminderLeadMinutes(input.workspaceId));
  const reminderAt = computeReminderAt(input.scheduledAt, lead);
  if (reminderAt.getTime() <= Date.now()) return;

  await safeSend('booking/created', {
    bookingId: input.bookingId,
    workspaceId: input.workspaceId,
    scheduledAt: input.scheduledAt.toISOString(),
    reminderAt: reminderAt.toISOString(),
    timezone: input.timezone ?? null,
  });
}

/** Batalkan reminder terjadwal (booking dibatalkan / dijadwal ulang / dihapus). */
export async function emitBookingCancelled(workspaceId: string, bookingId: string): Promise<void> {
  await safeSend('booking/cancelled', { bookingId, workspaceId, scheduledAt: '' });
}

/** Batalkan reminder (booking selesai diproses, mis. panggilan CALL-E sukses). */
export async function emitBookingCompleted(workspaceId: string, bookingId: string): Promise<void> {
  await safeSend('booking/completed', { bookingId, workspaceId, scheduledAt: '' });
}
