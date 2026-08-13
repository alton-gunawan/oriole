import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ZoomApiError, isZoomConfigured, getZoomAccessToken, createZoomMeeting, resetZoomTokenCache } from './zoom.ts';

vi.mock('./env.ts', () => ({
  env: {
    ZOOM_ACCOUNT_ID: 'test_account_id',
    ZOOM_CLIENT_ID: 'test_client_id',
    ZOOM_CLIENT_SECRET: 'test_client_secret',
  },
}));

const mockFetch = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  resetZoomTokenCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('isZoomConfigured', () => {
  it('mengembalikan true bila semua kredensial terisi (bukan placeholder)', () => {
    expect(isZoomConfigured()).toBe(true);
  });
});

describe('getZoomAccessToken', () => {
  it('melempar ZoomApiError bila fetch gagal (network error)', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(getZoomAccessToken()).rejects.toThrow(ZoomApiError);
  });

  it('melempar ZoomApiError bila respons OAuth bukan 2xx', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 400, text: () => Promise.resolve('bad request') });
    await expect(getZoomAccessToken()).rejects.toThrow(ZoomApiError);
  });

  it('melempar ZoomApiError bila tidak ada access_token', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    await expect(getZoomAccessToken()).rejects.toThrow(ZoomApiError);
  });

  it('mengembalikan token dan cache-nya', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ access_token: 'zoom_token_abc', expires_in: 3600 }),
    });
    const token = await getZoomAccessToken();
    expect(token).toBe('zoom_token_abc');
    // Panggil kedua — dari cache (tidak fetch ulang)
    mockFetch.mockClear();
    const cached = await getZoomAccessToken();
    expect(cached).toBe('zoom_token_abc');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('createZoomMeeting', () => {
  it('membuat meeting dan mengembalikan id + joinUrl + startUrl', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ access_token: 'token', expires_in: 3600 }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 123456,
        topic: 'Meeting konsultasi',
        join_url: 'https://zoom.us/j/123456',
        start_url: 'https://zoom.us/s/123456/start',
      }),
    });
    const meeting = await createZoomMeeting({
      topic: 'Konsultasi gigi',
      startTime: new Date('2026-01-15T10:00:00Z'),
      durationMinutes: 30,
      timezone: 'Asia/Jakarta',
    });
    expect(meeting.id).toBe(123456);
    expect(meeting.joinUrl).toBe('https://zoom.us/j/123456');
    expect(meeting.startUrl).toBe('https://zoom.us/s/123456/start');
  });

  it('melempar ZoomApiError bila respons API bukan 2xx', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ access_token: 'token', expires_in: 3600 }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: () => Promise.resolve('rate limited'),
    });
    await expect(
      createZoomMeeting({
        topic: 'Test',
        startTime: new Date(),
        durationMinutes: 30,
        timezone: 'UTC',
      }),
    ).rejects.toThrow(ZoomApiError);
  });

  it('melempar ZoomApiError bila respons tidak punya join_url', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ access_token: 'token', expires_in: 3600 }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: 789 }),
    });
    await expect(
      createZoomMeeting({
        topic: 'Test',
        startTime: new Date(),
        durationMinutes: 30,
        timezone: 'UTC',
      }),
    ).rejects.toThrow(ZoomApiError);
  });
});