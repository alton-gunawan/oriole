import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  canonicalPhone,
  normalizePhone,
  parseSlotTime,
  parseTelegramUpdate,
  renderAlreadyHandledReply,
  renderAskPhoneReply,
  renderBookingNotFoundReply,
  renderBookingReminder,
  renderCancelReply,
  renderConfirmReply,
  renderGenericReply,
  renderLinkedReply,
  renderNoBookingReply,
  renderNoFormReply,
  renderOptOutReply,
  renderRescheduleCancelled,
  renderRescheduleInvalid,
  renderReschedulePrompt,
  renderRescheduleSuccess,
  samePhone,
  type BotLanguage,
  type CanonicalInboundEvent,
  type TelegramUpdate,
} from '@oriole/messaging';
import {
  bookings as bookingsTable,
  conversations,
  customerChannels,
  messages,
  workspaceChannels,
  workspaces,
} from '@oriole/database';

import { db } from '../db/index.ts';
import { withBookingTitle } from './booking-title.ts';
import { env } from './env.ts';
import { formPublicUrl } from './form-links.ts';
import { encryptMessageContent } from './message-encryption.ts';
import { emitBookingCancelled, emitBookingCreated } from './reminders.ts';
import { findActiveFormIntegration } from './whatsapp-handler.ts';
import {
  telegramAnswerCallbackQuery,
  telegramEditMessageReplyMarkup,
  telegramSendMessage,
} from './telegram.ts';

const CHANNEL = 'telegram';

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
    .where(and(eq(workspaceChannels.workspaceId, workspaceId), eq(workspaceChannels.channelType, CHANNEL)))
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

  // Jalur kritis dipercepat: panggilan Telegram yang hanya efek samping
  // (ack callback + bersihkan tombol) dilepas dari antrian — dikirim
  // bersamaan dengan pemrosesan DB, tidak menunggunya. Ini menghemat
  // 2 round trip network Telegram dari waktu balasan (callback query).
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

  // Bahasa balasan = preferensi workspace (callGoalLanguage, default 'en').
  // Di-resolve paralel dengan lookup percakapan agar tidak menambah latensi.
  const [conversation, language] = await Promise.all([
    getOrCreateConversation(workspaceId, parsed),
    findWorkspaceLanguage(workspaceId),
  ]);
  await recordInboundMessage(workspaceId, conversation.id, parsed, String(update.update_id));

  // Intent + cek idempotensi balasan dijalankan PARALEL (keduanya tidak
  // saling bergantung — intent tidak menulis tabel messages) — hemat
  // 1 round trip DB dari jalur kritis.
  const [reply, alreadyReplied] = await Promise.all([
    applyInboundIntent(workspaceId, conversation, parsed, language),
    hasReplyForUpdate(conversation.id, String(update.update_id)),
  ]);

  if (reply?.text && !alreadyReplied) {
    const metadata = { replyToUpdateId: String(update.update_id) };
    // Catat 'queued' SEBELUM kirim agar retry Inngest tidak mengirim ulang.
    await recordOutboundMessage(workspaceId, conversation.id, reply.text, '', metadata, 'queued');

    const sent = await telegramSendMessage({
      token: channel.token,
      chatId: parsed.senderIdentifier,
      text: reply.text,
      buttons: reply.buttons,
      requestContact: reply.requestContact,
    });

    await db
      .update(messages)
      .set({ status: 'sent', providerMessageId: String(sent.messageId) })
      .where(
        and(
          eq(messages.conversationId, conversation.id),
          eq(messages.direction, 'outbound'),
          eq(messages.metadata, metadata),
        ),
      );
  }

  return { handled: true };
}

/** Apakah update_id ini sudah pernah dibalas (dedup retry Inngest)? */
async function hasReplyForUpdate(conversationId: string, updateId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.direction, 'outbound'),
        eq(messages.metadata, { replyToUpdateId: updateId }),
      ),
    )
    .limit(1);
  return Boolean(row);
}

