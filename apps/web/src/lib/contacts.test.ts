import { describe, expect, it } from 'vitest';

import { buildCreateContactPayload } from './contacts';

describe('buildCreateContactPayload', () => {
  it('trims fields and omits optional blanks', () => {
    expect(
      buildCreateContactPayload({
        name: '  Ada Lovelace  ',
        phone: '  +628123456789  ',
        email: '   ',
        notes: '  VIP customer  ',
      }),
    ).toEqual({
      name: 'Ada Lovelace',
      phone: '+628123456789',
      notes: 'VIP customer',
    });
  });

  it('rejects a missing name or phone number', () => {
    expect(
      buildCreateContactPayload({ name: 'Ada', phone: '', email: '', notes: '' }),
    ).toBeNull();
    expect(
      buildCreateContactPayload({ name: '', phone: '+628123456789', email: '', notes: '' }),
    ).toBeNull();
  });
});
