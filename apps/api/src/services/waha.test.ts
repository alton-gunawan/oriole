import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isWahaSessionAlreadyExistsError,
  WahaApiError,
  waIdToChatId,
  wahaCreateSession,
  wahaGetQr,
  wahaListSessions,
  wahaSendText,
  wahaStartSession,
  wahaUpdateSession,
} from './waha.ts';

// resolveWahaChannel membaca DB — test ini hanya untuk klien HTTP.
vi.mock('../db/index.ts', () => ({ db: {} }));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

afterEach(() => {
  fetchMock.mockReset();
});

function jsonResponse(status: number, body: unknown, contentType = 'application/json') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': contentType }),
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

/** Respons PNG mentah — WAHA baru (GET /api/{session}/auth/qr → image/png). */
function pngResponse(status: number, bytes: number[]) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'image/png' }),
    arrayBuffer: async () => new Uint8Array(bytes).buffer,
  } as unknown as Response;
}

describe('wahaListSessions — probe gateway', () => {
  it('memanggil GET /api/sessions?all=true dengan X-Api-Key', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, [{ name: 'ws_1', status: 'STOPPED' }]));

    const sessions = await wahaListSessions('http://waha.test:3000/', 'key-123');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://waha.test:3000/api/sessions?all=true',
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-api-key': 'key-123' }),
      }),
    );
    expect(sessions).toEqual([{ name: 'ws_1', status: 'STOPPED' }]);
  });

  it('HTTP error → WahaApiError dengan status', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: 'unauthorized' }));

    await expect(wahaListSessions('http://waha.test:3000', 'bad')).rejects.toMatchObject({
      status: 401,
    });
  });

  it('respons bukan array → WahaApiError (bukan gateway WAHA)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { status: 'ok' }));

    await expect(wahaListSessions('http://waha.test:3000', 'key')).rejects.toBeInstanceOf(WahaApiError);
  });
});

describe('waIdToChatId — wa_id → chatId WAHA', () => {
  it('menambahkan @c.us pada nomor polos', () => {
    expect(waIdToChatId('6281234567890')).toBe('6281234567890@c.us');
  });

  it('membiarkan identifier yang sudah bersuffix', () => {
    expect(waIdToChatId('6281234567890@c.us')).toBe('6281234567890@c.us');
    expect(waIdToChatId('6281234567890@s.whatsapp.net')).toBe('6281234567890@s.whatsapp.net');
    expect(waIdToChatId('6281234567890@lid')).toBe('6281234567890@lid');
  });
});

