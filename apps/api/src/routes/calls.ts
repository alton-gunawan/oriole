import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { calleCalls } from '@oriole/database';

import { db } from '../db/index.ts';
import { extractCallSeconds } from '../lib/calls.ts';
import { requireAuth } from '../middleware/auth.ts';
import { requireWorkspace, type WorkspaceVariables } from '../middleware/workspace.ts';

const LIST_LIMIT = 50;

/**
 * Riwayat panggilan CALL-E milik user yang sedang login.
 *
 * GET /api/calls → { calls, summary }
 * - `calls`: 50 panggilan terbaru (terurut createdAt desc)
 * - `summary`: agregat untuk seluruh riwayat (total, bulan ini, status, durasi)
 */
export const callsRoutes = new Hono<{ Variables: WorkspaceVariables }>().get(
  '/',
  requireAuth,
  requireWorkspace,
  async (c) => {
    const userId = c.get('userId');

    const [recentCalls, allCalls] = await Promise.all([
      db
        .select()
        .from(calleCalls)
        .where(and(eq(calleCalls.userId, userId), eq(calleCalls.workspaceId, c.get('workspaceId'))))
        .orderBy(desc(calleCalls.createdAt))
        .limit(LIST_LIMIT),
      db
        .select({
          status: calleCalls.status,
          createdAt: calleCalls.createdAt,
          result: calleCalls.result,
        })
        .from(calleCalls)
        .where(and(eq(calleCalls.userId, userId), eq(calleCalls.workspaceId, c.get('workspaceId')))),
    ]);

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const totalCalls = allCalls.length;
    const monthCalls = allCalls.filter((call) => call.createdAt >= monthStart).length;
    const completed = allCalls.filter((call) => call.status === 'completed').length;
    const failed = allCalls.filter(
      (call) => call.status === 'failed' || call.status === 'error',
    ).length;
    const totalSeconds = allCalls.reduce((acc, call) => acc + extractCallSeconds(call.result), 0);

    return c.json({
      calls: recentCalls,
      summary: { totalCalls, monthCalls, completed, failed, totalSeconds },
    });
  },
);
