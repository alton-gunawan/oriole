import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { MetaMessagingEvent, MetaWebhookPayload } from '@oriole/messaging';

import { db } from '../../db/index.ts';
import { inngest } from '../../inngest/client.ts';
import { env } from '../../lib/env.ts';
import { verifyMetaSignature } from '../../lib/meta.ts';
import { markWebhookProcessed, recordWebhookEvent } from '../../lib/webhooks.ts';
import { isWorkspaceActive } from '../../lib/workspace-lifecycle.ts';

/**
 * Webhook Meta — SATU callback URL untuk seluruh app (bukan per-workspace):
 *
 *   GET  /api/webhooks/meta?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…
 *   POST /api/webhooks/meta   (X-Hub-Signature-256 = HMAC-SHA256 raw body,
 *                              app secret)
 *
 * Meta mengirim event semua page ter-subscribe ke URL ini; routing ke
 * workspace dilakukan via `providerConfig.pageId` pada workspace_channels
 * (Instagram / Facebook). Event asing (page yang tidak terdaftar) di-ack
 * tanpa proses agar Meta tidak me-retry.
 */
export const metaWebhookRoutes = new Hono()
  /* ── Handshake verifikasi (dipanggil Meta saat subscribe webhook) ── */
  .get('/', async (c) => {
    const mode = c.req.query('hub.mode');
    const token = c.req.query('hub.verify_token');
    const challenge = c.req.query('hub.challenge');
    if (mode === 'subscribe' && token && challenge && env.META_VERIFY_TOKEN) {
      if (token === env.META_VERIFY_TOKEN) {
        return c.text(challenge);
      }
      return c.text('Verification token mismatch', 403);
    }
    return c.text('Invalid request', 400);
  })

  /* ── Event masuk (pesan baru) — verifikasi + routing + antre Inngest ── */
  .post('/', async (c) => {
    if (!env.META_APP_SECRET) {
      return c.text('META_APP_SECRET belum dikonfigurasi — webhook Meta dinonaktifkan.', 503);
    }
    const signature = c.req.header('X-Hub-Signature-256');
    const rawBody = await c.req.text();
    if (!verifyMetaSignature(rawBody, signature, env.META_APP_SECRET)) {
      return c.text('Invalid signature', 401);
    }

    let payload: MetaWebhookPayload;
    try {
      payload = JSON.parse(rawBody) as MetaWebhookPayload;
    } catch {
      return c.text('Invalid JSON', 400);
    }

    const entries = payload.entry ?? [];
    for (const entry of entries) {
      if (!entry.id || !Array.isArray(entry.messaging)) continue;
      for (const event of entry.messaging) {
        if (!isTextMessage(event)) continue;

        // Routing page → workspace + channel type (via providerConfig.pageId).
        const result = await db.execute<{
          workspace_id: string;
          channel_type: string;
        }>(
          sql`SELECT workspace_id, channel_type FROM workspace_channels WHERE provider_config->>'pageId' = ${entry.id} AND is_active = true LIMIT 1`,
        );
        const channelRow = result.rows?.[0];
        const workspaceId = channelRow?.workspace_id;
        const channelType = channelRow?.channel_type;
        if (!workspaceId || (channelType !== 'instagram' && channelType !== 'facebook')) {
          // Page tidak terdaftar / channel dijeda — ack 200 (jangan retry).
          continue;
        }
        if (!(await isWorkspaceActive(workspaceId))) continue;

        // Idempotency: mid unik per pesan (fallback gabungan).
        const mid = event.message?.mid ?? `${entry.id}:${event.sender?.id}:${event.timestamp ?? Date.now()}`;
        const record = await recordWebhookEvent(
          db,
          'meta',
          mid,
          'message',
          { workspaceId, channelType, event },
        );
        if (record === 'processed') continue;

        try {
          await inngest.send({
            name: 'meta/message.received',
            data: { workspaceId, channelType, pageId: entry.id, event },
          });
        } catch (error) {
          console.error(
            '[meta-webhook] GAGAL mengantre pesan ke Inngest — pastikan `pnpm dev:inngest` berjalan (lokal) atau INNGEST_EVENT_KEY valid (produksi):',
            (error as Error).message,
          );
          return c.json({ error: 'Pesan tidak dapat diantrekan ke Inngest. Coba lagi nanti.' }, 503);
        }
        await markWebhookProcessed(db, 'meta', mid);
      }
    }

    return c.json({ received: true });
  });

function isTextMessage(event: MetaMessagingEvent): boolean {
  return Boolean(event.message?.text && !event.message.is_echo);
}
