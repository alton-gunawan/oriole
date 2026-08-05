import { describe, expect, it } from 'vitest';

import { extractCallSeconds } from './calls';

describe('extractCallSeconds', () => {
  it('membaca durasi dari key yang dikenal (durationSeconds)', () => {
    expect(extractCallSeconds({ durationSeconds: 120 })).toBe(120);
    expect(extractCallSeconds({ duration: 45 })).toBe(45);
    expect(extractCallSeconds({ seconds: 12 })).toBe(12);
    expect(extractCallSeconds({ totalSeconds: 90 })).toBe(90);
    expect(extractCallSeconds({ callDuration: 300 })).toBe(300);
  });

  it('menerima durasi string numerik', () => {
    expect(extractCallSeconds({ durationSeconds: '75' })).toBe(75);
  });

  it('key pertama yang cocok menang', () => {
    expect(extractCallSeconds({ durationSeconds: 10, duration: 20 })).toBe(10);
  });

  it('null/undefined/bukan objek → 0', () => {
    expect(extractCallSeconds(null)).toBe(0);
    expect(extractCallSeconds(undefined)).toBe(0);
    expect(extractCallSeconds('x' as unknown as Record<string, unknown>)).toBe(0);
  });

  it('nilai tidak valid (NaN/Infinity/string bukan angka) → 0', () => {
    expect(extractCallSeconds({ durationSeconds: Number.NaN })).toBe(0);
    expect(extractCallSeconds({ durationSeconds: Number.POSITIVE_INFINITY })).toBe(0);
    expect(extractCallSeconds({ durationSeconds: 'abc' })).toBe(0);
    expect(extractCallSeconds({})).toBe(0);
  });
});
