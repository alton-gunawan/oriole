import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import type { TelegramUpdate } from '@oriole/messaging';

import { db } from '../../db/index.ts';
import { inngest } from '../../inngest/client.ts';
import { env } from '../../lib/env.ts';
import { resolveTelegramChannel } from '../../lib/telegram-handler.ts';
import { markWebhookProcessed, recordWebhookEvent } from '../../lib/webhooks.ts';
import { isWorkspaceActive } from '../../lib/workspace-lifecycle.ts';

/** Validasi longgar — Update Telegram dibiarkan .passthrough(). */
const telegramUpdateSchema = z
  .object({ update_id: z.number().int().positive() })
  .passthrough();

/**
 * Webhook Telegram — Telegram mengirim Update via POST dengan header
 * `X-Telegram-Bot-Api-Secret-Token` (secret_token saat setWebhook).
 *
 * Idempotency via `update_id` pada tabel webhook_events (provider='telegram');
 * Telegram melakukan at-least-once delivery, jadi duplikat harus diabaikan.
 *
 * URL: POST /api/webhooks/telegram/:workspaceId
 */
export const telegramWebhookRoutes = new Hono().post(
  '/:workspaceId',
  zValidator('json', telegramUpdateSchema),
  async (c) => {
    const workspaceId = c.req.param('workspaceId');
    const body = c.req.valid('json') as TelegramUpdate;

    // Project soft-deleted / sudah dihapus permanen → drop update (ack 200 agar
    // Telegram tidak me-retry; pesan tidak akan pernah diproses).
    if (!(await isWorkspaceActive(workspaceId))) {
      return c.json({ received: true, disabled: true });
    }

    const channel = await resolveTelegramChannel(workspaceId);
    if (!channel) {
      return c.text('Telegram channel tidak dikonfigurasi untuk workspace ini', 404);
    }
    if (!channel.isActive) {
      // Channel dijeda dari UI — ack 200 tanpa proses (hindari retry Telegram).
      return c.json({ received: true, disabled: true });
    }

    // Verifikasi asal request — wajib di produksi.
    const secret = channel.webhookSecret;
    const headerToken = c.req.header('X-Telegram-Bot-Api-Secret-Token');
    if (secret && headerToken !== secret) {
      return c.text('Unauthorized', 401);
    }
    if (!secret && env.NODE_ENV === 'production') {
      return c.text('Webhook secret belum dikonfigurasi untuk channel ini', 503);
    }

    // update_id adalah counter per-bot — namespace dengan workspaceId agar
    // idempotency (provider, eventId) tidak bentrok antar bot workspace berbeda.
    const eventId = `${workspaceId}:${String(body.update_id)}`;
    const record = await recordWebhookEvent(
      db,
      'telegram',
      eventId,
      'update',
      body as unknown as Record<string, unknown>,
    );
    if (record === 'processed') {
      return c.json({ duplicate: true, eventId }, 200);
    }

    try {
      await inngest.send({
        name: 'telegram/message.received',
        data: { workspaceId, update: body },
      });
    } catch (error) {
      // Inngest tidak tersedia (lokal: `pnpm dev:inngest` belum jalan; cloud:
      // INNGEST_EVENT_KEY salah/habis). Jangan ack 200 — Telegram me-retry
      // dengan update_id yang sama (recordWebhookEvent → 'pending') sehingga
      // pesan tidak hilang permanen begitu Inngest hidup kembali.
      console.error(
        '[telegram-webhook] GAGAL mengantre pesan ke Inngest — pastikan `pnpm dev:inngest` berjalan (lokal) atau INNGEST_EVENT_KEY valid (produksi):',
        (error as Error).message,
      );
      return c.json({ error: 'Pesan tidak dapat diantrekan ke Inngest. Coba lagi nanti.' }, 503);
    }
    await markWebhookProcessed(db, 'telegram', eventId);

    return c.json({ received: true, eventId });
  },
);
