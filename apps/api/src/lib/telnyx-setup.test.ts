import { beforeEach, describe, expect, it, vi } from 'vitest';

const { registerTelnyxNumberInVapiMock } = vi.hoisted(() => ({
  registerTelnyxNumberInVapiMock: vi.fn(),
}));

vi.mock('../services/telnyx-vapi.ts', () => ({
  registerTelnyxNumberInVapi: registerTelnyxNumberInVapiMock,
}));

import { runTelnyxSetup } from './telnyx-setup.ts';

function makeTelnyx() {
  return {
    searchAvailableNumbers: vi.fn(),
    listOwnedNumbers: vi.fn(),
    orderNumber: vi.fn(),
  };
}

const TELNYX_NUMBER = '+6281234567890';

beforeEach(() => {
  registerTelnyxNumberInVapiMock.mockReset();
  registerTelnyxNumberInVapiMock.mockResolvedValue({ vapiPhoneNumberId: 'pn-1', created: true });
});

describe('runTelnyxSetup — tanpa credentialId', () => {
  it('gagal cepat dengan pesan VAPI_TELNYX_CREDENTIAL_ID', async () => {
    const telnyx = makeTelnyx();
    telnyx.listOwnedNumbers.mockResolvedValue([]);

    await expect(
      runTelnyxSetup({
        telnyx: telnyx as never,
        vapi: {} as never,
        credentialId: '',
        countryCode: 'ID',
      }),
    ).rejects.toThrow('VAPI_TELNYX_CREDENTIAL_ID');
    expect(telnyx.listOwnedNumbers).not.toHaveBeenCalled();
  });
});

describe('runTelnyxSetup — nomor pilihan (preferredNumber)', () => {
  it('nomor sudah dimiliki & sudah di Vapi → already-configured, tanpa beli', async () => {
    const telnyx = makeTelnyx();
    telnyx.listOwnedNumbers.mockResolvedValue([{ id: 'tn-1', phoneNumber: TELNYX_NUMBER }]);
    registerTelnyxNumberInVapiMock.mockResolvedValue({ vapiPhoneNumberId: 'pn-1', created: false });

    const result = await runTelnyxSetup({
      telnyx: telnyx as never,
      vapi: {} as never,
      credentialId: 'cred-1',
      preferredNumber: TELNYX_NUMBER,
      countryCode: 'ID',
    });

    expect(result).toEqual({
      status: 'already-configured',
      telnyxNumber: TELNYX_NUMBER,
      vapiPhoneNumberId: 'pn-1',
      purchased: false,
      registered: false,
    });
    expect(telnyx.orderNumber).not.toHaveBeenCalled();
    expect(registerTelnyxNumberInVapiMock).toHaveBeenCalledWith(
      expect.objectContaining({ telnyxNumber: TELNYX_NUMBER, credentialId: 'cred-1' }),
    );
  });

  it('nomor belum dimiliki → beli + daftarkan ke Vapi', async () => {
    const telnyx = makeTelnyx();
    telnyx.listOwnedNumbers.mockResolvedValue([]);
    telnyx.orderNumber.mockResolvedValue({ id: 'order-1', status: 'success', phoneNumber: TELNYX_NUMBER });

    const result = await runTelnyxSetup({
      telnyx: telnyx as never,
      vapi: {} as never,
      credentialId: 'cred-1',
      preferredNumber: ' 6281234567890 ', // dinormalisasi ke E.164
      countryCode: 'ID',
    });

    expect(result).toMatchObject({
      status: 'registered',
      telnyxNumber: TELNYX_NUMBER,
      vapiPhoneNumberId: 'pn-1',
      purchased: true,
      registered: true,
      orderStatus: 'success',
    });
    expect(telnyx.orderNumber).toHaveBeenCalledWith(TELNYX_NUMBER);
  });

  it('dry-run → tidak membeli, tidak mendaftarkan', async () => {
    const telnyx = makeTelnyx();
    telnyx.listOwnedNumbers.mockResolvedValue([]);

    const result = await runTelnyxSetup({
      telnyx: telnyx as never,
      vapi: {} as never,
      credentialId: 'cred-1',
      preferredNumber: TELNYX_NUMBER,
      countryCode: 'ID',
      dryRun: true,
    });

    expect(result).toEqual({
      status: 'dry-run',
      telnyxNumber: TELNYX_NUMBER,
      vapiPhoneNumberId: null,
      purchased: true,
      registered: true,
    });
    expect(telnyx.orderNumber).not.toHaveBeenCalled();
    expect(registerTelnyxNumberInVapiMock).not.toHaveBeenCalled();
  });
});

describe('runTelnyxSetup — pencarian otomatis', () => {
  it('cari → beli hasil pertama → daftarkan', async () => {
    const telnyx = makeTelnyx();
    telnyx.listOwnedNumbers.mockResolvedValue([]);
    telnyx.searchAvailableNumbers.mockResolvedValue([
      { phoneNumber: TELNYX_NUMBER, locality: 'Jakarta' },
      { phoneNumber: '+6281299999999', locality: null },
    ]);
    telnyx.orderNumber.mockResolvedValue({ id: 'order-1', status: 'success', phoneNumber: TELNYX_NUMBER });

    const result = await runTelnyxSetup({
      telnyx: telnyx as never,
      vapi: {} as never,
      credentialId: 'cred-1',
      countryCode: 'id',
      areaCode: '21',
    });

    expect(telnyx.searchAvailableNumbers).toHaveBeenCalledWith(
      expect.objectContaining({ countryCode: 'id', areaCode: '21' }),
    );
    expect(telnyx.orderNumber).toHaveBeenCalledWith(TELNYX_NUMBER);
    expect(result).toMatchObject({ status: 'registered', telnyxNumber: TELNYX_NUMBER, purchased: true });
  });

  it('inventory kosong → error jelas dengan negara', async () => {
    const telnyx = makeTelnyx();
    telnyx.listOwnedNumbers.mockResolvedValue([]);
    telnyx.searchAvailableNumbers.mockResolvedValue([]);

    await expect(
      runTelnyxSetup({
        telnyx: telnyx as never,
        vapi: {} as never,
        credentialId: 'cred-1',
        countryCode: 'ID',
      }),
    ).rejects.toThrow('Tidak ada nomor Telnyx voice-capable tersedia untuk negara ID');
  });

  it('dry-run → pencarian jalan, pembelian & registrasi tidak', async () => {
    const telnyx = makeTelnyx();
    telnyx.listOwnedNumbers.mockResolvedValue([]);
    telnyx.searchAvailableNumbers.mockResolvedValue([{ phoneNumber: TELNYX_NUMBER }]);

    const result = await runTelnyxSetup({
      telnyx: telnyx as never,
      vapi: {} as never,
      credentialId: 'cred-1',
      countryCode: 'ID',
      dryRun: true,
    });

    expect(result).toEqual({
      status: 'dry-run',
      telnyxNumber: TELNYX_NUMBER,
      vapiPhoneNumberId: null,
      purchased: true,
      registered: true,
    });
    expect(telnyx.orderNumber).not.toHaveBeenCalled();
    expect(registerTelnyxNumberInVapiMock).not.toHaveBeenCalled();
  });
});
