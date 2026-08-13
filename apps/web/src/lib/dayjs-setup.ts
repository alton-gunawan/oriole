/**
 * Dayjs extensions required by @ilamy/calendar.
 *
 * The calendar internally calls `.utc()`, `.isSameOrAfter()`, `.isSameOrBefore()`,
 * and timezone helpers — these live on the SHARED `dayjs` instance (peer dep),
 * so they must be registered before `<IlamyCalendar>` renders.
 *
 * Importing this file once (e.g. in BookingsPage) is enough — side-effects
 * mutate the dayjs prototype for the entire process.
 */
import dayjs from 'dayjs';
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter';
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(isSameOrAfter);
dayjs.extend(isSameOrBefore);

export { dayjs };
