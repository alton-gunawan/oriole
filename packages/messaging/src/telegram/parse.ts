import type { CanonicalInboundEvent } from '../types.ts';

/**
 * Parsing Update Telegram → CanonicalInboundEvent (pure, tanpa network).
 *
 * Format callback data tombol: `bk:<bookingId>:<action>`
 * action ∈ confirm | cancel | reschedule | stop. Contoh:
 *   bk:550e8400-e29b-41d4-a716-446655440000:confirm
 */

export interface TelegramChat {
  id: number;
  first_name?: string;
  type?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    chat: TelegramChat;
    text?: string;
    /** Pesan kontak — dikirim saat user menekan tombol request_contact. */
    contact?: {
      phone_number?: string;
      first_name?: string;
      last_name?: string;
      user_id?: number;
    };
  };
  callback_query?: {
    id: string;
    message?: {
      message_id: number;
      chat: TelegramChat;
    };
    data?: string;
    from?: { first_name?: string };
  };
  my_chat_member?: {
    chat: TelegramChat;
    new_chat_member?: { status?: string };
  };
}

export const TELEGRAM_CALLBACK_ACTIONS = ['confirm', 'cancel', 'reschedule', 'stop'] as const;
export type TelegramCallbackAction = (typeof TELEGRAM_CALLBACK_ACTIONS)[number];

/** Bangun id callback data tombol untuk sebuah booking + aksi. */
export function buildCallbackData(bookingId: string, action: TelegramCallbackAction): string {
  return `bk:${bookingId}:${action}`;
}

/** Parse callback data `bk:<uuid>:<action>` → { bookingId, action } atau null. */
export function parseCallbackData(data: string | undefined): {
  bookingId: string;
  action: TelegramCallbackAction;
} | null {
  if (!data) return null;
  const match = /^bk:([0-9a-fA-F-]{36}):(confirm|cancel|reschedule|stop)$/.exec(data);
  if (!match) return null;
  return { bookingId: match[1], action: match[2] as TelegramCallbackAction };
}

/** Pesan teks yang dianggap permintaan berhenti (case-insensitive, bahasa EN/ID). */
export function isOptOutText(text: string | undefined): boolean {
  if (!text) return false;
  const normalized = text.trim().toUpperCase();
  return normalized === 'STOP' || normalized === 'STOP ALL' || normalized === 'BERHENTI';
}

/**
 * Parse satu Update Telegram.
 * Return null untuk update yang tidak mengandung event yang relevan
 * (mis. group chat, edited message, non-kick my_chat_member).
 */
export function parseTelegramUpdate(update: TelegramUpdate): CanonicalInboundEvent | null {
  const eventId = String(update.update_id);
  const receivedAt = new Date().toISOString();

  // 1. Callback query (tombol inline)
  const callback = update.callback_query;
  if (callback) {
    const chat = callback.message?.chat;
    if (!chat || chat.type === 'group' || chat.type === 'supergroup') return null;
    const parsed = parseCallbackData(callback.data);
    if (parsed) {
      return {
        channel: 'telegram',
        providerEventId: eventId,
        senderIdentifier: String(chat.id),
        senderName: callback.from?.first_name ?? null,
        intent: parsed.action === 'stop' ? 'opt-out' : parsed.action,
        bookingId: parsed.action === 'stop' ? null : parsed.bookingId,
        content: callback.data ?? '',
        raw: {
          callbackQueryId: callback.id,
          messageId: callback.message?.message_id,
          chatId: chat.id,
        },
        receivedAt,
      };
    }
    // Callback query tanpa data yang dikenal → anggap teks biasa.
    return {
      channel: 'telegram',
      providerEventId: eventId,
      senderIdentifier: String(chat.id),
      senderName: callback.from?.first_name ?? null,
      intent: 'text',
      bookingId: null,
      content: callback.data ?? '',
      raw: { callbackQueryId: callback.id, messageId: callback.message?.message_id, chatId: chat.id },
      receivedAt,
    };
  }

  // 2. Pesan teks biasa
  const message = update.message;
  if (message) {
    if (message.chat.type === 'group' || message.chat.type === 'supergroup') return null;
    const text = message.text;
    if (isOptOutText(text)) {
      return {
        channel: 'telegram',
        providerEventId: eventId,
        senderIdentifier: String(message.chat.id),
        senderName: message.chat.first_name ?? null,
        intent: 'opt-out',
        bookingId: null,
        content: text ?? '',
        raw: { chatId: message.chat.id, messageId: message.message_id },
        receivedAt,
      };
    }

    // 2b. Kontak (tombol request_contact) — nomor VERIFIED dari Telegram,
    //     dipakai alur linking chat → booking tanpa ketikan manual.
    //     Kontak tanpa nomor (tidak mungkin dari request_contact, tapi bisa
    //     dari pesan biasa) → bukan event relevan.
    if (message.contact && !message.contact.phone_number) return null;
    if (message.contact?.phone_number) {
      const contactName = [message.contact.first_name, message.contact.last_name]
        .filter(Boolean)
        .join(' ');
      return {
        channel: 'telegram',
        providerEventId: eventId,
        senderIdentifier: String(message.chat.id),
        senderName: contactName || message.chat.first_name || null,
        intent: 'contact',
        bookingId: null,
        content: message.contact.phone_number,
        raw: { chatId: message.chat.id, messageId: message.message_id },
        receivedAt,
      };
    }

    return {
      channel: 'telegram',
      providerEventId: eventId,
      senderIdentifier: String(message.chat.id),
      senderName: message.chat.first_name ?? null,
      intent: 'text',
      bookingId: null,
      content: text ?? '',
      raw: { chatId: message.chat.id, messageId: message.message_id },
      receivedAt,
    };
  }

  // 3. User memblokir bot → tanda opt-out otomatis
  const member = update.my_chat_member;
  if (member) {
    const status = member.new_chat_member?.status;
    if (status === 'kicked' || status === 'left') {
      return {
        channel: 'telegram',
        providerEventId: eventId,
        senderIdentifier: String(member.chat.id),
        senderName: null,
        intent: 'opt-out',
        bookingId: null,
        content: `blocked:${status}`,
        raw: { chatId: member.chat.id },
        receivedAt,
      };
    }
  }

  return null;
}
