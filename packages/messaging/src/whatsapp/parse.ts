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
 *
 * Keyword intent (BYO/WAHA): WhatsApp unofficial (WAHA) mengirim tekan tombol
 * interaktif sebagai pesan TEKS biasa dengan body = label tombol (tidak ada
 * callback-data ala Meta — spikes/waha/README.md §mapping). Label itu (mis.
 * '✅ Ya, hadir') maupun balasan bebas ('ya', 'batal', 'ubah jadwal') dipetakan
 * ke intent booking confirm/cancel/reschedule agar auto-reply BYO berfungsi
 * penuh. Event hasil mapping TIDAK membawa bookingId — handler me-resolve-nya
 * dari percakapan (auto-link by nomor).
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

/**
 * Keyword intent balasan teks bebas / tekan-tombol-as-text (BYO/WAHA) → intent
 * booking. Daftar ini diselaraskan dengan label tombol `renderBookingReminder`
 * (ID: '✅ Ya, hadir' / '📅 Ubah jadwal' / '❌ Batalkan'; EN: '✅ Yes, I will
 * attend' / '📅 Reschedule' / '❌ Cancel') dan instruksi bot ('ketik Batal' /
 * 'type *Cancel*' saat mengubah jadwal), plus varian natural user.
 */
const BOOKING_KEYWORD_INTENTS: { intent: InboundIntent; patterns: RegExp[] }[] = [
  {
    intent: 'confirm',
    patterns: [
      /^(ya|hadir|saya hadir|aku hadir|ya hadir)$/,
      /^(yes|attend|i will attend|yes i will attend|will attend)$/,
    ],
  },
  {
    intent: 'cancel',
    patterns: [
      /^(batal|batalkan|batalin|batal hadir|cancel|gak jadi|nggak jadi|tidak jadi)$/,
      /^(cancel|not attending|i will not attend)$/,
    ],
  },
  {
    intent: 'reschedule',
    patterns: [
      /^(ubah jadwal|ganti jadwal|pindah jadwal|reschedule|jadwal ulang)$/,
      /^(reschedule|change schedule|change appointment|move appointment|new time)$/,
    ],
  },
  // Minta booking baru → bot membalas tautan form terintegrasi (Google
  // Forms/Tally) — lihat handleBookingRequest di whatsapp-handler.
  {
    intent: 'booking-request',
    patterns: [
      /^(mau booking|minta booking|ingin booking|buat booking|booking dong|mau booking dong|booking yuk|booking)$/,
      /^(pesan jadwal|mau pesan|mau pesan jadwal|buat janji|mau janji|janji temu|ingin janji)$/,
      /^(book|make a booking|make booking|book an appointment|book appointment|schedule an appointment|make an appointment)$/,
    ],
  },
];

/**
 * Normalisasi teks keyword: lowercase, buang emoji (label tombol WAHA),
 * markdown, dan tanda baca; ratakan spasi. Pencocokan EXACT terhadap hasil
 * normalisasi — kalimat bebas ('saya tidak hadir') TIDAK ikut ter-parse.
 */
function normalizeKeywordText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\p{Extended_Pictographic}/gu, '') // emoji label tombol, mis. '✅'
    .replace(/[*_`~#]/g, '') // markdown (format `2026-08-15 14:00` dst.)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // tanda baca → spasi
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Cari intent booking dari teks keyword bebas (BYO/WAHA) — null bila teks
 * bukan keyword (dibiarkan sebagai intent `text` untuk handoff staf/AI).
 */
function matchBookingKeywordIntent(
  body: string | undefined,
): { intent: InboundIntent; bookingId: null } | null {
  if (!body) return null;
  const normalized = normalizeKeywordText(body);
  for (const rule of BOOKING_KEYWORD_INTENTS) {
    if (rule.patterns.some((pattern) => pattern.test(normalized))) {
      return { intent: rule.intent, bookingId: null };
    }
  }
  return null;
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
  if (type === 'text') {
    // Opt-out eksak dulu (STOP/BERHENTI) — bukan keyword booking.
    if (isOptOutText(body)) {
      return { intent: 'opt-out', bookingId: null };
    }
    const keyword = matchBookingKeywordIntent(body);
    if (keyword) return keyword;
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
