import { and, eq } from 'drizzle-orm';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { workspaceChannels, workspaceIntegrations, workspaces } from '@oriole/database';

import { db } from '../db/index.ts';
import { telegramGetMe, telegramSendMessage } from './telegram.ts';
import { resolveTelegramChannel } from './telegram-handler.ts';
import { formatSlackTime } from './slack.ts';

/* ────────────────────────────────────────────────────────────
 * Telegram booking alerts — notifikasi booking ke chat bisnis.
 *
 * Owner bisnis mengikat chat Telegram-nya (tombol Start pada bot
 * workspace) lewat deep-link `https://t.me/<bot>?start=oriole_<token>`.
 * Setelah terikat, setiap event booking (created / cancelled / …)
 * dikirim sebagai kartu pesan ke chat itu — pola yang sama dengan
 * notifikasi Slack (Incoming Webhook), tetapi lewat bot Telegram
 * yang sudah dipakai bisnis.
 *
 * Penyimpanan: `workspace_integrations` (type 'telegram-alerts'),
 * providerConfig = { bindToken, chatId, chatName }. Token dirotasi
 * setelah bind berhasil (link bekas tidak bisa dipakai ulang).
 * ──────────────────────────────────────────────────────────── */

export const TELEGRAM_ALERTS_INTEGRATION_TYPE = 'telegram-alerts';

/** Konfigurasi privat integrasi Telegram alerts (providerConfig). */
export interface TelegramAlertsConfig {
  /** Token rahasia deep-link bind — dirotasi setelah bind berhasil. */
  bindToken: string;
  /** Chat Telegram yang menerima alert booking (diisi saat bind). */
  chatId?: string | null;
  /** Nama chat (dari Telegram) — hanya untuk tampilan UI. */
  chatName?: string | null;
}

/** Error bisnis Telegram alerts — `status` dipetakan ke HTTP response. */
export class TelegramAlertError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'TelegramAlertError';
  }
}

/** Token bind baru (24 byte → 48 hex char) — cukup acak untuk deep-link. */
export function newBindToken(): string {
  return randomBytes(24).toString('hex');
}

/** Muat konfigurasi Telegram alerts untuk sebuah workspace (null bila belum). */
export async function loadTelegramAlertsConfig(
  workspaceId: string,
): Promise<(TelegramAlertsConfig & { isActive: boolean }) | null> {
  const [integration] = await db
    .select()
    .from(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, workspaceId),
        eq(workspaceIntegrations.integrationType, TELEGRAM_ALERTS_INTEGRATION_TYPE),
      ),
    )
    .limit(1);
  if (!integration) return null;
  const config = integration.providerConfig as unknown as TelegramAlertsConfig;
  if (!config?.bindToken) return null;
  return { ...config, isActive: integration.isActive };
}

/**
 * Aktifkan integrasi (find-or-create) dengan bind token BARU. Chat yang
 * sudah terikat dipertahankan — rotasi token hanya membuat link lama tidak
 * valid, alert tetap terkirim sampai bind baru menimpa chat.
 */
export async function ensureTelegramAlertsConfig(workspaceId: string): Promise<{
  integration: typeof workspaceIntegrations.$inferSelect;
  config: TelegramAlertsConfig;
}> {
  const existing = await loadTelegramAlertsConfig(workspaceId);
  const bindToken = newBindToken();
  const providerConfig: TelegramAlertsConfig = {
    bindToken,
    chatId: existing?.chatId ?? null,
    chatName: existing?.chatName ?? null,
  };
  // Cast: kolom jsonb bertipe Record<string, unknown> — interface opsional
  // tidak punya index signature (pola sama dengan providerConfig lain).
  const providerConfigJson = providerConfig as unknown as Record<string, unknown>;
  const [row] = await db
    .insert(workspaceIntegrations)
    .values({
      workspaceId,
      integrationType: TELEGRAM_ALERTS_INTEGRATION_TYPE,
      identifier: null,
      providerConfig: providerConfigJson,
      isActive: true,
    })
    .onConflictDoUpdate({
      target: [workspaceIntegrations.workspaceId, workspaceIntegrations.integrationType],
      set: {
        providerConfig: providerConfigJson,
        isActive: true,
        updatedAt: new Date(),
      },
    })
    .returning();
  return { integration: row, config: providerConfig };
}

/**
 * Parse payload deep-link Telegram: `/start oriole_<token>` (token 48 hex).
 * Format lain (termasuk `/start` polos) → null (bukan permintaan bind).
 */
