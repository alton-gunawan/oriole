import { describe, expect, it } from 'vitest';

import {
  intersectCalendarDateRange,
  toCalendarEvents,
} from './bookings-calendar';
import type { BookingRecord } from './bookings';

const now = '2026-08-12T09:00:00+07:00';

function makeBooking(overrides: Partial<BookingRecord> = {}): BookingRecord {
  return {
    id: 'b1',
    title: 'Booking #1',
    description: null,
    scheduledAt: now,
    timezone: 'Asia/Jakarta',
    status: 'confirmed',
    customerName: 'John Doe',
    phone: '+6281234567890',
    contactId: null,
    industry: null,
    goalType: null,
    customInstruction: null,
    noShowCount: 0,
    changeRequested: false,
    calleCallId: null,
    staffId: 's1',
    serviceId: 'svc1',
    serviceName: 'Consultation',
    durationMinutes: 60,
    recurrence: null,
    recurrenceSeriesId: null,
    callAttempts: { total: 0, failed: 0 },
    autoGoal: { action: 'goal_met' } as never,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('intersectCalendarDateRange', () => {
  const visibleRange = {
    start: '2026-08-01T00:00:00.000Z',
    end: '2026-08-31T23:59:59.999Z',
  };

  it('keeps the full visible range when no date filter is active', () => {
    expect(intersectCalendarDateRange(visibleRange)).toEqual(visibleRange);
  });

  it('clamps the visible range to the selected date filter', () => {
    expect(intersectCalendarDateRange(visibleRange, '2026-08-10', '2026-08-20')).toEqual({
      start: new Date('2026-08-10T00:00:00').toISOString(),
      end: new Date('2026-08-20T23:59:59.999').toISOString(),
    });
  });

  it('returns null when the visible range is outside the date filter', () => {
    expect(intersectCalendarDateRange(visibleRange, '2026-09-02', '2026-09-10')).toBeNull();
  });
});

describe('toCalendarEvents', () => {
  it('maps a basic booking to a CalendarEvent', () => {
    const staff = new Map([['s1', 'Alice']]);
    const [event] = toCalendarEvents([makeBooking()], staff);

    expect(event.id).toBe('b1');
    expect(event.title).toBe('Consultation');
    expect(event.start.toISOString()).toBe('2026-08-12T02:00:00.000Z');
    expect(event.end.toISOString()).toBe('2026-08-12T03:00:00.000Z');
    expect(event.color).toBe('#10b981'); // confirmed = emerald
  });

  it('uses title fallback when serviceName is null', () => {
    const [event] = toCalendarEvents(
      [makeBooking({ serviceName: null, title: 'Manual Title' })],
      new Map(),
    );
    expect(event.title).toBe('Manual Title');
  });

  it('falls back to em-dash when both serviceName and title are null', () => {
    const [event] = toCalendarEvents(
      [makeBooking({ serviceName: null, title: '' })],
      new Map(),
    );
    expect(event.title).toBe('—');
  });

  it('sets end = start + 30 min when durationMinutes is 0', () => {
    const [event] = toCalendarEvents(
      [makeBooking({ durationMinutes: 0 })],
      new Map(),
    );
    expect(event.end.diff(event.start, 'minute')).toBe(30);
  });

  it('returns correct color per status', () => {
    const bookings: BookingRecord[] = [
      makeBooking({ id: 'a', status: 'pending' }),
      makeBooking({ id: 'b', status: 'confirmed' }),
      makeBooking({ id: 'c', status: 'completed' }),
      makeBooking({ id: 'd', status: 'cancelled' }),
    ];
    const events = toCalendarEvents(bookings, new Map());

    expect(events.map((e) => e.color)).toEqual([
      '#f59e0b', // pending = amber
      '#10b981', // confirmed = emerald
      '#71717a', // completed = zinc
      '#ef4444', // cancelled = red
    ]);
  });

  it('includes staff name in event data when staffId matches', () => {
    const staff = new Map([['s1', 'Alice']]);
    const [event] = toCalendarEvents([makeBooking()], staff);
    expect(event.data).toMatchObject({ staffName: 'Alice' });
  });

  it('sets staffName to null when staffId is not in the map', () => {
    const [event] = toCalendarEvents([makeBooking()], new Map());
    expect(event.data).toMatchObject({ staffName: null });
  });

  it('handles empty input', () => {
    expect(toCalendarEvents([], new Map())).toEqual([]);
  });
});
