import { and, eq, gte, inArray, lt, ne, type SQL } from 'drizzle-orm';
import { bookings, staffSchedules, staffMembers, staffTimeOff } from '@oriole/database';

import { db } from '../db/index.ts';
import { getExternalCalendarBusyIntervals } from './google-calendar.ts';
import { startOfLocalDay, endOfLocalDay, zonedTimeToUtc, localDateParts } from './timezone.ts';

/* ────────────────────────────────────────────────────────────
 * Mesin availabilitas — slot generation + double-booking prevention.
 *
 * Model: jadwal mingguan per staf (dayOfWeek + menit sejak tengah malam
 * dalam zona waktu staf) → free intervals; booking aktif + cuti + event
 * eksternal kalender → busy intervals. Slot = durasi yang pas di dalam
 * free, dengan buffer staf diperhitungkan.
 *
 * Mode tanpa staf: 24/7 minus semua booking workspace (booking lama yang
 * tidak punya staf tetap memblokir — bisnis satu operator).
 * ──────────────────────────────────────────────────────────── */

/** Batas durasi booking (menit) — sinkron dengan validasi route bookings. */
export const MAX_BOOKING_DURATION_MINUTES = 720;

/** Jendela fetch booking di sekitar rentang (menit) — durasi maksimum + buffer. */
const FETCH_WINDOW_BEFORE_MS = (MAX_BOOKING_DURATION_MINUTES + 120) * 60_000;

export interface Interval {
  start: Date;
  end: Date;
}

export interface Slot {
  start: Date;
  end: Date;
}

/** Interval half-open: [a.start, a.end) ∩ [b.start, b.end) tidak kosong. */
export function intervalsOverlap(a: Interval, b: Interval): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

/** Gabungkan interval yang saling tumpang-tindih (sorted → hasil sorted). */
export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = [...list].sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: Interval[] = [];
  for (const item of sorted) {
    const last = merged[merged.length - 1];
    if (last && item.start.getTime() < last.end.getTime()) {
      if (item.end.getTime() > last.end.getTime()) last.end = item.end;
    } else {
      merged.push({ start: item.start, end: item.end });
    }
  }
  return merged;
}

/** Hapus `busy` dari `free` → sisa interval bebas (sorted). */
export function subtractIntervals(free: Interval[], busy: Interval[]): Interval[] {
  const mergedFree = mergeIntervals(free);
  const mergedBusy = mergeIntervals(busy);
  const result: Interval[] = [];
  let busyIdx = 0;
  for (const freeItem of mergedFree) {
    let cursor = freeItem.start;
    while (busyIdx < mergedBusy.length && mergedBusy[busyIdx].end.getTime() <= cursor.getTime()) {
      busyIdx += 1;
    }
    let idx = busyIdx;
    while (idx < mergedBusy.length && mergedBusy[idx].start.getTime() < freeItem.end.getTime()) {
      const busyItem = mergedBusy[idx];
      if (busyItem.start.getTime() > cursor.getTime()) {
        result.push({ start: cursor, end: busyItem.start });
      }
      if (busyItem.end.getTime() > cursor.getTime()) {
        cursor = busyItem.end.getTime() > freeItem.end.getTime() ? freeItem.end : busyItem.end;
      }
      if (cursor.getTime() >= freeItem.end.getTime()) break;
      idx += 1;
    }
    if (cursor.getTime() < freeItem.end.getTime()) {
      result.push({ start: cursor, end: freeItem.end });
    }
  }
  return result;
}

/** Lebarkan setiap interval sebesar buffer (menit) di kedua ujung. */
export function withBuffer(intervals: Interval[], bufferMinutes: number): Interval[] {
  if (!bufferMinutes || bufferMinutes <= 0) return intervals;
  const bufferMs = bufferMinutes * 60_000;
  return intervals.map((item) => ({
    start: new Date(item.start.getTime() - bufferMs),
    end: new Date(item.end.getTime() + bufferMs),
  }));
}

/**
 * Hasilkan kandidat slot: setiap interval bebas di-breakdown per step
 * (default 15 menit). Slot = [t, t+duration) dan wajib muat penuh di
 * dalam interval bebas (buffer sudah melebar di busy oleh pemanggil).
 */
export function generateSlots(
  free: Interval[],
  options: { durationMinutes: number; stepMinutes?: number; maxSlots?: number },
): Slot[] {
  const { durationMinutes, stepMinutes = 15, maxSlots = 200 } = options;
  const durationMs = durationMinutes * 60_000;
  const stepMs = Math.max(1, Math.trunc(stepMinutes)) * 60_000;
  const slots: Slot[] = [];
  for (const item of free) {
    let t = item.start.getTime();
    const endLimit = item.end.getTime();
    while (t + durationMs <= endLimit) {
      slots.push({ start: new Date(t), end: new Date(t + durationMs) });
      t += stepMs;
      if (slots.length >= maxSlots) return slots;
    }
  }
  return slots;
}

/* ────────────────────────────────────────────────────────────
 * Lapisan data — query Drizzle + komposisi busy
 * ──────────────────────────────────────────────────────────── */

