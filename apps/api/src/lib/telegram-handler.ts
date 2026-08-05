import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import {
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
  renderOptOutReply,
  renderPhoneMismatchReply,
  renderRescheduleCancelled,
  renderRescheduleInvalid,
  renderReschedulePrompt,
  renderRescheduleSuccess,
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
import { env } from './env.ts';
import { emitBookingCancelled, emitBookingCreated } from './reminders.ts';
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

  const conversation = await getOrCreateConversation(workspaceId, parsed);
  await recordInboundMessage(conversation.id, parsed, String(update.update_id));

  const callbackQueryId = parsed.raw?.callbackQueryId as string | undefined;
  if (callbackQueryId) {
    await telegramAnswerCallbackQuery(channel.token, callbackQueryId).catch(() => undefined);
  }

  const reply = await applyInboundIntent(workspaceId, conversation, parsed);
  if (reply?.text) {
    // Idempotensi balasan: Inngest bisa me-retry langkah ini (at-least-once),
    // jadi lewati bila update yang sama sudah pernah dibalas.
    const [alreadyReplied] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversation.id),
          eq(messages.direction, 'outbound'),
          eq(messages.metadata, { replyToUpdateId: String(update.update_id) }),
        ),
      )
      .limit(1);

    if (!alreadyReplied) {
      const metadata = { replyToUpdateId: String(update.update_id) };
      // Catat 'queued' SEBELUM kirim agar retry Inngest tidak mengirim ulang.
      await recordOutboundMessage(conversation.id, reply.text, '', metadata, 'queued');

      const sent = await telegramSendMessage({
        token: channel.token,
        chatId: parsed.senderIdentifier,
        text: reply.text,
        buttons: reply.buttons,
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
  }

  // Bersihkan tombol callback yang sudah dipakai (cegah double-tap).
  const messageId = parsed.raw?.messageId as number | undefined;
  const chatId = parsed.raw?.chatId as number | undefined;
  if (callbackQueryId && messageId && chatId) {
    await telegramEditMessageReplyMarkup(channel.token, String(chatId), messageId).catch(
      () => undefined,
    );
  }

  return { handled: true };
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
  const match = rows.find((row) => normalizePhone(row.phone) === channel.contactPhone);
  return match?.id ?? null;
}

async function recordInboundMessage(
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
      content: parsed.content,
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
      content,
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
): Promise<Reply | null> {
  const state = (conversation.state ?? {}) as { step?: string };

  // 1. Opt-out selalu menang.
  if (parsed.intent === 'opt-out') {
    await db
      .update(customerChannels)
      .set({ isOptedIn: false, optedOutAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(customerChannels.workspaceId, workspaceId),
          eq(customerChannels.channelType, CHANNEL),
          eq(customerChannels.identifier, parsed.senderIdentifier),
        ),
      );
    await db
      .update(conversations)
      .set({ status: 'closed', state: null, updatedAt: new Date() })
      .where(eq(conversations.id, conversation.id));
    return { text: renderOptOutReply() };
  }

  // 2. Belum terhubung → minta nomor telepon.
  const linked = await isChatLinked(workspaceId, parsed.senderIdentifier);
  if (parsed.intent === 'text' && !linked) {
    await db
      .update(conversations)
      .set({ state: { step: 'awaiting-phone' }, status: 'waiting_input', updatedAt: new Date() })
      .where(eq(conversations.id, conversation.id));
    return { text: renderAskPhoneReply() };
  }

  // 3. Menunggu input nomor telepon.
  if (state.step === 'awaiting-phone' && parsed.intent === 'text') {
    return handlePhoneLink(workspaceId, conversation, parsed);
  }

  // 4. Menunggu input waktu baru (reschedule).
  if (state.step === 'awaiting-time' && parsed.intent === 'text') {
    return handleRescheduleTimeInput(workspaceId, conversation, parsed);
  }

  // 5. Intent tombol booking.
  if (parsed.bookingId) {
    return handleBookingAction(workspaceId, conversation, parsed);
  }

  // 6. Teks biasa dengan konteks booking → kirim ulang reminder.
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
        },
        booking.id,
      );
    }
  }

  // 7. Pesan bebas yang tidak bisa diproses bot → handoff ke staf/AI.
  //    Muncul sebagai badge "Perlu perhatian" di unified inbox.
  if (parsed.intent === 'text') {
    await markNeedsAttention(conversation.id);
  }

  return { text: renderGenericReply() };
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

