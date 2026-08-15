import { describe, expect, it, vi } from 'vitest';

import { TelegramApiError, telegramGetWebhookInfo } from './telegram.ts';

describe('telegramGetWebhookInfo', () => {
  it('webhook aktif → url + pending count', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          result: { url: 'https://api.example.com/webhook', pending_update_count: 3 },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const info = await telegramGetWebhookInfo('tok');
      expect(info).toEqual({
        url: 'https://api.example.com/webhook',
        pendingUpdateCount: 3,
        lastError: null,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('webhook belum didaftarkan (url kosong) → url null', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { url: '', pending_update_count: 0 } }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const info = await telegramGetWebhookInfo('tok');
      expect(info.url).toBeNull();
      expect(info.pendingUpdateCount).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('Telegram menolak (ok:false) → TelegramApiError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, description: 'Unauthorized', error_code: 401 }), {
        status: 401,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(telegramGetWebhookInfo('bad-token')).rejects.toBeInstanceOf(TelegramApiError);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
