import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createTelnyxCredentialMock, findTelnyxCredentialByNameMock } = vi.hoisted(() => ({
  createTelnyxCredentialMock: vi.fn(),
  findTelnyxCredentialByNameMock: vi.fn(),
}));

vi.mock('../services/vapi-credential.ts', () => ({
  createTelnyxCredential: createTelnyxCredentialMock,
  findTelnyxCredentialByName: findTelnyxCredentialByNameMock,
}));

const { registerTelnyxNumberInVapiMock } = vi.hoisted(() => ({
  registerTelnyxNumberInVapiMock: vi.fn(),
}));

vi.mock('../services/telnyx-vapi.ts', () => ({
  registerTelnyxNumberInVapi: registerTelnyxNumberInVapiMock,
}));

import { TelnyxApiError } from '../services/telnyx.ts';
import {
  connectTelnyxByoc,
  searchTelnyxByoc,
  TelnyxByocNumberUnavailableError,
} from './telnyx-byoc.ts';

const TELNYX_NUMBER = '+6282199999999';
const CREDENTIAL_NAME = 'oriole-byoc-ws-1';
const API_KEY = 'telnyx_key_secret_123';

function makeTelnyx() {
  return {
    searchAvailableNumbers: vi.fn(),
    listOwnedNumbers: vi.fn(),
    orderNumber: vi.fn(),
  };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    telnyx: makeTelnyx() as never,
    vapi: {} as never,
    apiKey: API_KEY,
    existingCredentialId: null,
    credentialName: CREDENTIAL_NAME,
    phoneNumber: TELNYX_NUMBER,
    ...overrides,
  };
}

beforeEach(() => {
  createTelnyxCredentialMock.mockReset();
  findTelnyxCredentialByNameMock.mockReset();
  registerTelnyxNumberInVapiMock.mockReset();
  registerTelnyxNumberInVapiMock.mockResolvedValue({ vapiPhoneNumberId: 'pn-1', created: true });
});

describe('searchTelnyxByoc', () => {
  it('mengembalikan owned + available (tanpa duplikat milik sendiri)', async () => {
    const telnyx = makeTelnyx();
    telnyx.listOwnedNumbers.mockResolvedValue([{ id: 'tn-1', phoneNumber: TELNYX_NUMBER }]);
    telnyx.searchAvailableNumbers.mockResolvedValue([
      { phoneNumber: TELNYX_NUMBER, locality: 'Jakarta' },
      { phoneNumber: '+6282188888888' },
    ]);

    const result = await searchTelnyxByoc({
      telnyx: telnyx as never,
      countryCode: 'id',
      areaCode: '21',
    });

    expect(result.owned).toEqual([{ id: 'tn-1', phoneNumber: TELNYX_NUMBER }]);
    // Nomor yang sudah dimiliki tidak muncul dua kali di daftar tersedia.
    expect(result.available).toEqual([{ phoneNumber: '+6282188888888' }]);
    expect(telnyx.searchAvailableNumbers).toHaveBeenCalledWith({
      countryCode: 'id',
      areaCode: '21',
      limit: 20,
    });
  });
});