/** User mengirim nomor HP → cocokkan dengan booking/contact di workspace. */
async function handlePhoneLink(
  workspaceId: string,
  conversation: ConversationRow,
  parsed: CanonicalInboundEvent,
): Promise<Reply> {
  const phone = normalizePhone(parsed.content);
  // Hanya izinkan link ke nomor yang punya booking aktif — mencegah
  // klaim nomor lama/customer lain lalu mengontrol booking-nya.
  if (!phone || !(await phoneExistsInWorkspace(workspaceId, phone))) {
    return { text: renderPhoneMismatchReply() };
  }

  await upsertCustomerChannel(workspaceId, parsed.senderIdentifier, phone);
  const customerName = await findCustomerNameByPhone(workspaceId, phone);
  await db
    .update(conversations)
    .set({ status: 'active', state: null, customerName, updatedAt: new Date() })
    .where(eq(conversations.id, conversation.id));
  return { text: renderLinkedReply() };
}

/** User mengirim waktu baru (state awaiting-time) → update booking. */
async function handleRescheduleTimeInput(
  workspaceId: string,
  conversation: ConversationRow,
  parsed: CanonicalInboundEvent,
): Promise<Reply> {
  if (/^batal$/i.test(parsed.content.trim())) {
    await db
      .update(conversations)
      .set({ status: 'active', state: null, updatedAt: new Date() })
      .where(eq(conversations.id, conversation.id));
    return { text: renderRescheduleCancelled() };
  }

  if (!conversation.bookingId) {
    await db
      .update(conversations)
      .set({ status: 'active', state: null, updatedAt: new Date() })
      .where(eq(conversations.id, conversation.id));
    return { text: renderBookingNotFoundReply() };
  }

  const booking = await findBooking(workspaceId, conversation.bookingId);
  if (!booking) return { text: renderBookingNotFoundReply() };

  const newTime = parseSlotTime(parsed.content, booking.timezone);
  if (!newTime) return { text: renderRescheduleInvalid() };

  // Permintaan ubah jadwal sudah dipenuhi → reset flag agar goal engine
  // tidak terus menyarankan reschedule-assistance.
  await db
    .update(bookingsTable)
    .set({ scheduledAt: newTime, changeRequested: false, updatedAt: new Date() })
    .where(eq(bookingsTable.id, booking.id));
  await db
    .update(conversations)
    .set({ status: 'active', state: null, updatedAt: new Date() })
    .where(eq(conversations.id, conversation.id));
  // Reminder terjadwal lama dibatalkan, yang baru dijadwalkan ulang.
  await emitBookingCancelled(workspaceId, booking.id);
  await emitBookingCreated({
    workspaceId,
    bookingId: booking.id,
    scheduledAt: newTime,
    timezone: booking.timezone,
  });
  return { text: renderRescheduleSuccess(newTime.toISOString(), booking.timezone) };
}

