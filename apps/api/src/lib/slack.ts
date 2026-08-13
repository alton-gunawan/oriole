import { and, eq } from 'drizzle-orm';
import { workspaceIntegrations } from '@oriole/database';

import { db } from '../db/index.ts';

/* ────────────────────────────────────────────────────────────
 * Slack — notifikasi booking ke channel tim (Incoming Webhook).
 *
 * Workspace membuat Slack Incoming Webhook di Slack App →
 * `https://hooks.slack.com/services/T…/B…/…` dan menempelkannya di
 * halaman Integrations. Server mengirim pesan ber-format (blocks) saat
 * event booking terjadi (created / cancelled / completed / updated /
 * deleted) — sama seperti outgoing webhook, tetapi tampilan Slack asli.
 *
 * URL webhook adalah SECRET (siapa pun yang memegangnya bisa memposting
 * ke channel) — tidak pernah di-expose ke client; hanya host + label
 * channel yang tampil di UI.
 * ──────────────────────────────────────────────────────────── */

export const SLACK_TIMEOUT_MS = 5_000;

/** Konfigurasi privat integrasi Slack (disimpan di providerConfig). */
export interface SlackConfig {
  /** Incoming webhook URL — `https://hooks.slack.com/services/…`. */
  webhookUrl: string;
  /** Label channel opsional (mis. "#general") — hanya untuk tampilan. */
  channel?: string | null;
}

export class SlackDeliveryError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SlackDeliveryError';
  }
}

/** Meta pesan per event — emoji + judul (teks UI mengikuti bahasa server). */
const EVENT_META: Record<string, { emoji: string; title: string }> = {
  'booking.created': { emoji: '🆕', title: 'New booking' },
  'booking.cancelled': { emoji: '❌', title: 'Booking cancelled' },
  'booking.completed': { emoji: '✅', title: 'Booking completed' },
  'booking.updated': { emoji: '🔄', title: 'Booking updated' },
  'booking.deleted': { emoji: '🗑️', title: 'Booking deleted' },
  ping: { emoji: '🔔', title: 'Oriole test message' },
};

/** Escape karakter mrkdwn Slack (& < >) agar input user tidak rusak/abuse. */
export function escapeSlackMrkdwn(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/** Format waktu ISO → teks ramah (zona booking bila diberikan). */
export function formatSlackTime(iso: string, timezone?: string | null): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone || 'UTC',
    }).format(new Date(iso));
  } catch {
    // timezone tidak dikenal Intl — fallback UTC.
    try {
      return new Intl.DateTimeFormat('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'UTC',
      }).format(new Date(iso));
    } catch {
      return iso;
    }
  }
}

/** Payload Slack: `text` (fallback notifikasi) + `blocks` (tampilan kartu). */
export interface SlackPayload {
  text: string;
  blocks: Record<string, unknown>[];
}

/**
 * Susun pesan Slack dari event booking (pure function — mudah diuji).
 * `data` = snapshot payload webhook keluar (bookingWebhookPayload) atau
 * subset { id, workspaceId, … } untuk event tanpa snapshot lengkap.
 */
export function buildSlackMessage(event: string, data: Record<string, unknown>): SlackPayload {
  const meta = EVENT_META[event] ?? { emoji: '🔔', title: event };
  const title = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : null;

  const blocks: Record<string, unknown>[] = [
    { type: 'header', text: { type: 'plain_text', text: `${meta.emoji} ${meta.title}` } },
  ];
  if (title) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${escapeSlackMrkdwn(title)}*` } });
  }

  const fields: string[] = [];
  if (typeof data.customerName === 'string' && data.customerName.trim()) {
    fields.push(`*Customer:*\n${escapeSlackMrkdwn(data.customerName.trim())}`);
  }
  if (typeof data.scheduledAt === 'string' && data.scheduledAt) {
    const timezone = typeof data.timezone === 'string' ? data.timezone : null;
    fields.push(`*Time:*\n${formatSlackTime(data.scheduledAt, timezone)}`);
  }
  if (typeof data.phone === 'string' && data.phone.trim()) {
    fields.push(`*Phone:*\n${escapeSlackMrkdwn(data.phone.trim())}`);
  }
  if (typeof data.status === 'string' && data.status) {
    fields.push(`*Status:*\n${escapeSlackMrkdwn(data.status)}`);
  }
  if (typeof data.durationMinutes === 'number') {
    fields.push(`*Duration:*\n${data.durationMinutes} min`);
  }
  if (fields.length > 0) {
    blocks.push({ type: 'section', fields: fields.map((text) => ({ type: 'mrkdwn', text })) });
  }

  const text = `${meta.emoji} ${meta.title}${title ? ` — ${title}` : ''}`;
  return { text, blocks };
}

/**
 * Kirim satu pesan ke Slack dengan timeout. Semua kegagalan dilempar
 * sebagai SlackDeliveryError (Inngest akan me-retry dengan backoff).
 */
export async function deliverSlackMessage(
  webhookUrl: string,
  payload: SlackPayload,
): Promise<{ ok: true; status: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SLACK_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      const reason =
        error instanceof Error && error.name === 'AbortError'
          ? `timeout setelah ${SLACK_TIMEOUT_MS / 1000}s`
          : 'tidak dapat dijangkau';
      throw new SlackDeliveryError(`Slack tidak dapat dijangkau (${reason}).`, 0);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new SlackDeliveryError(
        `Slack menjawab ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}.`,
        res.status,
      );
    }
    return { ok: true, status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

/** Muat integrasi Slack AKTIF untuk sebuah workspace. */
export async function loadSlackConfig(workspaceId: string): Promise<SlackConfig | null> {
  const [integration] = await db
    .select()
    .from(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, workspaceId),
        eq(workspaceIntegrations.integrationType, 'slack'),
      ),
    )
    .limit(1);
  if (!integration || !integration.isActive) return null;
  const config = integration.providerConfig as unknown as SlackConfig;
  return config.webhookUrl ? config : null;
}

/** Hasil dispatch — `skipped` saat tidak dikonfigurasi (bukan throw). */
export type SlackDispatchResult = { delivered: true } | { skipped: 'not-configured' };

/**
 * Kirim notifikasi booking ke Slack workspace. Tidak terkonfigurasi →
 * `skipped` (run Inngest yang tertunda setelah user melepas integrasi
 * tidak gagal/retry). Kegagalan pengiriman tetap melempar → retry Inngest.
 */
export async function dispatchSlackNotification(
  workspaceId: string,
  event: string,
  data: Record<string, unknown>,
): Promise<SlackDispatchResult> {
  const config = await loadSlackConfig(workspaceId);
  if (!config) return { skipped: 'not-configured' };
  await deliverSlackMessage(config.webhookUrl, buildSlackMessage(event, data));
  return { delivered: true };
}

/** Ping uji — dipakai tombol "Test" di UI (pengiriman sinkron). */
export async function sendTestSlack(workspaceId: string): Promise<{ delivered: boolean; status: number }> {
  const config = await loadSlackConfig(workspaceId);
  if (!config) {
    throw new SlackDeliveryError('Integrasi Slack belum dikonfigurasi untuk workspace ini.', 409);
  }
  const result = await deliverSlackMessage(config.webhookUrl, buildSlackMessage('ping', {}));
  return { delivered: true, status: result.status };
}
