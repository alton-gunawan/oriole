import type { WhatsAppWebhookPayload } from '@oriole/messaging';

/**
 * Adapter inbound WAHA → tipe Oriole (port TS dari
 * spikes/waha/scripts/lib/map-waha-to-meta.mjs — format persis mengikuti
 * spikes/waha/README.md).
 *
 * Desain: produksi bentuk Meta (mapWahaEventToMeta) lalu reuse pipeline yang
 * sudah ada — parseWhatsAppWebhook (deteksi intent, STOP → opt-out),
 * idempotency webhook_events, dan event Inngest whatsapp/message.received
 * yang memanggil handleWhatsAppUpdate.
 * (Varian adapter langsung ke CanonicalInboundEvent tetap ada di spike:
 * spikes/waha/scripts/lib/map-waha-to-meta.mjs.)
 *
 * Gap yang diketahui (lihat spike README):
 *  - Event WAHA TIDAK membawa nama kontak → senderName selalu null
 *    (resolve via GET /api/{session}/contacts/{id} jika dibutuhkan).
 *  - Balasan tombol interaktif tiba sebagai pesan biasa dengan body = label
 *    tombol (tidak ada callback-data ala Meta) — parseWhatsAppWebhook
 *    memetakan keyword label ('ya hadir' / 'batal' / 'ubah jadwal' dll) ke
 *    intent confirm/cancel/reschedule; booking di-resolve handler dari
 *    percakapan (auto-link by nomor).
 *  - Pesan media dilewati (parser app juga mengabaikan non-teks).
 */

/** Envelope webhook WAHA — semua event berbagi bentuk ini. */
export interface WahaWebhookEvent {
  id?: string;
  timestamp?: number;
  event?: string;
  session?: string;
  metadata?: Record<string, unknown>;
  me?: { id?: string; pushName?: string } | null;
  payload?: WahaMessagePayload | Record<string, unknown>;
  environment?: Record<string, unknown>;
  engine?: string;
}

/** Bentuk payload event `message` / `message.any` WAHA. */
export interface WahaMessagePayload {
  id?: string;
  timestamp?: number;
  from?: string;
  fromMe?: boolean;
  to?: string;
  body?: string;
  hasMedia?: boolean;
  ack?: number;
  source?: string;
}

/** chatId ("6281234567890@c.us") → wa_id ("6281234567890"). */
export function chatIdToWaId(chatId: string | undefined | null): string | null {
  if (typeof chatId !== 'string' || chatId.length === 0) return null;
  return chatId
    .replace(/@c\.us$/, '')
    .replace(/@s\.whatsapp\.net$/, '')
    .replace(/@lid$/, '');
}

/**
 * WAHA event `message`/`message.any` → WhatsAppWebhookPayload (bentuk Meta
 * yang diterima parseWhatsAppWebhook), atau null bila event harus dilewati
 * (non-message, echo outbound fromMe, media, tanpa id/from).
 */
export function mapWahaEventToMeta(event: WahaWebhookEvent): WhatsAppWebhookPayload | null {
  if (!event || typeof event !== 'object') return null;
  if (event.event !== 'message' && event.event !== 'message.any') return null;

  const p = (event.payload ?? {}) as WahaMessagePayload;
  if (!p || typeof p !== 'object') return null;
  if (p.fromMe) return null; // echo outbound — lewati
  if (p.hasMedia) return null; // non-teks — parser app mengabaikannya

  const waId = chatIdToWaId(p.from);
  if (!waId || !p.id) return null;

  // WAHA me.id = wa_id akun — dipakai sebagai stand-in metadata
  // (display_phone_number / phone_number_id); parser app membaca tapi tidak
  // pernah mencocokkan nilainya, jadi perbedaan semantik tidak berdampak.
  const meId = chatIdToWaId(event.me?.id);
  const timestamp = Number.isFinite(Number(p.timestamp))
    ? String(p.timestamp)
    : String(Math.floor(Date.now() / 1000));

  const value: NonNullable<
    NonNullable<NonNullable<NonNullable<WhatsAppWebhookPayload['entry']>[number]['changes']>[number]['value']>
  > = {
    messaging_product: 'whatsapp',
    messages: [
      {
        from: waId,
        id: p.id, // id WAHA ("false_{chatId}_{messageId}") = kunci idempotency
        timestamp,
        type: 'text',
        text: { body: p.body ?? '' },
      },
    ],
  };
  if (meId) {
    value.metadata = { display_phone_number: meId, phone_number_id: meId };
  }

  return {
    object: 'whatsapp_business_account',
    entry: [{ id: event.session ?? 'default', changes: [{ field: 'messages', value }] }],
  };
}

