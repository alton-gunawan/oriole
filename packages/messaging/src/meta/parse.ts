import type { CanonicalInboundEvent, InboundIntent } from '../types.ts';

/**
 * Payload webhook Meta (Messenger / Instagram Messaging) — bentuk yang
 * dikirim Meta ke callback URL setelah App disubscribe ke page:
 *
 *   { object: 'page', entry: [{ id, time, messaging: [{ sender, recipient,
 *     timestamp, message: { mid, text, … } }] }] }
 *
 * Hanya pesan teks (message.text) yang diproses; event non-teks (read,
 * delivery, attachment, echo) diabaikan. `parseMetaMessagingEvent` murni
 * (tanpa network/DB) — mudah diuji.
 */

export interface MetaMessagingEvent {
  sender: { id: string };
  recipient: { id: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
  };
}

export interface MetaWebhookPayload {
  object?: string;
  entry?: {
    id: string;
    time?: number;
    messaging?: MetaMessagingEvent[];
  }[];
}

/** Intent default pesan teks Meta — tidak ada tombol/callback di v1. */
const TEXT_INTENT: InboundIntent = 'text';

/**
 * Parse satu event messaging Meta → CanonicalInboundEvent, atau null bila
 * bukan pesan teks yang relevan (echo / tanpa text / tanpa sender).
 */
export function parseMetaMessagingEvent(
  channel: 'instagram' | 'facebook',
  event: MetaMessagingEvent,
  pageId: string,
): CanonicalInboundEvent | null {
  const message = event.message;
  if (!message || !message.text || typeof message.text !== 'string') return null;
  if (message.is_echo) return null; // pesan yang kita kirim sendiri
  const senderId = event.sender?.id;
  if (!senderId) return null;

  const content = message.text.trim();
  if (!content) return null;

  // Idempotency: mid unik per pesan; fallback kombinasi sender+timestamp
  // bila mid tidak ada (defensif).
  const providerEventId = message.mid ?? `${pageId}:${senderId}:${event.timestamp ?? Date.now()}`;

  return {
    channel,
    providerEventId,
    senderIdentifier: senderId,
    senderName: null,
    intent: TEXT_INTENT,
    bookingId: null,
    content,
    raw: { pageId, mid: message.mid ?? null, recipientId: event.recipient?.id ?? null },
    receivedAt: event.timestamp ? new Date(event.timestamp * 1000).toISOString() : new Date().toISOString(),
  };
}

/** Kumpulkan semua event messaging teks dari payload webhook Meta. */
export function extractMetaMessagingEvents(
  payload: MetaWebhookPayload,
): { channelType: 'instagram' | 'facebook'; pageId: string; event: MetaMessagingEvent }[] {
  const results: { channelType: 'instagram' | 'facebook'; pageId: string; event: MetaMessagingEvent }[] = [];
  if (payload.object !== 'page' || !Array.isArray(payload.entry)) return results;

  for (const entry of payload.entry) {
    if (!entry.id || !Array.isArray(entry.messaging)) continue;
    // Entry dari Instagram Messaging membawa flag `standby`/`messaging` yang
    // sama; channel ditentukan oleh page yang subscribe — di-resolve via
    // providerConfig di route webhook. Default: facebook.
    const channelType: 'instagram' | 'facebook' = 'facebook';
    for (const event of entry.messaging) {
      results.push({ channelType, pageId: entry.id, event });
    }
  }
  return results;
}
