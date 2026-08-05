import { Hono } from 'hono';

import { db } from '../../db/index.ts';
import { inngest } from '../../inngest/client.ts';
import { env } from '../../lib/env.ts';
import { markWebhookProcessed, recordWebhookEvent } from '../../lib/webhooks.ts';
import { paddle } from '../../services/paddle.ts';

/**
 * Webhook Paddle Billing (MoR).
 * Signature diverifikasi dengan `paddle.webhooks.unmarshal` — WAJIB memakai
 * raw body (`c.req.text()`) agar verifikasi HMAC berhasil.
 *
 * Idempotency: event baru → queue ke Inngest; duplikat yang sudah diproses
 * → diabaikan; duplikat yang masih 'pending' (attempt sebelumnya gagal)
 * → diproses ulang agar tidak ada event yang hilang saat retry.
 */
export const paddleWebhookRoutes = new Hono().post('/', async (c) => {
  const signature = c.req.header('paddle-signature') ?? '';
  const rawBody = await c.req.text();

  let event: Awaited<ReturnType<typeof paddle.webhooks.unmarshal>>;
  try {
    event = await paddle.webhooks.unmarshal(rawBody, env.PADDLE_WEBHOOK_SECRET, signature);
  } catch {
    return c.text('Invalid signature', 400);
  }

  const eventId = event.eventId;
  const eventType = event.eventType;

  const record = await recordWebhookEvent(db, 'paddle', eventId, eventType, {
    eventType,
    data: event.data,
  });
  if (record === 'processed') {
    return c.text('Duplicate event', 200);
  }

  await inngest.send({
    name: 'paddle/event.received',
    data: { eventId, eventType, payload: event.data },
  });
  await markWebhookProcessed(db, 'paddle', eventId);

  return c.text('OK', 200);
});