describe('wahaGetQr — ambil QR pairing', () => {
  it('GET (WAHA baru) PNG mentah → data-URI base64 + status null', async () => {
    // PNG 1x1: \x89PNG\r\n\x1a\n + IHDR … 8 byte payload
    fetchMock.mockResolvedValue(
      pngResponse(200, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]),
    );

    const qr = await wahaGetQr({ baseUrl: 'http://waha.test:3000', apiKey: 'key', session: 'ws_ws-1' });

    expect(qr.url).toBe('data:image/png;base64,iVBORw0KGgoAAQI=');
    expect(qr.status).toBeNull();
    expect(qr.expected).toBeNull();
    expect(qr.ttl).toBeNull();
    expect(fetchMock.mock.calls[0][0]).toBe('http://waha.test:3000/api/ws_ws-1/auth/qr');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'GET' });
    // Hanya satu percobaan — GET sukses, tidak perlu POST.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('GET JSON { mimetype, data } (WAHA 2026.x + Accept json) → data-URI + status null', async () => {
    // Bentuk NYATA yang dikembalikan gateway noweb-arm-2026.7.2 saat
    // wahaHeaders mengirim Accept: application/json.
    fetchMock.mockResolvedValue(
      jsonResponse(200, { mimetype: 'image/png', data: 'iVBORw0KGgoAAQI=' }),
    );

    const qr = await wahaGetQr({ baseUrl: 'http://waha.test:3000', apiKey: 'key', session: 'ws_ws-1' });

    expect(qr).toEqual({
      status: null,
      url: 'data:image/png;base64,iVBORw0KGgoAAQI=',
      expected: null,
      ttl: null,
    });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'GET' });
  });

  it('GET JSON (versi lama yang membalas GET) → parse qr.url / expected / ttl', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        status: 'SCAN_QR_CODE',
        qr: {
          url: 'data:image/png;base64,iVBORw0KGgo=',
          expected: 'CQTG-XJXL-4BD6',
          ttl: 20,
        },
      }),
    );

    const qr = await wahaGetQr({ baseUrl: 'http://waha.test:3000', apiKey: 'key', session: 'ws_ws-1' });

    expect(qr).toEqual({
      status: 'SCAN_QR_CODE',
      url: 'data:image/png;base64,iVBORw0KGgo=',
      expected: 'CQTG-XJXL-4BD6',
      ttl: 20,
    });
    expect(fetchMock.mock.calls[0][0]).toBe('http://waha.test:3000/api/ws_ws-1/auth/qr');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'GET' });
  });

  it('GET 404 → fallback POST (versi WAHA lama yang hanya melayani POST)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { error: 'not found' }));
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { status: 'SCAN_QR_CODE', url: 'data:image/png;base64,AAAA' }),
    );

    const qr = await wahaGetQr({ baseUrl: 'http://waha.test:3000', apiKey: 'key', session: 'ws_ws-1' });

    expect(qr.url).toBe('data:image/png;base64,AAAA');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'GET' });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST' });
  });

  it('GET PNG → status null; pemanggil probe session untuk WORKING (route)', async () => {
    // Mode PNG: URL valid, tapi status tidak tersedia di body gambar.
    fetchMock.mockResolvedValue(
      pngResponse(200, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );

    const qr = await wahaGetQr({ baseUrl: 'http://waha.test:3000', apiKey: 'key', session: 'ws_ws-1' });

    expect(qr.status).toBeNull();
    expect(qr.url).toMatch(/^data:image\/png;base64,/);
  });

  it('respons WORKING → status WORKING tanpa QR', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { status: 'WORKING', qr: null }));

    const qr = await wahaGetQr({ baseUrl: 'http://waha.test:3000', apiKey: 'key', session: 'ws_ws-1' });

    expect(qr).toEqual({ status: 'WORKING', url: null, expected: null, ttl: null });
  });

  it('GET + POST keduanya gagal → WahaApiError', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: 'boom' }));

    await expect(
      wahaGetQr({ baseUrl: 'http://waha.test:3000', apiKey: 'key', session: 'ws_ws-1' }),
    ).rejects.toBeInstanceOf(WahaApiError);
  });
});

describe('wahaStartSession — mulai session yang berhenti', () => {
  it('memanggil POST /api/sessions/{session}/start dengan X-Api-Key', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, { name: 'ws_1', status: 'SCAN_QR_CODE', config: {} }),
    );

    const result = await wahaStartSession('http://waha.test:3000/', 'key-123', 'ws_1');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://waha.test:3000/api/sessions/ws_1/start',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-api-key': 'key-123' }),
      }),
    );
    expect(result).toMatchObject({ name: 'ws_1', status: 'SCAN_QR_CODE' });
  });

  it('HTTP error → WahaApiError dengan status (mis. session hilang → 404)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { message: 'Not Found' }));

    await expect(wahaStartSession('http://waha.test:3000', 'key-123', 'ws_hilang')).rejects.toMatchObject(
      {
        message: expect.stringContaining('404'),
        status: 404,
      },
    );
  });
});

describe('wahaUpdateSession — perbarui session eksisting (PUT)', () => {
  const input = {
    baseUrl: 'http://waha.test:3000/',
    apiKey: 'key-123',
    name: 'ws_1',
    workspaceId: 'ws-1',
    webhookUrl: 'http://api.test/api/webhooks/waha/ws-1',
    webhookSecret: 'secret-abc',
  };

  it('memanggil PUT /api/sessions/{session} dengan config yang sama seperti create', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { name: 'ws_1', status: 'STARTING' }));

    const result = await wahaUpdateSession(input);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://waha.test:3000/api/sessions/ws_1',
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({ 'x-api-key': 'key-123' }),
      }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.config.webhooks[0]).toMatchObject({
      url: 'http://api.test/api/webhooks/waha/ws-1',
      hmac: { key: 'secret-abc' },
      events: ['message', 'message.ack', 'session.status'],
    });
    expect(body.config.metadata).toEqual({ 'workspace.id': 'ws-1' });
    expect(body.config.noweb.store).toEqual({ enabled: true, fullSync: false });
    expect(result).toMatchObject({ name: 'ws_1', status: 'STARTING' });
  });

  it('HTTP error → WahaApiError dengan status', async () => {
    fetchMock.mockResolvedValue(jsonResponse(422, { message: 'boom' }));

    await expect(wahaUpdateSession(input)).rejects.toMatchObject({
      message: expect.stringContaining('422'),
      status: 422,
    });
  });
});

