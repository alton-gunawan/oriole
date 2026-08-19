/**
 * CalendarShell — wraps IlamyCalendar and bridges its internal API
 * (useIlamyCalendarContext) to an external React context, so the standalone
 * header can render outside the IlamyCalendar tree while still accessing
 * prev/next/today/view/setView/currentDate.
 *
 * @module CalendarShell
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  IlamyCalendar,
  useIlamyCalendarContext,
  type CalendarView,
  type Dayjs,
} from '@ilamy/calendar';
import type { IlamyCalendarProps } from '@ilamy/calendar';

/* ── Calendar context (bridged from useIlamyCalendarContext) ──────── */

interface CalendarContextValue {
  currentDate: Dayjs;
  view: CalendarView;
  setView: (view: CalendarView, date?: Dayjs) => void;
  prevPeriod: () => void;
  nextPeriod: () => void;
  today: () => void;
  getViews: () => { name: string }[];
}

const CalendarContext = createContext<CalendarContextValue | null>(null);

/**
 * Consume the calendar API from outside the IlamyCalendar tree.
 * Only works when rendered inside a `<CalendarShell>`.
 */
export function useCalendarContext(): CalendarContextValue {
  const ctx = useContext(CalendarContext);
  if (!ctx) {
    throw new Error('useCalendarContext must be used inside <CalendarShell>');
  }
  return ctx;
}

/* ── Inner bridge (rendered inside IlamyCalendar via headerComponent) ── */

function CalendarContextBridge() {
  const ctx = useIlamyCalendarContext();
  const { setCalendarApi } = useContext(CalendarBridgeSetterContext);

  // Push the calendar API to the outer context whenever it changes.
  useEffect(() => {
    setCalendarApi({
      currentDate: ctx.currentDate,
      view: ctx.view,
      setView: ctx.setView,
      prevPeriod: ctx.prevPeriod,
      nextPeriod: ctx.nextPeriod,
      today: ctx.today,
      getViews: ctx.getViews,
    });
  }, [
    ctx.currentDate,
    ctx.view,
    ctx.setView,
    ctx.prevPeriod,
    ctx.nextPeriod,
    ctx.today,
    ctx.getViews,
    setCalendarApi,
  ]);

  return null;
}

/* ── Setter context (internal) ──────────────────────────────────────── */

const CalendarBridgeSetterContext = createContext<{
  setCalendarApi: (api: CalendarContextValue) => void;
}>({ setCalendarApi: () => {} });

/* ── CalendarShell (public wrapper) ────────────────────────────────── */

interface CalendarShellProps extends IlamyCalendarProps {
  children?: ReactNode;
  /** Kelas untuk wrapper IlamyCalendar (mis. scope token shadcn `ilamy-calendar-scope`). */
  calendarClassName?: string;
}

/**
 * Wraps IlamyCalendar and provides a CalendarContext for children (e.g.
 * StandaloneCalendarHeader) to consume the calendar's internal API.
 *
 * Usage:
 * ```tsx
 * <CalendarShell events={events} initialView="month" onDateChange={...}>
 *   <StandaloneCalendarHeader />
 * </CalendarShell>
 * ```
 */
export function CalendarShell({
  children,
  calendarClassName,
  ...calendarProps
}: CalendarShellProps) {
  const [calendarApi, setCalendarApi] = useState<CalendarContextValue | null>(null);

  const setterValue = useMemo(() => ({ setCalendarApi }), []);

  const contextValue = useMemo<CalendarContextValue | null>(
    () =>
      calendarApi
        ? {
            currentDate: calendarApi.currentDate,
            view: calendarApi.view,
            setView: calendarApi.setView,
            prevPeriod: calendarApi.prevPeriod,
            nextPeriod: calendarApi.nextPeriod,
            today: calendarApi.today,
            getViews: calendarApi.getViews,
          }
        : null,
    [calendarApi],
  );

  return (
    <CalendarBridgeSetterContext.Provider value={setterValue}>
      <CalendarContext.Provider value={contextValue}>
        {/* Context diisi oleh CalendarContextBridge lewat effect, jadi pada
            render pertama nilainya null. Sembunyikan children sampai API
            kalender tersedia agar konsumen tidak melihat null. */}
        {calendarApi ? children : null}
        <div className={calendarClassName}>
          <IlamyCalendar
            {...calendarProps}
            headerComponent={<CalendarContextBridge />}
          />
        </div>
      </CalendarContext.Provider>
    </CalendarBridgeSetterContext.Provider>
  );
}
