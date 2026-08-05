import { describe, expect, it } from 'vitest';

import { isValidPhone, normalizePhone, phoneField } from './phone';

describe('normalizePhone', () => {
  it('menghapus pemisah dan mempertahankan awalan +', () => {
    expect(normalizePhone('0812-3456-7890')).toBe('081234567890');
    expect(normalizePhone('+62 812 3456 7890')).toBe('+6281234567890');
    expect(normalizePhone('(021) 555-0100')).toBe('0215550100');
  });
});

describe('isValidPhone', () => {
  it('menerima format valid (8–15 digit)', () => {
    expect(isValidPhone('081234567890')).toBe(true);
    expect(isValidPhone('+6281234567890')).toBe(true);
    expect(isValidPhone('12345678')).toBe(true);
  });

  it('menolak format tidak valid', () => {
    expect(isValidPhone('123')).toBe(false); // terlalu pendek
    expect(isValidPhone('abc')).toBe(false);
    expect(isValidPhone('1234567890123456')).toBe(false); // 16 digit
  });
});

describe('phoneField', () => {
  it('menormalkan dan memvalidasi input', () => {
    expect(phoneField.parse('+62 812-3456-7890')).toBe('+6281234567890');
    expect(phoneField.parse('0812.3456.7890')).toBe('081234567890');
  });

  it('menolak nilai yang bukan nomor telepon', () => {
    expect(() => phoneField.parse('bukan nomor')).toThrow();
    expect(() => phoneField.parse('123')).toThrow();
  });
});
