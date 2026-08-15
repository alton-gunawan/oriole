import { beforeEach, describe, expect, it, vi } from 'vitest';

// GRAPH_BASE dihitung saat modul dimuat dari env.META_GRAPH_API_VERSION —
// mock env dulu sebelum import (pola sama dengan tally.test.ts).
vi.mock('../lib/env.ts', () => ({
  env: { META_GRAPH_API_VERSION: 'v21.0' },
}));

import {
  buildMetaWhatsappSignupUrl,
  exchangeWhatsappCode,
  getWabaInfo,
  getWabaPhoneNumbers,
  metaSendMessage,
  registerPhoneNumber,
  resolveWabaIdByToken,
  subscribeAppToWaba,
} from './meta-whatsapp.ts';

const GRAPH = 'https://graph.facebook.com/v21.0';

/* ────────────────────────────────────────────────────────────
 * buildMetaWhatsappSignupUrl — pure
 * ──────────────────────────────────────────────────────────── */
describe('buildMetaWhatsappSignupUrl', () => {
  it('membangun URL dialog Embedded Signup dengan app_id/config_id/state/redirect_uri', () => {
    const url = buildMetaWhatsappSignupUrl({
      version: 'v21.0',
      appId: '123456789',
      configId: '987654321',
      state: 'csrf-state',
      redirectUri: 'https://api.example.com/api/whatsapp-business/connect/callback',
    });
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://www.facebook.com');
    expect(parsed.pathname).toBe('/v21.0/dialog/whatsapp_business_signup');
    expect(parsed.searchParams.get('app_id')).toBe('123456789');
    expect(parsed.searchParams.get('config_id')).toBe('987654321');
    expect(parsed.searchParams.get('state')).toBe('csrf-state');
    expect(parsed.searchParams.get('redirect_uri')).toBe(
      'https://api.example.com/api/whatsapp-business/connect/callback',
    );
  });
});

/* ────────────────────────────────────────────────────────────
 * API client — fetch di-stub
 * ──────────────────────────────────────────────────────────── */
describe('Meta WhatsApp Graph API client', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('exchangeWhatsappCode menukar code → token (respons teks polos)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'EAAbBusinessToken',
    });

    const token = await exchangeWhatsappCode({
      appId: '123',
      appSecret: 'secret',
      code: 'auth-code',
    });
    expect(token).toBe('EAAbBusinessToken');

    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe('/v21.0/oauth/access_token');
    expect(parsed.searchParams.get('client_id')).toBe('123');
    expect(parsed.searchParams.get('client_secret')).toBe('secret');
    expect(parsed.searchParams.get('code')).toBe('auth-code');
  });

  it('exchangeWhatsappCode melempar MetaWhatsAppApiError saat Meta menolak', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { message: 'Invalid code', code: 100 } }),
    });
    await expect(
      exchangeWhatsappCode({ appId: '123', appSecret: 'secret', code: 'bad' }),
    ).rejects.toMatchObject({ name: 'MetaWhatsAppApiError', status: 400 });
  });

  it('resolveWabaIdByToken membaca target_ids dari granular_scopes', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          data: {
            granular_scopes: [
              { scope: 'whatsapp_business_messaging', target_ids: ['111'] },
              { scope: 'whatsapp_business_management', target_ids: ['222'] },
            ],
          },
        }),
    });

    const wabaId = await resolveWabaIdByToken({
      systemUserToken: 'sys-token',
      businessToken: 'biz-token',
    });
    expect(wabaId).toBe('222');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${GRAPH}/debug_token?input_token=biz-token`);
    expect(((init as RequestInit).headers as Headers).get('authorization')).toBe('Bearer sys-token');
  });

  it('resolveWabaIdByToken → null bila scope management tidak ada', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: { granular_scopes: [] } }),
    });
    await expect(
      resolveWabaIdByToken({ systemUserToken: 'sys-token', businessToken: 'biz-token' }),
    ).resolves.toBeNull();
  });

  it('getWabaPhoneNumbers memetakan data → MetaWhatsAppPhoneNumber[]', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          data: [
            {
              id: 'pn-1',
              display_phone_number: '+62 812-3456-7890',
              verified_name: 'Klinik Gigi Sehat',
              quality_rating: 'GREEN',
              code_verification_status: 'VERIFIED',
              name_status: 'APPROVED',
            },
          ],
        }),
    });

    const phones = await getWabaPhoneNumbers({ businessToken: 'biz-token', wabaId: 'waba-1' });
    expect(phones).toEqual([
      {
        id: 'pn-1',
        displayPhoneNumber: '+62 812-3456-7890',
        verifiedName: 'Klinik Gigi Sehat',
        qualityRating: 'GREEN',
        codeVerificationStatus: 'VERIFIED',
        nameStatus: 'APPROVED',
      },
    ]);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `${GRAPH}/waba-1/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status,name_status`,
    );
  });

  it('getWabaInfo membaca nama WABA', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ name: 'Sehat Bersama' }),
    });
    await expect(getWabaInfo({ businessToken: 'biz-token', wabaId: 'waba-1' })).resolves.toEqual({
      name: 'Sehat Bersama',
    });
  });

  it('subscribeAppToWaba POST /{waba}/subscribed_apps', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '{"success":true}' });
    await subscribeAppToWaba({ businessToken: 'biz-token', wabaId: 'waba-1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${GRAPH}/waba-1/subscribed_apps`);
    expect((init as RequestInit).method).toBe('POST');
  });

  it('registerPhoneNumber POST /{phone_number_id}/register dengan PIN', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '{"success":true}' });
    await registerPhoneNumber({ businessToken: 'biz-token', phoneNumberId: 'pn-1', pin: '123456' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${GRAPH}/pn-1/register`);
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      messaging_product: 'whatsapp',
      pin: '123456',
    });
  });

  it('metaSendMessage POST /{phone_number_id}/messages → wamid', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ messages: [{ id: 'wamid.out.1' }] }),
    });
    const result = await metaSendMessage({
      businessToken: 'biz-token',
      phoneNumberId: 'pn-1',
      body: { messaging_product: 'whatsapp', to: '6281234567890', type: 'text', text: { body: 'Halo' } },
    });
    expect(result).toEqual({ messageId: 'wamid.out.1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${GRAPH}/pn-1/messages`);
    expect((init as RequestInit).method).toBe('POST');
    expect(((init as RequestInit).headers as Headers).get('authorization')).toBe('Bearer biz-token');
  });

  it('non-2xx → MetaWhatsAppApiError dengan code Graph', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { message: '(#100) Param invalid', code: 100 } }),
    });
    await expect(
      metaSendMessage({ businessToken: 'biz-token', phoneNumberId: 'pn-1', body: {} }),
    ).rejects.toMatchObject({ name: 'MetaWhatsAppApiError', status: 400, code: 100 });
  });
});
