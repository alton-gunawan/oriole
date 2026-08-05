import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  bookings as bookingsTable,
  calleCalls,
  conversations,
  messages,
} from '@oriole/database';

import { db } from '../db/index.ts';
import {
  aggregateBookingsByMonth,
  aggregateBookingStatus,
  aggregateCallOutcomes,
  aggregateMessagesByChannel,
  buildFunnel,
  countNeedsAttention,
  countThisMonth,
  type BookingRow,
  type CallRow,
  type ConversationRow,
  type MessageRow,
} from '../lib/analytics.ts';
import { requireAuth } from '../middleware/auth.ts';
import { requireWorkspace, type WorkspaceVariables } from '../middleware/workspace.ts';

/**
 * Analytics — agregasi ringkas untuk halaman Analytics (per workspace).
 *
 * GET /api/analytics/overview → {
 *   summary: { bookingsTotal, bookingsThisMonth, callsTotal, callsThisMonth,
 *              messagesTotal, needsAttention },
 *   bookingsByMonth: [{ month: 'YYYY-MM', count }] — 12 bulan terakhir (0 diisi),
 *   bookingStatus: [{ status, count }],
 *   callOutcomes: [{ status, count }],
 *   messagesByChannel: [{ channel, inbound, outbound }],
 *   funnel: [{ step: 'created'|'confirmed'|'completed', count }],
 * }
 *
 * Hanya membaca baris workspace aktif (X-Workspace-Id); tanpa mutasi.
 */
export const analyticsRoutes = new Hono<{ Variables: WorkspaceVariables }>().get(
  '/overview',
  requireAuth,
  requireWorkspace,
  async (c) => {
    const workspaceId = c.get('workspaceId');

    const [bookingRows, callRows, messageRows, conversationRows] = await Promise.all([
      db
        .select({ status: bookingsTable.status, createdAt: bookingsTable.createdAt })
        .from(bookingsTable)
        .where(eq(bookingsTable.workspaceId, workspaceId)),
      db
        .select({ status: calleCalls.status, createdAt: calleCalls.createdAt })
        .from(calleCalls)
        .where(eq(calleCalls.workspaceId, workspaceId)),
      // Pesan tidak punya workspaceId — join lewat conversations.
      db
        .select({
          channel: messages.channelType,
          direction: messages.direction,
        })
        .from(messages)
        .innerJoin(conversations, eq(messages.conversationId, conversations.id))
        .where(eq(conversations.workspaceId, workspaceId)),
      db
        .select({ state: conversations.state })
        .from(conversations)
        .where(eq(conversations.workspaceId, workspaceId)),
    ]);

    const now = new Date();

    return c.json({
      summary: {
        bookingsTotal: bookingRows.length,
        bookingsThisMonth: countThisMonth(bookingRows as { createdAt: Date }[], now),
        callsTotal: callRows.length,
        callsThisMonth: countThisMonth(callRows as { createdAt: Date }[], now),
        messagesTotal: messageRows.length,
        needsAttention: countNeedsAttention(conversationRows as ConversationRow[]),
      },
      bookingsByMonth: aggregateBookingsByMonth(bookingRows as BookingRow[], now),
      bookingStatus: aggregateBookingStatus(bookingRows as BookingRow[]),
      callOutcomes: aggregateCallOutcomes(callRows as CallRow[]),
      messagesByChannel: aggregateMessagesByChannel(messageRows as MessageRow[]),
      funnel: buildFunnel(bookingRows as BookingRow[]),
    });
  },
);
