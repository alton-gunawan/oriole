import type { GoalType } from '@oriole/call-goals';

/**
 * Lapisan abstraksi multi-channel (Fase 0 — lihat docs/chat-integration.md).
 *
 * Prinsip: semua logic di package ini PURE & deterministik (sama seperti
 * @oriole/call-goals) — tanpa env, tanpa network, tanpa DB. Implementasi
 * adapter yang butuh env/network hidup di apps/api.
 */

export const CHANNEL_TYPES = ['whatsapp', 'telegram', 'sms', 'email', 'voice'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const MESSAGE_DIRECTIONS = ['inbound', 'outbound'] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

export const MESSAGE_STATUSES = ['queued', 'sent', 'delivered', 'failed'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/**
 * Intent hasil parsing pesan masuk — input state machine percakapan.
 * - `confirm` / `cancel` / `reschedule` : aksi booking via tombol (callback data).
 * - `reschedule-time`                  : jawaban waktu baru (state awaiting-time).
 * - `opt-out`                          : user meminta berhenti / memblokir bot.
 * - `text`                             : pesan bebas (belum ter-parse ke intent).
 */
export const INBOUND_INTENTS = [
  'confirm',
  'cancel',
  'reschedule',
  'reschedule-time',
  'opt-out',
  'text',
] as const;
export type InboundIntent = (typeof INBOUND_INTENTS)[number];

/** Pesan outbound terstruktur — diterjemahkan ke format channel oleh adapter. */
export interface OutboundMessage {
  channel: ChannelType;
  /** Booking terkait (untuk konteks & linking percakapan). */
  bookingId?: string | null;
  goalType?: GoalType | null;
  /** Identitas penerima per channel: chat_id (Telegram) / nomor (WhatsApp). */
  recipient: { identifier: string };
  text: string;
  /** Tombol interaktif — id dipakai sebagai callback data (mis. `bk:<id>:confirm`). */
  buttons?: { id: string; label: string }[];
  metadata?: Record<string, unknown>;
}

/**
 * Event masuk ter-normalisasi dari webhook provider mana pun.
 * Webhook mentah (WhatsApp nested, Telegram Update, SMS form-urlencoded)
 * di-parse adapter → bentuk tunggal ini sebelum masuk Inngest / DB.
 */
export interface CanonicalInboundEvent {
  channel: ChannelType;
  /** Id idempotency dari provider (update_id / wamid) — dedup di DB. */
  providerEventId: string;
  /** Identitas pengirim per channel (chat_id / nomor). */
  senderIdentifier: string;
  senderName?: string | null;
  intent: InboundIntent;
  /** bookingId bila dapat di-resolve (callback data / state percakapan). */
  bookingId?: string | null;
  content: string;
  /** Data mentah yang masih dibutuhkan handler (callback_query_id, message_id, ...). */
  raw?: Record<string, unknown>;
  receivedAt: string;
}

/** Kontrak adapter channel. Implementasi konkret di apps/api (butuh env/network). */
export interface ChannelAdapter {
  readonly channel: ChannelType;
  send(message: OutboundMessage): Promise<{ providerMessageId: string | null }>;
}

/** Normalisasi nomor telepon untuk pencocokan lintas tabel (digit saja). */
export function normalizePhone(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 6 ? digits : null;
}
