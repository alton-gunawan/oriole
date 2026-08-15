import { Hono } from 'hono';
import type { WhatsAppWebhookPayload } from '@oriole/messaging';

import { db } from '../../db/index.ts';
import { inngest } from '../../inngest/client.ts';
import { env } from '../../lib/env.ts';
import { verifyWebhookSignature } from '../../lib/webhook-signature.ts';
import { markWebhookProcessed, recordWebhookEvent } from '../../lib/webhooks.ts';
import { resolveWorkspaceByPhoneNumberId } from '../../lib/whatsapp-business.ts';
import { isWorkspaceActive } from '../../lib/workspace-lifecycle.ts';

/**
 * Webhook Meta WhatsApp Business (Cloud API — Tech Provider, satu callback
 * untuk SEMUA tenant karena satu Meta App platform).
 *
 * Routing tenant: `metadata.phone_number_id` → `whatsapp_connections`
 * (unique per nomor). Signature: X-Hub-Signature-256 (HMAC-SHA256 raw body,
 * app secret platform). Idempotency: unik per (workspaceId:wamid) di
 * webhook_events — Meta at-least-once delivery + retry hingga 7 hari.
 *
 * URL: GET/POST /api/webhooks/whatsapp-business
 */
export const whatsappBusinessWebhookRoutes = new Hono()
  // Verifikasi webhook Meta (hub.challenge) — dikirim saat setup dashboard.
  .get('/', (c) => {
    const mode = c.req.query('hub.mode');
    const token = c.req.query('hub.verify_token');
    const challenge = c.req.query('hub.challenge');
    if (mode === 'subscribe' && env.META_WHATSAPP_VERIFY_TOKEN && token === env.META_WHATSAPP_VERIFY_TOKEN && challenge) {
      return c.text(challenge);
    }
    return c.text('Forbidden', 403);
  })
  .post('/', async (c) => {
    const rawBody = await c.req.text();

    // Fail-closed: tanpa app secret di produksi, jangan proses event apa pun.
    const appSecret = env.META_WHATSAPP_APP_SECRET;
    const header = c.req.header('x-hub-signature-256') ?? '';
    const provided = header.startsWith('sha256=') ? header.slice('sha256='.length) : header;
    if (appSecret) {
      if (!verifyWebhookSignature(rawBody, appSecret, provided)) {
        return c.text('Invalid signature', 401);
      }
    } else if (env.NODE_ENV === 'production') {
      return c.text('Webhook secret belum dikonfigurasi', 503);
    }

    let payload: WhatsAppWebhookPayload;
    try {
      payload = JSON.parse(rawBody) as WhatsAppWebhookPayload;
    } catch {
      return c.json({ error: 'Payload bukan JSON valid' }, 400);
    }

    // Event tanpa messages (verifikasi, status pengiriman) → ack 200.
    const hasMessages = Boolean(
      payload.entry?.some((entry) =>
        entry.changes?.some(
          (change) => change.field === 'messages' && (change.value?.messages?.length ?? 0) > 0,
        ),
      ),
    );
    if (!hasMessages) {
      return c.json({ received: true, events: 0 });
    }

    // Tenant = phone_number_id dari metadata value pertama yang membawa pesan.
    const firstValue = payload.entry
      ?.flatMap((entry) => entry.changes ?? [])
      .find((change) => change.field === 'messages')?.value;
    const phoneNumberId =
      typeof firstValue?.metadata?.phone_number_id === 'string'
        ? firstValue.metadata.phone_number_id
        : '';
    if (!phoneNumberId) {
      return c.json({ received: true, events: 0, skipped: 'no-phone-number-id' });
    }

    const workspaceId = await resolveWorkspaceByPhoneNumberId(phoneNumberId);
    if (!workspaceId) {
      // Nomor tidak dikenal platform → ack 200 agar Meta tidak me-retry selamanya.
      return c.json({ received: true, skipped: 'unknown-phone-number-id' });
    }
    if (!(await isWorkspaceActive(workspaceId))) {
      return c.json({ received: true, disabled: true });
    }

    const firstWamid = firstValue?.messages?.[0]?.id;
    if (!firstWamid) {
      return c.json({ received: true, events: 0 });
    }
    const eventId = `${workspaceId}:${firstWamid}`;

    const record = await recordWebhookEvent(db, 'whatsapp', eventId, 'messages', payload as unknown as Record<string, unknown>);
    if (record === 'processed') {
      return c.json({ duplicate: true, eventId }, 200);
    }

    await inngest.send({
      name: 'whatsapp/message.received',
      data: { workspaceId, payload },
    });
    await markWebhookProcessed(db, 'whatsapp', eventId);

    return c.json({ received: true, eventId });
  });