export function parseTelegramAlertBindPayload(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = /^\/start\s+oriole_([0-9a-f]{48})$/i.exec(text.trim());
  return match ? match[1] : null;
}

/**
 * Bind chat ke alert booking. Verifikasi token constant-time; setelah
 * berhasil, token dirotasi (link bekas tidak bisa dipakai ulang) dan
 * chatId/chatName tersimpan. Bind ulang dari chat lain menimpa chat lama.
 */
export async function bindTelegramAlertsChat(input: {
  workspaceId: string;
  chatId: string;
  chatName: string | null;
  token: string;
}): Promise<{ bound: true } | { bound: false; reason: 'not-configured' | 'invalid-token' }> {
  const existing = await loadTelegramAlertsConfig(input.workspaceId);
  if (!existing) return { bound: false, reason: 'not-configured' };

  const expected = Buffer.from(existing.bindToken, 'hex');
  const provided = Buffer.from(input.token, 'hex');
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return { bound: false, reason: 'invalid-token' };
  }

  await db
    .update(workspaceIntegrations)
    .set({
      providerConfig: {
        bindToken: newBindToken(),
        chatId: input.chatId,
        chatName: input.chatName ?? null,
      },
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, input.workspaceId),
        eq(workspaceIntegrations.integrationType, TELEGRAM_ALERTS_INTEGRATION_TYPE),
      ),
    );

  return { bound: true };
}

/** Meta pesan per event — emoji + judul (bahasa server konsisten dengan Slack). */
const ALERT_EVENT_META: Record<string, { emoji: string; title: string }> = {
  'booking.created': { emoji: '🆕', title: 'New booking' },
  'booking.cancelled': { emoji: '❌', title: 'Booking cancelled' },
  'booking.completed': { emoji: '✅', title: 'Booking completed' },
  'booking.updated': { emoji: '🔄', title: 'Booking updated' },
  'booking.deleted': { emoji: '🗑️', title: 'Booking deleted' },
  ping: { emoji: '🔔', title: 'Oriole test message' },
};

/**
 * Susun teks kartu alert booking (plain text — dikirim tanpa parse_mode,
 * jadi tanpa markdown; emoji cukup sebagai penanda). `data` = snapshot
 * payload webhook keluar (bookingWebhookPayload) atau subset minimal.
 */
export function buildTelegramBookingAlert(event: string, data: Record<string, unknown>): string {
  const meta = ALERT_EVENT_META[event] ?? { emoji: '🔔', title: event };
  const title = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : null;

  const lines = [`${meta.emoji} ${meta.title}`];
  if (title) lines.push(title);
  if (typeof data.customerName === 'string' && data.customerName.trim()) {
    lines.push(`👤 ${data.customerName.trim()}`);
  }
  if (typeof data.scheduledAt === 'string' && data.scheduledAt) {
    const timezone = typeof data.timezone === 'string' ? data.timezone : null;
    lines.push(`📅 ${formatSlackTime(data.scheduledAt, timezone)}`);
  }
  if (typeof data.phone === 'string' && data.phone.trim()) {
    lines.push(`📞 ${data.phone.trim()}`);
  }
  if (typeof data.status === 'string' && data.status) {
    lines.push(`• ${data.status}`);
  }
  return lines.join('\n');
}

/** Username bot Telegram workspace (tanpa @) — untuk deep-link bind. */
async function resolveTelegramBotUsername(
  workspaceId: string,
  token: string,
): Promise<string | null> {
  const [channel] = await db
    .select({ identifier: workspaceChannels.identifier })
    .from(workspaceChannels)
    .where(
      and(
        eq(workspaceChannels.workspaceId, workspaceId),
        eq(workspaceChannels.channelType, 'telegram'),
      ),
    )
    .limit(1);
  if (typeof channel?.identifier === 'string' && channel.identifier.trim()) {
    const username = channel.identifier.replace(/^@/, '').trim();
    if (username) return username;
  }
  // Fallback env bot (dev shared) — tanpa baris channel, cari via getMe.
  try {
    const me = await telegramGetMe(token);
    return me.username;
  } catch {
    return null;
  }
}

/**
 * Deep-link bind: `https://t.me/<bot>?start=oriole_<token>`. User membuka
 * link ini, menekan Start pada bot → webhook menerima `/start oriole_<token>`
 * → chat terikat. Null bila bot tidak punya username (Telegram menolak
 * deep-link tanpa username).
 */
export async function telegramAlertsBindUrl(
  workspaceId: string,
  config: TelegramAlertsConfig,
): Promise<string | null> {
  const channel = await resolveTelegramChannel(workspaceId);
  if (!channel) return null;
  const username = await resolveTelegramBotUsername(workspaceId, channel.token);
  if (!username) return null;
  return `https://t.me/${username}?start=oriole_${config.bindToken}`;
}

