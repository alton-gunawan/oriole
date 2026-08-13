import { env } from './env.ts';

/**
 * URL webhook inbound (Telegram / WhatsApp / WAHA / dll).
 *
 * Base URL diambil dari `WEBHOOK_BASE_URL` (opsional, HTTPS publik untuk
 * produksi) dan jatuh ke `API_URL` bila tidak disetel. Dipisah karena di
 * produksi `API_URL` bisa berupa alamat internal (mis. `http://api:3000`
 * di Docker) yang TIDAK bisa dijangkau provider eksternal.
 */

/** Base URL webhook, tanpa trailing slash. */
export function webhookBaseUrl(): string {
  return (env.WEBHOOK_BASE_URL ?? env.API_URL).replace(/\/+$/, '');
}

/** URL webhook inbound untuk channel + workspace tertentu. */
export function webhookUrlFor(workspaceId: string, channelType: string): string {
  return `${webhookBaseUrl()}/api/webhooks/${channelType}/${workspaceId}`;
}

/** Error dengan pesan yang bisa ditindaklanjuti — dipetakan ke 400 di route. */
export class WebhookUrlError extends Error {}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Validasi URL webhook yang harus bisa dijangkau provider eksternal sebagai
 * HTTPS publik (Telegram, 360dialog, WAHA). Gagal cepat DENGAN PESAN JELAS
 * sebelum memanggil provider — error asli provider ("bad webhook: An HTTPS
 * URL must be provided") tidak membingungkan pengguna.
 *
 * Melempar WebhookUrlError bila URL bukan HTTPS publik.
 */
export function assertPublicHttpsWebhookUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WebhookUrlError(`URL webhook tidak valid: ${url}`);
  }

  const host = parsed.hostname.toLowerCase();
  const isLocal =
    LOCAL_HOSTS.has(host) || host.endsWith('.local') || host.endsWith('.localhost');

  if (parsed.protocol !== 'https:' || isLocal) {
    throw new WebhookUrlError(
      `Webhook membutuhkan URL HTTPS publik yang dapat diakses internet (saat ini: ${url}). ` +
        `Setel WEBHOOK_BASE_URL ke URL publik Anda (mis. https://api.domain.com) — ` +
        `localhost / alamat internal tidak dapat dijangkau Telegram.`,
    );
  }
}
