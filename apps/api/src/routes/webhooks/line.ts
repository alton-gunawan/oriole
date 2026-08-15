import { Hono } from 'hono';
import type { LineWebhookPayload } from '@oriole/messaging';

import { db } from '../../db/index.ts';
import { inngest } from '../../inngest/client.ts';
import { resolveLineChannel } from '../../lib/line-handler.ts';
import { verifyLineSignature } from '../../lib/line.ts';
import { markWebhookProcessed, recordWebhookEvent } from '../../lib/webhooks.ts';
import { isWorkspaceActive } from '../../lib/workspace-lifecycle.ts';

/**
 * Webhook Line Messaging API — Line mengirim semua event bot ke SATU endpoint
 * per bot (didaftarkan via PUT /v2/bot/channel/webhook/endpoint saat setup).
 *
 *   POST /api/webhooks/line/:workspaceId
 *   Header: X-Line-Signature = base64(HMAC-SHA256(channelSecret, rawBody))
 *
 * Keamanan: verifikasi signature dengan channelSecret workspace — request
 * palsu ditolak 401 sebelum diproses. Idempotency via tabel webhook_events
 * (eventId = gabungan message.id/replyToken per payload); Line melakukan
 * redelivery (deliveryContext.isRedelivery) jadi duplikat harus diabaikan.
 */
export const lineWebhookRoutes = new Hono().post('/:workspaceId', async (c) => {
  const workspaceId = c.req.param('workspaceId');

  // Bisnis soft-deleted / sudah dihapus permanen → drop event (ack 200 agar
  // Line tidak me-retry; pesan tidak akan pernah diproses).
  if (!(await isWorkspaceActive(workspaceId))) {
    return c.json({ received: true, disabled: true });
  }

  // Channel di-resolve DULU — channelSecret dipakai verifikasi signature.
  const channel = await resolveLineChannel(workspaceId);
  if (!channel) {
    return c.text('Line channel tidak dikonfigurasi untuk workspace ini', 404);
  }
  if (!channel.isActive) {
    // Channel dijeda dari UI — ack 200 tanpa proses (hindari retry Line).
    return c.json({ received: true, disabled: true });
  }
  if (!channel.channelSecret) {
    return c.text('Channel secret belum dikonfigurasi untuk channel ini', 503);
  }

  const rawBody = await c.req.text();
  const signature = c.req.header('X-Line-Signature');
  if (!verifyLineSignature(channel.channelSecret, rawBody, signature)) {
    return c.text('Unauthorized', 401);
  }

  let payload: LineWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as LineWebhookPayload;
  } catch {
    return c.text('Invalid JSON', 400);
  }

  if (!payload.events || payload.events.length === 0) {
    return c.json({ received: true, events: 0 });
  }

  // Idempotency per payload: eventId = gabungan id event (message.id untuk
  // pesan, replyToken untuk postback). Redelivery payload sama → duplicate.
  const eventKey = payload.events
    .map((event) => event.message?.id ?? event.replyToken ?? 'no-id')
    .join('|');
  const record = await recordWebhookEvent(db, 'line', eventKey, 'update', payload as unknown as Record<string, unknown>);
  if (record === 'processed') {
    return c.json({ duplicate: true, eventKey }, 200);
  }

  try {
    await inngest.send({
      name: 'line/message.received',
      data: { workspaceId, payload },
    });
  } catch (error) {
    // Inngest tidak tersedia — jangan ack 200: Line me-retry payload yang
    // sama sehingga pesan tidak hilang permanen begitu Inngest hidup kembali.
    console.error(
      '[line-webhook] GAGAL mengantre pesan ke Inngest — pastikan `pnpm dev:inngest` berjalan (lokal) atau INNGEST_EVENT_KEY valid (produksi):',
      (error as Error).message,
    );
    return c.json({ error: 'Pesan tidak dapat diantrekan ke Inngest. Coba lagi nanti.' }, 503);
  }
  await markWebhookProcessed(db, 'line', eventKey);

  return c.json({ received: true, eventKey });
});
