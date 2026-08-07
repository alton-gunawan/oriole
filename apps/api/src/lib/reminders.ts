import { and, eq, gte, inArray, isNotNull, isNull } from 'drizzle-orm';
import { bookings, workspaces } from '@oriole/database';

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
  // Workspace soft-deleted dianggap tidak ada → fallback default (pemanggil
  // berhenti memproses; run Inngest lama di-guard di fungsi masing-masing).
  const [workspace] = await db
    .select({ lead: workspaces.reminderLeadMinutes })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)))
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

async function safeSend(
  name: string,
  data: BookingEventData | AutoCallEventData,
): Promise<void> {
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

/* ────────────────────────────────────────────────────────────
 * Auto-call CALL-E — panggilan otomatis sesuai window workspace
 * ──────────────────────────────────────────────────────────── */

export const DEFAULT_AUTO_CALL_LEAD_HOURS = 24;

/** Setting auto-call workspace: aktif/mati + lead hours (fallback default). */
export async function resolveAutoCallSettings(workspaceId: string): Promise<{
  enabled: boolean;
  leadHours: number;
}> {
  // Workspace soft-deleted → dianggap nonaktif (auto-call tidak dijadwalkan).
  const [workspace] = await db
    .select({
      enabled: workspaces.autoCallEnabled,
      leadHours: workspaces.autoCallLeadHours,
    })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)))
    .limit(1);

  const enabled = workspace?.enabled ?? false;
  const lead = workspace?.leadHours ?? DEFAULT_AUTO_CALL_LEAD_HOURS;
  return {
    enabled,
    leadHours: Number.isFinite(lead) && lead > 0 ? lead : DEFAULT_AUTO_CALL_LEAD_HOURS,
  };
}

/** Hitung waktu auto-call: scheduledAt − lead hours. */
export function computeAutoCallAt(scheduledAt: Date, leadHours: number): Date {
  return new Date(scheduledAt.getTime() - leadHours * 3_600_000);
}

export interface AutoCallEventData {
  bookingId: string;
  workspaceId: string;
  scheduledAt: string;
  autoCallAt?: string;
  timezone?: string | null;
}

/**
 * Jadwalkan auto-call untuk booking (event terpisah dari reminder channel —
 * beda window & bisa di-reschedule tanpa menduplikasi reminder). Skip bila
 * auto-call mati atau waktu lewat. `leadHours`/`enabled` bisa di-override
 * (dipakai saat re-schedule masal setelah setting workspace berubah).
 */
export async function emitAutoCallScheduled(input: {
  workspaceId: string;
  bookingId: string;
  scheduledAt: Date;
  timezone?: string | null;
  leadHours?: number;
  enabled?: boolean;
}): Promise<void> {
  // Kedua override ada (pemanggil sudah tahu setting) → hindari query ganda.
  const settings =
    input.enabled === undefined || input.leadHours === undefined
      ? await resolveAutoCallSettings(input.workspaceId)
      : null;
  const enabled = input.enabled ?? settings?.enabled ?? false;
  if (!enabled) return;

  const leadHours = input.leadHours ?? settings?.leadHours ?? DEFAULT_AUTO_CALL_LEAD_HOURS;
  const autoCallAt = computeAutoCallAt(input.scheduledAt, leadHours);
  if (autoCallAt.getTime() <= Date.now()) return;

  await safeSend('booking/auto-call/created', {
    bookingId: input.bookingId,
    workspaceId: input.workspaceId,
    scheduledAt: input.scheduledAt.toISOString(),
    autoCallAt: autoCallAt.toISOString(),
    timezone: input.timezone ?? null,
  });
}

/** Batalkan auto-call terjadwal (booking dibatalkan / selesai / setting mati). */
export async function emitAutoCallCancelled(workspaceId: string, bookingId: string): Promise<void> {
  await safeSend('booking/auto-call/cancelled', { bookingId, workspaceId, scheduledAt: '' });
}

/**
 * Re-schedule auto-call untuk semua booking mendatang yang aktif — dipanggil
 * saat setting auto-call workspace berubah (on/off atau lead hours).
 *
 * TIDAK mengirim event cancel: run lama membatalkan dirinya sendiri saat
 * bangun (guard `lead-changed` di autoCallBooking membandingkan autoCallAt
 * dengan lead hours terkini) — ini menghindari race cancel/create yang bisa
 * mematikan run baru. Saat mati (enabled=false), run lama juga self-skip
 * lewat guard `auto-call-disabled`.
 */
export async function rescheduleWorkspaceAutoCalls(input: {
  workspaceId: string;
  enabled: boolean;
  leadHours?: number;
}): Promise<{ rescheduled: number }> {
  if (!input.enabled) return { rescheduled: 0 };

  const rows = await db
    .select({ id: bookings.id, scheduledAt: bookings.scheduledAt, timezone: bookings.timezone })
    .from(bookings)
    .where(
      and(
        eq(bookings.workspaceId, input.workspaceId),
        inArray(bookings.status, ['pending', 'confirmed']),
        // Lead window baru: jadwalkan ulang hanya booking yang masih sempat
        // dipanggil (autoCallAt-nya belum lewat).
        gte(bookings.scheduledAt, new Date(Date.now() + (input.leadHours ?? DEFAULT_AUTO_CALL_LEAD_HOURS) * 3_600_000)),
        isNotNull(bookings.phone),
      ),
    );

  for (const row of rows) {
    await emitAutoCallScheduled({
      workspaceId: input.workspaceId,
      bookingId: row.id,
      scheduledAt: row.scheduledAt,
      timezone: row.timezone,
      leadHours: input.leadHours,
      enabled: true,
    });
  }
  return { rescheduled: rows.length };
}
