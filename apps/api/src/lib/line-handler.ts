import { and, eq } from 'drizzle-orm';
import { parseLineWebhook, type CanonicalInboundEvent, type LineWebhookPayload } from '@oriole/messaging';
import { workspaceChannels } from '@oriole/database';

import { db } from '../db/index.ts';
import { decryptSecret } from './crypto.ts';
import {
  ChatDispatchError,
  dispatchChannelConfirmation,
  dispatchChannelReminder,
  processInboundEvent,
  sendWithStatus,
  type BookingOutboundInput,
  type ChatEngineDeps,
} from './chat-engine.ts';
import { lineBuildMessages, linePushMessage, lineSendReply, type LineOutboundMessage } from './line.ts';

/** Error bisnis dengan pesan siap-tampil (dipetakan route → 400). */
export class LineDispatchError extends Error {}

export interface LineChannelConfig {
  /** Channel access token (Bearer) — dienkripsi at-rest, didekripsi saat resolve. */
  accessToken: string;
  /** Channel secret — dipakai verifikasi X-Line-Signature di route webhook. */
  channelSecret: string;
  /** false = channel dijeda dari UI (inbound di-drop, outbound ditolak). */
  isActive: boolean;
}

/**
 * Resolve kredensial channel Line untuk sebuah workspace dari tabel
 * workspace_channels (multi-tenant; tidak ada fallback env — Line selalu
 * per-workspace, mirip WhatsApp).
 */
export async function resolveLineChannel(workspaceId: string): Promise<LineChannelConfig | null> {
  const [channel] = await db
    .select()
    .from(workspaceChannels)
    .where(and(eq(workspaceChannels.workspaceId, workspaceId), eq(workspaceChannels.channelType, 'line')))
    .limit(1);

  const rawToken = channel?.providerConfig?.channelAccessToken;
  const rawSecret = channel?.providerConfig?.channelSecret;
  if (typeof rawToken !== 'string' || rawToken.length === 0) return null;

  return {
    accessToken: decryptSecret(rawToken),
    channelSecret:
      typeof rawSecret === 'string' && rawSecret.length > 0 ? decryptSecret(rawSecret) : '',
    isActive: channel?.isActive ?? true,
  };
}

/**
 * Deps mesin percakapan untuk channel Line: resolve kredensial + kirim via
 * Line API. Balasan inbound memakai replyToken sekali pakai (dari raw event);
 * bila tidak ada (mis. window 1 menit lewat) jatuh ke push message.
 */
function lineDeps(workspaceId: string, replyToken?: string): ChatEngineDeps {
  let resolved: LineChannelConfig | null | undefined;
  const resolve = async (): Promise<LineChannelConfig | null> => {
    if (resolved === undefined) resolved = await resolveLineChannel(workspaceId);
    return resolved;
  };
  return {
    channel: 'line',
    replyMetadataKey: 'replyToEventId',
    resolveChannel: async () => {
      const channel = await resolve();
      return channel ? { isActive: channel.isActive } : null;
    },
    send: async ({ workspaceId: wsId, conversationId, recipient, reply, metadata }) =>
      sendWithStatus({
        workspaceId: wsId,
        conversationId,
        channel: 'line',
        recipient,
        reply,
        metadata,
        providerSend: async (r) => {
          const channel = await resolve();
          if (!channel) throw new LineDispatchError('Channel Line belum dikonfigurasi untuk workspace ini.');
          const messages: LineOutboundMessage[] = lineBuildMessages(r.text, r.buttons, r.shortPrompt);
          if (replyToken) {
            await lineSendReply({ accessToken: channel.accessToken, replyToken, messages });
            return { providerMessageId: null };
          }
          await linePushMessage({ accessToken: channel.accessToken, to: recipient, messages });

          return { providerMessageId: null };
        },
      }),
  };
}

/* ────────────────────────────────────────────────────────────
 * Inbound — webhook Line → intent → state machine → balasan
 * ──────────────────────────────────────────────────────────── */

/**
 * Proses satu payload webhook Line (bisa memuat beberapa event).
 * Setiap event di-parse → CanonicalInboundEvent lalu diproses melalui
 * state machine percakapan. Idempotensi per event: recordInboundMessage
 * onConflictDoNothing (providerMessageId unik) + dedup balasan metadata.
 */
export async function handleLineUpdate(
  workspaceId: string,
  payload: LineWebhookPayload,
): Promise<{ handled: boolean; events: number }> {
  const events = parseLineWebhook(payload);
  if (events.length === 0) return { handled: false, events: 0 };

  const channel = await resolveLineChannel(workspaceId);
  if (!channel) return { handled: false, events: events.length };
  if (!channel.isActive) return { handled: false, events: events.length };

  for (const event of events) {
    await processInboundEvent(
      workspaceId,
      event,
      event.providerEventId,
      lineDeps(workspaceId, rawReplyToken(event)),
    );
  }

  return { handled: true, events: events.length };
}

/** replyToken dari raw event — dipakai balasan sekali pakai. */
function rawReplyToken(event: CanonicalInboundEvent): string | undefined {
  const token = event.raw?.replyToken;
  return typeof token === 'string' && token.length > 0 ? token : undefined;
}

/* ────────────────────────────────────────────────────────────
 * Outbound — kirim reminder / konfirmasi booking (push)
 * ──────────────────────────────────────────────────────────── */

export async function dispatchLineReminder(
  input: Omit<BookingOutboundInput, 'channel' | 'channelLabel' | 'deps'>,
): Promise<{ messageId: string | null }> {
  try {
    return await dispatchChannelReminder({
      ...input,
      channel: 'line',
      channelLabel: 'Line',
      deps: lineDeps(input.workspaceId),
    });
  } catch (error) {
    if (error instanceof ChatDispatchError) throw new LineDispatchError(error.message);
    throw error;
  }
}

export async function dispatchLineConfirmation(
  input: Omit<BookingOutboundInput, 'channel' | 'channelLabel' | 'deps'>,
): Promise<{ messageId: string | null }> {
  try {
    return await dispatchChannelConfirmation({
      ...input,
      channel: 'line',
      channelLabel: 'Line',
      deps: lineDeps(input.workspaceId),
    });
  } catch (error) {
    if (error instanceof ChatDispatchError) throw new LineDispatchError(error.message);
    throw error;
  }
}
