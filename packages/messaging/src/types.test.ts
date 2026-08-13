import { describe, expect, it } from 'vitest';

import { canonicalPhone, normalizePhone, samePhone } from './types.ts';

describe('normalizePhone', () => {
  it('membuang semua non-digit, tetap mempertahankan 0 depan', () => {
    expect(normalizePhone('0812-3456-7890')).toBe('081234567890');
    expect(normalizePhone('+62 812 3456 7890')).toBe('6281234567890');
    expect(normalizePhone('(021) 555-0100')).toBe('0215550100');
  });

  it('null / kosong / terlalu pendek → null', () => {
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('123')).toBeNull();
  });
});

describe('canonicalPhone', () => {
  it('format lokal (0xx) dan internasional (+62 / 62) menghasilkan bentuk sama', () => {
    const canonical = '6281234567890';
    expect(canonicalPhone('081234567890')).toBe(canonical);
    expect(canonicalPhone('+6281234567890')).toBe(canonical);
    expect(canonicalPhone('62 812 3456 7890')).toBe(canonical);
  });

  it('nomor tanpa prefix 0 dibiarkan apa adanya', () => {
    expect(canonicalPhone('6281234567890')).toBe('6281234567890');
    expect(canonicalPhone('2125551234')).toBe('2125551234');
  });

  it('null / kosong → null', () => {
    expect(canonicalPhone(null)).toBeNull();
    expect(canonicalPhone(undefined)).toBeNull();
    expect(canonicalPhone('')).toBeNull();
  });
});

describe('samePhone', () => {
  it('format lokal vs internasional dianggap sama', () => {
    expect(samePhone('081234567890', '+6281234567890')).toBe(true);
    expect(samePhone('081234567890', '6281234567890')).toBe(true);
    expect(samePhone('+62 812-3456-7890', '081234567890')).toBe(true);
  });

  it('nomor yang benar-benar berbeda → false', () => {
    expect(samePhone('081234567890', '081199999999')).toBe(false);
    expect(samePhone('081234567890', '628199999999')).toBe(false);
  });

  it('salah satu kosong / tidak valid → false', () => {
    expect(samePhone(null, '081234567890')).toBe(false);
    expect(samePhone('081234567890', undefined)).toBe(false);
    expect(samePhone('', '081234567890')).toBe(false);
  });
});
