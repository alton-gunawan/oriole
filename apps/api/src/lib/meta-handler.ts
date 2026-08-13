import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  parseMetaMessagingEvent,
  renderBookingReminder,
  renderGenericReply,
  type BotLanguage,
  type CanonicalInboundEvent,
  type MetaMessagingEvent,
} from '@oriole/messaging';
import { bookings, conversations, messages, workspaceChannels, workspaces } from '@oriole/database';

import { db } from '../db/index.ts';
import { withBookingTitle } from './booking-title.ts';
import { encryptMessageContent } from './message-encryption.ts';
import { metaSendTextMessage } from './meta.ts';

/* ────────────────────────────────────────────────────────────
 * Meta inbound — webhook Meta → percakapan → balasan/handoff.
 *
 * Versi ringkas dari handler Telegram/WhatsApp: Meta DMs (Messenger &
 * Instagram) v1 mendukung teks saja (tanpa tombol callback). Alur:
 *   - pesan teks dengan konteks booking → kirim ulang reminder booking
 *     (termasuk link video call bila ada)
 *   - pesan lain → tandai needsAttention (badge inbox untuk staf/AI)
 *     + balasan generik
 * ──────────────────────────────────────────────────────────── */

export interface MetaChannelConfig {
  accessToken: string;
  pageId: string;
  pageName?: string | null;
  /** Instagram business account id — wajib untuk channel instagram. */
  igBusinessId?: string | null;
  isActive: boolean;
}

/** Resolve kredensial channel Meta (instagram/facebook) untuk workspace. */
export async function resolveMetaChannel(
  workspaceId: string,
  channelType: 'instagram' | 'facebook',
): Promise<MetaChannelConfig | null> {
  const [channel] = await db
    .select()
    .from(workspaceChannels)
    .where(
      and(
        eq(workspaceChannels.workspaceId, workspaceId),
        eq(workspaceChannels.channelType, channelType),
      ),
    )
    .limit(1);
  if (!channel || !channel.isActive) return null;
  const config = channel.providerConfig as unknown as MetaChannelConfig;
  if (!config.accessToken || !config.pageId) return null;
  return { ...config, isActive: channel.isActive };
}

/** Proses satu pesan masuk Meta. Kembalikan false bila tidak diproses. */
export async function handleMetaMessagingEvent(input: {
  workspaceId: string;
  channelType: 'instagram' | 'facebook';
  pageId: string;
  event: MetaMessagingEvent;
}): Promise<{ handled: boolean; reason?: string }> {
  const { workspaceId, channelType, pageId } = input;
  const channel = await resolveMetaChannel(workspaceId, channelType);
  if (!channel) return { handled: false, reason: 'no-channel' };

  const parsed = parseMetaMessagingEvent(channelType, input.event, pageId);
  if (!parsed) return { handled: false, reason: 'no-text-event' };

  const [conversation, language] = await Promise.all([
    getOrCreateConversation(workspaceId, channelType, parsed),
    findWorkspaceLanguage(workspaceId),
  ]);
  await recordInboundMessage(workspaceId, conversation.id, parsed);

  const [reply, alreadyReplied] = await Promise.all([
    applyInboundIntent(workspaceId, conversation, language),
    hasReplyForEvent(conversation.id, parsed.providerEventId),
  ]);

  if (reply?.text && !alreadyReplied) {
    const metadata = { replyToMetaEventId: parsed.providerEventId };
    await recordOutboundMessage(workspaceId, conversation.id, channelType, reply.text, '', metadata, 'queued');

    const sent = await metaSendTextMessage({
      accessToken: channel.accessToken,
      pageId: channel.pageId,
      recipientId: parsed.senderIdentifier,
      text: reply.text,
    });

    await db
      .update(messages)
      .set({ status: 'sent', providerMessageId: sent.messageId })
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

async function hasReplyForEvent(conversationId: string, eventId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.direction, 'outbound'),
        eq(messages.metadata, { replyToMetaEventId: eventId }),
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
  channelType: 'instagram' | 'facebook',
  parsed: CanonicalInboundEvent,
): Promise<ConversationRow> {
  const [existing] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.workspaceId, workspaceId),
        eq(conversations.channelType, channelType),
        eq(conversations.externalId, parsed.senderIdentifier),
      ),
    )
    .limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(conversations)
    .values({
      workspaceId,
      bookingId: null,
      channelType,
      externalId: parsed.senderIdentifier,
      customerName: parsed.senderName ?? null,
      status: 'active',
    })
    .returning();
  return created;
}

async function recordInboundMessage(
  workspaceId: string,
  conversationId: string,
  parsed: CanonicalInboundEvent,
): Promise<void> {
  const [inserted] = await db
    .insert(messages)
    .values({
      conversationId,
      channelType: parsed.channel,
      direction: 'inbound',
      providerMessageId: parsed.providerEventId,
      content: encryptMessageContent(workspaceId, parsed.content),
      status: 'sent',
    })
    .onConflictDoNothing()
    .returning({ id: messages.id });

  if (inserted) {
    await db
      .update(conversations)
      .set({
        unreadCount: sql`${conversations.unreadCount} + 1`,
        lastMessageAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conversationId));
  }
}

async function recordOutboundMessage(
  workspaceId: string,
  conversationId: string,
  channelType: 'instagram' | 'facebook',
  content: string,
  providerMessageId: string,
  metadata?: Record<string, unknown>,
  status: 'queued' | 'sent' | 'failed' = 'sent',
): Promise<void> {
  await db
    .insert(messages)
    .values({
      conversationId,
      channelType,
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
}

async function applyInboundIntent(
  workspaceId: string,
  conversation: ConversationRow,
  language: BotLanguage,
): Promise<Reply | null> {
  // Konteks booking → kirim ulang reminder (termasuk link video bila ada).
  if (conversation.bookingId) {
    const booking = await findBooking(workspaceId, conversation.bookingId);
    if (booking && (booking.status === 'pending' || booking.status === 'confirmed')) {
      const businessName = await findBusinessName(workspaceId);
      await markNeedsAttention(conversation.id);
      return { text: renderBookingReminder(
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
      ).text };
    }
  }

  // Pesan bebas → handoff staf/AI (badge inbox) + balasan generik.
  await markNeedsAttention(conversation.id);
  return { text: renderGenericReply(language) };
}

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
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.workspaceId, workspaceId)))
    .limit(1);
  // Title booking = nama layanan katalog (kolom title sudah dihapus).
  return row ? withBookingTitle(workspaceId, row) : null;
}

async function findBusinessName(workspaceId: string): Promise<string | null> {
  const [workspace] = await db
    .select({ name: workspaces.name })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)))
    .limit(1);
  return workspace?.name ?? null;
}

async function findWorkspaceLanguage(workspaceId: string): Promise<BotLanguage> {
  const [workspace] = await db
    .select({ chatLanguage: workspaces.chatLanguage })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return workspace?.chatLanguage === 'id' ? 'id' : 'en';
}
