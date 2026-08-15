import { Hono } from 'hono';
import type { WhatsAppWebhookPayload } from '@oriole/messaging';

import { db } from '../../db/index.ts';
import { inngest } from '../../inngest/client.ts';
import { env } from '../../lib/env.ts';
import { verifyWebhookSignature } from '../../lib/webhook-signature.ts';
import { resolveWhatsAppChannel } from '../../services/whatsapp.ts';
import { markWebhookProcessed, recordWebhookEvent } from '../../lib/webhooks.ts';
import { isWorkspaceActive } from '../../lib/workspace-lifecycle.ts';

/**
 * Webhook WhatsApp — payload Meta Cloud API yang diteruskan 360dialog.
 *
 * Keamanan: verifikasi `X-Hub-Signature-256` (HMAC-SHA256 atas RAW body
 * dengan app secret). Fail-closed di produksi bila secret belum disetel.
 *
 * Idempotency: unik per (provider, workspaceId:wamid) di webhook_events —
 * Meta melakukan at-least-once delivery dengan retry hingga 7 hari.
 *
 * URL: POST /api/webhooks/whatsapp/:workspaceId
 */
export const whatsappWebhookRoutes = new Hono().post('/:workspaceId', async (c) => {
  const workspaceId = c.req.param('workspaceId');

  // Bisnis soft-deleted / sudah dihapus permanen → drop update (ack 200 agar
  // Meta tidak me-retry; pesan tidak akan pernah diproses).
  if (!(await isWorkspaceActive(workspaceId))) {
    return c.json({ received: true, disabled: true });
  }

  const channel = await resolveWhatsAppChannel(workspaceId);
  if (!channel) {
    return c.text('WhatsApp channel tidak dikonfigurasi untuk workspace ini', 404);
  }
  // Route ini hanya untuk 360dialog (HMAC-SHA256 + payload Meta). Channel BYO
  // (provider 'waha') menerima webhook di /api/webhooks/waha/:workspaceId
  // (HMAC-SHA512) — jangan verifikasi secret 360dialog terhadapnya.
  if (channel.provider === 'waha' || channel.provider === 'meta') {
    // BYO (WAHA) punya webhook sendiri; Meta Embedded Signup diterima di
    // /api/webhooks/whatsapp-business (routing per phone_number_id).
    return c.text('WhatsApp channel tidak dikonfigurasi untuk workspace ini', 404);
  }
  if (!channel.isActive) {
    // Channel dijeda dari UI — ack 200 tanpa proses (hindari retry Meta).
    return c.json({ received: true, disabled: true });
  }

  // WAJIB pakai raw body — HMAC dihitung atas byte mentah.
  const rawBody = await c.req.text();

  const secret = channel.webhookSecret;
  const header = c.req.header('x-hub-signature-256') ?? '';
  const provided = header.startsWith('sha256=') ? header.slice('sha256='.length) : header;

  if (secret) {
    if (!verifyWebhookSignature(rawBody, secret, provided)) {
      return c.text('Invalid signature', 401);
    }
  } else if (env.NODE_ENV === 'production') {
    return c.text('Webhook secret belum dikonfigurasi untuk channel ini', 503);
  }

  let payload: WhatsAppWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as WhatsAppWebhookPayload;
  } catch {
    return c.json({ error: 'Payload bukan JSON valid' }, 400);
  }

  // Event tanpa messages (verifikasi webhook, status pengiriman) → ack 200.
  const hasMessages = Boolean(
    payload.entry?.some((entry) =>
      entry.changes?.some((change) => change.field === 'messages' && (change.value?.messages?.length ?? 0) > 0),
    ),
  );
  if (!hasMessages) {
    return c.json({ received: true, events: 0 });
  }

  // Namespace dengan workspaceId: wamid global, tapi eventId dipakai lintas channel.
  const firstWamid = payload.entry![0].changes![0].value!.messages![0].id;
  const eventId = `${workspaceId}:${firstWamid}`;

  const record = await recordWebhookEvent(
    db,
    'whatsapp',
    eventId,
    'messages',
    payload as unknown as Record<string, unknown>,
  );
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
