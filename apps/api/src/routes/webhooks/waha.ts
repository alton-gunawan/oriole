import { Hono } from 'hono';

import { db } from '../../db/index.ts';
import { inngest } from '../../inngest/client.ts';
import { env } from '../../lib/env.ts';
import {
  applyWahaMessageAck,
  applyWahaMessageSeen,
  applyWahaSessionStatus,
} from '../../lib/waha-health.ts';
import {
  mapWahaEventToMeta,
  type WahaMessagePayload,
  type WahaWebhookEvent,
} from '../../lib/waha-mapping.ts';
import { verifyWahaWebhookSignature } from '../../lib/webhook-signature.ts';
import { markWebhookProcessed, recordWebhookEvent } from '../../lib/webhooks.ts';
import { isWorkspaceActive } from '../../lib/workspace-lifecycle.ts';
import { resolveWahaChannel } from '../../services/waha.ts';

/**
 * Webhook WhatsApp BYO (unofficial, WAHA) — POST /api/webhooks/waha/:workspaceId
 *
 * WAHA mengirim satu webhook per event (envelope `{ event, session, payload }`).
 * Keamanan: verifikasi `X-Webhook-Hmac` — HMAC-SHA512 atas RAW body dengan
 * secret per-workspace dari `providerConfig.webhookSecret` (BUKAN SHA-256
 * ala Meta/360dialog — lihat spikes/waha/README.md).
 *
 * Tiga jenis event (spikes/waha/README.md §webhook):
 *  - `session.status`   → update health real-time (connected / restricted /
 *    disconnected + identifier nomor sendiri + timelock) — applyWahaSessionStatus.
 *  - `message.ack`      → status pengiriman outbound di unified inbox
 *    (sent/delivered/failed) + heartbeat — applyWahaMessageAck.
 *  - `message`/`message.any` → shape-shift ke bentuk Meta
 *    (mapWahaEventToMeta) lalu reuse pipeline yang sama persis dengan
 *    360dialog — idempotency `webhook_events` (eventId namespace `waha:`) dan
 *    Inngest `whatsapp/message.received` → `handleWhatsAppUpdate`.
 *
 * Semua event di-dedup (envelope id WAHA unik per delivery; retry memakai id
 * yang sama) dan di-ack 200 — WAHA tidak me-retry event yang sudah diproses.
 *
 * Outbound BYO (auto-reply / inbox / reminder / form send) di-dispatch
 * provider-aware via `resolveWhatsAppChannel` + `sendWhatsAppMessage`
 * (services/whatsapp.ts) → WAHA `POST /api/sendText`, dan dijaga oleh guard
 * banned/restricted/kuota (lihat lib/waha-health.ts).
 */
export const wahaWebhookRoutes = new Hono().post('/:workspaceId', async (c) => {
  const workspaceId = c.req.param('workspaceId');

  // Bisnis soft-deleted / sudah dihapus permanen → drop update (ack 200 agar
  // WAHA tidak me-retry; pesan tidak akan pernah diproses).
  if (!(await isWorkspaceActive(workspaceId))) {
    return c.json({ received: true, disabled: true });
  }

  const channel = await resolveWahaChannel(workspaceId);
  if (!channel) {
    return c.text('Channel WhatsApp BYO tidak dikonfigurasi untuk workspace ini', 404);
  }
  if (!channel.isActive) {
    // Channel dijeda dari UI — ack 200 tanpa proses (hindari retry WAHA).
    return c.json({ received: true, disabled: true });
  }

  // WAJIB pakai raw body — HMAC dihitung atas byte mentah.
  const rawBody = await c.req.text();

  const secret = channel.webhookSecret;
  const header = c.req.header('x-webhook-hmac') ?? '';
  const algorithm = c.req.header('x-webhook-hmac-algorithm') ?? '';

  if (secret) {
    if (algorithm && algorithm !== 'sha512') {
      return c.text('Invalid signature algorithm', 401);
    }
    if (!verifyWahaWebhookSignature(rawBody, secret, header)) {
      return c.text('Invalid signature', 401);
    }
  } else if (env.NODE_ENV === 'production') {
    return c.text('Webhook secret belum dikonfigurasi untuk channel ini', 503);
  }

  let event: WahaWebhookEvent;
  try {
    event = JSON.parse(rawBody) as WahaWebhookEvent;
  } catch {
    return c.json({ error: 'Payload bukan JSON valid' }, 400);
  }

  const eventType = event.event ?? 'unknown';
  const payload = (event.payload ?? {}) as WahaMessagePayload;

  // Idempotency: pesan masuk memakai id WAHA ("false_{chatId}_{messageId}");
  // event lain memakai envelope id (ULID unik per delivery, sama saat retry).
  const messageMeta = mapWahaEventToMeta(event);
  const messageId = messageMeta?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.id;
  const eventId = messageId
    ? `${workspaceId}:waha:${messageId}`
    : `${workspaceId}:waha:${event.id ?? 'unknown'}:${eventType}`;

  const record = await recordWebhookEvent(
    db,
    'waha',
    eventId,
    eventType,
    event as unknown as Record<string, unknown>,
  );
  if (record === 'processed') {
    return c.json({ duplicate: true, eventId }, 200);
  }

  // ── session.status → health state machine (real-time) ─────
  if (eventType === 'session.status') {
    await applyWahaSessionStatus(workspaceId, event);
    await markWebhookProcessed(db, 'waha', eventId);
    return c.json({ received: true, events: 0 });
  }

  // ── message.ack → status outbound di inbox + heartbeat ────
  if (eventType === 'message.ack') {
    await applyWahaMessageAck(workspaceId, payload);
    await markWebhookProcessed(db, 'waha', eventId);
    return c.json({ received: true, events: 0 });
  }

  // ── message / message.any ─────────────────────────────────
  if (!messageMeta) {
    // Echo outbound / media / event tak dikenal — tetap catat heartbeat agar
    // watchdog tidak menandai gateway mati karena tidak ada pesan masuk.
    await applyWahaMessageSeen(workspaceId);
    await markWebhookProcessed(db, 'waha', eventId);
    return c.json({ received: true, events: 0 });
  }

  await applyWahaMessageSeen(workspaceId);

  // Pipeline yang sama dengan 360dialog — payload sudah berbentuk Meta.
  // `id` stabil per pesan (WAHA message id) → Inngest sendiri mendedup retry
  // yang tiba setelah send sukses tapi respons hilang (at-least-once).
  try {
    await inngest.send({
      id: `waha-${workspaceId}-${messageId ?? eventId}`,
      name: 'whatsapp/message.received',
      data: { workspaceId, payload: messageMeta },
    });
  } catch (error) {
    // Inngest tidak tersedia (lokal: `pnpm dev:inngest` belum jalan; cloud:
    // INNGEST_EVENT_KEY salah/habis). Jangan ack 200 — WAHA me-retry dengan
    // envelope id yang sama (recordWebhookEvent → 'pending') sehingga pesan
    // tidak hilang permanen begitu Dev Server / Inngest hidup kembali.
    console.error(
      '[waha-webhook] GAGAL mengantre pesan ke Inngest — pastikan `pnpm dev:inngest` berjalan (lokal) atau INNGEST_EVENT_KEY valid (produksi):',
      (error as Error).message,
    );
    return c.json({ error: 'Pesan tidak dapat diantrekan ke Inngest. Coba lagi nanti.' }, 503);
  }
  await markWebhookProcessed(db, 'waha', eventId);

  return c.json({ received: true, eventId });
});
