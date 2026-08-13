/**
 * BookingRecord → IlamyCalendar CalendarEvent mapping.
 *
 * Pure function (tanpa React/hook) supaya bisa diuji unit di node env.
 * Dipakai di BookingsPage untuk menampilkan booking di view kalender.
 */
import type { CalendarEvent } from '@ilamy/calendar';
import { dayjs } from './dayjs-setup';

import type { BookingRecord } from './bookings';

export interface CalendarDateRange {
  start: string;
  end: string;
}

/**
 * Intersect the calendar's visible range with the optional date filter from
 * the Bookings page. Returning null prevents an invalid `from > to` request
 * when the user navigates outside the selected filter range.
 */
export function intersectCalendarDateRange(
  visibleRange: CalendarDateRange,
  fromDate?: string,
  toDate?: string,
): CalendarDateRange | null {
  const filterStart = fromDate ? new Date(`${fromDate}T00:00:00`).toISOString() : null;
  const filterEnd = toDate ? new Date(`${toDate}T23:59:59.999`).toISOString() : null;
  const start =
    filterStart && filterStart > visibleRange.start ? filterStart : visibleRange.start;
  const end = filterEnd && filterEnd < visibleRange.end ? filterEnd : visibleRange.end;

  return start <= end ? { start, end } : null;
}

/**
 * Warna per status booking — hex, selaras dengan STATUS_BADGE & STATUS_DOT
 * yang sudah ada di BookingsPage (zinc/amber/emerald/red).
 */
const STATUS_COLOR: Record<BookingRecord['status'], string> = {
  pending: '#f59e0b',      // amber-500
  confirmed: '#10b981',    // emerald-500
  completed: '#71717a',    // zinc-500
  cancelled: '#ef4444',    // red-500
};

/** Background variant per status — lebih pucat dari foreground. */
const STATUS_BG: Record<BookingRecord['status'], string> = {
  pending: '#fef3c7',      // amber-100
  confirmed: '#d1fae5',    // emerald-100
  completed: '#f4f4f5',    // zinc-100
  cancelled: '#fee2e2',    // red-100
};

/**
 * Konversi daftar booking menjadi CalendarEvent[]
 * untuk @ilamy/calendar (week/month/day view).
 *
 * @param bookings   Baris booking yang sudah di-filter oleh API (status,
 *                   title, customer, dateRange) sesuai URL search params.
 * @param staffNameById  Map id staf → nama (untuk menampilkan nama staf di bar event).
 */
export function toCalendarEvents(
  bookings: BookingRecord[],
  staffNameById: Map<string, string>,
): CalendarEvent[] {
  return bookings.map((b) => {
    const start = dayjs.utc(b.scheduledAt);
    const duration = b.durationMinutes > 0 ? b.durationMinutes : 30;
    const end = start.add(duration, 'minute');
    const staffName = b.staffId ? staffNameById.get(b.staffId) ?? null : null;

    return {
      id: b.id,
      // Gunakan || (bukan ??) agar string kosong juga jatuh ke fallback.
      title: b.serviceName || b.title || '—',
      start,
      end,
      color: STATUS_COLOR[b.status],
      backgroundColor: STATUS_BG[b.status],
      data: {
        bookingId: b.id,
        status: b.status,
        serviceName: b.serviceName,
        customerName: b.customerName,
        phone: b.phone,
        staffName,
      } satisfies Record<string, unknown>,
    };
  });
}
