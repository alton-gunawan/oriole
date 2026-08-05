import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { determineCallGoal, type BookingGoalContext } from '@oriole/call-goals';
import { bookings, calleCalls, workspaces } from '@oriole/database';

import { db } from '../db/index.ts';
import { countCallAttempts } from '../lib/booking-goal.ts';
import { dispatchEmailReminder, EmailDispatchError } from '../lib/email-reminder.ts';
import { dispatchWhatsAppReminder, WhatsAppDispatchError } from '../lib/whatsapp-handler.ts';
import { requireAuth } from '../middleware/auth.ts';
import { requireWorkspace, type WorkspaceVariables } from '../middleware/workspace.ts';

const bookingIdParamSchema = z.object({ id: z.string().uuid() });

function toGoalContext(
  row: typeof bookings.$inferSelect,
  attempts: { total: number; failed: number },
): BookingGoalContext {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    scheduledAt: row.scheduledAt.toISOString(),
    timezone: row.timezone,
    customerName: row.customerName,
    phone: row.phone,
    changeRequested: row.changeRequested,
    noShowCount: row.noShowCount,
    previousCallAttempts: attempts.total,
    failedCallAttempts: attempts.failed,
  };
}

/**
 * Router terpisah untuk trigger berbasis booking (agar tidak menyentuh
 * bookings.ts): `POST /api/bookings/:id/trigger-whatsapp` + trigger-email.
 *
 * Mengirim reminder saat itu juga (WhatsApp via Message Template — wajib
 * untuk memulai percakapan di luar 24h window). Mesin goal sama dengan
 * CALL-E / Telegram.
 */

export const bookingTriggersRoutes = new Hono<{ Variables: WorkspaceVariables }>().post(
  '/:id/trigger-whatsapp',
  requireAuth,
  requireWorkspace,
  zValidator('param', bookingIdParamSchema),
  async (c) => {
    const { id } = c.req.valid('param');

    const [row] = await db
      .select()
      .from(bookings)
      .where(and(eq(bookings.id, id), eq(bookings.workspaceId, c.get('workspaceId'))))
      .limit(1);
    if (!row) return c.json({ error: 'Booking tidak ditemukan' }, 404);

    const [workspace] = await db
      .select({ name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, c.get('workspaceId')))
      .limit(1);

    const calls = await db
      .select({ status: calleCalls.status })
      .from(calleCalls)
      .where(eq(calleCalls.bookingId, row.id));
    const attempts = countCallAttempts(calls);
    const decision = determineCallGoal(toGoalContext(row, attempts));

    if (decision.goalType === null) {
      return c.json({ error: 'Tidak ada goal untuk status booking ini (dibatalkan / selesai).' }, 400);
    }

    try {
      await dispatchWhatsAppReminder({
        workspaceId: c.get('workspaceId'),
        booking: {
          id: row.id,
          title: row.title,
          customerName: row.customerName,
          phone: row.phone,
          scheduledAt: row.scheduledAt,
          timezone: row.timezone,
        },
        businessName: workspace?.name ?? null,
      });

      return c.json({
        ok: true,
        channel: 'whatsapp',
        goal: { goalType: decision.goalType, reason: decision.reason },
      });
    } catch (error) {
      if (error instanceof WhatsAppDispatchError) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }
  })

  /* ── Trigger reminder via email (channel outbound-only) ─── */
  .post('/:id/trigger-email', requireAuth, requireWorkspace, zValidator('param', bookingIdParamSchema), async (c) => {
    const { id } = c.req.valid('param');

    const [row] = await db
      .select()
      .from(bookings)
      .where(and(eq(bookings.id, id), eq(bookings.workspaceId, c.get('workspaceId'))))
      .limit(1);
    if (!row) return c.json({ error: 'Booking tidak ditemukan' }, 404);

    const [workspace] = await db
      .select({ name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, c.get('workspaceId')))
      .limit(1);

    const calls = await db
      .select({ status: calleCalls.status })
      .from(calleCalls)
      .where(eq(calleCalls.bookingId, row.id));
    const attempts = countCallAttempts(calls);
    const decision = determineCallGoal(toGoalContext(row, attempts));
    if (decision.goalType === null) {
      return c.json({ error: 'Tidak ada goal untuk status booking ini (dibatalkan / selesai).' }, 400);
    }

    try {
      await dispatchEmailReminder({
        workspaceId: c.get('workspaceId'),
        booking: {
          id: row.id,
          title: row.title,
          customerName: row.customerName,
          phone: row.phone,
          scheduledAt: row.scheduledAt,
          timezone: row.timezone,
        },
        businessName: workspace?.name ?? null,
      });
      return c.json({ ok: true, channel: 'email' });
    } catch (error) {
      if (error instanceof EmailDispatchError) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }
  });
