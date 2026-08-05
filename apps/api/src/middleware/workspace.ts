import { and, eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { workspaces } from '@oriole/database';

import { db } from '../db/index.ts';
import type { AuthVariables } from './auth.ts';

export type WorkspaceVariables = AuthVariables & { workspaceId: string };

/** Require a workspace header that belongs to the current authenticated user. */
export const requireWorkspace: MiddlewareHandler<{ Variables: WorkspaceVariables }> = async (c, next) => {
  const workspaceId = c.req.header('X-Workspace-Id');
  if (!workspaceId) {
    return c.json({ error: 'Workspace wajib dipilih' }, 400);
  }

  const [workspace] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.userId, c.get('userId'))));

  if (!workspace) {
    return c.json({ error: 'Workspace tidak ditemukan' }, 404);
  }

  c.set('workspaceId', workspace.id);
  await next();
};