/** Hasil dispatch — `skipped` saat belum dikonfigurasi (bukan throw). */
export type TelegramAlertDeliveryResult =
  | { delivered: true }
  | { skipped: 'not-configured' | 'not-bound' | 'no-channel' | 'channel-disabled' };

/**
 * Kirim alert booking ke chat bisnis yang terikat. Tidak terkonfigurasi /
 * belum bind → `skipped` (run Inngest yang tertunda tidak gagal/retry).
 * Kegagalan pengiriman tetap melempar → retry built-in Inngest.
 */
export async function deliverTelegramBusinessAlert(
  workspaceId: string,
  event: string,
  data: Record<string, unknown>,
): Promise<TelegramAlertDeliveryResult> {
  const config = await loadTelegramAlertsConfig(workspaceId);
  if (!config || !config.isActive) return { skipped: 'not-configured' };
  if (!config.chatId) return { skipped: 'not-bound' };

  const channel = await resolveTelegramChannel(workspaceId);
  if (!channel) return { skipped: 'no-channel' };
  if (!channel.isActive) return { skipped: 'channel-disabled' };

  await telegramSendMessage({
    token: channel.token,
    chatId: config.chatId,
    text: buildTelegramBookingAlert(event, data),
  });
  return { delivered: true };
}

/** Ping uji — dipakai tombol "Test" di UI (pengiriman sinkron). */
export async function sendTestTelegramAlert(
  workspaceId: string,
): Promise<{ delivered: boolean }> {
  const config = await loadTelegramAlertsConfig(workspaceId);
  if (!config) {
    throw new TelegramAlertError('Integrasi Telegram alerts belum diaktifkan untuk workspace ini.', 409);
  }
  if (!config.chatId) {
    throw new TelegramAlertError(
      'Belum ada chat yang terikat. Buka tautan bind lalu tekan Start pada bot.',
      409,
    );
  }
  const channel = await resolveTelegramChannel(workspaceId);
  if (!channel) {
    throw new TelegramAlertError('Channel Telegram belum dikonfigurasi untuk workspace ini.', 409);
  }
  if (!channel.isActive) {
    throw new TelegramAlertError('Channel Telegram sedang dijeda (nonaktif).', 409);
  }
  await telegramSendMessage({
    token: channel.token,
    chatId: config.chatId,
    text: buildTelegramBookingAlert('ping', {}),
  });
  return { delivered: true };
}

/**
 * Tangani pesan masuk `/start oriole_<token>` (deep-link bind) — dipanggil
 * oleh telegram-handler SEBELUM alur customer. Pesan bind tidak masuk inbox
 * (percakapan customer tidak dibuat). Balasan konfirmasi dikirim langsung.
 */
export async function handleTelegramAlertBind(input: {
  workspaceId: string;
  chatId: string;
  chatName: string | null;
  content: string;
  channelToken: string;
}): Promise<{ handled: boolean; reason?: 'bound' | 'invalid-token' | 'not-configured' }> {
  const bindToken = parseTelegramAlertBindPayload(input.content);
  if (!bindToken) return { handled: false };

  const result = await bindTelegramAlertsChat({
    workspaceId: input.workspaceId,
    chatId: input.chatId,
    chatName: input.chatName,
    token: bindToken,
  });

  // Balasan mengikuti bahasa chat workspace (setting terpisah dari call).
  const [workspace] = await db
    .select({ chatLanguage: workspaces.chatLanguage })
    .from(workspaces)
    .where(eq(workspaces.id, input.workspaceId))
    .limit(1);
  const id = workspace?.chatLanguage === 'id';
  const reply = result.bound
    ? id
      ? '✅ Notifikasi booking diaktifkan di chat ini. Booking baru akan muncul di sini.'
      : '✅ Booking alerts are now enabled in this chat. New bookings will show up here.'
    : result.reason === 'invalid-token'
      ? id
        ? '❌ Tautan tidak valid atau sudah kedaluwarsa. Buka ulang dari halaman Integrations.'
        : '❌ This link is invalid or expired. Open it again from the Integrations page.'
      : id
        ? '❌ Notifikasi booking belum diaktifkan di workspace ini.'
        : '❌ Booking alerts are not enabled for this workspace.';

  await telegramSendMessage({ token: input.channelToken, chatId: input.chatId, text: reply });
  return { handled: true, reason: result.bound ? 'bound' : result.reason };
}
