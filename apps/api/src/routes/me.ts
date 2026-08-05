import { zValidator } from '@hono/zod-validator';
import { and, asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { WORKSPACE_TEMPLATE_CATEGORY_IDS, industryForTemplateCategory } from '@oriole/config';
import { INDUSTRIES } from '@oriole/call-goals';
import { workspaces } from '@oriole/database';

import { db } from '../db/index.ts';
import { requireAuth, type AuthVariables } from '../middleware/auth.ts';

const workspaceSchema = z.object({
  name: z.string().trim().min(2).max(120),
  templateCategory: z.enum(WORKSPACE_TEMPLATE_CATEGORY_IDS),
  /**
   * Industri bisnis (opsional) — dipakai untuk goal CALL-E otomatis.
   * Bila tidak dikirim, diturunkan dari `templateCategory` via
   * `industryForTemplateCategory` (user cukup memilih kategori sekali).
   */
  industry: z.enum(INDUSTRIES).optional(),
  /** Lead time reminder otomatis (menit sebelum jadwal). */
  reminderLeadMinutes: z.number().int().min(5).max(10_080).optional(),
});

/** PATCH bersifat parsial — cukup kirim field yang ingin diubah. */
const workspacePatchSchema = workspaceSchema.partial();

const workspaceIdParamSchema = z.object({ id: z.string().uuid() });

/** Identitas user + daftar store/project yang dimiliki akun. */
export const meRoutes = new Hono<{ Variables: AuthVariables }>()
  .get('/', requireAuth, async (c) => {
    const userId = c.get('userId');
    const userWorkspaces = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.userId, userId))
      .orderBy(asc(workspaces.createdAt));

    return c.json({
      userId,
      email: c.get('userEmail'),
      workspaces: userWorkspaces,
    });
  })
  .post('/workspaces', requireAuth, zValidator('json', workspaceSchema), async (c) => {
    const body = c.req.valid('json');
    const industry = body.industry ?? industryForTemplateCategory(body.templateCategory);
    const [workspace] = await db
      .insert(workspaces)
      .values({
        userId: c.get('userId'),
        name: body.name,
        templateCategory: body.templateCategory,
        industry,
      })
      .returning();

    return c.json({ workspace }, 201);
  })
  .patch(
    '/workspaces/:id',
    requireAuth,
    zValidator('param', workspaceIdParamSchema),
    zValidator('json', workspacePatchSchema),
    async (c) => {
      const userId = c.get('userId');
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');

      if (
        !body.name &&
        !body.templateCategory &&
        body.industry === undefined &&
        body.reminderLeadMinutes === undefined
      ) {
        return c.json({ error: 'Tidak ada field yang diubah' }, 400);
      }

      // Sinkronisasi: industry mengikuti kategori baru, kecuali client mengirim
      // override eksplisit — nilai yang sengaja tidak cocok tetap dihormati.
      const industry =
        body.industry ??
        (body.templateCategory ? industryForTemplateCategory(body.templateCategory) : undefined);

      const [workspace] = await db
        .update(workspaces)
        .set({
          ...(body.name ? { name: body.name } : {}),
          ...(body.templateCategory ? { templateCategory: body.templateCategory } : {}),
          ...(industry !== undefined ? { industry } : {}),
          ...(body.reminderLeadMinutes !== undefined
            ? { reminderLeadMinutes: body.reminderLeadMinutes }
            : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(workspaces.id, id), eq(workspaces.userId, userId)))
        .returning();

      if (!workspace) {
        return c.json({ error: 'Workspace tidak ditemukan' }, 404);
      }
      return c.json({ workspace });
    },
  )
  .delete(
    '/workspaces/:id',
    requireAuth,
    zValidator('param', workspaceIdParamSchema),
    async (c) => {
      const userId = c.get('userId');
      const { id } = c.req.valid('param');

      const [deleted] = await db
        .delete(workspaces)
        .where(and(eq(workspaces.id, id), eq(workspaces.userId, userId)))
        .returning({ id: workspaces.id });

      if (!deleted) {
        return c.json({ error: 'Workspace tidak ditemukan' }, 404);
      }
      return c.json({ ok: true, id: deleted.id });
    },
  );
