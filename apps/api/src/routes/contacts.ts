import { and, desc, eq, ilike, lt, or, sql, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { contacts } from '@oriole/database';

import { db } from '../db/index.ts';
import { normalizePhone, phoneField } from '../lib/phone.ts';
import { requireAuth } from '../middleware/auth.ts';
import { requireWorkspace, type WorkspaceVariables } from '../middleware/workspace.ts';

/** Email opsional: string kosong disimpan sebagai null; nilai lain harus valid. */
const optionalEmail = z
  .string()
  .trim()
  .max(200)
  .refine((value) => value === '' || z.email().safeParse(value).success, {
    message: 'Email tidak valid',
  })
  .transform((value) => (value === '' ? null : value))
  .nullable()
  .optional();

/** Catatan opsional: string kosong dinormalisasi menjadi null (konsisten dengan email). */
const optionalNotes = z
  .string()
  .trim()
  .max(2_000)
  .transform((value) => (value === '' ? null : value))
  .nullable()
  .optional();

const createContactSchema = z.object({
  name: z.string().trim().min(1, 'Nama wajib diisi').max(200),
  phone: phoneField,
  email: optionalEmail,
  notes: optionalNotes,
});

const updateContactSchema = z.object({
  name: z.string().trim().min(1, 'Nama wajib diisi').max(200).optional(),
  phone: phoneField.optional(),
  email: optionalEmail,
  notes: optionalNotes,
});

const contactIdParamSchema = z.object({ id: z.string().uuid() });

/**
 * Filter daftar kontak: pencarian teks global (q, legacy) atau per-kolom
 * (name/phone/email) + pagination kursor keyset. Filter per-kolom saling
 * AND — dipakai filter bar halaman Contacts (pola Bookings).
 */
const listQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  name: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(200).optional(),
  email: z.string().trim().max(200).optional(),
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const cursorPayloadSchema = z.object({
  at: z.iso.datetime({ offset: true }),
  id: z.string().uuid(),
});

/** Decode kursor pagination ({ at, id } base64url) → kondisi keyset, atau null bila tidak ada. */
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

function encodeCursor(row: ContactRow): string {
  return Buffer.from(
    JSON.stringify({ at: row.createdAt.toISOString(), id: row.id }),
  ).toString('base64url');
}

type ContactRow = typeof contacts.$inferSelect;

function serializeContact(row: ContactRow) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function findContact(workspaceId: string, contactId: string): Promise<ContactRow | undefined> {
  const [row] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.workspaceId, workspaceId)))
    .limit(1);
  return row;
}

/** Nomor telepon duplikat di workspace yang sama → friendly 409. */
function isDuplicatePhoneError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