interface ConversationRow {
  id: string;
  bookingId: string | null;
  state: Record<string, unknown> | null;
  status: string;
  customerName: string | null;
}

async function getOrCreateConversation(
  workspaceId: string,
  parsed: CanonicalInboundEvent,
): Promise<ConversationRow> {
  const [existing] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.workspaceId, workspaceId),
        eq(conversations.channelType, CHANNEL),
        eq(conversations.externalId, parsed.senderIdentifier),
      ),
    )
    .limit(1);
  if (existing) return existing;

  const bookingId = parsed.bookingId ?? (await resolveBookingByChat(workspaceId, parsed.senderIdentifier));
  const customerName = bookingId
    ? await bookingCustomerName(workspaceId, bookingId)
    : (parsed.senderName ?? null);
  const [created] = await db
    .insert(conversations)
    .values({
      workspaceId,
      bookingId,
      channelType: CHANNEL,
      externalId: parsed.senderIdentifier,
      customerName,
      status: 'active',
    })
    .returning();
  return created;
}

/** Cari booking terbaru untuk chat: via contactPhone yang sudah terhubung. */
async function resolveBookingByChat(workspaceId: string, chatId: string): Promise<string | null> {
  const [channel] = await db
    .select({ contactPhone: customerChannels.contactPhone })
    .from(customerChannels)
    .where(
      and(
        eq(customerChannels.workspaceId, workspaceId),
        eq(customerChannels.channelType, CHANNEL),
        eq(customerChannels.identifier, chatId),
        eq(customerChannels.isOptedIn, true),
      ),
    )
    .limit(1);
  if (!channel?.contactPhone) return null;

  const rows = await db
    .select({ id: bookingsTable.id, phone: bookingsTable.phone })
    .from(bookingsTable)
    .where(and(eq(bookingsTable.workspaceId, workspaceId), isNotNull(bookingsTable.phone)))
    .limit(200);
  const match = rows.find((row) => row.phone && samePhone(row.phone, channel.contactPhone));
  return match?.id ?? null;
}

async function recordInboundMessage(
  workspaceId: string,
  conversationId: string,
  parsed: CanonicalInboundEvent,
  providerMessageId: string,
): Promise<void> {
  // onConflictDoNothing: update_id sama (retry) tidak boleh double-record.
  // Hanya bump unread/lastMessageAt bila baris BENAR-BENAR baru (bukan retry).
  const [inserted] = await db
    .insert(messages)
    .values({
      conversationId,
      channelType: CHANNEL,
      direction: 'inbound',
      providerMessageId,
      content: encryptMessageContent(workspaceId, parsed.content),
      status: 'sent',
    })
    .onConflictDoNothing()
    .returning({ id: messages.id });

  if (inserted) {
    await db
      .update(conversations)
      .set({ unreadCount: sql`${conversations.unreadCount} + 1`, lastMessageAt: new Date(), updatedAt: new Date() })
      .where(eq(conversations.id, conversationId));
  }
}

async function recordOutboundMessage(
  workspaceId: string,
  conversationId: string,
  content: string,
  providerMessageId: string,
  metadata?: Record<string, unknown>,
  status: 'queued' | 'sent' | 'failed' = 'sent',
): Promise<void> {
  await db
    .insert(messages)
    .values({
      conversationId,
      channelType: CHANNEL,
      direction: 'outbound',
      providerMessageId,
      content: encryptMessageContent(workspaceId, content),
      status,
      metadata: metadata ?? null,
    })
    .onConflictDoNothing();

  await db
    .update(conversations)
    .set({ lastMessageAt: new Date(), updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));
}

interface Reply {
  text: string;
  buttons?: { id: string; label: string }[];
  /** Reply keyboard sekali pakai dengan tombol request_contact ("Bagikan Nomor"). */
  requestContact?: { label: string };
}

/**
 * State machine percakapan:
 * - intent tombol (confirm/cancel/reschedule) → aksi booking langsung.
 * - `awaiting-phone` → user mengirim nomor → link chat ke customer.
 * - `awaiting-time`  → user mengirim waktu baru → reschedule booking.
 * - `opt-out`        → matikan channel, tutup percakapan.
 */
