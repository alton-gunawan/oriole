import { and, eq } from 'drizzle-orm';
import { parseTelegramUpdate, type TelegramUpdate } from '@oriole/messaging';
import { workspaceChannels } from '@oriole/database';

import { db } from '../db/index.ts';
import { env } from './env.ts';
import {
  ChatDispatchError,
  dispatchChannelConfirmation,
  dispatchChannelReminder,
  dispatchChannelReview,
  processInboundEvent,
  sendWithStatus,
  type BookingOutboundInput,
  type ChatEngineDeps,
} from './chat-engine.ts';
import {
  telegramAnswerCallbackQuery,
  telegramEditMessageReplyMarkup,
  telegramSendMessage,
} from './telegram.ts';

/** Error bisnis dengan pesan siap-tampil (dipetakan route → 400). */
export class TelegramDispatchError extends Error {}

export interface TelegramChannelConfig {
  token: string;
  webhookSecret: string | null;
  /** false = channel dijeda dari UI (inbound di-drop, outbound ditolak). */
  isActive: boolean;
}

/**
 * Resolve kredensial channel Telegram untuk sebuah workspace.
 * Prioritas: providerConfig di tabel workspace_channels (multi-tenant),
 * lalu fallback env TELEGRAM_BOT_TOKEN (development single-tenant).
 */
export async function resolveTelegramChannel(
  workspaceId: string,
): Promise<TelegramChannelConfig | null> {
  const [channel] = await db
    .select()
    .from(workspaceChannels)
    .where(and(eq(workspaceChannels.workspaceId, workspaceId), eq(workspaceChannels.channelType, 'telegram')))
    .limit(1);

  const providerToken = channel?.providerConfig?.botToken;
  if (typeof providerToken === 'string' && providerToken.length > 0) {
    const secret = channel?.providerConfig?.webhookSecret;
    return {
      token: providerToken,
      webhookSecret: typeof secret === 'string' && secret.length > 0 ? secret : null,
      isActive: channel?.isActive ?? true,
    };
  }

  if (env.TELEGRAM_BOT_TOKEN) {
    return {
      token: env.TELEGRAM_BOT_TOKEN,
      webhookSecret: env.TELEGRAM_WEBHOOK_SECRET ?? null,
      isActive: true,
    };
  }
  return null;
}

/**
 * Deps mesin percakapan untuk channel Telegram: resolve kredensial +
 * kirim via Telegram API (termasuk reply keyboard request_contact).
 *
 * Bila `preResolved` diberikan (jalur inbound — channel sudah di-resolve
 * untuk ack callback), dipakai langsung tanpa query DB tambahan. Bila tidak
 * (jalur dispatch), resolve dimemoize per pemanggilan agar send memakai
 * konfigurasi yang sama dengan pengecekan isActive.
 */
function telegramDeps(workspaceId: string, preResolved?: TelegramChannelConfig): ChatEngineDeps {
  let resolved: TelegramChannelConfig | null | undefined = preResolved;
  const resolve = async (): Promise<TelegramChannelConfig | null> => {
    if (resolved === undefined) resolved = await resolveTelegramChannel(workspaceId);
    return resolved;
  };
  return {
    channel: 'telegram',
    replyMetadataKey: 'replyToUpdateId',
    resolveChannel: async () => {
      const channel = await resolve();
      return channel ? { isActive: channel.isActive } : null;
    },
    send: async ({ workspaceId: wsId, conversationId, recipient, reply, metadata }) =>
      sendWithStatus({
        workspaceId: wsId,
        conversationId,
        channel: 'telegram',
        recipient,
        reply,
        metadata,
        providerSend: async (r) => {
          const channel = await resolve();
          if (!channel) throw new TelegramDispatchError('Channel Telegram belum dikonfigurasi untuk workspace ini.');
          const sent = await telegramSendMessage({
            token: channel.token,
            chatId: recipient,
            text: r.text,
            buttons: r.buttons,
            requestContact: r.requestContact,
          });
          return { providerMessageId: String(sent.messageId) };
        },
      }),
  };
}

/* ────────────────────────────────────────────────────────────
 * Inbound — webhook Telegram → intent → state machine → balasan
 * ──────────────────────────────────────────────────────────── */