export interface StaffAvailability {
  staff: typeof staffMembers.$inferSelect;
  schedules: typeof staffSchedules.$inferSelect[];
  timeOff: typeof staffTimeOff.$inferSelect[];
}

/** Muat staf + jadwal mingguan + cuti. null = staf tidak ada. */
export async function loadStaffAvailability(staffId: string): Promise<StaffAvailability | null> {
  const [staff] = await db
    .select()
    .from(staffMembers)
    .where(eq(staffMembers.id, staffId))
    .limit(1);
  if (!staff) return null;
  const [schedules, timeOff] = await Promise.all([
    db.select().from(staffSchedules).where(eq(staffSchedules.staffId, staffId)),
    db.select().from(staffTimeOff).where(eq(staffTimeOff.staffId, staffId)),
  ]);
  return { staff, schedules, timeOff };
}

/**
 * Interval busy dari booking aktif (pending/confirmed) di workspace.
 * - `staffId` di-set → hanya booking staf itu (booking tanpa staf tidak
 *   memblokir staf; ia memblokir mode tanpa staf).
 * - `staffId` null → SEMUA booking workspace (mode tanpa staf).
 * Waktu akhir dihitung dari `durationMinutes` per booking (default 60).
 */
export async function getBookingsBusy(input: {
  workspaceId: string;
  staffId?: string | null;
  from: Date;
  to: Date;
  excludeBookingId?: string;
}): Promise<Interval[]> {
  const { workspaceId, staffId, from, to, excludeBookingId } = input;
  const conditions: SQL[] = [
    eq(bookings.workspaceId, workspaceId),
    inArray(bookings.status, ['pending', 'confirmed']),
    lt(bookings.scheduledAt, to),
    gte(bookings.scheduledAt, new Date(from.getTime() - FETCH_WINDOW_BEFORE_MS)),
  ];
  if (staffId) conditions.push(eq(bookings.staffId, staffId));
  if (excludeBookingId) conditions.push(ne(bookings.id, excludeBookingId));

  const rows = await db.select().from(bookings).where(and(...conditions));
  return rows.map((row) => {
    const start = row.scheduledAt;
    const durationMs = (row.durationMinutes ?? 60) * 60_000;
    return { start, end: new Date(start.getTime() + durationMs) };
  });
}

/** Interval busy seluruh hari dari entri cuti (hari lokal zona staf). */
export function timeOffToBusy(
  timeOff: typeof staffTimeOff.$inferSelect[],
  timeZone: string,
): Interval[] {
  return timeOff.map((entry) => ({
    start: startOfLocalDay(entry.startDate, timeZone),
    end: endOfLocalDay(entry.endDate, timeZone),
  }));
}

/** Jendela jadwal mingguan untuk sebuah hari kalender (zona staf). */
export function scheduleWindowsForDay(
  schedules: typeof staffSchedules.$inferSelect[],
  day: Date,
  timeZone: string,
): Interval[] {
  const { year, month, day: dayOfMonth } = localDateParts(day, timeZone);
  const dow = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' })
    .formatToParts(day)
    .find((part) => part.type === 'weekday')?.value;
  // Konversi singkatan → angka (0=Sun..6=Sat) — hindari asumsi locale.
  const dowIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(dow ?? '');
  return schedules
    .filter((schedule) => schedule.dayOfWeek === dowIndex)
    .filter((schedule) => schedule.endMinutes > schedule.startMinutes)
    .map((schedule) => ({
      start: zonedTimeToUtc(year, month, dayOfMonth, Math.floor(schedule.startMinutes / 60), schedule.startMinutes % 60, timeZone),
      end: zonedTimeToUtc(year, month, dayOfMonth, Math.floor(schedule.endMinutes / 60), schedule.endMinutes % 60, timeZone),
    }));
}

/** Iterasi tanggal kalender dalam rentang [from, to] di zona waktu (inklusi hari). */
function eachLocalDay(from: Date, to: Date, timeZone: string): Date[] {
  const days: Date[] = [];
  let cursor = startOfLocalDay(from, timeZone);
  const last = startOfLocalDay(to, timeZone);
  while (cursor.getTime() <= last.getTime() && days.length < 400) {
    days.push(cursor);
    cursor = new Date(cursor.getTime() + 86_400_000);
  }
  return days;
}

export type SlotResult =
  | { ok: true; slots: Slot[]; busy: Interval[]; truncated: boolean }
  | { ok: false; reason: 'staff-not-found' };

/**
 * Slot yang tersedia untuk workspace dalam rentang [from, to] (instant).
 *
 * - `staffId` → free = jadwal mingguan staf (zona staf); busy = booking
 *   staf + cuti + kalender eksternal. Tanpa jadwal sama sekali → 24/7.
 * - tanpa `staffId` → free = seluruh rentang; busy = semua booking + kalender.
 */