async function applyInboundIntent(
  workspaceId: string,
  conversation: ConversationRow,
  parsed: CanonicalInboundEvent,
  language: BotLanguage,
): Promise<Reply | null> {
  const state = (conversation.state ?? {}) as { step?: string };

  // 1. Opt-out selalu menang.
  if (parsed.intent === 'opt-out') {
    // Dua update independen — jalan paralel (hemat 1 round trip DB).
    await Promise.all([
      db
        .update(customerChannels)
        .set({ isOptedIn: false, optedOutAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(customerChannels.workspaceId, workspaceId),
            eq(customerChannels.channelType, CHANNEL),
            eq(customerChannels.identifier, parsed.senderIdentifier),
          ),
        ),
      db
        .update(conversations)
        .set({ status: 'closed', state: null, updatedAt: new Date() })
        .where(eq(conversations.id, conversation.id)),
    ]);
    return { text: renderOptOutReply(language) };
  }

  // 2. Kontak (request_contact) — nomor VERIFIED dari Telegram. Selalu
  //    coba link (di luar state machine): berbagi kontak adalah tindakan
  //    eksplisit user, valid walau tidak sedang di alur awaiting-phone.
  if (parsed.intent === 'contact') {
    return handlePhoneLink(workspaceId, conversation, parsed, language);
  }

  // 3. State machine dulu: input yang sedang ditunggu menang atas fallback
  //    "belum terhubung" (user yang sudah di tengah alur tidak boleh
  //    dilempar balik ke minta-nomor oleh branch di bawah).
  if (state.step === 'awaiting-phone' && parsed.intent === 'text') {
    return handlePhoneLink(workspaceId, conversation, parsed, language);
  }
  if (state.step === 'awaiting-time' && parsed.intent === 'text') {
    return handleRescheduleTimeInput(workspaceId, conversation, parsed, language);
  }

  // 4. Intent tombol booking.
  if (parsed.bookingId) {
    return handleBookingAction(workspaceId, conversation, parsed, language);
  }

  // 5. Belum terhubung → minta nomor telepon.
  const linked = await isChatLinked(workspaceId, parsed.senderIdentifier);
  if (parsed.intent === 'text' && !linked) {
    await db
      .update(conversations)
      .set({ state: { step: 'awaiting-phone' }, status: 'waiting_input', updatedAt: new Date() })
      .where(eq(conversations.id, conversation.id));
    // Balasan membawa request_contact (tombol "Bagikan Nomor") — dipakai
    // telegramSendMessage untuk menampilkan reply keyboard sekali pakai.
    return renderAskPhoneReply(language);
  }

  // 7. Teks biasa dengan konteks booking → kirim ulang reminder.
  //    Tetap tandai needsAttention agar staf/AI (inbox) bisa menindaklanjuti
  //    permintaan yang tidak tercakup tombol.
  if (parsed.intent === 'text' && conversation.bookingId) {
    const booking = await findBooking(workspaceId, conversation.bookingId);
    if (booking && (booking.status === 'pending' || booking.status === 'confirmed')) {
      const businessName = await findBusinessName(workspaceId);
      await markNeedsAttention(conversation.id);
      return renderBookingReminder(
        {
          businessName: businessName ?? 'kami',
          customerName: booking.customerName,
          title: booking.title,
          scheduledAt: booking.scheduledAt.toISOString(),
          timezone: booking.timezone,
          videoLink: booking.videoLink,
        },
        booking.id,
        language,
      );
    }
  }

  // 8. Pesan bebas yang tidak bisa diproses bot → handoff ke staf/AI.
  //    Muncul sebagai badge "Perlu perhatian" di unified inbox.
  if (parsed.intent === 'text') {
    await markNeedsAttention(conversation.id);
  }

  return { text: renderGenericReply(language) };
}

