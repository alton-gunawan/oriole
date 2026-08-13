import { describe, expect, it, vi } from 'vitest';

// activeLocale() membaca i18next — stub agar tes tidak butuh init i18n.
vi.mock('../i18n/format', () => ({
  activeLocale: () => 'en-US',
}));

import { formatPaymentAmount } from './payments';

describe('formatPaymentAmount', () => {
  it('minor units → string mata uang (en-US, 2 desimal)', () => {
    expect(formatPaymentAmount(25000, 'USD')).toBe('$250.00');
    expect(formatPaymentAmount(50, 'USD')).toBe('$0.50');
    expect(formatPaymentAmount(2999, 'EUR')).toBe('€29.99');
  });

  it('mata uang yang tidak dikenal Intl → tetap format tanpa crash', () => {
    // Perilaku bergantung runtime: Node 24 menampilkan kode mata uang
    // ('XYZ 123.45'); environment lain melempar → fallback manual ('123.45 XYZ').
    const result = formatPaymentAmount(12345, 'XYZ');
    expect(result).toContain('123.45');
    expect(result).toContain('XYZ');
  });
});
