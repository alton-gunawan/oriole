/**
 * Komponen kustom untuk header & event bar @ilamy/calendar di CalendarPage.
 *
 * Header menggunakan `useIlamyCalendarContext()` untuk mendapatkan state
 * (prev/next/today, view, setView) dan merender tombol bergaya Astryx.
 * Event bar menampilkan info booking (warna status + nama staf/customer).
 *
 * @module BookingsCalendarHeader
 */
import { useMemo } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  Button,
  ButtonGroup,
} from '@astryxdesign/core';
import {
  defaultTranslations,
  type CalendarEvent,
  type Dayjs,
  type Translations,
} from '@ilamy/calendar';

import { IconChevronLeft, IconChevronRight } from '../shell/icons';

export const STATUS_LEGEND = [
  { status: 'pending', color: '#f59e0b' },
  { status: 'confirmed', color: '#10b981' },
  { status: 'completed', color: '#71717a' },
  { status: 'cancelled', color: '#ef4444' },
] as const;

/** API kalender yang diangkat ke luar IlamyCalendar (via CalendarContextBridge)
 *  agar toolbar bisa dirender di header halaman, bukan di dalam kalender. */
export interface CalendarToolbarApi {
  currentDate: Dayjs;
  view: string;
  setView: (view: string, date?: Dayjs) => void;
  prevPeriod: () => void;
  nextPeriod: () => void;
  today: () => void;
  getViews: () => { name: string }[];
}

/* ── Switcher tampilan kalender (Month/Week/Day) ─────────────────────── */

/**
 * Tombol switcher tampilan kalender (bulan, minggu, hari) untuk dirender di
 * header action halaman (PageHeader).
 */
export function CalendarViewButtons({
  activeView,
  onViewChange,
}: {
  activeView: string;
  onViewChange: (view: 'month' | 'week' | 'day') => void;
}) {
  const { t } = useTranslation();
  const views = ['month', 'week', 'day'] as const;

  return (
    <div className="bookings-calendar-button-group">
      <ButtonGroup label={t('calendar.viewMode')}>
        {views.map((name) => (
          <Button
            key={name}
            label={viewLabel(name, t as unknown as SimpleT)}
            variant={activeView === name ? 'primary' : 'ghost'}
            onClick={() => onViewChange(name)}
          />
        ))}
      </ButtonGroup>
    </div>
  );
}

/* ── Navigasi kalender (Prev/Next) ───────────────────────────────────── */

/**
 * Tombol navigasi kalender (←, →) untuk dirender di header action halaman
 * (PageHeader) di sebelah kiri switcher Month/Week/Day.
 */
export function CalendarNavButtons({
  onPrev,
  onNext,
}: {
  onPrev: () => void;
  onNext: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="bookings-calendar-button-group">
      <ButtonGroup label={t('calendar.navigation')}>
        <Button
          label={t('calendar.previous')}
          variant="ghost"
          isIconOnly
          icon={<IconChevronLeft className="size-4" />}
          onClick={onPrev}
        />
        <Button
          label={t('calendar.next')}
          variant="ghost"
          isIconOnly
          icon={<IconChevronRight className="size-4" />}
          onClick={onNext}
        />
      </ButtonGroup>
    </div>
  );
}

type SimpleT = (k: string) => string;

function viewLabel(name: string, t: SimpleT): string {
  switch (name) {
    case 'month': return t('calendar.month');
    case 'week':  return t('calendar.week');
    case 'day':   return t('calendar.day');
    default:      return name;
  }
}

/* ── Event bar kustom ─────────────────────────────────────────────────── */

/**
 * Bar event yang menampilkan nama layanan + waktu + info staf/customer.
 * Diberi warna berdasarkan status booking (via inline bg dari mapping).
 * Dibungkus `<Link>` agar klik bar navigasi ke halaman detail booking.
 */
export function CalendarEventBar({ event }: { event: CalendarEvent }) {
  const d = (event.data ?? {}) as Record<string, unknown>;
  const bookingId = d.bookingId as string;
  const staffName = d.staffName as string | null;
  const customerName = d.customerName as string | null;

  const startStr = event.start.format('HH:mm');
  const endStr = event.end.format('HH:mm');

  const attendee = staffName ?? customerName;
  const eventLabel = `${event.title}, ${startStr}–${endStr}${attendee ? `, ${attendee}` : ''}`;

  return (
    <Link
      to={`/app/bookings/${bookingId}`}
      aria-label={eventLabel}
      title={eventLabel}
      className="bookings-calendar-event group flex h-full min-w-0 flex-col justify-center overflow-hidden rounded-md px-2 py-1 transition hover:-translate-y-px hover:shadow-sm"
      style={{
        backgroundColor: event.backgroundColor,
        borderLeft: `3px solid ${event.color}`,
        boxShadow: `inset 0 0 0 1px ${event.color}22`,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <span className="block truncate text-[11px] font-bold leading-tight tracking-[-0.01em] text-zinc-900 dark:text-zinc-100">
        {event.title}
      </span>
      <span className="mt-0.5 block truncate text-[10px] font-medium leading-tight text-zinc-600 dark:text-zinc-400">
        {startStr}–{endStr}{attendee ? ` · ${attendee}` : ''}
      </span>
    </Link>
  );
}

/* ── Terjemahan calendar header ───────────────────────────────────────── */

/**
 * Membangun objek Translations untuk @ilamy/calendar dari i18next `t`.
 * Hanya kunci yang dipakai header + overflow dialog diterjemahkan;
 * sisanya pakai defaultTranslations (Inggris).
 */
export function useCalendarTranslations(): Translations {
  const { t } = useTranslation();
  // i18next typed t() returns a complex union — String() coerces to plain string
  // for the Translations record type (Record<string, string>).
  return useMemo<Translations>(
    () => ({
      ...defaultTranslations,
      today: String(t('calendar.today')),
      previous: String(t('calendar.previous')),
      next: String(t('calendar.next')),
      month: String(t('calendar.month')),
      week: String(t('calendar.week')),
      day: String(t('calendar.day')),
      year: String(t('calendar.year')),
      more: String(t('calendar.more')),
      event: String(t('calendar.event')),
      events: String(t('calendar.events')),
    }),
    [t],
  );
}