export async function handleTelegramUpdate(
  workspaceId: string,
  update: TelegramUpdate,
): Promise<{ handled: boolean; reason?: string }> {
  const parsed = parseTelegramUpdate(update);
  if (!parsed) return { handled: false, reason: 'no-event' };

  const channel = await resolveTelegramChannel(workspaceId);
  if (!channel) return { handled: false, reason: 'no-channel' };

  // Deep-link bind Telegram booking alerts (`/start oriole_<token>`) —
  // ditangani SEBELUM alur customer: pesan bind tidak masuk inbox dan tidak
  // membuat percakapan. Dynamic import memutus siklus modul (telegram-alerts
  // mengimpor resolveTelegramChannel dari file ini).
  if (parsed.intent === 'text' && parsed.content.startsWith('/start ')) {
    const { handleTelegramAlertBind } = await import('./telegram-alerts.ts');
    const bindResult = await handleTelegramAlertBind({
      workspaceId,
      chatId: parsed.senderIdentifier,
      chatName: parsed.senderName ?? null,
      content: parsed.content,
      channelToken: channel.token,
    });
    if (bindResult.handled) return { handled: true, reason: 'alert-bind' };
  }

  // Efek samping Telegram: ack callback + bersihkan tombol yang sudah dipakai
  // (cegah double-tap) — dikirim bersamaan dengan pemrosesan, tidak menunggunya.
  const callbackQueryId = parsed.raw?.callbackQueryId as string | undefined;
  if (callbackQueryId) {
    // Ack SEGERA (non-blocking) agar spinner tombol hilang tanpa menunggu
    // proses intent. Error ditelan — ack gagal tidak menggagalkan balasan.
    void telegramAnswerCallbackQuery(channel.token, callbackQueryId).catch(() => undefined);

    // Bersihkan tombol callback yang sudah dipakai (cegah double-tap) —
    // berjalan paralel dengan pemrosesan intent di bawah.
    const messageId = parsed.raw?.messageId as number | undefined;
    const chatId = parsed.raw?.chatId as number | undefined;
    if (messageId && chatId) {
      void telegramEditMessageReplyMarkup(channel.token, String(chatId), messageId).catch(
        () => undefined,
      );
    }
  }

  return processInboundEvent(workspaceId, parsed, String(update.update_id), telegramDeps(workspaceId, channel));
}

/* ────────────────────────────────────────────────────────────
 * Outbound — kirim reminder booking ke chat customer
 * ──────────────────────────────────────────────────────────── */

export async function dispatchTelegramReminder(
  input: Omit<BookingOutboundInput, 'channel' | 'channelLabel' | 'deps'>,
): Promise<{ messageId: number | null }> {
  try {
    const result = await dispatchChannelReminder({
      ...input,
      channel: 'telegram',
      channelLabel: 'Telegram',
      deps: telegramDeps(input.workspaceId),
    });
    return { messageId: result.messageId === null ? null : Number(result.messageId) };
  } catch (error) {
    if (error instanceof ChatDispatchError) throw new TelegramDispatchError(error.message);
    throw error;
  }
}

/**
 * Kirim pesan bebas ke chat Telegram (mis. tawaran slot waitlist).
 * Business error (channel belum dikonfigurasi / dijeda) → TelegramDispatchError;
 * error provider dibiarkan bubble agar pemanggil (Inngest) me-retry.
 */
export async function dispatchTelegramText(
  workspaceId: string,
  chatId: string,
  text: string,
): Promise<{ messageId: number | null }> {
  const channel = await resolveTelegramChannel(workspaceId);
  if (!channel) {
    throw new TelegramDispatchError('Channel Telegram belum dikonfigurasi untuk workspace ini.');
  }
  if (!channel.isActive) {
    throw new TelegramDispatchError('Channel Telegram sedang dijeda (nonaktif).');
  }
  const sent = await telegramSendMessage({ token: channel.token, chatId, text });
  return { messageId: sent.messageId };
}

export async function dispatchTelegramReview(
  input: Omit<BookingOutboundInput, 'channel' | 'channelLabel' | 'deps'>,
): Promise<{ messageId: number | null }> {
  try {
    const result = await dispatchChannelReview({
      ...input,
      channel: 'telegram',
      channelLabel: 'Telegram',
      deps: telegramDeps(input.workspaceId),
    });
    return { messageId: result.messageId === null ? null : Number(result.messageId) };
  } catch (error) {
    if (error instanceof ChatDispatchError) throw new TelegramDispatchError(error.message);
    throw error;
  }
}

export async function dispatchTelegramConfirmation(
  input: Omit<BookingOutboundInput, 'channel' | 'channelLabel' | 'deps'>,
): Promise<{ messageId: number | null }> {
  try {
    const result = await dispatchChannelConfirmation({
      ...input,
      channel: 'telegram',
      channelLabel: 'Telegram',
      deps: telegramDeps(input.workspaceId),
    });
    return { messageId: result.messageId === null ? null : Number(result.messageId) };
  } catch (error) {
    if (error instanceof ChatDispatchError) throw new TelegramDispatchError(error.message);
    throw error;
  }
}
