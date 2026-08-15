import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { LineApiError, lineBuildMessages, verifyLineSignature } from './line.ts';

function sign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('base64');
}

describe('verifyLineSignature', () => {
  const secret = 'test-channel-secret';
  const body = '{"events":[]}';

  it('signature valid → true', () => {
    expect(verifyLineSignature(secret, body, sign(secret, body))).toBe(true);
  });

  it('body dimodifikasi → false', () => {
    expect(verifyLineSignature(secret, body + 'x', sign(secret, body))).toBe(false);
  });

  it('secret salah → false', () => {
    expect(verifyLineSignature('other-secret', body, sign(secret, body))).toBe(false);
  });

  it('signature kosong / null / undefined → false', () => {
    expect(verifyLineSignature(secret, body, '')).toBe(false);
    expect(verifyLineSignature(secret, body, null)).toBe(false);
    expect(verifyLineSignature(secret, body, undefined)).toBe(false);
  });
});

describe('lineBuildMessages', () => {
  it('tanpa tombol → satu pesan teks', () => {
    const messages = lineBuildMessages('Halo');
    expect(messages).toEqual([{ type: 'text', text: 'Halo' }]);
  });

  it('dengan tombol → teks + template buttons dengan postback data', () => {
    const messages = lineBuildMessages('Konfirmasi?', [
      { id: 'bk:abc:confirm', label: 'Konfirmasi' },
      { id: 'bk:abc:cancel', label: 'Batalkan' },
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ type: 'text', text: 'Konfirmasi?' });
    const template = messages[1] as { type: string; template: { type: string; actions: { type: string; label: string; data: string }[] } };
    expect(template.type).toBe('template');
    expect(template.template.type).toBe('buttons');
    expect(template.template.actions).toEqual([
      { type: 'postback', label: 'Konfirmasi', data: 'bk:abc:confirm' },
      { type: 'postback', label: 'Batalkan', data: 'bk:abc:cancel' },
    ]);
  });

  it('maks 4 tombol (batas template Line)', () => {
    const buttons = [1, 2, 3, 4, 5].map((n) => ({ id: `bk:x:${n}`, label: `Aksi ${n}` }));
    const messages = lineBuildMessages('Pilih', buttons);
    const template = messages[1] as { template: { actions: unknown[] } };
    expect(template.template.actions).toHaveLength(4);
  });

  it('teks > 160 karakter → template memakai shortPrompt (batas text template Line)', () => {
    const long = 'x'.repeat(200);
    const messages = lineBuildMessages(long, [{ id: 'bk:abc:confirm', label: 'Ya' }], 'Pilih aksi:');
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ type: 'text', text: long });
    const template = messages[1] as { template: { text: string } };
    expect(template.template.text).toBe('Pilih aksi:');
  });

  it('teks > 160 karakter tanpa shortPrompt → template memakai potongan teks', () => {
    const long = 'x'.repeat(200);
    const messages = lineBuildMessages(long, [{ id: 'bk:abc:confirm', label: 'Ya' }]);
    const template = messages[1] as { template: { text: string } };
    expect(template.template.text).toHaveLength(160);
  });

  it('markdown Telegram dibersihkan (tidak tampil literal di Line)', () => {
    const messages = lineBuildMessages('Ini **pengingat** untuk `booking` Anda');
    expect(messages[0].text).toBe('Ini pengingat untuk booking Anda');
  });
});

describe('lineCall error handling', () => {
  it('fetch non-2xx → LineApiError dengan status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: 'Invalid token' }), { status: 401 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      // lineGetBotInfo dengan token salah → LineApiError 401.
      const { lineGetBotInfo } = await import('./line.ts');
      try {
        await lineGetBotInfo('bad-token');
        expect.unreachable('harusnya throw');
      } catch (error) {
        expect(error).toBeInstanceOf(LineApiError);
        expect((error as LineApiError).status).toBe(401);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('token valid → info bot', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ userId: 'U123', displayName: 'My Bot' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { lineGetBotInfo } = await import('./line.ts');
      const info = await lineGetBotInfo('valid-token');
      expect(info).toEqual({ userId: 'U123', displayName: 'My Bot' });
      // URL benar + Bearer token benar.
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(String(url)).toBe('https://api.line.me/v2/bot/info');
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer valid-token');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
