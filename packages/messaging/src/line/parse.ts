import type { CanonicalInboundEvent } from '../types.ts';
import {
  isBookingRequestText,
  isOptOutText,
  parseCallbackData,
  type TelegramCallbackAction,
} from '../telegram/parse.ts';

/**
 * Parsing webhook Line → CanonicalInboundEvent (pure, tanpa network).
 *
 * Line Messaging API mengirim payload berisi array `events` via POST ke
 * webhook endpoint dengan header `X-Line-Signature` (HMAC-SHA256 dari raw
 * body, diverifikasi di route API). Satu payload bisa memuat beberapa event.
 *
 * Format postback tombol memakai format yang sama dengan Telegram:
 *   bk:<bookingId>:<action>   action ∈ confirm | cancel | reschedule | stop
 * sehingga state machine percakapan (confirm/cancel/reschedule) bekerja
 * identik lintas channel.
 */

export interface LineWebhookPayload {
  destination?: string;
  events: LineWebhookEvent[];
}

export type LineWebhookEvent = {
  type: string;
  mode?: string;
  timestamp: number;
  replyToken?: string;
  source?: { type?: string; userId?: string; groupId?: string; roomId?: string };
  message?: LineMessage;
  postback?: { data?: string };
  deliveryContext?: { isRedelivery?: boolean };
};

export interface LineMessage {
  id: string;
  type: string;
  text?: string;
}

/** Nama tampilan fallback untuk pesan non-teks (dipakai content placeholder). */
const NON_TEXT_LABELS: Record<string, string> = {
  image: '[Gambar]',
  video: '[Video]',
  audio: '[Audio]',
  file: '[File]',
  location: '[Lokasi]',
  sticker: '[Stiker]',
};

/**
 * Id idempotency per event Line. Line tidak menyediakan event id; untuk
 * pesan dipakai `message.id` (unik), untuk postback dipakai replyToken
 * (unik per event delivery, stabil pada redelivery). Event tanpa keduanya
 * (mis. follow) tidak dianggap relevan.
 */
function lineEventId(event: LineWebhookEvent): string | null {
  if (event.message?.id) return `msg:${event.message.id}`;
  if (event.replyToken) return `postback:${event.replyToken}`;
  return null;
}

/**
 * Parse payload webhook Line.
 * Return array CanonicalInboundEvent — event yang tidak relevan
 * (follow/unfollow/join/leave/beacon, group/room chat) dilewati.
 */
export function parseLineWebhook(payload: LineWebhookPayload): CanonicalInboundEvent[] {
  const events: CanonicalInboundEvent[] = [];

  for (const event of payload.events ?? []) {
    const eventId = lineEventId(event);
    if (!eventId) continue;

    // Hanya DM 1-on-1 (source type 'user') — group/room chat diabaikan
    // (mirip Telegram: group/supergroup tidak diproses).
    if (event.source?.type && event.source.type !== 'user') continue;
    const senderIdentifier = event.source?.userId;
    if (!senderIdentifier) continue;

    const receivedAt = new Date(event.timestamp ?? Date.now()).toISOString();

    // 1. Postback tombol (confirm/cancel/reschedule/stop)
    if (event.type === 'postback') {
      const parsed = parseCallbackData(event.postback?.data);
      if (parsed) {
        events.push({
          channel: 'line',
          providerEventId: eventId,
          senderIdentifier,
          senderName: null,
          intent: parsed.action === 'stop' ? 'opt-out' : parsed.action,
          bookingId: parsed.action === 'stop' ? null : parsed.bookingId,
          content: event.postback?.data ?? '',
          raw: { replyToken: event.replyToken ?? null },
          receivedAt,
        });
        continue;
      }
      // Postback tanpa data dikenal → abaikan (bukan event percakapan).
      continue;
    }

    // 2. Pesan teks
    if (event.type === 'message' && event.message) {
      const text = event.message.text;
      if (isOptOutText(text)) {
        events.push({
          channel: 'line',
          providerEventId: eventId,
          senderIdentifier,
          senderName: null,
          intent: 'opt-out',
          bookingId: null,
          content: text ?? '',
          raw: { replyToken: event.replyToken ?? null },
          receivedAt,
        });
        continue;
      }

      if (isBookingRequestText(text)) {
        events.push({
          channel: 'line',
          providerEventId: eventId,
          senderIdentifier,
          senderName: null,
          intent: 'booking-request',
          bookingId: null,
          content: text ?? '',
          raw: { replyToken: event.replyToken ?? null },
          receivedAt,
        });
        continue;
      }

      // Pesan non-teks (sticker/gambar/dll.) → intent 'text' dengan placeholder
      // agar state machine tidak crash dan percakapan tetap terlihat di inbox.
      const content =
        text !== undefined
          ? text
          : (NON_TEXT_LABELS[event.message.type] ?? `[${event.message.type}]`);
      events.push({
        channel: 'line',
        providerEventId: eventId,
        senderIdentifier,
        senderName: null,
        intent: 'text',
        bookingId: null,
        content,
        raw: { replyToken: event.replyToken ?? null },
        receivedAt,
      });
      continue;
    }

    // 3. Event lain (follow/unfollow/join/leave/beacon/dll.) — diabaikan.
    //    Bot menyapa saat follow bisa ditambahkan nanti via push; greeting
    //    paksa tanpa konteks tidak mengubah perilaku percakapan.
  }

  return events;
}

/** Bangun id callback data tombol — format sama dengan Telegram. */
export function buildLineCallbackData(bookingId: string, action: TelegramCallbackAction): string {
  return `bk:${bookingId}:${action}`;
}