/** Nama customer dari booking (denormalized ke conversations untuk inbox). */
async function bookingCustomerName(workspaceId: string, bookingId: string): Promise<string | null> {
  const [booking] = await db
    .select({ customerName: bookingsTable.customerName })
    .from(bookingsTable)
    .where(and(eq(bookingsTable.id, bookingId), eq(bookingsTable.workspaceId, workspaceId)))
    .limit(1);
  return booking?.customerName ?? null;
}

async function isChatLinked(workspaceId: string, chatId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: customerChannels.id })
    .from(customerChannels)
    .where(
      and(
        eq(customerChannels.workspaceId, workspaceId),
        eq(customerChannels.channelType, CHANNEL),
        eq(customerChannels.identifier, chatId),
        eq(customerChannels.isOptedIn, true),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * User mengirim nomor HP (ketikan ATAU kontak request_contact) → cocokkan
 * dengan booking aktif di workspace.
 *
 * Tiga hasil:
 * - Bukan nomor valid       → minta ulang (tombol request_contact tetap ada).
 * - Cocok dengan booking    → link chat + upsert customerChannel (opt-in).
 * - Nomor valid, TANPA
 *   booking aktif            → tandai needsAttention + arahkan ke form booking
 *                             (bila ada) — customer yang mau booking dari awal
 *                             tidak boleh terjebak di loop "nomor tidak cocok".
 */
async function handlePhoneLink(
  workspaceId: string,
  conversation: ConversationRow,
  parsed: CanonicalInboundEvent,
  language: BotLanguage,
): Promise<Reply> {
  const phone = normalizePhone(parsed.content);
  if (!phone) {
    // Bukan nomor (kurang dari 6 digit) — tampilkan ulang keyboard + contoh
    // format, jangan balas "tidak cocok" yang menyesatkan.
    return renderAskPhoneReply(language);
  }

  // Satu query untuk cek keberadaan + ambil nama customer — hanya izinkan
  // link ke nomor yang punya booking aktif (mencegah klaim nomor
  // lama/customer lain lalu mengontrol booking-nya).
  const booking = await findActiveBookingByPhone(workspaceId, phone);
  if (!booking) {
    // Nomor valid tapi belum ada booking aktif → arahkan ke booking baru
    // (form terintegrasi bila ada), bukan penolakan mentah. Staf tetap
    // melihat percakapan di inbox (needsAttention).
    await markNeedsAttention(conversation.id);
    const form = await findActiveFormIntegration(workspaceId);
    if (form) {
      return {
        text: renderNoBookingReply(formPublicUrl(form.integrationType, form.formId), language),
      };
    }
    return { text: renderNoFormReply(language) };
  }

  // Link chat + update percakapan independen — jalan paralel (hemat 1 round trip DB).
  await Promise.all([
    upsertCustomerChannel(workspaceId, parsed.senderIdentifier, phone),
    db
      .update(conversations)
      .set({
        status: 'active',
        state: null,
        customerName: booking.customerName,
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conversation.id)),
  ]);
  return { text: renderLinkedReply(language) };
}

/** User mengirim waktu baru (state awaiting-time) → update booking. */
async function handleRescheduleTimeInput(
  workspaceId: string,
  conversation: ConversationRow,
  parsed: CanonicalInboundEvent,
  language: BotLanguage,
): Promise<Reply> {
  if (/^batal$/i.test(parsed.content.trim())) {
    await db
      .update(conversations)
      .set({ status: 'active', state: null, updatedAt: new Date() })
      .where(eq(conversations.id, conversation.id));
    return { text: renderRescheduleCancelled(language) };
  }

  if (!conversation.bookingId) {
    await db
      .update(conversations)
      .set({ status: 'active', state: null, updatedAt: new Date() })
      .where(eq(conversations.id, conversation.id));
    return { text: renderBookingNotFoundReply(language) };
  }

  const booking = await findBooking(workspaceId, conversation.bookingId);
  if (!booking) return { text: renderBookingNotFoundReply(language) };

  const newTime = parseSlotTime(parsed.content, booking.timezone);
  if (!newTime) return { text: renderRescheduleInvalid(language) };

  // Permintaan ubah jadwal sudah dipenuhi → reset flag agar goal engine
  // tidak terus menyarankan reschedule-assistance.
  // Update booking + percakapan independen — jalan paralel (hemat 1 round trip DB).
  await Promise.all([
    db
      .update(bookingsTable)
      .set({ scheduledAt: newTime, changeRequested: false, updatedAt: new Date() })
      .where(eq(bookingsTable.id, booking.id)),
    db
      .update(conversations)
      .set({ status: 'active', state: null, updatedAt: new Date() })
      .where(eq(conversations.id, conversation.id)),
  ]);
  // Reminder terjadwal lama dibatalkan, yang baru dijadwalkan ulang.
  await emitBookingCancelled(workspaceId, booking.id);
  await emitBookingCreated({
    workspaceId,
    bookingId: booking.id,
    scheduledAt: newTime,
    timezone: booking.timezone,
  });
  return { text: renderRescheduleSuccess(newTime.toISOString(), booking.timezone, language) };
}

/** Intent dari tombol: confirm / cancel / reschedule. */
async function handleBookingAction(
  workspaceId: string,
  conversation: ConversationRow,
  parsed: CanonicalInboundEvent,
  language: BotLanguage,
): Promise<Reply> {
  const booking = await findBooking(workspaceId, parsed.bookingId!);
  if (!booking) return { text: renderBookingNotFoundReply(language) };

  if (parsed.intent === 'confirm') {
    if (booking.status === 'cancelled' || booking.status === 'completed' || booking.status === 'confirmed') {
      return { text: renderAlreadyHandledReply(language) };
    }
    await db
      .update(bookingsTable)
      .set({ status: 'confirmed', updatedAt: new Date() })
      .where(eq(bookingsTable.id, booking.id));
    // Backfill link chat → customer (phone dari booking) + update percakapan
    // independen — jalan paralel (hemat 1 round trip DB).
    const phone = normalizePhone(booking.phone);
    await Promise.all([
      phone ? upsertCustomerChannel(workspaceId, parsed.senderIdentifier, phone) : Promise.resolve(),
      db
        .update(conversations)
        .set({
          bookingId: booking.id,
          customerName: booking.customerName ?? conversation.customerName,
          status: 'active',
          state: null,
          updatedAt: new Date(),
        })
        .where(eq(conversations.id, conversation.id)),
    ]);
    return { text: renderConfirmReply(booking.scheduledAt.toISOString(), booking.timezone, language) };
  }

  if (parsed.intent === 'cancel') {
    if (booking.status === 'cancelled') return { text: renderAlreadyHandledReply(language) };
    // Update booking + percakapan independen — jalan paralel (hemat 1 round trip DB).
    await Promise.all([
      db
        .update(bookingsTable)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(eq(bookingsTable.id, booking.id)),
      db
        .update(conversations)
        .set({ status: 'active', state: null, updatedAt: new Date() })
        .where(eq(conversations.id, conversation.id)),
    ]);
    // Batalkan reminder terjadwal untuk booking ini.
    await emitBookingCancelled(workspaceId, booking.id);
    return { text: renderCancelReply(booking.title, language) };
  }

  if (parsed.intent === 'reschedule') {
    if (booking.status === 'cancelled' || booking.status === 'completed') {
      return { text: renderAlreadyHandledReply(language) };
    }
    await db
      .update(conversations)
      .set({
        bookingId: booking.id,
        customerName: booking.customerName ?? conversation.customerName,
        status: 'waiting_input',
        state: { step: 'awaiting-time' },
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conversation.id));
    return { text: renderReschedulePrompt(language) };
  }

  return { text: renderGenericReply(language) };
}

/* ────────────────────────────────────────────────────────────
 * Outbound — kirim reminder booking ke chat customer
 * ──────────────────────────────────────────────────────────── */

export async function dispatchTelegramReminder(input: {
  workspaceId: string;
  booking: {
    id: string;
    title: string;
    customerName: string | null;
    phone: string | null;
    scheduledAt: Date;
    timezone: string;
    videoLink: string | null;
  };
  businessName: string | null;
  /** Bahasa balasan — default mengikuti preferensi workspace (callGoalLanguage). */
  language?: BotLanguage;
}): Promise<{ messageId: number | null }> {
  const phone = normalizePhone(input.booking.phone);
  if (!phone) {
    throw new TelegramDispatchError('Booking belum memiliki nomor telepon customer.');
  }
  const language = input.language ?? (await findWorkspaceLanguage(input.workspaceId));

  const chat = await findChatByPhone(input.workspaceId, phone);
  if (!chat) {
    throw new TelegramDispatchError('Customer belum terhubung ke Telegram bot.');
  }

  const channel = await resolveTelegramChannel(input.workspaceId);
  if (!channel) {
    throw new TelegramDispatchError('Channel Telegram belum dikonfigurasi untuk workspace ini.');
  }
  if (!channel.isActive) {
    throw new TelegramDispatchError('Channel Telegram sedang dijeda (nonaktif).');
  }

  // Siapkan percakapan DULU agar dedup bisa dicek sebelum mengirim
  // (cegah duplikat saat Inngest me-retry step after send-without-response).
  const [existing] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.workspaceId, input.workspaceId),
        eq(conversations.channelType, CHANNEL),
        eq(conversations.externalId, chat.identifier),
      ),
    )
    .limit(1);

  let conversationId: string | undefined = existing?.id;
  if (conversationId) {
    await db
      .update(conversations)
      .set({
        bookingId: input.booking.id,
        customerName: input.booking.customerName,
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conversationId));
  } else {
    const [created] = await db
      .insert(conversations)
      .values({
        workspaceId: input.workspaceId,
        bookingId: input.booking.id,
        channelType: CHANNEL,
        externalId: chat.identifier,
        customerName: input.booking.customerName,
        status: 'active',
      })
      .returning({ id: conversations.id });
    if (created) conversationId = created.id;
  }

  if (!conversationId) return { messageId: null };

  // Dedup: reminder untuk booking yang sama sudah pernah dikirim ke chat ini.
  const reminderMetadata = { reminderBookingId: input.booking.id };
  const [alreadySent] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.direction, 'outbound'),
        eq(messages.metadata, reminderMetadata),
      ),
    )
    .limit(1);
  if (alreadySent) return { messageId: null };

  const rendered = renderBookingReminder(
    {
      businessName: input.businessName ?? 'kami',
      customerName: input.booking.customerName,
      title: input.booking.title,
      scheduledAt: input.booking.scheduledAt.toISOString(),
      timezone: input.booking.timezone,
      videoLink: input.booking.videoLink,
    },
    input.booking.id,
    language,
  );

  // Catat 'queued' SEBELUM kirim — retry Inngest tidak mengirim ulang.
  await recordOutboundMessage(input.workspaceId, conversationId, rendered.text, '', reminderMetadata, 'queued');

  const sent = await telegramSendMessage({
    token: channel.token,
    chatId: chat.identifier,
    text: rendered.text,
    buttons: rendered.buttons,
  });

  await db
    .update(messages)
    .set({ status: 'sent', providerMessageId: String(sent.messageId) })
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.direction, 'outbound'),
        eq(messages.metadata, reminderMetadata),
      ),
    );

  return { messageId: sent.messageId };
}

