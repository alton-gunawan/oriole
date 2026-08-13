import { describe, expect, it, vi } from 'vitest';

import { findVapiPhoneNumberByTelnyx, registerTelnyxNumberInVapi } from './telnyx-vapi.ts';

type MockVapi = {
  phoneNumbers: {
    list: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
};

function makeVapi(): MockVapi {
  return {
    phoneNumbers: {
      list: vi.fn(),
      create: vi.fn(),
    },
  };
}

describe('findVapiPhoneNumberByTelnyx', () => {
  it('menemukan nomor dengan provider telnyx + nomor cocok', async () => {
    const vapi = makeVapi();
    vapi.phoneNumbers.list.mockResolvedValue([
      { id: 'pn-1', provider: 'twilio', number: '+15551112222' },
      { id: 'pn-2', provider: 'telnyx', number: '+6281234567890' },
    ]);

    const id = await findVapiPhoneNumberByTelnyx(vapi as never, '+6281234567890');
    expect(id).toBe('pn-2');
  });

  it('mengembalikan null bila belum terdaftar', async () => {
    const vapi = makeVapi();
    vapi.phoneNumbers.list.mockResolvedValue([{ id: 'pn-1', provider: 'vapi', number: '+1555000' }]);

    const id = await findVapiPhoneNumberByTelnyx(vapi as never, '+6281234567890');
    expect(id).toBeNull();
  });
});

describe('registerTelnyxNumberInVapi', () => {
  it('sudah terdaftar → reuse id tanpa create', async () => {
    const vapi = makeVapi();
    vapi.phoneNumbers.list.mockResolvedValue([{ id: 'pn-9', provider: 'telnyx', number: '+6281234567890' }]);

    const result = await registerTelnyxNumberInVapi({
      vapi: vapi as never,
      telnyxNumber: '+6281234567890',
      credentialId: 'cred-1',
      name: 'oriole-telnyx',
    });

    expect(result).toEqual({ vapiPhoneNumberId: 'pn-9', created: false });
    expect(vapi.phoneNumbers.create).not.toHaveBeenCalled();
  });

  it('belum terdaftar → create dengan provider telnyx + credentialId', async () => {
    const vapi = makeVapi();
    vapi.phoneNumbers.list.mockResolvedValue([]);
    vapi.phoneNumbers.create.mockResolvedValue({ id: 'pn-new', provider: 'telnyx', number: '+6281234567890' });

    const result = await registerTelnyxNumberInVapi({
      vapi: vapi as never,
      telnyxNumber: '+6281234567890',
      credentialId: 'cred-1',
      name: 'oriole-telnyx-+6281234567890',
    });

    expect(result).toEqual({ vapiPhoneNumberId: 'pn-new', created: true });
    expect(vapi.phoneNumbers.create).toHaveBeenCalledWith({
      provider: 'telnyx',
      number: '+6281234567890',
      credentialId: 'cred-1',
      name: 'oriole-telnyx-+6281234567890',
    });
  });

  it('response create dengan provider aneh → error jelas', async () => {
    const vapi = makeVapi();
    vapi.phoneNumbers.list.mockResolvedValue([]);
    vapi.phoneNumbers.create.mockResolvedValue({ id: 'pn-x', provider: 'twilio' });

    await expect(
      registerTelnyxNumberInVapi({
        vapi: vapi as never,
        telnyxNumber: '+6281234567890',
        credentialId: 'cred-1',
      }),
    ).rejects.toThrow("provider 'twilio'");
  });
});
