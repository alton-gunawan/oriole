import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  normalizePhone,
  parseSlotTime,
  parseWhatsAppWebhook,
  renderAlreadyHandledReply,
  renderBookingNotFoundReply,
  renderBookingReminder,
  renderCancelReply,
  renderConfirmReply,
  renderGenericReply,
  renderOptOutReply,
  renderRescheduleCancelled,
  renderRescheduleInvalid,
  renderReschedulePrompt,
  renderRescheduleSuccess,
  type CanonicalInboundEvent,
  type WhatsAppWebhookPayload,
} from '@oriole/messaging';
import {
  bookings as bookingsTable,
  conversations,
  customerChannels,
  messages,
  workspaces,
} from '@oriole/database';

import { db } from '../db/index.ts';
import { env } from './env.ts';
import { emitBookingCancelled, emitBookingCreated } from './reminders.ts';
import {
  resolveWhatsAppChannel,
  whatsappSendInteractive,
  whatsappSendTemplate,
  whatsappSendText,
} from '../services/whatsapp.ts';

const CHANNEL = 'whatsapp';

/** Error bisnis dengan pesan siap-tampil (dipetakan route → 400). */
export class WhatsAppDispatchError extends Error {}

/**
 * Proses satu payload webhook WhatsApp (Meta/360dialog).
 * Berbeda dari Telegram: `wa_id` = nomor HP customer, jadi identitas
 * langsung diketahui — chat auto-terhubung ke booking via nomor.
 */
export async function handleWhatsAppUpdate(
  workspaceId: string,
  payload: WhatsAppWebhookPayload,
): Promise<{ handled: boolean; events: number }> {
  const events = parseWhatsAppWebhook(payload);
  if (events.length === 0) return { handled: false, events: 0 };

  const channel = await resolveWhatsAppChannel(workspaceId);
  if (!channel) return { handled: false, events: events.length };

  for (const event of events) {
    const conversation = await getOrCreateConversation(workspaceId, event);
    await recordInboundMessage(conversation.id, event);

    const reply = await applyInboundIntent(workspaceId, conversation, event);
    if (reply?.text) {
      // Idempotensi balasan: skip bila wamid yang sama sudah pernah dibalas.
      const [alreadyReplied] = await db
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversation.id),
            eq(messages.direction, 'outbound'),
            eq(messages.metadata, { replyToWamid: event.providerEventId }),
          ),
        )
        .limit(1);

      if (!alreadyReplied) {
        const metadata = { replyToWamid: event.providerEventId };
        // Catat 'queued' SEBELUM kirim agar retry Inngest tidak mengirim ulang
        // (dedup membaca baris ini meski send belum selesai).
        await recordOutboundMessage(conversation.id, reply.text, '', metadata, 'queued');

        const sent = reply.buttons?.length
          ? await whatsappSendInteractive({
              token: channel.apiKey,
              to: event.senderIdentifier,
              text: reply.text,
              buttons: reply.buttons,
            })
          : await whatsappSendText({
              token: channel.apiKey,
              to: event.senderIdentifier,
              text: reply.text,
            });

        await db
          .update(messages)
          .set({ status: 'sent', providerMessageId: sent.messageId ?? event.providerEventId })
          .where(
            and(
              eq(messages.conversationId, conversation.id),
              eq(messages.direction, 'outbound'),
              eq(messages.metadata, metadata),
            ),
          );
      }
    }
  }

  return { handled: true, events: events.length };
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
  event: CanonicalInboundEvent,
): Promise<ConversationRow> {
  const [existing] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.workspaceId, workspaceId),
        eq(conversations.channelType, CHANNEL),
        eq(conversations.externalId, event.senderIdentifier),
      ),
    )
    .limit(1);
  if (existing) return existing;

  const bookingId = event.bookingId ?? (await resolveBookingByPhone(workspaceId, event.senderIdentifier));
  const customerName = bookingId
    ? await bookingCustomerName(workspaceId, bookingId)
    : (event.senderName ?? null);
  const [created] = await db
    .insert(conversations)
    .values({
      workspaceId,
      bookingId,
      channelType: CHANNEL,
      externalId: event.senderIdentifier,
      customerName,
      status: 'active',
    })
    .returning();
  return created;
}

