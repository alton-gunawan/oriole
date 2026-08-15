import { and, eq, isNull } from 'drizzle-orm';
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

  // Bisnis soft-deleted diperlakukan seperti tidak ada (404) — user tidak
  // boleh mengakses data bisnis yang sedang dalam masa tenggang penghapusan.
  const [workspace] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.userId, c.get('userId')), isNull(workspaces.deletedAt)));

  if (!workspace) {
    return c.json({ error: 'Workspace tidak ditemukan' }, 404);
  }

  c.set('workspaceId', workspace.id);
  await next();
};