describe('connectTelnyxByoc', () => {
  it('happy path: credential baru + beli nomor + daftar ke Vapi', async () => {
    findTelnyxCredentialByNameMock.mockResolvedValue(null);
    createTelnyxCredentialMock.mockResolvedValue({ id: 'cred-new' });
    const telnyx = makeTelnyx();
    telnyx.listOwnedNumbers.mockResolvedValue([]);
    telnyx.orderNumber.mockResolvedValue({ id: 'order-1', status: 'success', phoneNumber: TELNYX_NUMBER });

    const result = await connectTelnyxByoc(baseInput({ telnyx: telnyx as never }));

    expect(result).toEqual({
      vapiCredentialId: 'cred-new',
      vapiPhoneNumberId: 'pn-1',
      telnyxNumber: TELNYX_NUMBER,
      purchased: true,
      registered: true,
    });
    expect(createTelnyxCredentialMock).toHaveBeenCalledWith({
      vapi: expect.anything(),
      apiKey: API_KEY,
      name: CREDENTIAL_NAME,
    });
    expect(telnyx.orderNumber).toHaveBeenCalledWith(TELNYX_NUMBER);
    expect(registerTelnyxNumberInVapiMock).toHaveBeenCalledWith(
      expect.objectContaining({ telnyxNumber: TELNYX_NUMBER, credentialId: 'cred-new' }),
    );
  });

  it('existingCredentialId dari row → reuse tanpa find/create', async () => {
    const telnyx = makeTelnyx();
    telnyx.listOwnedNumbers.mockResolvedValue([{ id: 'tn-1', phoneNumber: TELNYX_NUMBER }]);

    const result = await connectTelnyxByoc(
      baseInput({ telnyx: telnyx as never, existingCredentialId: 'cred-ada' }),
    );

    expect(result.vapiCredentialId).toBe('cred-ada');
    expect(findTelnyxCredentialByNameMock).not.toHaveBeenCalled();
    expect(createTelnyxCredentialMock).not.toHaveBeenCalled();
    // Nomor sudah dimiliki → tanpa pembelian.
    expect(telnyx.orderNumber).not.toHaveBeenCalled();
    expect(result.purchased).toBe(false);
  });

  it('adopsi credential orphan by nama (attempt gagal di tengah) — tanpa create ganda', async () => {
    findTelnyxCredentialByNameMock.mockResolvedValue({ id: 'cred-orphan' });
    const telnyx = makeTelnyx();
    telnyx.listOwnedNumbers.mockResolvedValue([{ id: 'tn-1', phoneNumber: TELNYX_NUMBER }]);

    const result = await connectTelnyxByoc(baseInput({ telnyx: telnyx as never }));

    expect(result.vapiCredentialId).toBe('cred-orphan');
    expect(createTelnyxCredentialMock).not.toHaveBeenCalled();
  });

  it('normalisasi nomor ke E.164 sebelum dipakai', async () => {
    findTelnyxCredentialByNameMock.mockResolvedValue(null);
    createTelnyxCredentialMock.mockResolvedValue({ id: 'cred-new' });
    const telnyx = makeTelnyx();
    telnyx.listOwnedNumbers.mockResolvedValue([]);
    telnyx.orderNumber.mockResolvedValue({ id: 'o', status: 'success', phoneNumber: TELNYX_NUMBER });

    await connectTelnyxByoc(baseInput({ telnyx: telnyx as never, phoneNumber: ' 62821 9999 9999 ' }));

    expect(telnyx.orderNumber).toHaveBeenCalledWith(TELNYX_NUMBER);
    expect(registerTelnyxNumberInVapiMock).toHaveBeenCalledWith(
      expect.objectContaining({ telnyxNumber: TELNYX_NUMBER }),
    );
  });

  it('order 422 tapi nomor ternyata sudah milik akun (race) → lanjut tanpa gagal', async () => {
    findTelnyxCredentialByNameMock.mockResolvedValue(null);
    createTelnyxCredentialMock.mockResolvedValue({ id: 'cred-new' });
    const telnyx = makeTelnyx();
    telnyx.listOwnedNumbers.mockResolvedValueOnce([]); // cek awal: belum dimiliki
    telnyx.orderNumber.mockRejectedValue(new TelnyxApiError(422, 'already owned'));
    telnyx.listOwnedNumbers.mockResolvedValueOnce([{ id: 'tn-1', phoneNumber: TELNYX_NUMBER }]); // cek ulang

    const result = await connectTelnyxByoc(baseInput({ telnyx: telnyx as never }));

    expect(result.purchased).toBe(false);
    expect(registerTelnyxNumberInVapiMock).toHaveBeenCalled();
  });

  it('order 422 dan nomor BUKAN milik akun → TelnyxByocNumberUnavailableError', async () => {
    findTelnyxCredentialByNameMock.mockResolvedValue(null);
    createTelnyxCredentialMock.mockResolvedValue({ id: 'cred-new' });
    const telnyx = makeTelnyx();
    telnyx.listOwnedNumbers.mockResolvedValueOnce([]);
    telnyx.orderNumber.mockRejectedValue(new TelnyxApiError(422, 'not available'));
    telnyx.listOwnedNumbers.mockResolvedValueOnce([]);

    await expect(connectTelnyxByoc(baseInput({ telnyx: telnyx as never }))).rejects.toBeInstanceOf(
      TelnyxByocNumberUnavailableError,
    );
    expect(registerTelnyxNumberInVapiMock).not.toHaveBeenCalled();
  });

  it('error order lain (500) → diteruskan, tidak mendaftarkan apa pun', async () => {
    findTelnyxCredentialByNameMock.mockResolvedValue(null);
    createTelnyxCredentialMock.mockResolvedValue({ id: 'cred-new' });
    const telnyx = makeTelnyx();
    telnyx.listOwnedNumbers.mockResolvedValue([]);
    telnyx.orderNumber.mockRejectedValue(new TelnyxApiError(500, 'internal'));

    await expect(connectTelnyxByoc(baseInput({ telnyx: telnyx as never }))).rejects.toMatchObject({
      name: 'TelnyxApiError',
      status: 500,
    });
    expect(registerTelnyxNumberInVapiMock).not.toHaveBeenCalled();
  });

  it('error list kepemilikan (key invalid) → diteruskan SEBELUM buat credential (no orphan)', async () => {
    const telnyx = makeTelnyx();
    telnyx.listOwnedNumbers.mockRejectedValue(new TelnyxApiError(401, 'Invalid API key'));

    await expect(connectTelnyxByoc(baseInput({ telnyx: telnyx as never }))).rejects.toMatchObject({
      name: 'TelnyxApiError',
      status: 401,
    });
    expect(findTelnyxCredentialByNameMock).not.toHaveBeenCalled();
    expect(createTelnyxCredentialMock).not.toHaveBeenCalled();
    expect(registerTelnyxNumberInVapiMock).not.toHaveBeenCalled();
  });
});
