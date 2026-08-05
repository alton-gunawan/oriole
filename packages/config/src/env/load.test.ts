import { describe, expect, it } from 'vitest';

import { parseEnvFile } from './load';

describe('parseEnvFile', () => {
  it('mem-parse pasangan key=value sederhana', () => {
    expect(parseEnvFile('A=1\nB=two\n')).toEqual({ A: '1', B: 'two' });
  });

  it('mengabaikan baris kosong dan komentar', () => {
    expect(parseEnvFile('# komentar\n\nA=1\n  # komentar lain\n')).toEqual({ A: '1' });
  });

  it('menghapus kutipan ganda dan tunggal', () => {
    expect(parseEnvFile('NAME="Oriole"\nURL=\'http://x.test\'')).toEqual({
      NAME: 'Oriole',
      URL: 'http://x.test',
    });
  });

  it('nilai kosong tetap ada sebagai string kosong', () => {
    expect(parseEnvFile('EMPTY=\nFULL=1')).toEqual({ EMPTY: '', FULL: '1' });
  });

  it('menangani baris dengan CRLF', () => {
    expect(parseEnvFile('A=1\r\nB=2\r\n')).toEqual({ A: '1', B: '2' });
  });

  it('nilai boleh mengandung tanda =', () => {
    expect(parseEnvFile('URL=https://x.test/path?a=1&b=2')).toEqual({
      URL: 'https://x.test/path?a=1&b=2',
    });
  });

  it('key boleh memiliki spasi di sekitar =', () => {
    expect(parseEnvFile('  KEY  =  value  ')).toEqual({ KEY: 'value' });
  });
});
