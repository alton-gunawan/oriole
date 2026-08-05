import { describe, expect, it } from 'vitest';

import { formatSlotTime, parseSlotTime, renderBookingReminder } from './render.ts';
import { buildCallbackData } from './parse.ts';

const BOOKING_ID = '550e8400-e29b-41d4-a716-446655440000';

describe('renderBookingReminder', () => {
  const rendered = renderBookingReminder(
    {
      businessName: 'Klinik Gigi Sehat',
      customerName: 'Budi',
      title: 'Scaling Gigi',
      scheduledAt: '2026-08-15T07:00:00.000Z',
      timezone: 'Asia/Jakarta',
    },
    BOOKING_ID,
  );

  it('menyertakan nama bisnis, judul booking, dan waktu terformat (id-ID)', () => {
    expect(rendered.text).toContain('Klinik Gigi Sehat');
    expect(rendered.text).toContain('Scaling Gigi');
    expect(rendered.text).toContain('Budi');
    // 07:00 UTC = 14:00 WIB (Asia/Jakarta, UTC+7)
    expect(rendered.text).toContain('14.00');
    expect(rendered.text).toContain('Agustus');
  });

  it('menghasilkan tombol confirm / reschedule / cancel dengan callback data booking', () => {
    expect(rendered.buttons.map((b) => b.id)).toEqual([
      buildCallbackData(BOOKING_ID, 'confirm'),
      buildCallbackData(BOOKING_ID, 'reschedule'),
      buildCallbackData(BOOKING_ID, 'cancel'),
    ]);
  });
});

describe('formatSlotTime', () => {
  it('memformat dengan locale id-ID dan timezone booking', () => {
    const formatted = formatSlotTime('2026-08-15T07:00:00.000Z', 'Asia/Jakarta');
    expect(formatted).toContain('Agustus');
    expect(formatted).toContain('14.00');
  });
});

describe('parseSlotTime', () => {
  it('mem-parse naive local time di timezone Asia/Jakarta (+7)', () => {
    const parsed = parseSlotTime('2026-08-15 14:00', 'Asia/Jakarta', new Date('2026-01-01T00:00:00Z'));
    expect(parsed?.toISOString()).toBe('2026-08-15T07:00:00.000Z');
  });

  it('mem-parse ISO datetime ber-offset apa adanya', () => {
    const parsed = parseSlotTime(
      '2026-08-15T14:00:00+07:00',
      'Asia/Jakarta',
      new Date('2026-01-01T00:00:00Z'),
    );
    expect(parsed?.toISOString()).toBe('2026-08-15T07:00:00.000Z');
  });

  it('menolak waktu yang sudah lewat', () => {
    expect(parseSlotTime('2020-01-01 10:00', 'UTC', new Date('2026-01-01T00:00:00Z'))).toBeNull();
  });

  it('menolak format yang tidak dikenali', () => {
    expect(parseSlotTime('nanti sore', 'UTC')).toBeNull();
    expect(parseSlotTime('14:00', 'UTC')).toBeNull();
    expect(parseSlotTime('2026-13-40 99:99', 'UTC')).toBeNull();
  });
});