describe('isWahaSessionAlreadyExistsError — deteksi "session sudah ada"', () => {
  it('WAHA lama (409) → true', () => {
    expect(isWahaSessionAlreadyExistsError(new WahaApiError('duplicate', 409))).toBe(true);
  });

  it('WAHA 2026.x (422 + pesan already exists) → true', () => {
    const err = new WahaApiError(
      `WAHA gagal membuat session: 422 {"message":"Session 'ws_1' already exists. Use PUT to update it."}`,
      422,
    );
    expect(isWahaSessionAlreadyExistsError(err)).toBe(true);
  });

  it('422 tanpa pesan already exists → false', () => {
    expect(isWahaSessionAlreadyExistsError(new WahaApiError('name too long', 422))).toBe(false);
  });

  it('status lain (500/401) → false', () => {
    expect(isWahaSessionAlreadyExistsError(new WahaApiError('down', 500))).toBe(false);
    expect(isWahaSessionAlreadyExistsError(new WahaApiError('unauthorized', 401))).toBe(false);
  });
});

describe('wahaSendText — kirim pesan teks', () => {
  it('memanggil POST /api/sendText dengan session + chatId + text', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: 'true_abc', key: { id: 'true_abc' } }));

    const result = await wahaSendText({
      baseUrl: 'http://waha.test:3000/',
      apiKey: 'key-123',
      session: 'ws_ws-1',
      chatId: '6281234567890@c.us',
      text: 'Halo!',
    });

    expect(result).toEqual({ messageId: 'true_abc' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://waha.test:3000/api/sendText');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      session: 'ws_ws-1',
      chatId: '6281234567890@c.us',
      text: 'Halo!',
    });
  });

  it('meneruskan reply_to saat disediakan', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: 'true_reply' }));

    await wahaSendText({
      baseUrl: 'http://waha.test:3000',
      apiKey: 'key',
      session: 'ws_ws-1',
      chatId: '6281234567890@c.us',
      text: 'Balasan',
      replyTo: 'evt_inbound_1',
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.reply_to).toBe('evt_inbound_1');
  });

  it('HTTP error → WahaApiError dengan status', async () => {
    fetchMock.mockResolvedValue(jsonResponse(463, { error: 'reachout timelock' }));

    await expect(
      wahaSendText({
        baseUrl: 'http://waha.test:3000',
        apiKey: 'key',
        session: 'ws_ws-1',
        chatId: '6281234567890@c.us',
        text: 'Halo',
      }),
    ).rejects.toMatchObject({ status: 463 });
  });
});

describe('wahaCreateSession — buat session dengan webhook + metadata', () => {
  it('mengirim body lengkap: webhook adapter, HMAC secret, metadata workspace', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { name: 'ws_ws-1', status: 'STARTING' }));

    const created = await wahaCreateSession({
      baseUrl: 'http://waha.test:3000',
      apiKey: 'key-123',
      name: 'ws_ws-1',
      workspaceId: 'ws-1',
      webhookUrl: 'https://api.example.com/api/webhooks/waha/ws-1',
      webhookSecret: 'secret-abc',
    });

    expect(created).toEqual({ name: 'ws_ws-1', status: 'STARTING' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://waha.test:3000/api/sessions');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      name: 'ws_ws-1',
      config: {
        webhooks: [
          {
            url: 'https://api.example.com/api/webhooks/waha/ws-1',
            events: ['message', 'message.ack', 'session.status'],
            hmac: { key: 'secret-abc' },
            retries: { policy: 'constant', delaySeconds: 2, attempts: 5 },
          },
        ],
        metadata: { 'workspace.id': 'ws-1' },
        // Store NOWEB aktif (history chat bertahan restart).
        noweb: { store: { enabled: true, fullSync: false } },
      },
    });
  });

  it('409 (session sudah ada) → WahaApiError status 409', async () => {
    fetchMock.mockResolvedValue(jsonResponse(409, { error: 'duplicate' }));

    await expect(
      wahaCreateSession({
        baseUrl: 'http://waha.test:3000',
        apiKey: 'key',
        name: 'ws_ws-1',
        workspaceId: 'ws-1',
        webhookUrl: 'https://x/api/webhooks/waha/ws-1',
        webhookSecret: 's',
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
