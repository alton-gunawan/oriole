import type { CanonicalInboundEvent, InboundIntent } from '../types.ts';
import { isOptOutText, parseCallbackData } from '../telegram/parse.ts';

/**
 * Parsing payload webhook WhatsApp (Meta Cloud API) → CanonicalInboundEvent[].
 *
 * 360dialog (BSP) meneruskan payload Meta dalam bentuk yang sama:
 *   { entry: [{ changes: [{ field: 'messages', value: { messages: [...] } }] }] }
 *
 * Format callback data tombol sama dengan Telegram (`bk:<bookingId>:<action>`)
 * agar handler channel bisa berbagi state machine. Teks `STOP`/`BERHENTI`
 * juga dikenali sebagai opt-out.
 */

export interface WhatsAppWebhookPayload {
  object?: string;
  entry?: {
    id?: string;
    changes?: {
      field?: string;
      value?: {
        messaging_product?: string;
        metadata?: { display_phone_number?: string; phone_number_id?: string };
        contacts?: { profile?: { name?: string }; wa_id?: string }[];
        messages?: {
          from?: string;
          id?: string;
          timestamp?: string;
          type?: string;
          text?: { body?: string };
          interactive?: { type?: string; button_reply?: { id?: string; title?: string } };
          button?: { text?: string; payload?: string };
        }[];
        /** Status pengiriman (sent/delivered/read) — diabaikan pada MVP. */
        statuses?: { id?: string; status?: string; timestamp?: string }[];
      };
    }[];
  }[];
}

function resolveIntent(
  type: string | undefined,
  body: string | undefined,
  buttonId: string | undefined,
): { intent: InboundIntent; bookingId: string | null } {
  if (type === 'interactive' || type === 'button') {
    const parsed = parseCallbackData(buttonId);
    if (parsed) {
      return {
        intent: parsed.action === 'stop' ? 'opt-out' : parsed.action,
        bookingId: parsed.action === 'stop' ? null : parsed.bookingId,
      };
    }
    return { intent: 'text', bookingId: null };
  }
  if (type === 'text' && isOptOutText(body)) {
    return { intent: 'opt-out', bookingId: null };
  }
  return { intent: 'text', bookingId: null };
}

/**
 * Parse payload webhook → daftar event kanonik (satu per pesan masuk).
 * Return [] bila payload bukan pesan (mis. verifikasi webhook / statuses).
 */
export function parseWhatsAppWebhook(payload: WhatsAppWebhookPayload): CanonicalInboundEvent[] {
  const events: CanonicalInboundEvent[] = [];
  const receivedAtFallback = new Date().toISOString();

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages') continue;
      const value = change.value;
      if (!value) continue;

      const senderName = value.contacts?.[0]?.profile?.name ?? null;
      const phoneNumberId = value.metadata?.phone_number_id;

      for (const msg of value.messages ?? []) {
        // `from` = wa_id (nomor customer); `id` = wamid (idempotency key).
        if (!msg.from || !msg.id) continue;
        // Lewati tipe non-teks (image/audio/location/dokumen/reaksi) —
        // tidak relevan untuk alur konfirmasi/reminder booking.
        if (msg.type && msg.type !== 'text' && msg.type !== 'interactive' && msg.type !== 'button') {
          continue;
        }

        const body = msg.type === 'text' ? msg.text?.body : undefined;
        const buttonId =
          msg.type === 'interactive'
            ? msg.interactive?.button_reply?.id
            : msg.type === 'button'
              ? msg.button?.payload
              : undefined;

        const { intent, bookingId } = resolveIntent(msg.type, body, buttonId);

        events.push({
          channel: 'whatsapp',
          providerEventId: msg.id,
          senderIdentifier: msg.from,
          senderName,
          intent,
          bookingId,
          content: buttonId ?? body ?? '',
          raw: {
            phoneNumberId,
            messageId: msg.id,
            timestamp: msg.timestamp,
            type: msg.type,
          },
          receivedAt: msg.timestamp
            ? new Date(Number(msg.timestamp) * 1000).toISOString()
            : receivedAtFallback,
        });
      }
    }
  }

  return events;
}
