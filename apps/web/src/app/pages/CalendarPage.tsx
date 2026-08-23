import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { Button, Popover, Selector, SelectorOption, StatusDot, TextInput, type StatusDotVariant } from '@astryxdesign/core';
import { IlamyCalendar, useIlamyCalendarContext } from '@ilamy/calendar';

import { ApiError, apiFetch } from '../../lib/api';
import { toCalendarEvents, type CalendarDateRange } from '../../lib/bookings-calendar';
import { dayjs } from '../../lib/dayjs-setup';
import type { BookingRecord, BookingsListResponse } from '../../lib/bookings';
import type { StaffListResponse } from '../../lib/staff';
import { useWorkspaceStore } from '../../stores/workspace';
import { bookingStatusKey } from '../../i18n/enums';
import { IconAlertTriangle, IconCalendar, IconInfo, IconSearch } from '../shell/icons';
import {
  CalendarEventBar,
  CalendarNavButtons,
  CalendarViewButtons,
  STATUS_LEGEND,
  useCalendarTranslations,
  type CalendarToolbarApi,
} from './BookingsCalendarHeader';
import { PageHeader, ReloadMenuButton } from '../shell/ui';

const CALENDAR_VIEWS = ['month', 'week', 'day'] as const;
type CalendarView = (typeof CALENDAR_VIEWS)[number];

const VALID_STATUSES: BookingRecord['status'][] = ['confirmed', 'completed', 'pending', 'cancelled'];
const STATUS_DOT: Record<BookingRecord['status'], StatusDotVariant> = {
  confirmed: 'success',
  completed: 'neutral',
  pending: 'warning',
  cancelled: 'error',
};
const STATUS_TEXT: Record<string, string> = {
  '': 'text-zinc-500 dark:text-zinc-400',
  confirmed: 'text-emerald-600',
  completed: 'text-zinc-500 dark:text-zinc-400',
  pending: 'text-amber-600',
  cancelled: 'text-red-600',
};

function statusLabel(status: string | null, t: TFunction): string {
  const key = bookingStatusKey(status);
  return key ? t(key) : (status ?? '');
}

/**
 * Jembatan: angkat API kalender internal (useIlamyCalendarContext) ke state
 * halaman, supaya toolbar bisa dirender di header halaman (di luar kalender).
 * Menggunakan ref dan functional state updater agar tidak memicu infinite render loop.
 */
function CalendarContextBridge({
  onApi,
}: {
  onApi: Dispatch<SetStateAction<CalendarToolbarApi | null>>;
}) {
  const ctx = useIlamyCalendarContext();
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const prevPeriod = useCallback(() => ctxRef.current.prevPeriod(), []);
  const nextPeriod = useCallback(() => ctxRef.current.nextPeriod(), []);
  const today = useCallback(() => ctxRef.current.today(), []);
  const setView = useCallback(
    (view: string, date?: dayjs.Dayjs) => ctxRef.current.setView(view as CalendarView, date),
    [],
  );
  const getViews = useCallback(() => ctxRef.current.getViews(), []);

  const currentDateKey = ctx.currentDate.format('YYYY-MM-DD');

  useEffect(() => {
    onApi((prev) => {
      if (
        prev &&
        prev.view === ctx.view &&
        prev.currentDate.isSame(ctx.currentDate, 'day')
      ) {
        return prev;
      }
      return {
        currentDate: ctx.currentDate,
        view: ctx.view,
        setView,
        prevPeriod,
        nextPeriod,
        today,
        getViews,
      };
    });
  }, [currentDateKey, ctx.view, ctx.currentDate, setView, prevPeriod, nextPeriod, today, getViews, onApi]);

  return null;
}

