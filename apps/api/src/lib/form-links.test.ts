import { describe, expect, it } from 'vitest';

import { formPublicUrl, googleFormUrl, tallyFormUrl } from './form-links.ts';

describe('form-links', () => {
  it('googleFormUrl membentuk URL viewform publik', () => {
    expect(googleFormUrl('1FAIpQLSabc')).toBe(
      'https://docs.google.com/forms/d/e/1FAIpQLSabc/viewform',
    );
  });

  it('tallyFormUrl membentuk URL r/{id}', () => {
    expect(tallyFormUrl('nGM0Py')).toBe('https://tally.so/r/nGM0Py');
  });

  it('formPublicUrl memilih builder sesuai jenis integrasi', () => {
    expect(formPublicUrl('google-forms', 'form-abc')).toBe(
      'https://docs.google.com/forms/d/e/form-abc/viewform',
    );
    expect(formPublicUrl('tally', 'form-abc')).toBe('https://tally.so/r/form-abc');
  });

  it('encode formId agar aman di URL', () => {
    expect(googleFormUrl('a b/c')).toContain(encodeURIComponent('a b/c'));
  });
});
