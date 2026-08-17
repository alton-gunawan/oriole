import { useCallback, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';

import { Button } from '@astryxdesign/core';
import { IlamyCalendar } from '@ilamy/calendar';

import { ApiError, apiFetch } from '../../lib/api';
import { toCalendarEvents, type CalendarDateRange } from '../../lib/bookings-calendar';
import { dayjs } from '../../lib/dayjs-setup';
import type { BookingRecord, BookingsListResponse } from '../../lib/bookings';
import type { StaffListResponse } from '../../lib/staff';
import { useWorkspaceStore } from '../../stores/workspace';
import { IconAlertTriangle, IconCalendar } from '../shell/icons';
import {
  CalendarEventBar,
  CalendarHeader,
  useCalendarTranslations,
} from './BookingsCalendarHeader';
import { PageHeader, ReloadMenuButton } from '../shell/ui';

const CALENDAR_VIEWS = ['month', 'week', 'day'] as const;
type CalendarView = (typeof CALENDAR_VIEWS)[number];

export function CalendarPage() {
  const { t } = useTranslation();
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);

  // Nama staf per id — untuk menampilkan nama staf di event bar kalender.
  const { data: staffPage } = useQuery({
    queryKey: ['staff', activeWorkspaceId],
    queryFn: () => apiFetch<StaffListResponse>('/staff'),
    enabled: Boolean(activeWorkspaceId),
    // Retry dengan backoff (1s/2s/4s default react-query) — kegagalan sesaat
    // (API restart, Neon cold-start) pulih sendiri tanpa user klik Retry.
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 3,
  });
  const staffNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const staff of staffPage?.staff ?? []) map.set(staff.id, staff.name);
    return map;
  }, [staffPage]);

  // View kalender (month/week/day) — dipersist di URL agar bisa dibagikan.
  const [searchParams, setSearchParams] = useSearchParams();
  const rawCalendarView = searchParams.get('calendarView');
  const calendarView: CalendarView = CALENDAR_VIEWS.includes(
    rawCalendarView as CalendarView,
  )
    ? (rawCalendarView as CalendarView)
    : 'month';

  // Range awal agar kalender tidak menunggu callback internal untuk menampilkan
  // booking saat pertama kali dibuka. IlamyCalendar akan segera menggantinya
  // dengan range persis untuk month/week/day lewat onDateChange.
  const [calendarRange, setCalendarRange] = useState<CalendarDateRange>(() => {
    const monthStart = dayjs().startOf('month');
    const monthEnd = monthStart.endOf('month');
    const leadingDays = (monthStart.day() + 6) % 7;
    const trailingDays = (7 - monthEnd.day()) % 7;
    return {
      start: monthStart.subtract(leadingDays, 'day').startOf('day').toISOString(),
      end: monthEnd.add(trailingDays, 'day').endOf('day').toISOString(),
    };
  });

  // Kalender mengambil range visible secara terpisah dari tabel bookings.
  // Kalender harus memuat SEMUA booking pada rentang yang sedang dilihat
  // (bukan hanya satu halaman tabel).
  const handleCalendarDateChange = useCallback(
    (_date: unknown, range: { start: { toISOString: () => string }; end: { toISOString: () => string } }) => {
      setCalendarRange({
        start: range.start.toISOString(),
        end: range.end.toISOString(),
      });
    },
    [],
  );

  const calendarQuery = useQuery({
    queryKey: [
      'bookings-calendar',
      activeWorkspaceId,
      calendarRange.start,
      calendarRange.end,
    ],
    enabled: Boolean(activeWorkspaceId),
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams();
      params.set('from', calendarRange.start);
      params.set('to', calendarRange.end);

      // The API caps one offset page at 200. Keep requesting pages so a busy
      // week/month never silently drops events from the calendar.
      const allBookings: BookingRecord[] = [];
      const pageSize = 200;
      let pageNumber = 1;
      let total = 0;
      do {
        params.set('page', String(pageNumber));
        params.set('pageSize', String(pageSize));
        const response = await apiFetch<BookingsListResponse>(
          `/bookings?${params.toString()}`,
          { signal },
        );
        allBookings.push(...response.bookings);
        total = response.total ?? allBookings.length;
        if (allBookings.length >= total || response.bookings.length === 0) break;
        pageNumber += 1;
      } while (allBookings.length < total);

      return { bookings: allBookings, total } satisfies BookingsListResponse;
    },
    placeholderData: keepPreviousData,
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 3,
  });

  // ── Kalender @ilamy/calendar ──────────────────────────────
  const navigate = useNavigate();
  const calendarTranslations = useCalendarTranslations();
  const calendarEvents = useMemo(
    () => toCalendarEvents(calendarQuery.data?.bookings ?? [], staffNameById),
    [calendarQuery.data, staffNameById],
  );
  const handleCalendarEventClick = useCallback(
    (event: import('@ilamy/calendar').CalendarEvent) => {
      const bookingId = (event.data as Record<string, unknown>)?.bookingId;
      if (bookingId) navigate(`/app/bookings/${bookingId}`);
    },
    [navigate],
  );
  const renderBookingEvent = useCallback(
    (event: import('@ilamy/calendar').CalendarEvent) => (
      <CalendarEventBar event={event} />
    ),
    [],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header halaman — padding horizontal sama dengan halaman lain; hanya
          kalender di bawahnya yang full-bleed. */}
      <div className="px-4 pb-5 pt-8 sm:px-6 lg:px-8">
        <PageHeader
          title={t('calendar.title')}
          description={t('calendar.description')}
          icon={IconCalendar}
        >
          <ReloadMenuButton
            isFetching={calendarQuery.isFetching}
            onReload={() => {
              void calendarQuery.refetch();
            }}
          />
        </PageHeader>
      </div>

      <div
        className="ilamy-calendar-scope bookings-calendar relative min-h-0 flex-1 overflow-hidden"
        aria-busy={calendarQuery.isFetching}
      >
          <IlamyCalendar
            events={calendarEvents}
            initialView={calendarView}
            firstDayOfWeek="monday"
            timeFormat="24-hour"
            slotDuration={30}
            scrollTime="08:00"
            stickyViewHeader
            disableDragAndDrop
            disableCellClick
            hideExportButton
            headerClassName="bookings-calendar-native-header"
            viewHeaderClassName="bookings-calendar-view-header"
            translations={calendarTranslations}
            headerComponent={<CalendarHeader />}
            renderEvent={renderBookingEvent}
            renderHour={(date) => (
              <span className="bookings-calendar-hour">{date.format('HH:mm')}</span>
            )}
            onDateChange={handleCalendarDateChange}
            onViewChange={(nextView) => {
              if (!CALENDAR_VIEWS.includes(nextView as CalendarView)) return;
              setSearchParams(
                (prev) => {
                  const params = new URLSearchParams(prev);
                  params.set('calendarView', nextView);
                  return params;
                },
                { replace: true },
              );
            }}
            onEventClick={handleCalendarEventClick}
            dayMaxEvents={3}
            eventHeight={36}
            eventSpacing={3}
          />

          {calendarQuery.isFetching && !calendarQuery.isError && (
            <div className="bookings-calendar-loading" role="status" aria-live="polite">
              {t('calendar.loading')}
            </div>
          )}

          {calendarQuery.isError && !calendarQuery.data && (
            <div className="bookings-calendar-error" role="alert">
              <IconAlertTriangle className="size-4" aria-hidden="true" />
              <span>{t('errors.apiConnection')}</span>
              <Button
                label={t('common.retry')}
                variant="secondary"
                size="sm"
                onClick={() => void calendarQuery.refetch()}
              />
            </div>
          )}
      </div>
    </div>
  );
}