export function CalendarPage() {
  const { t } = useTranslation();
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);

  // API kalender yang diangkat dari dalam IlamyCalendar (lihat CalendarContextBridge)
  // — null sampai bridge effect pertama jalan.
  const [calendarApi, setCalendarApi] = useState<CalendarToolbarApi | null>(null);

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

  const searchFilter = searchParams.get('q') ?? '';
  const statusFilter = (searchParams.get('status') as BookingRecord['status']) || '';
  const staffFilter = searchParams.get('staffId') ?? '';

  const hasFilters = Boolean(searchFilter.trim() || statusFilter || staffFilter);

  const setFilter = useCallback(
    (key: string, value: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value.trim()) {
            next.set(key, value);
          } else {
            next.delete(key);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const resetFilters = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('q');
        next.delete('status');
        next.delete('staffId');
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);

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
      const nextStart = range.start.toISOString();
      const nextEnd = range.end.toISOString();
      setCalendarRange((prev) => {
        if (prev.start === nextStart && prev.end === nextEnd) return prev;
        return { start: nextStart, end: nextEnd };
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

  const filteredBookings = useMemo(() => {
    let list = calendarQuery.data?.bookings ?? [];
    if (statusFilter) {
      list = list.filter((b) => b.status === statusFilter);
    }
    if (staffFilter) {
      list = list.filter((b) => b.staffId === staffFilter);
    }
    if (searchFilter.trim()) {
      const q = searchFilter.toLowerCase().trim();
      list = list.filter(
        (b) =>
          b.title.toLowerCase().includes(q) ||
          b.customerName?.toLowerCase().includes(q) ||
          b.phone?.toLowerCase().includes(q) ||
          b.serviceName?.toLowerCase().includes(q),
      );
    }
    return list;
  }, [calendarQuery.data?.bookings, statusFilter, staffFilter, searchFilter]);

  // ── Kalender @ilamy/calendar ──────────────────────────────
  const navigate = useNavigate();
  const calendarTranslations = useCalendarTranslations();
  const calendarEvents = useMemo(
    () => toCalendarEvents(filteredBookings, staffNameById),
    [filteredBookings, staffNameById],
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

  const currentPeriodText = (calendarApi?.currentDate ?? dayjs()).format('MMMM YYYY');

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header halaman — padding horizontal dan spacing selaras dengan
          halaman Bookings, Customers, Services, dan Staff (w-full px-4 pb-4 pt-8 sm:px-6 lg:px-8 space-y-6). */}
      <div className="w-full px-4 pb-4 pt-8 sm:px-6 lg:px-8 space-y-6">
        <PageHeader
          title={t('calendar.title')}
          status={
            <div className="flex items-center gap-2 text-zinc-400 dark:text-zinc-500">
              <span
                className="size-1.5 rounded-full bg-zinc-300 dark:bg-zinc-600"
                aria-hidden="true"
              />
              <span className="text-lg font-medium text-zinc-600 dark:text-zinc-300">
                {currentPeriodText}
              </span>
              <Button
                label={t('calendar.today')}
                variant="secondary"
                size="sm"
                onClick={() => calendarApi?.today()}
              />
            </div>
          }
          description={
            <span>
              {t('calendar.description')}
              <Popover
                label={t('calendar.statusLegend')}
                placement="below"
                alignment="end"
                hasCloseButton={false}
                content={
                  <div className="flex flex-col gap-2.5 p-1.5">
                    {STATUS_LEGEND.map(({ status, color }) => (
                      <span key={status} className="flex items-center gap-2.5 text-sm font-semibold text-zinc-800 dark:text-zinc-200">
                        <span
                          className="size-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: color }}
                        />
                        {t(`status.${status}`)}
                      </span>
                    ))}
                  </div>
                }
              >
                <button
                  type="button"
                  aria-label={t('calendar.statusLegend')}
                  className="ml-1.5 inline-block align-middle rounded-full text-zinc-400 transition hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
                >
                  <IconInfo className="size-4" />
                </button>
              </Popover>
            </span>
          }
          icon={IconCalendar}
        >
          <CalendarNavButtons
            onPrev={() => calendarApi?.prevPeriod()}
            onNext={() => calendarApi?.nextPeriod()}
          />
          <CalendarViewButtons
            activeView={calendarApi?.view ?? calendarView}
            onViewChange={(nextView) => {
              if (calendarApi) {
                calendarApi.setView(nextView);
              } else {
                setSearchParams(
                  (prev) => {
                    const params = new URLSearchParams(prev);
                    params.set('calendarView', nextView);
                    return params;
                  },
                  { replace: true },
                );
              }
            }}
          />
          <ReloadMenuButton
            isFetching={calendarQuery.isFetching}
            onReload={() => {
              void calendarQuery.refetch();
            }}
          />
        </PageHeader>

        {/* Filter bar — komponen Astryx (TextInput + Selector Staff + Selector Status) */}
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="min-w-0 flex-1">
            <TextInput
              label={t('bookings.colService')}
              isLabelHidden
              placeholder={t('bookings.servicePlaceholder')}
              value={searchFilter}
              onChange={(value) => setFilter('q', value)}
              startIcon={<IconSearch className="size-4" />}
              width="100%"
            />
          </div>

          <div className="min-w-0 flex-1">
            <Selector
              label={t('staff.title')}
              isLabelHidden
              placeholder={t('calendar.allStaff')}
              options={[
                { value: '', label: t('calendar.allStaff') },
                ...(staffPage?.staff ?? []).map((s) => ({ value: s.id, label: s.name })),
              ]}
              value={staffFilter}
              onChange={(value) => setFilter('staffId', value ?? '')}
              width="100%"
            />
          </div>

          <div className="min-w-0 flex-1">
            <Selector
              label={t('common.status')}
              isLabelHidden
              placeholder={t('bookings.allStatuses')}
              options={[
                {
                  value: '',
                  label: t('bookings.allStatuses'),
                  icon: <StatusDot variant="neutral" label={t('bookings.allStatuses')} />,
                },
                ...VALID_STATUSES.map((status) => {
                  const label = statusLabel(status, t);
                  return {
                    value: status,
                    label,
                    icon: <StatusDot variant={STATUS_DOT[status]} label={label} />,
                  };
                }),
              ]}
              value={statusFilter}
              onChange={(value) => setFilter('status', value ?? '')}
              width="100%"
              renderOption={(option) => (
                <SelectorOption
                  icon={option.icon}
                  label={
                    <span className={STATUS_TEXT[option.value] ?? 'text-zinc-500 dark:text-zinc-400'}>
                      {option.label}
                    </span>
                  }
                />
              )}
            />
          </div>

          <div className="flex items-center gap-3 lg:ml-auto">
            {hasFilters && (
              <Button
                label={t('calendar.resetFilter')}
                variant="ghost"
                size="sm"
                onClick={resetFilters}
              />
            )}
          </div>
        </div>
      </div>

      <div
        className="ilamy-calendar-scope bookings-calendar relative min-h-0 flex-1 overflow-hidden border-t border-zinc-200 dark:border-zinc-700 border-l-0 border-r-0 border-b-0"
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
            headerComponent={<CalendarContextBridge onApi={setCalendarApi} />}
            renderEvent={renderBookingEvent}
            renderHour={(date) => (
              <span className="bookings-calendar-hour">{date.format('HH:mm')}</span>
            )}
            onDateChange={handleCalendarDateChange}
            onViewChange={(nextView) => {
              if (!CALENDAR_VIEWS.includes(nextView as CalendarView)) return;
              setSearchParams(
                (prev) => {
                  if (prev.get('calendarView') === nextView) return prev;
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
