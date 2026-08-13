import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTelnyxCredential, findTelnyxCredentialByName } from './vapi-credential.ts';

type MockVapi = { fetch: ReturnType<typeof vi.fn> };

function makeVapi(): MockVapi {
  return { fetch: vi.fn() };
}

/** Bangun respons fetch palsu (bukan Response asli — cukup untuk klien kita). */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
  } as unknown as Response;
}

const CREDENTIAL_NAME = 'oriole-byoc-ws-1';
const API_KEY = 'telnyx_key_secret_123';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('createTelnyxCredential', () => {
  it('mengirim POST /credential dengan provider telnyx + apiKey + name, memakai id respons', async () => {
    const vapi = makeVapi();
    vapi.fetch.mockResolvedValue(jsonResponse({ id: 'cred-1', provider: 'telnyx' }));

    const result = await createTelnyxCredential({
      vapi: vapi as never,
      apiKey: API_KEY,
      name: CREDENTIAL_NAME,
    });

    expect(result).toEqual({ id: 'cred-1' });
    expect(vapi.fetch).toHaveBeenCalledWith(
      '/credential',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ provider: 'telnyx', apiKey: API_KEY, name: CREDENTIAL_NAME }),
      }),
    );
  });

  it('respons non-2xx → VapiCredentialApiError dengan pesan dari body', async () => {
    const vapi = makeVapi();
    vapi.fetch.mockResolvedValue(
      jsonResponse({ message: 'Provider key is invalid', statusCode: 400 }, 400),
    );

    await expect(
      createTelnyxCredential({ vapi: vapi as never, apiKey: API_KEY, name: CREDENTIAL_NAME }),
    ).rejects.toMatchObject({
      name: 'VapiCredentialApiError',
      status: 400,
      message: expect.stringContaining('Provider key is invalid'),
    });
  });

  it('respons 2xx tanpa id → error jelas (format API berubah)', async () => {
    const vapi = makeVapi();
    vapi.fetch.mockResolvedValue(jsonResponse({ provider: 'telnyx' }));

    await expect(
      createTelnyxCredential({ vapi: vapi as never, apiKey: API_KEY, name: CREDENTIAL_NAME }),
    ).rejects.toThrow('tidak memuat id');
  });
});

describe('findTelnyxCredentialByName', () => {
  it('respons array → cocokkan provider telnyx + name', async () => {
    const vapi = makeVapi();
    vapi.fetch.mockResolvedValue(
      jsonResponse([
        { id: 'cred-1', provider: 'twilio', name: 'twilio-x' },
        { id: 'cred-2', provider: 'telnyx', name: CREDENTIAL_NAME },
      ]),
    );

    const result = await findTelnyxCredentialByName(vapi as never, CREDENTIAL_NAME);
    expect(result).toEqual({ id: 'cred-2' });
    expect(vapi.fetch).toHaveBeenCalledWith('/credential', { method: 'GET' });
  });

  it('respons terbungkus { credentials: [...] } juga didukung', async () => {
    const vapi = makeVapi();
    vapi.fetch.mockResolvedValue(
      jsonResponse({ credentials: [{ id: 'cred-3', provider: 'telnyx', name: CREDENTIAL_NAME }] }),
    );

    const result = await findTelnyxCredentialByName(vapi as never, CREDENTIAL_NAME);
    expect(result).toEqual({ id: 'cred-3' });
  });

  it('tidak ada yang cocok → null (tanpa error)', async () => {
    const vapi = makeVapi();
    vapi.fetch.mockResolvedValue(jsonResponse([{ id: 'cred-1', provider: 'telnyx', name: 'lain' }]));

    const result = await findTelnyxCredentialByName(vapi as never, CREDENTIAL_NAME);
    expect(result).toBeNull();
  });

  it('respons non-2xx → VapiCredentialApiError (fail-closed)', async () => {
    const vapi = makeVapi();
    vapi.fetch.mockResolvedValue(jsonResponse({ message: 'Server error' }, 500));

    await expect(findTelnyxCredentialByName(vapi as never, CREDENTIAL_NAME)).rejects.toMatchObject({
      name: 'VapiCredentialApiError',
      status: 500,
    });
  });
});