/** Cari booking aktif terbaru untuk nomor (wa_id) ini. */
async function resolveBookingByPhone(workspaceId: string, waId: string): Promise<string | null> {
  const phone = normalizePhone(waId);
  if (!phone) return null;
  const rows = await db
    .select({ id: bookingsTable.id, phone: bookingsTable.phone })
    .from(bookingsTable)
    .where(
      and(
        eq(bookingsTable.workspaceId, workspaceId),
        isNotNull(bookingsTable.phone),
        inArray(bookingsTable.status, ['pending', 'confirmed']),
      ),
    )
    .limit(200);
  return rows.find((row) => normalizePhone(row.phone) === phone)?.id ?? null;
}

async function recordInboundMessage(
  conversationId: string,
  event: CanonicalInboundEvent,
): Promise<void> {
  // Hanya bump unread/lastMessageAt bila baris BENAR-BENAR baru (bukan retry).
  const [inserted] = await db
    .insert(messages)
    .values({
      conversationId,
      channelType: CHANNEL,
      direction: 'inbound',
      providerMessageId: event.providerEventId,
      content: event.content,
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
 * State machine — sama dengan Telegram:
 * opt-out > tombol booking (confirm/cancel/reschedule) > text (awaiting-time).
 * Tidak ada alur "ketik nomor": identitas sudah diketahui dari wa_id.
 */
async function applyInboundIntent(
  workspaceId: string,
  conversation: ConversationRow,
  event: CanonicalInboundEvent,
): Promise<Reply | null> {
  const state = (conversation.state ?? {}) as { step?: string };

  if (event.intent === 'opt-out') {
    await db
      .update(customerChannels)
      .set({ isOptedIn: false, optedOutAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(customerChannels.workspaceId, workspaceId),
          eq(customerChannels.channelType, CHANNEL),
          eq(customerChannels.identifier, event.senderIdentifier),
        ),
      );
    await db
      .update(conversations)
      .set({ status: 'closed', state: null, updatedAt: new Date() })
      .where(eq(conversations.id, conversation.id));
    return { text: renderOptOutReply() };
  }

  // Auto-link: nomor WhatsApp = identitas customer. HORMATI opt-out yang
  // sudah ada — user yang pernah STOP tidak boleh di-re-opt-in hanya karena
  // mengirim pesan apa pun (baru link pertama / status opt-in tetap).
  const phone = normalizePhone(event.senderIdentifier);
  if (phone) {
    const [existing] = await db
      .select({ id: customerChannels.id, isOptedIn: customerChannels.isOptedIn })
      .from(customerChannels)
      .where(
        and(
          eq(customerChannels.workspaceId, workspaceId),
          eq(customerChannels.channelType, CHANNEL),
          eq(customerChannels.identifier, event.senderIdentifier),
        ),
      )
      .limit(1);

    if (!existing) {
      await db
        .insert(customerChannels)
        .values({
          workspaceId,
          channelType: CHANNEL,
          identifier: event.senderIdentifier,
          contactPhone: phone,
          source: CHANNEL,
        })
        .onConflictDoNothing();
    } else if (existing.isOptedIn) {
      await db
        .update(customerChannels)
        .set({ contactPhone: phone, updatedAt: new Date() })
        .where(eq(customerChannels.id, existing.id));
    }
    // else: sudah opt-out — biarkan, jangan re-enable.
  }

  if (state.step === 'awaiting-time' && event.intent === 'text') {
    return handleRescheduleTimeInput(workspaceId, conversation, event);
  }

  if (event.bookingId) {
    return handleBookingAction(workspaceId, conversation, event);
  }

  // Teks bebas: kirim ulang reminder booking aktif (kalau ada) + tandai
  // needsAttention agar permintaan yang tidak tercakup tombol terlihat staf/AI.
  if (event.intent === 'text' && conversation.bookingId) {
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

  // Pesan bebas yang tidak bisa diproses bot → handoff ke staf/AI.
  if (event.intent === 'text') {
    await markNeedsAttention(conversation.id);
  }

  return { text: renderGenericReply() };
}

async function handleRescheduleTimeInput(
  workspaceId: string,
  conversation: ConversationRow,
  event: CanonicalInboundEvent,
): Promise<Reply> {
  if (/^batal$/i.test(event.content.trim())) {
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

  const newTime = parseSlotTime(event.content, booking.timezone);
  if (!newTime) return { text: renderRescheduleInvalid() };

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

async function handleBookingAction(
  workspaceId: string,
  conversation: ConversationRow,
  event: CanonicalInboundEvent,
): Promise<Reply> {
  const booking = await findBooking(workspaceId, event.bookingId!);
  if (!booking) return { text: renderBookingNotFoundReply() };

  if (event.intent === 'confirm') {
    if (booking.status === 'cancelled' || booking.status === 'completed' || booking.status === 'confirmed') {
      return { text: renderAlreadyHandledReply() };
    }
    await db
      .update(bookingsTable)
      .set({ status: 'confirmed', updatedAt: new Date() })
      .where(eq(bookingsTable.id, booking.id));
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

  if (event.intent === 'cancel') {
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

  if (event.intent === 'reschedule') {
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
 * Outbound — reminder via Message Template (wajib di luar 24h window)
 * ──────────────────────────────────────────────────────────── */

export async function dispatchWhatsAppReminder(input: {
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
  templateName?: string;
}): Promise<void> {
  const phone = normalizePhone(input.booking.phone);
  if (!phone) {
    throw new WhatsAppDispatchError('Booking belum memiliki nomor telepon customer.');
  }

  // Cari chat WhatsApp customer: identifier = wa_id = nomor HP.
  const [chat] = await db
    .select({ identifier: customerChannels.identifier })
    .from(customerChannels)
    .where(
      and(
        eq(customerChannels.workspaceId, input.workspaceId),
        eq(customerChannels.channelType, CHANNEL),
        eq(customerChannels.contactPhone, phone),
        eq(customerChannels.isOptedIn, true),
      ),
    )
    .limit(1);
  if (!chat) {
    throw new WhatsAppDispatchError('Customer belum terhubung ke WhatsApp (belum pernah membalas).');
  }

  const channel = await resolveWhatsAppChannel(input.workspaceId);
  if (!channel) {
    throw new WhatsAppDispatchError('Channel WhatsApp belum dikonfigurasi untuk workspace ini.');
  }
  if (!channel.isActive) {
    throw new WhatsAppDispatchError('Channel WhatsApp sedang dijeda (nonaktif).');
  }

  // Siapkan percakapan DULU agar dedup bisa dicek sebelum kirim template
  // (cegah duplikat saat retry Inngest setelah send-without-response).
  const [existing] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.workspaceId, input.workspaceId),
        eq(conversations.channelType, CHANNEL),
        eq(conversations.externalId, chat.identifier),
      ),
    )
    .limit(1);

  let conversationId = existing?.id;
  if (!conversationId) {
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
    conversationId = created?.id;
  } else {
    await db
      .update(conversations)
      .set({
        bookingId: input.booking.id,
        customerName: input.booking.customerName,
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conversationId));
  }

  if (!conversationId) return;

  // Dedup: template reminder untuk booking ini sudah pernah dikirim.
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
  if (alreadySent) return;

  const templateName =
    input.templateName ?? env.WHATSAPP_TEMPLATE_REMINDER ?? 'booking_reminder';

  // Template harus punya body dengan params posisional:
  // {{1}} nama customer, {{2}} judul, {{3}} waktu terformat.
  const when = new Intl.DateTimeFormat('id-ID', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: input.booking.timezone,
  }).format(input.booking.scheduledAt);

  const sent = await whatsappSendTemplate({
    token: channel.apiKey,
    to: chat.identifier,
    templateName,
    language: 'id',
    components: [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: input.booking.customerName ?? 'Anda' },
          { type: 'text', text: input.booking.title },
          { type: 'text', text: when },
        ],
      },
    ],
  });

  // Catat template terkirim ke percakapan (unified inbox) + dedup.
  await db
    .insert(messages)
    .values({
      conversationId,
      channelType: CHANNEL,
      direction: 'outbound',
      providerMessageId: sent.messageId ?? '',
      content: `[template:${templateName}] reminder dikirim`,
      status: 'sent',
      metadata: reminderMetadata,
    })
    .onConflictDoNothing();
  await db
    .update(conversations)
    .set({ lastMessageAt: new Date(), updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));
}

/* ────────────────────────────────────────────────────────────
 * Helpers DB
 * ──────────────────────────────────────────────────────────── */

/** Nama customer dari booking (denormalized ke conversations untuk inbox). */
async function bookingCustomerName(workspaceId: string, bookingId: string): Promise<string | null> {
  const [booking] = await db
    .select({ customerName: bookingsTable.customerName })
    .from(bookingsTable)
    .where(and(eq(bookingsTable.id, bookingId), eq(bookingsTable.workspaceId, workspaceId)))
    .limit(1);
  return booking?.customerName ?? null;
}

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
