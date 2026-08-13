import { and, desc, eq, inArray, isNotNull, lt, or, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { brand } from '@oriole/config';
import { bookings as bookingsTable, conversations, customerChannels, messages } from '@oriole/database';

import { db } from '../db/index.ts';
import { DEFAULT_BOOKING_TITLE, loadServiceNames } from '../lib/booking-title.ts';
import { decryptMessageContent, encryptMessageContent } from '../lib/message-encryption.ts';
import { resend } from '../services/email.ts';
import { TelegramApiError, telegramSendMessage } from '../lib/telegram.ts';
import { resolveTelegramChannel } from '../lib/telegram-handler.ts';
import { resolveWhatsAppChannel, sendWhatsAppMessage, WhatsAppApiError } from '../services/whatsapp.ts';
import { requireAuth } from '../middleware/auth.ts';
import { requireWorkspace, type WorkspaceVariables } from '../middleware/workspace.ts';

/**
 * Unified inbox — percakapan customer lintas channel (Telegram, WhatsApp,
 * email) dalam satu tempat. Staff membaca, menandai dibaca, dan membalas
 * lewat channel aslinya (sendMessage / interactive / Resend).
 */

const conversationIdParamSchema = z.object({ id: z.string().uuid() });

const listQuerySchema = z.object({
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

const cursorPayloadSchema = z.object({
  at: z.iso.datetime({ offset: true }),
  id: z.string().uuid(),
});

function decodeCursor(cursor: string | undefined): { at: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed = cursorPayloadSchema.safeParse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
    );
    if (!parsed.success) return null;
    return { at: new Date(parsed.data.at), id: parsed.data.id };
  } catch {
    return null;
  }
}

const replySchema = z.object({
  text: z.string().trim().min(1, 'Pesan tidak boleh kosong').max(4000),
  buttons: z
    .array(z.object({ id: z.string().min(1).max(64), label: z.string().min(1).max(20) }))
    .max(3)
    .optional(),
});

async function findConversation(workspaceId: string, conversationId: string) {
  const [row] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  return row;
}

export const inboxRoutes = new Hono<{ Variables: WorkspaceVariables }>()
  /* ── Daftar percakapan (unread + preview + pagination keyset) ── */
  .get('/', requireAuth, requireWorkspace, zValidator('query', listQuerySchema), async (c) => {
    const workspaceId = c.get('workspaceId');
    const { limit, cursor: rawCursor } = c.req.valid('query');

    const cursor = decodeCursor(rawCursor);
    if (rawCursor && !cursor) {
      return c.json({ error: 'Kursor pagination tidak valid' }, 400);
    }

    const conditions: (SQL | undefined)[] = [
      eq(conversations.workspaceId, workspaceId),
      // Percakapan tanpa pesan (lastMessageAt NULL) tidak relevan di inbox
      // dan menyederhanakan keyset pagination (NULL tidak ikut di-halaman 2+).
      isNotNull(conversations.lastMessageAt),
    ];
    if (cursor) {
      // Urutan desc(lastMessageAt), desc(id) — keyset setelah kursor.
      conditions.push(
        or(
          lt(conversations.lastMessageAt, cursor.at),
          and(eq(conversations.lastMessageAt, cursor.at), lt(conversations.id, cursor.id)),
        ),
      );
    }

    const rows = await db
      .select()
      .from(conversations)
      .where(and(...conditions))
      .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    // Preview pesan terakhir per percakapan + judul booking terkait.
    const previews = new Map<string, { content: string; direction: string; createdAt: Date }>();
    if (page.length > 0) {
      const lastMessages = await db
        .select()
        .from(messages)
        .where(inArray(messages.conversationId, page.map((row) => row.id)))
        .orderBy(desc(messages.createdAt));
      for (const message of lastMessages) {
        if (!previews.has(message.conversationId)) {
          previews.set(message.conversationId, {
            content: decryptMessageContent(workspaceId, message.content),
            direction: message.direction,
            createdAt: message.createdAt,
          });
        }
      }
    }

    const bookingTitles = new Map<string, string>();
    const bookingIds = page.map((row) => row.bookingId).filter((id): id is string => Boolean(id));
    if (bookingIds.length > 0) {
      // Title booking = nama layanan katalog (kolom title sudah dihapus).
      const bookingRows = await db
        .select({ id: bookingsTable.id, serviceId: bookingsTable.serviceId })
        .from(bookingsTable)
        .where(inArray(bookingsTable.id, bookingIds));
      const serviceNames = await loadServiceNames(
        workspaceId,
        bookingRows.map((booking) => booking.serviceId),
      );
      for (const booking of bookingRows) {
        bookingTitles.set(
          booking.id,
          booking.serviceId ? (serviceNames.get(booking.serviceId) ?? DEFAULT_BOOKING_TITLE) : DEFAULT_BOOKING_TITLE,
        );
      }
    }

    return c.json({
      conversations: page.map((row) => {
        const state = (row.state ?? {}) as { needsAttention?: boolean };
        const preview = previews.get(row.id);
        return {
          id: row.id,
          channelType: row.channelType,
          externalId: row.externalId,
          customerName: row.customerName,
          status: row.status,
          unreadCount: row.unreadCount,
          needsAttention: state.needsAttention === true,
          bookingId: row.bookingId,
          bookingTitle: row.bookingId ? bookingTitles.get(row.bookingId) ?? null : null,
          lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
          preview: preview
            ? { content: preview.content, direction: preview.direction, createdAt: preview.createdAt.toISOString() }
            : null,
        };
      }),
      nextCursor:
        hasMore && page.length > 0
          ? Buffer.from(
              JSON.stringify({
                at: (page[page.length - 1].lastMessageAt ?? new Date(0)).toISOString(),
                id: page[page.length - 1].id,
              }),
            ).toString('base64url')
          : null,
      hasMore,
    });
  })

  /* ── Detail percakapan + riwayat pesan ───────────────────── */
  .get('/:id', requireAuth, requireWorkspace, zValidator('param', conversationIdParamSchema), async (c) => {
    const { id } = c.req.valid('param');
    const workspaceId = c.get('workspaceId');
    const conversation = await findConversation(workspaceId, id);
    if (!conversation) return c.json({ error: 'Percakapan tidak ditemukan' }, 404);

    const messageRows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, id))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(300);

    let booking = null;
    if (conversation.bookingId) {
      const [row] = await db
        .select({
          id: bookingsTable.id,
          serviceId: bookingsTable.serviceId,
          status: bookingsTable.status,
          scheduledAt: bookingsTable.scheduledAt,
          timezone: bookingsTable.timezone,
          customerName: bookingsTable.customerName,
          phone: bookingsTable.phone,
        })
        .from(bookingsTable)
        .where(eq(bookingsTable.id, conversation.bookingId))
        .limit(1);
      if (row) {
        // Title booking = nama layanan katalog (kolom title sudah dihapus).
        const serviceNames = await loadServiceNames(workspaceId, [row.serviceId]);
        const serviceName = row.serviceId ? (serviceNames.get(row.serviceId) ?? null) : null;
        booking = {
          ...row,
          title: serviceName ?? DEFAULT_BOOKING_TITLE,
          scheduledAt: row.scheduledAt.toISOString(),
        };
      }
    }

    const state = (conversation.state ?? {}) as { needsAttention?: boolean };
    return c.json({
      conversation: {
        id: conversation.id,
        channelType: conversation.channelType,
        externalId: conversation.externalId,
        customerName: conversation.customerName,
        status: conversation.status,
        unreadCount: conversation.unreadCount,
        needsAttention: state.needsAttention === true,
        createdAt: conversation.createdAt.toISOString(),
      },
      booking,
      messages: messageRows
        .map((message) => ({
          id: message.id,
          direction: message.direction,
          content: decryptMessageContent(c.get('workspaceId'), message.content),
          status: message.status,
          createdAt: message.createdAt.toISOString(),
        }))
        .reverse(), // asc untuk tampilan chat
    });
  })

  /* ── Tandai dibaca (reset unreadCount) ───────────────────── */
  .post('/:id/read', requireAuth, requireWorkspace, zValidator('param', conversationIdParamSchema), async (c) => {
    const { id } = c.req.valid('param');
    const [updated] = await db
      .update(conversations)
      .set({ unreadCount: 0, updatedAt: new Date() })
      .where(
        and(eq(conversations.id, id), eq(conversations.workspaceId, c.get('workspaceId'))),
      )
      .returning({ id: conversations.id });
    if (!updated) return c.json({ error: 'Percakapan tidak ditemukan' }, 404);
    return c.json({ ok: true, id: updated.id });
  })

  /* ── Balas lewat channel aslinya ─────────────────────────── */
  .post(
    '/:id/reply',
    requireAuth,
    requireWorkspace,
    zValidator('param', conversationIdParamSchema),
    zValidator('json', replySchema),
    async (c) => {
      const { id } = c.req.valid('param');
      const { text, buttons } = c.req.valid('json');
      const workspaceId = c.get('workspaceId');

      const conversation = await findConversation(workspaceId, id);
      if (!conversation) return c.json({ error: 'Percakapan tidak ditemukan' }, 404);

      if (conversation.status === 'closed') {
        return c.json({ error: 'Percakapan sudah ditutup (customer opt-out).' }, 400);
      }

      // Jangan kirim ke customer yang sudah opt-out (kecuali email — tanpa opt-out).
      if (conversation.channelType === 'telegram' || conversation.channelType === 'whatsapp') {
        const [channelRow] = await db
          .select({ isOptedIn: customerChannels.isOptedIn })
          .from(customerChannels)
          .where(
            and(
              eq(customerChannels.workspaceId, workspaceId),
              eq(customerChannels.channelType, conversation.channelType),
              eq(customerChannels.identifier, conversation.externalId),
            ),
          )
          .limit(1);
        if (channelRow && !channelRow.isOptedIn) {
          return c.json({ error: 'Customer sudah berhenti (opt-out) di channel ini.' }, 400);
        }
      }

      // Kirim via channel asli.
      let providerMessageId: string | null = null;
      if (conversation.channelType === 'telegram') {
        const channel = await resolveTelegramChannel(workspaceId);
        if (!channel) {
          return c.json({ error: 'Channel Telegram belum dikonfigurasi untuk workspace ini.' }, 400);
        }
        if (!channel.isActive) {
          return c.json({ error: 'Channel Telegram sedang dijeda — aktifkan dulu di halaman Channels.' }, 400);
        }
        try {
          const sent = await telegramSendMessage({
            token: channel.token,
            chatId: conversation.externalId,
            text,
            buttons,
          });
          providerMessageId = String(sent.messageId);
        } catch (error) {
          if (error instanceof TelegramApiError) {
            return c.json({ error: `Gagal mengirim: ${error.message}` }, 400);
          }
          throw error;
        }
      } else if (conversation.channelType === 'whatsapp') {
        const channel = await resolveWhatsAppChannel(workspaceId);
        if (!channel) {
          return c.json({ error: 'Channel WhatsApp belum dikonfigurasi untuk workspace ini.' }, 400);
        }
        if (!channel.isActive) {
          return c.json({ error: 'Channel WhatsApp sedang dijeda — aktifkan dulu di halaman Channels.' }, 400);
        }
        try {
          // Dispatch provider-aware: 360dialog → interactive/text; BYO (waha)
          // → sendText polos (tombol reply engine-dependent, fallback teks).
          const sent = await sendWhatsAppMessage({
            channel,
            to: conversation.externalId,
            text,
            buttons,
          });
          providerMessageId = sent.messageId;
        } catch (error) {
          if (error instanceof WhatsAppApiError) {
            return c.json({ error: `Gagal mengirim: ${error.message}` }, 400);
          }
          throw error;
        }
      } else if (conversation.channelType === 'email') {
        const { data, error } = await resend.emails.send({
          from: brand.emailFrom,
          to: [conversation.externalId],
          subject: 'Balasan dari tim kami',
          html: `<p>${text.replace(/\n/g, '<br/>')}</p>`,
        });
        if (error) {
          return c.json({ error: `Gagal mengirim email: ${error.message}` }, 400);
        }
        providerMessageId = data?.id ?? null;
      } else {
        return c.json({ error: `Channel ${conversation.channelType} belum mendukung balasan dari inbox.` }, 400);
      }

      // Catat balasan + bersihkan tanda butuh perhatian.
      await db
        .insert(messages)
        .values({
          conversationId: id,
          channelType: conversation.channelType,
          direction: 'outbound',
          providerMessageId: providerMessageId ?? '',
          content: encryptMessageContent(workspaceId, text),
          status: 'sent',
        })
        .onConflictDoNothing();

      const state = (conversation.state ?? {}) as Record<string, unknown>;
      const { needsAttention: _ignored, ...rest } = state;
      const nextState = Object.keys(rest).length > 0 ? rest : null;
      await db
        .update(conversations)
        .set({
          state: nextState,
          lastMessageAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(conversations.id, id));

      return c.json({ ok: true, providerMessageId });
    },
  );
