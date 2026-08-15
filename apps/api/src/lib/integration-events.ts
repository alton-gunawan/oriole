import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { workspaceIntegrations } from '@oriole/database';

import { db } from '../db/index.ts';
import { inngest } from '../inngest/client.ts';

/* ────────────────────────────────────────────────────────────
 * Emit event integrasi dari route aplikasi → Inngest.
 * Pola sama dengan reminder/auto-call: route cukup mengirim event
 * (cepat), fungsi Inngest yang melakukan kerja jaringan berat
 * (fetch Google / webhook) dengan retry otomatis.
 * ──────────────────────────────────────────────────────────── */

/** Cek cepat apakah integrasi aktif (tanpa memuat kredensial). */
async function integrationIsActive(workspaceId: string, integrationType: string): Promise<boolean> {
  const [row] = await db
    .select({ id: workspaceIntegrations.id })
    .from(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, workspaceId),
        eq(workspaceIntegrations.integrationType, integrationType),
        eq(workspaceIntegrations.isActive, true),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Fire-and-forget wrapper — kegagalan kirim event tidak menggagalkan request. */
async function safeSend(name: string, data: Record<string, unknown>): Promise<void> {
  try {
    await inngest.send({ name, data });
  } catch (error) {
    console.warn(`[integrations] gagal mengirim event ${name}:`, error);
  }
}

/**
 * Antrekan pengiriman webhook keluar (`outgoing-webhook/deliver`).
 * Data berupa snapshot JSON — diforward apa adanya ke endpoint user.
 *
 * webhookId dibuat SEKALI di sini dan diteruskan lewat event, sehingga
 * retry Inngest mengirim ulang dengan webhookId yang SAMA — penerima bisa
 * dedupe (idempotensi) walau pengiriman pertama gagal di tengah jalan.
 */
export async function emitOutgoingWebhookEvent(
  workspaceId: string,
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
  if (!(await integrationIsActive(workspaceId, 'webhook'))) return;
  await safeSend('outgoing-webhook/deliver', {
    workspaceId,
    event,
    data,
    webhookId: randomUUID(),
  });
}

/**
 * Antrekan pembuatan link video (`video/link.required`). Integrasi video
 * aktif + provider zoom → Inngest membuat meeting Zoom lalu menyimpan
 * join_url ke booking.video_link. Provider meet ditangani sync kalender.
 */
export async function emitVideoLinkEvent(workspaceId: string, bookingId: string): Promise<void> {
  if (!(await integrationIsActive(workspaceId, 'video'))) return;
  await safeSend('video/link.required', { workspaceId, bookingId });
}

/**
 * Antrekan notifikasi booking → Slack (`slack/booking.event`).
 * Payload sama dengan webhook keluar — lib slack.ts yang memformat pesan.
 */
export async function emitSlackBookingEvent(
  workspaceId: string,
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
  if (!(await integrationIsActive(workspaceId, 'slack'))) return;
  await safeSend('slack/booking.event', { workspaceId, event, data });
}

/**
 * Antrekan notifikasi booking → chat Telegram bisnis
 * (`telegram-alert/booking.event`). Payload sama dengan webhook keluar —
 * lib telegram-alerts.ts yang memformat kartu pesan.
 */
export async function emitTelegramBookingAlert(
  workspaceId: string,
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
  if (!(await integrationIsActive(workspaceId, 'telegram-alerts'))) return;
  await safeSend('telegram-alert/booking.event', { workspaceId, event, data });
}

/**
 * Antrekan sinkronisasi booking → Google Calendar
 * (`google-calendar/booking.changed`, action: 'upsert' | 'delete').
 */
export async function emitCalendarBookingEvent(
  workspaceId: string,
  bookingId: string,
  action: 'upsert' | 'delete',
): Promise<void> {
  if (!(await integrationIsActive(workspaceId, 'google-calendar'))) return;
  await safeSend('google-calendar/booking.changed', { workspaceId, bookingId, action });
}
