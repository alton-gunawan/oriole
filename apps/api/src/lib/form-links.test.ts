import { describe, expect, it } from 'vitest';

import {
  formPublicUrl,
  formPublicUrlForCustomer,
  googleFormUrl,
  tallyFormUrl,
  tallyPrefillUrl,
} from './form-links.ts';

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

  it('tallyPrefillUrl menambahkan parameter phone (URL-encoded)', () => {
    expect(tallyPrefillUrl('nGM0Py', '+6281234567890')).toBe(
      'https://tally.so/r/nGM0Py?phone=%2B6281234567890',
    );
  });

  it('tallyPrefillUrl menambahkan parameter name (URL-encoded)', () => {
    expect(tallyPrefillUrl('nGM0Py', '+6281234567890', 'Budi Santoso')).toBe(
      'https://tally.so/r/nGM0Py?phone=%2B6281234567890&name=Budi+Santoso',
    );
    // Nama kosong → tidak ikut.
    expect(tallyPrefillUrl('nGM0Py', '+6281234567890', '  ')).toBe(
      'https://tally.so/r/nGM0Py?phone=%2B6281234567890',
    );
  });

  it('tallyPrefillUrl menambahkan token chat asal (orioleChatId)', () => {
    expect(tallyPrefillUrl('nGM0Py', '+6281234567890', 'Budi', '123456789')).toBe(
      'https://tally.so/r/nGM0Py?phone=%2B6281234567890&name=Budi&orioleChatId=123456789',
    );
    // Token kosong → tidak ikut.
    expect(tallyPrefillUrl('nGM0Py', '+6281234567890', null, '  ')).toBe(
      'https://tally.so/r/nGM0Py?phone=%2B6281234567890',
    );
  });

  it('formPublicUrlForCustomer — Tally + data → prefill; tanpa data/Google Forms → polos', () => {
    expect(formPublicUrlForCustomer('tally', 'nGM0Py', '6281234567890')).toBe(
      'https://tally.so/r/nGM0Py?phone=6281234567890',
    );
    // Nomor + nama → dua parameter.
    expect(formPublicUrlForCustomer('tally', 'nGM0Py', '6281234567890', 'Budi Santoso')).toBe(
      'https://tally.so/r/nGM0Py?phone=6281234567890&name=Budi+Santoso',
    );
    // Nama saja (tanpa nomor) → prefill name tetap.
    expect(formPublicUrlForCustomer('tally', 'nGM0Py', null, 'Budi Santoso')).toBe(
      'https://tally.so/r/nGM0Py?name=Budi+Santoso',
    );
    // Token chat asal (dari bot) → parameter orioleChatId.
    expect(
      formPublicUrlForCustomer('tally', 'nGM0Py', '6281234567890', 'Budi', '123456789'),
    ).toBe('https://tally.so/r/nGM0Py?phone=6281234567890&name=Budi&orioleChatId=123456789');
    // Token saja (nomor/nama tak dikenal) → token tetap disuntikkan.
    expect(formPublicUrlForCustomer('tally', 'nGM0Py', null, null, '123456789')).toBe(
      'https://tally.so/r/nGM0Py?orioleChatId=123456789',
    );
    expect(formPublicUrlForCustomer('tally', 'nGM0Py', null)).toBe('https://tally.so/r/nGM0Py');
    expect(formPublicUrlForCustomer('tally', 'nGM0Py', '')).toBe('https://tally.so/r/nGM0Py');
    expect(formPublicUrlForCustomer('google-forms', 'form-abc', '6281234567890', 'Budi')).toBe(
      'https://docs.google.com/forms/d/e/form-abc/viewform',
    );
  });
});