export async function getAvailableSlots(input: {
  workspaceId: string;
  staffId?: string | null;
  from: Date;
  to: Date;
  durationMinutes: number;
}): Promise<SlotResult> {
  const { workspaceId, staffId, from, to, durationMinutes } = input;
  const duration = Math.max(1, Math.min(MAX_BOOKING_DURATION_MINUTES, Math.trunc(durationMinutes) || 60));

  let free: Interval[];
  let staffBuffer = 0;

  if (staffId) {
    const loaded = await loadStaffAvailability(staffId);
    if (!loaded) return { ok: false, reason: 'staff-not-found' };
    staffBuffer = loaded.staff.bufferMinutes;
    if (loaded.schedules.length === 0) {
      free = [{ start: from, end: to }];
    } else {
      const windows = eachLocalDay(from, to, loaded.staff.timezone).flatMap((day) =>
        scheduleWindowsForDay(loaded.schedules, day, loaded.staff.timezone),
      );
      free = windows;
    }
  } else {
    free = [{ start: from, end: to }];
  }

  const [bookingsBusy, externalBusy] = await Promise.all([
    getBookingsBusy({ workspaceId, staffId: staffId ?? null, from, to }),
    getExternalCalendarBusyIntervals(workspaceId, from, to),
  ]);

  let busy: Interval[] = [];
  if (staffId) {
    const loaded = await loadStaffAvailability(staffId);
    busy = loaded ? timeOffToBusy(loaded.timeOff, loaded.staff.timezone) : [];
  }
  busy = mergeIntervals([...busy, ...bookingsBusy, ...externalBusy]);

  const freeAfterBuffer = subtractIntervals(free, withBuffer(busy, staffBuffer));
  const slots = generateSlots(freeAfterBuffer, { durationMinutes: duration });
  return { ok: true, slots, busy, truncated: slots.length >= 200 };
}

export type AvailabilityAssert =
  | { ok: true }
  | {
      ok: false;
      reason: 'staff-not-found' | 'outside-working-hours' | 'time-off' | 'conflict';
      detail?: string;
    };

/**
 * Pastikan [start, end) bisa di-book:
 * 1. Staf ada (bila staffId di-set).
 * 2. Booking muat di dalam jadwal mingguan staf (bila staf punya jadwal).
 * 3. Tidak jatuh di hari cuti staf.
 * 4. Tidak menabrak booking aktif lain (dengan buffer staf) — double-booking.
 * 5. Tidak menabrak event eksternal kalender (two-way sync).
 *
 * Catatan: tanpa staf → hanya cek (1)-skip, (4) terhadap SEMUA booking dan (5).
 * Pengaman utama anti-race adalah cek ini yang dijalankan dalam satu
 * request sebelum insert — tanpa exclusion constraint DB (membutuhkan
 * ekstensi btree_gist yang belum tentu tersedia di Neon).
 */
export async function assertSlotAvailable(input: {
  workspaceId: string;
  staffId: string | null;
  start: Date;
  end: Date;
  excludeBookingId?: string;
}): Promise<AvailabilityAssert> {
  const { workspaceId, staffId, start, end, excludeBookingId } = input;

  let bufferMinutes = 0;
  if (staffId) {
    const loaded = await loadStaffAvailability(staffId);
    if (!loaded) return { ok: false, reason: 'staff-not-found' };
    bufferMinutes = loaded.staff.bufferMinutes;

    // Cuti: hari lokal booking jatuh dalam rentang cuti → blokir.
    const timeZone = loaded.staff.timezone;
    const dayStart = startOfLocalDay(start, timeZone);
    const dayEnd = endOfLocalDay(start, timeZone);
    for (const entry of loaded.timeOff) {
      const busyStart = startOfLocalDay(entry.startDate, timeZone);
      const busyEnd = endOfLocalDay(entry.endDate, timeZone);
      if (dayStart.getTime() < busyEnd.getTime() && busyStart.getTime() < dayEnd.getTime()) {
        return { ok: false, reason: 'time-off', detail: entry.reason ?? undefined };
      }
    }

    // Jadwal mingguan: booking wajib muat di dalam minimal satu jendela
    // (bila staf sudah punya jadwal — staf tanpa jadwal = 24/7).
    if (loaded.schedules.length > 0) {
      const windows = scheduleWindowsForDay(loaded.schedules, start, timeZone);
      const fits = windows.some(
        (window) => window.start.getTime() <= start.getTime() && end.getTime() <= window.end.getTime(),
      );
      if (!fits) return { ok: false, reason: 'outside-working-hours' };
    }
  }

  const [bookingsBusy, externalBusy] = await Promise.all([
    getBookingsBusy({ workspaceId, staffId, from: start, to: end, excludeBookingId }),
    getExternalCalendarBusyIntervals(workspaceId, start, end),
  ]);

  const request: Interval = { start, end };
  const conflicted = [...withBuffer(bookingsBusy, bufferMinutes), ...externalBusy];
  const clash = conflicted.find((item) => intervalsOverlap(item, request));
  if (clash) {
    return {
      ok: false,
      reason: 'conflict',
      detail: `Tabrakan slot ${clash.start.toISOString()}–${clash.end.toISOString()}`,
    };
  }
  return { ok: true };
}