/* ────────────────────────────────────────────────────────────
 * Helpers DB
 * ──────────────────────────────────────────────────────────── */

/** Tandai percakapan butuh perhatian staf/AI (state.needsAttention). */
async function markNeedsAttention(conversationId: string): Promise<void> {
  const [row] = await db
    .select({ state: conversations.state })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  const state = { ...(row?.state ?? {}), needsAttention: true };
  await db
    .update(conversations)
    .set({ state, updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));
}

/** Booking aktif yang nomornya cocok (via nomor HP ternormalisasi). */
async function findActiveBookingByPhone(
  workspaceId: string,
  phone: string,
): Promise<{ customerName: string | null } | null> {
  const rows = await db
    .select({ phone: bookingsTable.phone, customerName: bookingsTable.customerName })
    .from(bookingsTable)
    .where(
      and(
        eq(bookingsTable.workspaceId, workspaceId),
        isNotNull(bookingsTable.phone),
        inArray(bookingsTable.status, ['pending', 'confirmed']),
      ),
    )
    .limit(200);
  const match = rows.find((row) => row.phone && samePhone(row.phone, phone));
  return match ? { customerName: match.customerName } : null;
}

/**
 * Cari chat_id dari contactPhone yang sudah terhubung & opted-in.
 * contactPhone baru tersimpan kanonik (kode negara, tanpa 0 depan) → query
 * pertama memakai index (workspaceId, contactPhone). Fallback scan (bounded)
 * menangani baris lama yang tersimpan format lokal (0xx) sebelum normalisasi
 * kanonik — dibandingkan via samePhone agar format berbeda tetap cocok.
 */
