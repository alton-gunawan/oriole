import { createHmac, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { workspaceIntegrations } from '@oriole/database';

import { db } from '../db/index.ts';

/* ────────────────────────────────────────────────────────────
 * Outgoing webhooks — kirim notifikasi event (booking.created,
 * booking.updated, ...) ke endpoint URL milik user.
 *
 * Format (best practice):
 *   POST {url}
 *   Content-Type: application/json
 *   X-Oriole-Event:      booking.created
 *   X-Oriole-Timestamp:  1720000000 (unix detik — cegah replay)
 *   X-Oriole-Signature:  sha256=<hex hmac-sha256("${ts}.${body}", secret)>
 *   X-Oriole-Webhook-Id: <uuid unik per pengiriman>
 *
 * Bila `secret` dikonfigurasi, signature WAJIB diverifikasi penerima.
 * ──────────────────────────────────────────────────────────── */

export const OUTGOING_WEBHOOK_TIMEOUT_MS = 5_000;

/** Konfigurasi privat integrasi webhook (disimpan di providerConfig). */
export interface OutgoingWebhookConfig {
  url: string;
  /** Shared secret opsional — dipakai HMAC signing. */
  secret?: string | null;
}

export class WebhookDeliveryError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'WebhookDeliveryError';
  }
}

/** Headers + body mentah untuk satu pengiriman webhook. */
export interface WebhookDelivery {
  url: string;
  headers: Record<string, string>;
  rawBody: string;
}

/**
 * Susun payload webhook: body JSON + header termasuk HMAC-SHA256 bila
 * secret diberikan. Pure function — mudah diuji.
 */
export function buildWebhookDelivery(
  url: string,
  event: string,
  workspaceId: string,
  data: Record<string, unknown>,
  secret?: string | null,
  webhookId: string = randomUUID(),
): WebhookDelivery {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payload = {
    event,
    workspaceId,
    webhookId,
    timestamp,
    occurredAt: new Date().toISOString(),
    data,
  };
  const rawBody = JSON.stringify(payload);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Oriole-Event': event,
    'X-Oriole-Timestamp': timestamp,
    'X-Oriole-Webhook-Id': webhookId,
  };
  if (secret) {
    const signature = createHmac('sha256', secret)
      .update(`${timestamp}.${rawBody}`, 'utf8')
      .digest('hex');
    headers['X-Oriole-Signature'] = `sha256=${signature}`;
  }
  return { url, headers, rawBody };
}

/**
 * Kirim satu webhook dengan timeout. Mengembalikan true bila penerima
 * menjawab 2xx. Semua kegagalan dilempar sebagai WebhookDeliveryError
 * (Inngest akan me-retry pengiriman dengan backoff).
 */
export async function deliverWebhook(delivery: WebhookDelivery): Promise<{ ok: true; status: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OUTGOING_WEBHOOK_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(delivery.url, {
        method: 'POST',
        headers: delivery.headers,
        body: delivery.rawBody,
        signal: controller.signal,
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === 'AbortError'
        ? `timeout setelah ${OUTGOING_WEBHOOK_TIMEOUT_MS / 1000}s`
        : 'tidak dapat dijangkau';
      throw new WebhookDeliveryError(`Webhook gagal dikirim (${reason}).`, 0);
    }
    if (!res.ok) {
      throw new WebhookDeliveryError(`Penerima webhook menjawab ${res.status}.`, res.status);
    }
    return { ok: true, status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

/** Muat integrasi webhook AKTIF untuk sebuah workspace. */
export async function loadWebhookConfig(workspaceId: string): Promise<OutgoingWebhookConfig | null> {
  const [integration] = await db
    .select()
    .from(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, workspaceId),
        eq(workspaceIntegrations.integrationType, 'webhook'),
      ),
    )
    .limit(1);
  if (!integration || !integration.isActive) return null;
  const config = integration.providerConfig as unknown as OutgoingWebhookConfig;
  return config.url ? config : null;
}

/**
 * Kirim event webhook ke semua endpoint terkonfigurasi (satu endpoint per
 * workspace saat ini). Melempar WebhookDeliveryError bila gagal — dipakai
 * fungsi Inngest `deliverOutgoingWebhook` yang punya retry built-in.
 */
export type DispatchResult =
  | { delivered: true; eventId: string }
  | { skipped: 'not-configured' };

/**
 * Kirim event webhook ke endpoint terkonfigurasi (satu per workspace).
 * Tidak terkonfigurasi → `skipped` (bukan throw, agar run Inngest yang
 * tertunda setelah user melepas webhook tidak gagal/retry). Kegagalan
 * pengiriman tetap melempar → Inngest me-retry dengan backoff.
 */
export async function dispatchOutgoingWebhook(
  workspaceId: string,
  event: string,
  data: Record<string, unknown>,
  webhookId?: string,
): Promise<DispatchResult> {
  const config = await loadWebhookConfig(workspaceId);
  if (!config) return { skipped: 'not-configured' };
  // webhookId dari event (dibuat saat emit) dipakai ulang di setiap retry
  // agar penerima bisa dedupe. Tanpa itu, tiap retry terlihat seperti
  // pengiriman baru.
  const delivery = buildWebhookDelivery(config.url, event, workspaceId, data, config.secret, webhookId);
  await deliverWebhook(delivery);
  return { delivered: true, eventId: delivery.headers['X-Oriole-Webhook-Id'] };
}

/** Ping uji — dipakai tombol "Test" di UI (pengiriman sinkron). */
export async function sendTestWebhook(workspaceId: string): Promise<{ delivered: boolean; status: number }> {
  const config = await loadWebhookConfig(workspaceId);
  if (!config) {
    throw new WebhookDeliveryError('Webhook belum dikonfigurasi untuk workspace ini.', 409);
  }
  const delivery = buildWebhookDelivery(config.url, 'ping', workspaceId, { ping: true }, config.secret);
  const result = await deliverWebhook(delivery);
  return { delivered: true, status: result.status };
}
