/**
 * Validasi konfigurasi Meta WhatsApp Business (Embedded Signup — Tech
 * Provider) + helper URL callback/webhook. Murni (tanpa network/process)
 * supaya bisa diuji unit dan dipakai script `setup:whatsapp`.
 */

export interface MetaWhatsAppEnvInput {
  appId?: string;
  appSecret?: string;
  configId?: string;
  verifyToken?: string;
  systemUserToken?: string;
  graphVersion?: string;
  apiUrl?: string;
  appUrl?: string;
  /** Base URL publik untuk callback/webhook (WEBHOOK_BASE_URL) — fallback API_URL. */
  webhookBaseUrl?: string;
}

export interface MetaWhatsAppValidation {
  ok: boolean;
  problems: string[];
  values: {
    appId: string;
    appSecret: string;
    configId: string;
    verifyToken: string;
    systemUserToken: string;
    graphVersion: string;
    apiUrl: string;
    appUrl: string;
  };
  callbackUrl: string;
  webhookUrl: string;
  frontendReturnUrl: string;
}

/** URL callback (redirect) — Meta mengarahkan user ke sini setelah signup selesai. */
export function metaWhatsappCallbackUrl(apiUrl: string): string {
  return `${apiUrl.replace(/\/+$/, '')}/api/whatsapp-business/connect/callback`;
}

/** URL webhook platform — satu untuk SEMUA tenant (routing via phone_number_id). */
export function metaWhatsappWebhookUrl(apiUrl: string): string {
  return `${apiUrl.replace(/\/+$/, '')}/api/webhooks/whatsapp-business`;
}

/** URL kembali ke UI setelah callback selesai. */
export function metaWhatsappFrontendReturnUrl(appUrl: string): string {
  return `${appUrl.replace(/\/+$/, '')}/integrations?whatsapp=connected`;
}

/** Validasi env — murni, tidak menyentuh network/process. */
export function validateMetaWhatsappEnv(input: MetaWhatsAppEnvInput): MetaWhatsAppValidation {
  const problems: string[] = [];
  const apiUrl = input.apiUrl?.trim() ?? '';
  const appUrl = input.appUrl?.trim() ?? '';
  // Base publik = WEBHOOK_BASE_URL bila disetel, kalau tidak API_URL.
  const publicBase = input.webhookBaseUrl?.trim() || apiUrl;
  const values = {
    appId: input.appId?.trim() ?? '',
    appSecret: input.appSecret?.trim() ?? '',
    configId: input.configId?.trim() ?? '',
    verifyToken: input.verifyToken?.trim() ?? '',
    systemUserToken: input.systemUserToken?.trim() ?? '',
    graphVersion: input.graphVersion?.trim() || 'v21.0',
    apiUrl,
    appUrl,
  };

  const requireMin = (name: string, value: string, min: number) => {
    if (!value) problems.push(`${name} kosong.`);
    else if (value.length < min) problems.push(`${name} terlalu pendek (min ${min} karakter).`);
  };

  requireMin('META_WHATSAPP_APP_ID', values.appId, 8);
  requireMin('META_WHATSAPP_APP_SECRET', values.appSecret, 8);
  requireMin('META_WHATSAPP_CONFIG_ID', values.configId, 1);
  requireMin('META_WHATSAPP_VERIFY_TOKEN', values.verifyToken, 8);
  requireMin('META_WHATSAPP_SYSTEM_USER_TOKEN', values.systemUserToken, 8);

  if (!/^v\d+(\.\d+)*$/.test(values.graphVersion)) {
    problems.push(`META_GRAPH_API_VERSION tidak valid: "${values.graphVersion}" (contoh v21.0).`);
  }
  if (!/^https?:\/\//.test(values.appUrl)) {
    problems.push('APP_URL harus URL http(s) absolut (dipakai untuk redirect kembali ke UI).');
  }
  if (!/^https?:\/\//.test(publicBase)) {
    problems.push(
      'WEBHOOK_BASE_URL/API_URL harus URL http(s) absolut (dipakai untuk callback/webhook).',
    );
  } else if (
    !publicBase.startsWith('https') &&
    !publicBase.includes('localhost') &&
    !publicBase.includes('127.0.0.1')
  ) {
    problems.push(
      'Callback/webhook harus HTTPS publik di produksi — Meta menolak http non-localhost. ' +
        'Setel WEBHOOK_BASE_URL ke URL publik Anda (mis. https://api.domain.com).',
    );
  }

  return {
    ok: problems.length === 0,
    problems,
    values,
    callbackUrl: metaWhatsappCallbackUrl(publicBase),
    webhookUrl: metaWhatsappWebhookUrl(publicBase),
    frontendReturnUrl: metaWhatsappFrontendReturnUrl(values.appUrl),
  };
}

/** Mask secret untuk output CLI — cukup untuk verifikasi, tidak bocor penuh. */
export function maskMetaWhatsappSecret(value: string): string {
  if (!value) return '(kosong)';
  return value.length <= 8 ? '••••••••' : `${value.slice(0, 6)}…${value.slice(-4)}`;
}