/** Intent dari tombol: confirm / cancel / reschedule. */
async function handleBookingAction(
  workspaceId: string,
  conversation: ConversationRow,
  parsed: CanonicalInboundEvent,
): Promise<Reply> {
  const booking = await findBooking(workspaceId, parsed.bookingId!);
  if (!booking) return { text: renderBookingNotFoundReply() };

  if (parsed.intent === 'confirm') {
    if (booking.status === 'cancelled' || booking.status === 'completed' || booking.status === 'confirmed') {
      return { text: renderAlreadyHandledReply() };
    }
    await db
      .update(bookingsTable)
      .set({ status: 'confirmed', updatedAt: new Date() })
      .where(eq(bookingsTable.id, booking.id));
    // Backfill link chat → customer (phone dari booking).
    const phone = normalizePhone(booking.phone);
    if (phone) await upsertCustomerChannel(workspaceId, parsed.senderIdentifier, phone);
    await db
      .update(conversations)
      .set({
        bookingId: booking.id,
        customerName: booking.customerName ?? conversation.customerName,
        status: 'active',
        state: null,
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conversation.id));
    return { text: renderConfirmReply(booking.scheduledAt.toISOString(), booking.timezone) };
  }

  if (parsed.intent === 'cancel') {
    if (booking.status === 'cancelled') return { text: renderAlreadyHandledReply() };
    await db
      .update(bookingsTable)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(eq(bookingsTable.id, booking.id));
    await db
      .update(conversations)
      .set({ status: 'active', state: null, updatedAt: new Date() })
      .where(eq(conversations.id, conversation.id));
    // Batalkan reminder terjadwal untuk booking ini.
    await emitBookingCancelled(workspaceId, booking.id);
    return { text: renderCancelReply(booking.title) };
  }

  if (parsed.intent === 'reschedule') {
    if (booking.status === 'cancelled' || booking.status === 'completed') {
      return { text: renderAlreadyHandledReply() };
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
    return { text: renderReschedulePrompt() };
  }

  return { text: renderGenericReply() };
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
  };
  businessName: string | null;
}): Promise<{ messageId: number | null }> {
  const phone = normalizePhone(input.booking.phone);
  if (!phone) {
    throw new TelegramDispatchError('Booking belum memiliki nomor telepon customer.');
  }

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
    },
    input.booking.id,
  );

  // Catat 'queued' SEBELUM kirim — retry Inngest tidak mengirim ulang.
  await recordOutboundMessage(conversationId, rendered.text, '', reminderMetadata, 'queued');

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

/** Nama customer dari booking aktif (via nomor HP) — backfill saat link. */
async function findCustomerNameByPhone(workspaceId: string, phone: string): Promise<string | null> {
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
    .limit(50);
  const match = rows.find((row) => row.phone && normalizePhone(row.phone) === phone);
  return match?.customerName ?? null;
}

/** Cari chat_id dari contactPhone yang sudah terhubung & opted-in. */
async function findChatByPhone(
  workspaceId: string,
  phone: string,
): Promise<{ identifier: string } | null> {
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
  const match = rows.find((row) => row.contactPhone === phone);
  return match ? { identifier: match.identifier } : null;
}

async function phoneExistsInWorkspace(workspaceId: string, phone: string): Promise<boolean> {
  const rows = await db
    .select({ phone: bookingsTable.phone })
    .from(bookingsTable)
    .where(
      and(
        eq(bookingsTable.workspaceId, workspaceId),
        isNotNull(bookingsTable.phone),
        inArray(bookingsTable.status, ['pending', 'confirmed']),
      ),
    )
    .limit(200);
  return rows.some((row) => normalizePhone(row.phone) === phone);
}

async function upsertCustomerChannel(
  workspaceId: string,
  chatId: string,
  contactPhone: string,
): Promise<void> {
  await db
    .insert(customerChannels)
    .values({
      workspaceId,
      channelType: CHANNEL,
      identifier: chatId,
      contactPhone,
      source: CHANNEL,
    })
    .onConflictDoUpdate({
      target: [customerChannels.workspaceId, customerChannels.channelType, customerChannels.identifier],
      set: {
        contactPhone,
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
  return row;
}

async function findBusinessName(workspaceId: string): Promise<string | null> {
  const [workspace] = await db
    .select({ name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return workspace?.name ?? null;
}