export const contactsRoutes = new Hono<{ Variables: WorkspaceVariables }>()
  /* ── List kontak workspace (cari + pagination kursor) ─────── */
  .get('/', requireAuth, requireWorkspace, zValidator('query', listQuerySchema), async (c) => {
    const workspaceId = c.get('workspaceId');
    const { q, name, phone, email, limit, cursor: rawCursor } = c.req.valid('query');

    const cursor = decodeCursor(rawCursor);
    if (rawCursor && !cursor) {
      return c.json({ error: 'Kursor pagination tidak valid' }, 400);
    }

    const conditions: (SQL | undefined)[] = [eq(contacts.workspaceId, workspaceId)];
    if (q) {
      const pattern = `%${q}%`;
      conditions.push(
        or(ilike(contacts.name, pattern), ilike(contacts.phone, pattern), ilike(contacts.email, pattern)),
      );
    }
    // Filter per-kolom (UI Contacts mengikuti pola filter Bookings).
    if (name) conditions.push(ilike(contacts.name, `%${name}%`));
    if (phone) {
      // Cocokkan substring string asli ATAU versi digit-only — user boleh
      // mengetik nomor tanpa format (mis. "08123456789" cocok dengan
      // "+62 812-3456-7890").
      const phoneMatch: SQL[] = [ilike(contacts.phone, `%${phone}%`)];
      const phoneDigits = normalizePhone(phone);
      if (phoneDigits) {
        phoneMatch.push(
          ilike(
            sql<string>`regexp_replace(${contacts.phone}, '[^0-9]', '', 'g')`,
            `%${phoneDigits}%`,
          ),
        );
      }
      conditions.push(or(...phoneMatch));
    }
    if (email) conditions.push(ilike(contacts.email, `%${email}%`));
    // Keyset pagination: urut desc(createdAt), desc(id) — ambil baris setelah kursor.
    if (cursor) {
      conditions.push(
        or(
          lt(contacts.createdAt, cursor.at),
          and(eq(contacts.createdAt, cursor.at), lt(contacts.id, cursor.id)),
        ),
      );
    }

    // Ambil limit+1 untuk mendeteksi adanya halaman berikutnya.
    const rows = await db
      .select()
      .from(contacts)
      .where(and(...conditions))
      .orderBy(desc(contacts.createdAt), desc(contacts.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    return c.json({
      contacts: pageRows.map(serializeContact),
      nextCursor: hasMore && pageRows.length > 0 ? encodeCursor(pageRows[pageRows.length - 1]) : null,
      hasMore,
    });
  })

  /* ── Detail kontak (workspace-scoped) ─────────────────────── */
  .get(
    '/:id',
    requireAuth,
    requireWorkspace,
    zValidator('param', contactIdParamSchema),
    async (c) => {
      const contact = await findContact(c.get('workspaceId'), c.req.valid('param').id);
      if (!contact) {
        return c.json({ error: 'Kontak tidak ditemukan' }, 404);
      }
      return c.json({ contact: serializeContact(contact) });
    },
  )

  /* ── Buat kontak ──────────────────────────────────────────── */
  .post('/', requireAuth, requireWorkspace, zValidator('json', createContactSchema), async (c) => {
    const body = c.req.valid('json');

    try {
      const [row] = await db
        .insert(contacts)
        .values({
          userId: c.get('userId'),
          workspaceId: c.get('workspaceId'),
          name: body.name,
          phone: body.phone,
          email: body.email ?? null,
          notes: body.notes ?? null,
        })
        .returning();

      return c.json({ contact: serializeContact(row) }, 201);
    } catch (error) {
      if (isDuplicatePhoneError(error)) {
        return c.json({ error: 'Kontak dengan nomor telepon ini sudah ada di workspace ini.' }, 409);
      }
      throw error;
    }
  })

  /* ── Update kontak (parsial) ──────────────────────────────── */
  .patch(
    '/:id',
    requireAuth,
    requireWorkspace,
    zValidator('param', contactIdParamSchema),
    zValidator('json', updateContactSchema),
    async (c) => {
      const { id } = c.req.valid('param');
      const existing = await findContact(c.get('workspaceId'), id);
      if (!existing) return c.json({ error: 'Kontak tidak ditemukan' }, 404);

      const body = c.req.valid('json');
      const values: Record<string, unknown> = { updatedAt: new Date() };
      if (body.name !== undefined) values.name = body.name;
      if (body.phone !== undefined) values.phone = body.phone;
      if (body.email !== undefined) values.email = body.email;
      if (body.notes !== undefined) values.notes = body.notes;

      try {
        const [updated] = await db
          .update(contacts)
          .set(values)
          .where(eq(contacts.id, existing.id))
          .returning();
        return c.json({ contact: serializeContact(updated) });
      } catch (error) {
        if (isDuplicatePhoneError(error)) {
          return c.json({ error: 'Kontak dengan nomor telepon ini sudah ada di workspace ini.' }, 409);
        }
        throw error;
      }
    },
  )

  /* ── Hapus kontak (workspace-scoped) ──────────────────────── */
  .delete(
    '/:id',
    requireAuth,
    requireWorkspace,
    zValidator('param', contactIdParamSchema),
    async (c) => {
      const { id } = c.req.valid('param');
      const [deleted] = await db
        .delete(contacts)
        .where(and(eq(contacts.id, id), eq(contacts.workspaceId, c.get('workspaceId'))))
        .returning({ id: contacts.id });

      if (!deleted) {
        return c.json({ error: 'Kontak tidak ditemukan' }, 404);
      }
      return c.json({ ok: true, id: deleted.id });
    },
  );
