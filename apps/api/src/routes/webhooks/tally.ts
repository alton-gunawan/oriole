import { Hono } from 'hono';

import { db } from '../../db/index.ts';
import { env } from '../../lib/env.ts';
import {
  loadTallyConfig,
  syncTallySubmissionToContacts,
  tallyWebhookPayloadSchema,
  verifyTallySignature,
  type TallyWebhookPayload,
} from '../../lib/tally.ts';
import { markWebhookProcessed, recordWebhookEvent } from '../../lib/webhooks.ts';
import { isWorkspaceActive } from '../../lib/workspace-lifecycle.ts';

/**
 * Webhook Tally — dikirim real-time setiap form di-submit.
 *
 * Keamanan: verifikasi header `Tally-Signature`
 * (base64 HMAC-SHA256 dari raw body, pakai signingSecret). Fail-closed di
 * produksi bila secret belum tersimpan.
 *
 * Idempotency: `submissionId` unik per submission — eventId
 * `workspaceId:submissionId` di tabel webhook_events (Tally melakukan
 * at-least-once delivery dengan retry).
 *
 * Processing: submission diproses SINCRON di route (kontak + booking +
 * konfirmasi Telegram) — TIDAK antre ke Inngest, supaya alur inti tidak
 * bergantung pada worker Inngest yang berjalan (di dev, worker tidak selalu
 * aktif). Kegagalan → 500 → Tally me-retry webhook; idempotensi internal
 * (booking unique sourceRef + find-or-create kontak) membuat retry aman.
 *
 * URL: POST /api/webhooks/tally/:workspaceId
 */
export const tallyWebhookRoutes = new Hono().post('/:workspaceId', async (c) => {
  const workspaceId = c.req.param('workspaceId');

  // Bisnis soft-deleted / sudah dihapus permanen → drop (ack 200 agar
  // Tally tidak me-retry; submission tidak akan pernah diproses).
  if (!(await isWorkspaceActive(workspaceId))) {
    return c.json({ received: true, disabled: true });
  }

  const config = await loadTallyConfig(workspaceId);
  if (!config) {
    return c.text('Tally integration tidak dikonfigurasi untuk workspace ini', 404);
  }
  if (!config.isActive) {
    // Integrasi dijeda dari UI — ack 200 tanpa proses (hindari retry Tally).
    return c.json({ received: true, disabled: true });
  }

  // WAJIB pakai raw body — HMAC dihitung atas byte mentah.
  const rawBody = await c.req.text();

  const signature = c.req.header('tally-signature') ?? '';
  if (config.webhookSecret) {
    if (!verifyTallySignature(rawBody, config.webhookSecret, signature)) {
      return c.text('Invalid signature', 401);
    }
  } else if (env.NODE_ENV === 'production') {
    return c.text('Webhook secret belum dikonfigurasi untuk integrasi ini', 503);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return c.json({ error: 'Payload bukan JSON valid' }, 400);
  }
  const parsedPayload = tallyWebhookPayloadSchema.safeParse(parsed);
  if (!parsedPayload.success) {
    return c.json({ error: 'Payload tidak valid' }, 400);
  }
  const payload = parsedPayload.data as TallyWebhookPayload;

  // Payload non-submission (verifikasi, dll) → ack 200.
  const submissionId = payload.data?.submissionId ?? payload.data?.responseId;
  if (!submissionId) {
    return c.json({ received: true, events: 0 });
  }

  // submissionId unik per submission — namespace dengan workspaceId agar
  // idempotency (provider, eventId) tidak bentrok antar workspace.
  const eventId = `${workspaceId}:${submissionId}`;

  const record = await recordWebhookEvent(
    db,
    'tally',
    eventId,
    'form_response',
    payload as unknown as Record<string, unknown>,
  );
  if (record === 'processed') {
    return c.json({ duplicate: true, eventId }, 200);
  }

  try {
    // Proses langsung (sinkron): kontak + booking + konfirmasi Telegram
    // best-effort di dalam. Gagal → 500 agar Tally me-retry (idempoten).
    await syncTallySubmissionToContacts(workspaceId, payload);
  } catch (error) {
    console.error('[webhook:tally] gagal memproses submission:', error);
    return c.json({ error: 'Gagal memproses submission' }, 500);
  }

  // Hanya tandai processed SETELAH sukses — retry Tally tetap memproses ulang
  // bila langkah di atas gagal di tengah jalan.
  await markWebhookProcessed(db, 'tally', eventId);

  return c.json({ received: true, eventId });
});
