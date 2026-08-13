import { describe, expect, it, vi } from 'vitest';

import { createTelnyxClient, TelnyxNotConfiguredError, toE164 } from './telnyx.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type FetchHandler = (url: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>;

function mockFetch(handler: FetchHandler): typeof fetch {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => handler(url, init)) as typeof fetch;
}

describe('toE164', () => {
  it('menambahkan + dan membersihkan karakter non-digit', () => {
    expect(toE164('6281234567890')).toBe('+6281234567890');
    expect(toE164('+62 812-3456-7890')).toBe('+6281234567890');
  });

  it('melempar error untuk input kosong', () => {
    expect(() => toE164('   ')).toThrow('kosong');
  });
});

describe('createTelnyxClient — tanpa API key (fail-closed)', () => {
  it('semua operasi melempar TelnyxNotConfiguredError', async () => {
    const client = createTelnyxClient(undefined, mockFetch(() => new Response('{}')));
    await expect(client.searchAvailableNumbers({ countryCode: 'ID' })).rejects.toThrow(TelnyxNotConfiguredError);
    await expect(client.listOwnedNumbers()).rejects.toThrow(TelnyxNotConfiguredError);
    await expect(client.orderNumber('+6281234567890')).rejects.toThrow(TelnyxNotConfiguredError);
  });
});

describe('searchAvailableNumbers', () => {
  it('mengirim filter country/area/voice + auth Bearer, memetakan hasil', async () => {
    const fetchMock = mockFetch((url, init) => {
      const u = String(url);
      expect(u).toContain('filter%5Bcountry_code%5D=ID');
      expect(u).toContain('filter%5Barea_code%5D=21');
      expect(u).toContain('filter%5Bfeatures%5D%5B%5D=voice');
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer telnyx-key' });
      return jsonResponse({
        data: [
          {
            phone_number: '+628211234567',
            region_information: [{ region_type: 'locality', region_name: 'Jakarta' }],
          },
          { phone_number: '+628219999999', region_information: [] },
        ],
      });
    });

    const client = createTelnyxClient('telnyx-key', fetchMock);
    const results = await client.searchAvailableNumbers({ countryCode: 'id', areaCode: '21', limit: 5 });

    expect(results).toEqual([
      { phoneNumber: '+628211234567', locality: 'Jakarta' },
      { phoneNumber: '+628219999999', locality: null },
    ]);
  });
});

describe('listOwnedNumbers', () => {
  it('menarik semua halaman dan memetakan connectionId', async () => {
    const calls: string[] = [];
    const fetchMock = mockFetch((url) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('page%5Bnumber%5D=1')) {
        return jsonResponse({
          data: [{ id: 'n-1', phone_number: '+628200000001', connection_id: 'conn-1' }],
          meta: { total_pages: 2 },
        });
      }
      return jsonResponse({
        data: [{ id: 'n-2', phone_number: '+628200000002', connection_id: null }],
        meta: { total_pages: 2 },
      });
    });

    const client = createTelnyxClient('telnyx-key', fetchMock);
    const results = await client.listOwnedNumbers();

    expect(results).toEqual([
      { id: 'n-1', phoneNumber: '+628200000001', connectionId: 'conn-1' },
      { id: 'n-2', phoneNumber: '+628200000002', connectionId: null },
    ]);
    expect(calls).toHaveLength(2);
  });
});

describe('orderNumber', () => {
  it('mengirim payload number_orders dengan nomor E.164 dan memetakan hasil', async () => {
    const fetchMock = mockFetch((_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ phone_numbers: [{ phone_number: '+6281234567890' }] });
      return jsonResponse({
        data: {
          id: 'order-1',
          status: 'success',
          phone_numbers: [{ phone_number: '+6281234567890' }],
        },
      });
    });

    const client = createTelnyxClient('telnyx-key', fetchMock);
    const result = await client.orderNumber('6281234567890');

    expect(result).toEqual({ id: 'order-1', status: 'success', phoneNumber: '+6281234567890' });
  });
});

describe('error handling', () => {
  it('non-2xx dengan message top-level → status + message', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ message: 'Number is not available for purchase' }, 422));
    const client = createTelnyxClient('telnyx-key', fetchMock);
    await expect(client.orderNumber('+6281234567890')).rejects.toThrow('Telnyx API 422');
    await expect(client.orderNumber('+6281234567890')).rejects.toThrow('Number is not available for purchase');
  });

  it('non-2xx tanpa message → detail dari array errors', async () => {
    const fetchMock = mockFetch(() =>
      jsonResponse({ errors: [{ title: 'validation_error', detail: 'number taken' }] }, 422),
    );
    const client = createTelnyxClient('telnyx-key', fetchMock);
    await expect(client.orderNumber('+6281234567890')).rejects.toThrow('Telnyx API 422');
    await expect(client.orderNumber('+6281234567890')).rejects.toThrow('validation_error');
  });

  it('error tanpa body JSON → pakai statusText', async () => {
    const fetchMock = mockFetch(() => new Response('oops', { status: 500, statusText: 'Internal Server Error' }));
    const client = createTelnyxClient('telnyx-key', fetchMock);
    await expect(client.listOwnedNumbers()).rejects.toThrow('Telnyx API 500');
  });
});
