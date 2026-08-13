import { describe, expect, it } from 'vitest';

import { applyRangeFilter } from './bookings';

/**
 * Regression test untuk bug DateRangeInput: dua panggilan `setSearchParams`
 * terpisah di handler yang sama saling menimpa (update kedua membaca
 * searchParams basi), membuat `from` hilang dari URL dan trigger picker
 * tidak pernah menampilkan tanggal. `applyRangeFilter` menulis kedua ujung
 * dalam satu update atomik — perilaku ini dijamin di sini.
 */
describe('applyRangeFilter', () => {
  const RANGE = { start: '2026-08-03', end: '2026-08-06' } as const;

  it('menulis from DAN to dalam satu update atomik (regresi URL basi)', () => {
    const next = applyRangeFilter(new URLSearchParams(), RANGE);

    expect(next.get('from')).toBe('2026-08-03');
    expect(next.get('to')).toBe('2026-08-06');
    expect(next.toString()).toBe('from=2026-08-03&to=2026-08-06');
  });

  it('tidak menyentuh param filter lain yang sudah ada di URL', () => {
    const prev = new URLSearchParams({ status: 'confirmed', title: 'checkup' });
    const next = applyRangeFilter(prev, RANGE);

    expect(next.get('from')).toBe('2026-08-03');
    expect(next.get('to')).toBe('2026-08-06');
    expect(next.get('status')).toBe('confirmed');
    expect(next.get('title')).toBe('checkup');
  });

  it('menimpa rentang lama saat user memilih rentang baru', () => {
    const prev = new URLSearchParams({ from: '2026-01-01', to: '2026-01-15' });
    const next = applyRangeFilter(prev, RANGE);

    expect(next.get('from')).toBe('2026-08-03');
    expect(next.get('to')).toBe('2026-08-06');
  });

  it('menghapus from DAN to saat rentang di-clear (null)', () => {
    const prev = new URLSearchParams({ from: '2026-08-03', to: '2026-08-06', status: 'pending' });
    const next = applyRangeFilter(prev, null);

    expect(next.has('from')).toBe(false);
    expect(next.has('to')).toBe(false);
    // Param lain tetap utuh.
    expect(next.get('status')).toBe('pending');
  });

  it('idempoten: clear saat belum ada rentang tidak menambah param', () => {
    const prev = new URLSearchParams({ status: 'pending' });
    const next = applyRangeFilter(prev, null);

    expect(next.toString()).toBe('status=pending');
  });

  it('tidak memutasi input prev (murni)', () => {
    const prev = new URLSearchParams({ status: 'pending' });
    applyRangeFilter(prev, RANGE);

    expect(prev.has('from')).toBe(false);
    expect(prev.has('to')).toBe(false);
  });
});
