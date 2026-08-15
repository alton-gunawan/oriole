import { describe, expect, it } from 'vitest';

import {
  maskMetaWhatsappSecret,
  metaWhatsappCallbackUrl,
  metaWhatsappFrontendReturnUrl,
  metaWhatsappWebhookUrl,
  validateMetaWhatsappEnv,
} from './meta-whatsapp-config.ts';

const VALID = {
  appId: 'app-12345678',
  appSecret: 'app-secret-123',
  configId: 'config-id-123',
  verifyToken: 'verify-token-123',
  systemUserToken: 'sys-token-123',
  graphVersion: 'v21.0',
  apiUrl: 'https://api.example.com',
  appUrl: 'https://app.example.com',
};

describe('URL helpers', () => {
  it('callback/webhook/return URL dibangun dari API_URL/APP_URL (trailing slash dinormalisasi)', () => {
    expect(metaWhatsappCallbackUrl('https://api.example.com/')).toBe(
      'https://api.example.com/api/whatsapp-business/connect/callback',
    );
    expect(metaWhatsappWebhookUrl('https://api.example.com')).toBe(
      'https://api.example.com/api/webhooks/whatsapp-business',
    );
    expect(metaWhatsappFrontendReturnUrl('https://app.example.com/')).toBe(
      'https://app.example.com/integrations?whatsapp=connected',
    );
  });
});

describe('validateMetaWhatsappEnv', () => {
  it('konfigurasi lengkap → ok', () => {
    const v = validateMetaWhatsappEnv(VALID);
    expect(v.ok).toBe(true);
    expect(v.problems).toEqual([]);
    expect(v.callbackUrl).toBe('https://api.example.com/api/whatsapp-business/connect/callback');
  });

  it('melaporkan setiap env yang kosong/terlalu pendek', () => {
    const v = validateMetaWhatsappEnv({
      appId: 'short',
      appSecret: '',
      configId: '',
      verifyToken: 'tok',
      systemUserToken: '',
      apiUrl: 'https://api.example.com',
      appUrl: 'https://app.example.com',
    });
    expect(v.ok).toBe(false);
    expect(v.problems).toContain('META_WHATSAPP_APP_ID terlalu pendek (min 8 karakter).');
    expect(v.problems).toContain('META_WHATSAPP_APP_SECRET kosong.');
    expect(v.problems).toContain('META_WHATSAPP_CONFIG_ID kosong.');
    expect(v.problems).toContain('META_WHATSAPP_VERIFY_TOKEN terlalu pendek (min 8 karakter).');
    expect(v.problems).toContain('META_WHATSAPP_SYSTEM_USER_TOKEN kosong.');
  });

  it('graph version default v21.0 bila kosong; menolak format salah', () => {
    expect(validateMetaWhatsappEnv({ ...VALID, graphVersion: '' }).values.graphVersion).toBe('v21.0');
    const bad = validateMetaWhatsappEnv({ ...VALID, graphVersion: '21' });
    expect(bad.ok).toBe(false);
    expect(bad.problems.some((p) => p.includes('META_GRAPH_API_VERSION'))).toBe(true);
  });

  it('menolak base publik non-http dan http non-localhost', () => {
    const noScheme = validateMetaWhatsappEnv({ ...VALID, apiUrl: 'api.example.com' });
    expect(noScheme.problems).toContain(
      'WEBHOOK_BASE_URL/API_URL harus URL http(s) absolut (dipakai untuk callback/webhook).',
    );

    const httpPublic = validateMetaWhatsappEnv({ ...VALID, apiUrl: 'http://api.example.com' });
    expect(httpPublic.problems).toContain(
      'Callback/webhook harus HTTPS publik di produksi — Meta menolak http non-localhost. ' +
        'Setel WEBHOOK_BASE_URL ke URL publik Anda (mis. https://api.domain.com).',
    );

    // localhost http boleh (dev).
    const local = validateMetaWhatsappEnv({ ...VALID, apiUrl: 'http://localhost:3000' });
    expect(local.problems).not.toContain(
      'Callback/webhook harus HTTPS publik di produksi — Meta menolak http non-localhost. ' +
        'Setel WEBHOOK_BASE_URL ke URL publik Anda (mis. https://api.domain.com).',
    );
  });

  it('WEBHOOK_BASE_URL menang atas API_URL untuk callback/webhook', () => {
    const v = validateMetaWhatsappEnv({
      ...VALID,
      apiUrl: 'http://api:3000', // internal Docker
      webhookBaseUrl: 'https://public.example.com/',
    });
    expect(v.ok).toBe(true);
    expect(v.callbackUrl).toBe(
      'https://public.example.com/api/whatsapp-business/connect/callback',
    );
    expect(v.webhookUrl).toBe('https://public.example.com/api/webhooks/whatsapp-business');
  });
});

describe('maskMetaWhatsappSecret', () => {
  it('menyembunyikan nilai tengah secret', () => {
    expect(maskMetaWhatsappSecret('app-secret-123')).toBe('app-se…-123');
    expect(maskMetaWhatsappSecret('')).toBe('(kosong)');
    expect(maskMetaWhatsappSecret('short')).toBe('••••••••');
  });
});