async function findChatByPhone(
  workspaceId: string,
  phone: string,
): Promise<{ identifier: string } | null> {
  const canonical = canonicalPhone(phone);
  if (canonical) {
    const [row] = await db
      .select({ identifier: customerChannels.identifier })
      .from(customerChannels)
      .where(
        and(
          eq(customerChannels.workspaceId, workspaceId),
          eq(customerChannels.channelType, CHANNEL),
          eq(customerChannels.isOptedIn, true),
          eq(customerChannels.contactPhone, canonical),
        ),
      )
      .limit(1);
    if (row) return { identifier: row.identifier };
  }

  const rows = await db
    .select({ identifier: customerChannels.identifier, contactPhone: customerChannels.contactPhone })
    .from(customerChannels)
    .where(
      and(
        eq(customerChannels.workspaceId, workspaceId),
        eq(customerChannels.channelType, CHANNEL),
        eq(customerChannels.isOptedIn, true),
      ),
    )
    .limit(200);
  const match = rows.find((row) => row.contactPhone && samePhone(row.contactPhone, phone));
  return match ? { identifier: match.identifier } : null;
}

async function upsertCustomerChannel(
  workspaceId: string,
  chatId: string,
  contactPhone: string,
): Promise<void> {
  // Simpan KANONIK (kode negara, tanpa 0 depan) agar pencocokan SQL by
  // contactPhone konsisten dengan format booking/kontak mana pun
  // (+62… / 62… / 0812…).
  const canonical = canonicalPhone(contactPhone) ?? contactPhone;
  await db
    .insert(customerChannels)
    .values({
      workspaceId,
      channelType: CHANNEL,
      identifier: chatId,
      contactPhone: canonical,
      source: CHANNEL,
    })
    .onConflictDoUpdate({
      target: [customerChannels.workspaceId, customerChannels.channelType, customerChannels.identifier],
      set: {
        contactPhone: canonical,
        isOptedIn: true,
        optedOutAt: null,
        updatedAt: new Date(),
      },
    });
}

async function findBooking(workspaceId: string, bookingId: string) {
  const [row] = await db
    .select()
    .from(bookingsTable)
    .where(and(eq(bookingsTable.id, bookingId), eq(bookingsTable.workspaceId, workspaceId)))
    .limit(1);
  // Title booking = nama layanan katalog (kolom title sudah dihapus).
  return row ? withBookingTitle(workspaceId, row) : null;
}

async function findBusinessName(workspaceId: string): Promise<string | null> {
  // Workspace soft-deleted → null (caller fallback ke "kami").
  const [workspace] = await db
    .select({ name: workspaces.name })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)))
    .limit(1);
  return workspace?.name ?? null;
}

/** Bahasa balasan bot — setting `chatLanguage` workspace (default 'en'). */
async function findWorkspaceLanguage(workspaceId: string): Promise<BotLanguage> {
  const [workspace] = await db
    .select({ chatLanguage: workspaces.chatLanguage })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return workspace?.chatLanguage === 'id' ? 'id' : 'en';
}
