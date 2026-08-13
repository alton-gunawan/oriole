import { describe, expect, it, vi } from 'vitest';

// vapi.ts membaca env saat import — mock wajib agar tidak validasi .env.
vi.mock('../lib/env.ts', () => ({
  env: {
    API_URL: 'http://localhost:3000',
    VAPI_API_KEY: 'vapi_test_key',
    VAPI_PHONE_NUMBER_ID: 'pn-default-1',
    VAPI_WEBHOOK_SECRET: 'webhook-secret',
    VAPI_MODEL: 'gpt-4o-mini',
    VAPI_VOICE_ID: 'voice-1',
  },
}));

import { filterOperatorVapiNumbers, VAPI_BYOC_NAME_PREFIX } from './vapi.ts';

describe('filterOperatorVapiNumbers', () => {
  it('menyaring nomor BYOC (prefix oriole-byoc-) dari picker operator', () => {
    const numbers = [
      { id: 'pn-byoc', number: '+628211111111', name: 'oriole-byoc-+628211111111', provider: 'telnyx' },
      { id: 'pn-operator', number: '+15550000000', name: 'Default', provider: 'vapi' },
      { id: 'pn-telnyx-ops', number: '+15551112222', name: null, provider: 'telnyx' },
    ];

    const result = filterOperatorVapiNumbers(numbers);

    expect(result.map((n) => n.id)).toEqual(['pn-operator', 'pn-telnyx-ops']);
  });

  it('tanpa nomor BYOC → semua nomor operator tetap tampil', () => {
    const numbers = [
      { id: 'pn-1', number: '+15550000000', name: null, provider: 'vapi' },
      { id: 'pn-2', number: '+15551112222', name: 'Support line', provider: 'telnyx' },
    ];

    expect(filterOperatorVapiNumbers(numbers)).toHaveLength(2);
  });

  it('prefix tetap konsisten dengan nama yang dipakai registrasi BYOC', () => {
    expect(VAPI_BYOC_NAME_PREFIX).toBe('oriole-byoc-');
  });
});
