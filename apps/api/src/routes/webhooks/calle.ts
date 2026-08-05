import { Hono } from 'hono';
import { z } from 'zod';

import { db } from '../../db/index.ts';
import { inngest } from '../../inngest/client.ts';
import type { CalleWebhookPayload } from '../../lib/calle-types.ts';
import { env } from '../../lib/env.ts';
import { verifyWebhookSignature } from '../../lib/webhook-signature.ts';
import { markWebhookProcessed, recordWebhookEvent } from '../../lib/webhooks.ts';

/**
 * Validasi dalam payload webhook CALL-E. Semua field yang dipakai
 * downstream (Inngest: upsert calleCalls, tandai booking completed)
 * harus berbentuk yang diketahui — field asing dibuang agar data
 * yang disimpan & diproses selalu bersih.
 */
const calleWebhookPayloadSchema = z.object({
  id: z.string().min(1),
  type: z.string().optional(),
  createdAt: z.string().optional(),
  data: z
    .object({
      callId: z.string().optional(),
      phone: z.string().optional(),
      status: z.string().optional(),
      result: z.record(z.string(), z.unknown()).nullable().optional(),
      userId: z.string().optional(),
      workspaceId: z.string().optional(),
      bookingId: z.string().optional(),
    })
    .optional(),
});

/**
 * Webhook CALL-E — event dikirim setelah hasil panggilan difinalisasi.
 *
 * Keamanan: CALL-E tidak menandatangani payload, jadi app mewajibkan
 * header `x-calle-signature` = HMAC-SHA256 atas RAW body dengan
 * `CALLE_WEBHOOK_SECRET` (constant-time compare). Tanpa secret terkonfigurasi
 * endpoint bersifat fail-closed (503). Idempotency via
 * `CALL-E-Event-Id` / `body.id` tetap seperti sebelumnya.
 */
export const calleWebhookRoutes = new Hono().post('/', async (c) => {
  const secret = env.CALLE_WEBHOOK_SECRET;
  if (!secret) {
    return c.json(
      { error: 'Webhook belum dikonfigurasi: set CALLE_WEBHOOK_SECRET dan kirim header x-calle-signature.' },
      503,
    );
  }

  const signature = c.req.header('x-calle-signature') ?? '';
  // WAJIB pakai raw body — HMAC dihitung atas byte mentah, bukan objek
  // hasil re-serialisasi (agar cocok dengan sisi pengirim).
  const rawBody = await c.req.text();

  if (!verifyWebhookSignature(rawBody, secret, signature)) {
    return c.text('Invalid signature', 401);
  }

  // Parse JSON dari raw body SETELAH signature lolos.
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return c.json({ error: 'Payload bukan JSON valid' }, 400);
  }
  const parsedPayload = calleWebhookPayloadSchema.safeParse(parsed);
  if (!parsedPayload.success) {
    return c.json({ error: 'Payload tidak valid', issues: parsedPayload.error.issues }, 400);
  }
  const payload = parsedPayload.data as CalleWebhookPayload;

  const headerEventId = c.req.header('CALL-E-Event-Id');
  if (headerEventId && headerEventId !== payload.id) {
    return c.text('Event id mismatch', 400);
  }
  const eventId = headerEventId ?? payload.id;

  const record = await recordWebhookEvent(db, 'calle', eventId, payload.type, payload);
  if (record === 'processed') {
    return c.json({ duplicate: true, eventId }, 200);
  }

  await inngest.send({
    name: 'calle/event.received',
    data: { eventId, eventType: payload.type, payload },
  });
  await markWebhookProcessed(db, 'calle', eventId);

  return c.json({ received: true, eventId });
});
