import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertPublicHttpsWebhookUrl,
  WebhookUrlError,
  webhookBaseUrl,
  webhookUrlFor,
} from './webhook-url.ts';

// ── Mocks ───────────────────────────────────────────────────────

const { envState } = vi.hoisted(() => ({
  envState: {
    API_URL: 'http://localhost:3000',
    WEBHOOK_BASE_URL: undefined,
  } as Record<string, string | undefined>,
}));

vi.mock('./env.ts', () => ({ env: envState }));

beforeEach(() => {
  envState.API_URL = 'http://localhost:3000';
  envState.WEBHOOK_BASE_URL = undefined;
});

// ── webhookBaseUrl / webhookUrlFor ──────────────────────────────

describe('webhookBaseUrl / webhookUrlFor', () => {
  it('WEBHOOK_BASE_URL kosong → fallback ke API_URL', () => {
    expect(webhookBaseUrl()).toBe('http://localhost:3000');
    expect(webhookUrlFor('ws-1', 'telegram')).toBe(
      'http://localhost:3000/api/webhooks/telegram/ws-1',
    );
  });

  it('WEBHOOK_BASE_URL dipakai, trailing slash dirapikan', () => {
    envState.WEBHOOK_BASE_URL = 'https://api.example.com/';
    expect(webhookBaseUrl()).toBe('https://api.example.com');
    expect(webhookUrlFor('ws-1', 'telegram')).toBe(
      'https://api.example.com/api/webhooks/telegram/ws-1',
    );
  });

  it('WEBHOOK_BASE_URL menang atas API_URL (kasus produksi: API internal)', () => {
    envState.API_URL = 'http://api:3000';
    envState.WEBHOOK_BASE_URL = 'https://public.example.com';
    expect(webhookUrlFor('ws-1', 'whatsapp')).toBe(
      'https://public.example.com/api/webhooks/whatsapp/ws-1',
    );
  });
});

// ── assertPublicHttpsWebhookUrl ─────────────────────────────────

describe('assertPublicHttpsWebhookUrl', () => {
  it('HTTPS publik diterima', () => {
    expect(() =>
      assertPublicHttpsWebhookUrl('https://api.example.com/api/webhooks/telegram/ws-1'),
    ).not.toThrow();
  });

  it('http ditolak dengan pesan yang bisa ditindaklanjuti', () => {
    try {
      assertPublicHttpsWebhookUrl('http://api.example.com/x');
      throw new Error('seharusnya melempar');
    } catch (error) {
      expect(error).toBeInstanceOf(WebhookUrlError);
      const message = (error as WebhookUrlError).message;
      expect(message).toContain('HTTPS');
      expect(message).toContain('WEBHOOK_BASE_URL');
    }
  });

  it('localhost / IP lokal / *.local ditolak walau https', () => {
    expect(() => assertPublicHttpsWebhookUrl('https://localhost:3000/x')).toThrow(
      WebhookUrlError,
    );
    expect(() => assertPublicHttpsWebhookUrl('https://127.0.0.1/x')).toThrow(WebhookUrlError);
    expect(() => assertPublicHttpsWebhookUrl('https://api.local/x')).toThrow(WebhookUrlError);
  });

  it('URL tidak valid ditolak', () => {
    expect(() => assertPublicHttpsWebhookUrl('bukan url')).toThrow(WebhookUrlError);
  });
});
