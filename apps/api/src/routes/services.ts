import { and, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { serviceStaff, services, staffMembers } from '@oriole/database';

import { db } from '../db/index.ts';
import { requireAuth } from '../middleware/auth.ts';
import { requireWorkspace, type WorkspaceVariables } from '../middleware/workspace.ts';
import { findService, loadServices } from '../lib/service-catalog.ts';

/** Mata uang umum (ISO 4217) — picker frontend + validasi backend. */
const SUPPORTED_CURRENCIES = [
  'USD',
  'IDR',
  'EUR',
  'GBP',
  'SGD',
  'MYR',
  'AUD',
  'JPY',
  'THB',
  'VND',
  'PHP',
  'INR',
  'BRL',
  'CAD',
] as const;

/** Harga dalam minor units (sen): 0 diizinkan (layanan gratis), null = belum di-set. */
const priceMinorField = z
  .number()
  .int('Harga harus bilangan bulat')
  .min(0, 'Harga tidak boleh negatif')
  .max(100_000_000, 'Harga terlalu besar')
  .nullable()
  .optional();

/** Kategori/tag layanan — string tunggal (legacy) atau array. Dinormalisasi ke array unik. */
const categoryField = z.union([
  z.string().trim().max(50),
  // Item kosong diizinkan di level schema — normalizeCategories membuangnya.
  z.array(z.string().trim().max(50)).max(20),
]);

const createServiceSchema = z.object({
  name: z.string().trim().min(1, 'Nama layanan tidak boleh kosong').max(100),
  description: z.string().trim().max(500).optional(),
  durationMinutes: z.number().int().min(5).max(720).default(60),
  priceMinor: priceMinorField,
  currency: z.enum(SUPPORTED_CURRENCIES).default('USD'),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Warna harus hex (#rrggbb)').default('#f59e0b'),
  category: categoryField.optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9_999).optional(),
  /** Staf yang melayani layanan ini — harus milik workspace & aktif. */
  staffIds: z.array(z.string().uuid()).max(50).default([]),
});

const updateServiceSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  durationMinutes: z.number().int().min(5).max(720).optional(),
  priceMinor: priceMinorField,
  currency: z.enum(SUPPORTED_CURRENCIES).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  category: categoryField.nullable().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9_999).optional(),
  staffIds: z.array(z.string().uuid()).max(50).optional(),
});

const serviceIdParamSchema = z.object({ id: z.string().uuid() });

/**
 * Normalisasi daftar kategori/tag: trim, buang kosong, dedupe (case-insensitive),
 * maksimal 20 item. Kembalikan null bila kosong (konsisten dengan kolom nullable).
 */
function normalizeCategories(value: string | string[] | null | undefined): string[] | null {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string' && value.trim()
      ? [value]
      : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const item = raw.trim();
    if (!item) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.length > 0 ? out.slice(0, 20) : null;
}

function serialize(service: Awaited<ReturnType<typeof loadServices>>[number]) {
  return {
    id: service.id,
    name: service.name,
    description: service.description,
    durationMinutes: service.durationMinutes,
    priceMinor: service.priceMinor,
    currency: service.currency,
    color: service.color,
    category: service.category,
    isActive: service.isActive,
    sortOrder: service.sortOrder,
    staffIds: service.staffIds,
    createdAt: service.createdAt.toISOString(),
    updatedAt: service.updatedAt.toISOString(),
  };
}

/**
 * Validasi daftar staf ter-assign: semua id harus milik workspace & aktif.
 * Mengembalikan pesan error bila tidak valid, atau null bila OK.
 */
async function validateStaffAssignment(
  workspaceId: string,
  staffIds: string[],
): Promise<string | null> {
  if (staffIds.length === 0) return null;
  const rows = await db
    .select({ id: staffMembers.id, isActive: staffMembers.isActive })
    .from(staffMembers)
    .where(and(eq(staffMembers.workspaceId, workspaceId), inArray(staffMembers.id, staffIds)));

  const found = new Set(rows.map((row) => row.id));
  const missing = staffIds.filter((id) => !found.has(id));
  if (missing.length > 0) return 'Salah satu staf tidak ditemukan di workspace ini';
  const inactive = rows.filter((row) => !row.isActive);
  if (inactive.length > 0) return 'Staf dinonaktifkan tidak bisa ditugaskan ke layanan';
  return null;
}

export const servicesRoutes = new Hono<{ Variables: WorkspaceVariables }>()
  /* ── Daftar layanan (katalog) workspace ──────────────────── */
  .get('/', requireAuth, requireWorkspace, async (c) => {
    const servicesList = await loadServices(c.get('workspaceId'));
    return c.json({ services: servicesList.map(serialize) });
  })

  /* ── Buat layanan ────────────────────────────────────────── */
  .post('/', requireAuth, requireWorkspace, zValidator('json', createServiceSchema), async (c) => {
    const body = c.req.valid('json');
    const workspaceId = c.get('workspaceId');

    const staffError = await validateStaffAssignment(workspaceId, body.staffIds);
    if (staffError) return c.json({ error: staffError }, 400);

    const [row] = await db
      .insert(services)
      .values({
        userId: c.get('userId'),
        workspaceId,
        name: body.name,
        description: body.description?.trim() ? body.description.trim() : null,
        durationMinutes: body.durationMinutes,
        priceMinor: body.priceMinor ?? null,
        currency: body.currency,
        color: body.color,
        category: normalizeCategories(body.category),
        isActive: body.isActive ?? true,
        sortOrder: body.sortOrder ?? 0,
      })
      .returning();

    if (body.staffIds.length > 0) {
      await db.insert(serviceStaff).values(
        body.staffIds.map((staffId) => ({ serviceId: row.id, staffId })),
      );
    }

    const [detailed] = await loadServices(workspaceId).then((list) =>
      list.filter((service) => service.id === row.id),
    );
    return c.json({ service: serialize(detailed) }, 201);
  })

  /* ── Detail layanan ──────────────────────────────────────── */
  .get('/:id', requireAuth, requireWorkspace, zValidator('param', serviceIdParamSchema), async (c) => {
    const { id } = c.req.valid('param');
    const service = await findService(c.get('workspaceId'), id);
    if (!service) return c.json({ error: 'Layanan tidak ditemukan' }, 404);
    return c.json({ service: serialize(service) });
  })

  /* ── Update layanan ──────────────────────────────────────── */
  .patch(
    '/:id',
    requireAuth,
    requireWorkspace,
    zValidator('param', serviceIdParamSchema),
    zValidator('json', updateServiceSchema),
    async (c) => {
      const { id } = c.req.valid('param');
      const workspaceId = c.get('workspaceId');
      const existing = await findService(workspaceId, id);
      if (!existing) return c.json({ error: 'Layanan tidak ditemukan' }, 404);

      const body = c.req.valid('json');

      if (body.staffIds !== undefined) {
        const staffError = await validateStaffAssignment(workspaceId, body.staffIds);
        if (staffError) return c.json({ error: staffError }, 400);
      }

      const values: Record<string, unknown> = { updatedAt: new Date() };
      if (body.name !== undefined) values.name = body.name;
      if (body.description !== undefined)
        values.description = body.description?.trim() ? body.description.trim() : null;
      if (body.durationMinutes !== undefined) values.durationMinutes = body.durationMinutes;
      if (body.priceMinor !== undefined) values.priceMinor = body.priceMinor ?? null;
      if (body.currency !== undefined) values.currency = body.currency;
      if (body.color !== undefined) values.color = body.color;
      if (body.category !== undefined) values.category = normalizeCategories(body.category);
      if (body.isActive !== undefined) values.isActive = body.isActive;
      if (body.sortOrder !== undefined) values.sortOrder = body.sortOrder;

      await db.update(services).set(values).where(eq(services.id, existing.id));

      // Replace-all staff assignment bila dikirim (delete → insert) — idempotent.
      if (body.staffIds !== undefined) {
        await db.delete(serviceStaff).where(eq(serviceStaff.serviceId, existing.id));
        if (body.staffIds.length > 0) {
          await db.insert(serviceStaff).values(
            body.staffIds.map((staffId) => ({ serviceId: existing.id, staffId })),
          );
        }
      }

      const updated = await findService(workspaceId, existing.id);
      return c.json({ service: serialize(updated!) });
    },
  )

  /* ── Hapus layanan (booking tertaut otomatis ke serviceId null) ── */
  .delete(
    '/:id',
    requireAuth,
    requireWorkspace,
    zValidator('param', serviceIdParamSchema),
    async (c) => {
      const { id } = c.req.valid('param');
      const [deleted] = await db
        .delete(services)
        .where(and(eq(services.id, id), eq(services.workspaceId, c.get('workspaceId'))))
        .returning({ id: services.id });
      if (!deleted) return c.json({ error: 'Layanan tidak ditemukan' }, 404);
      return c.json({ ok: true, id: deleted.id });
    },
  );
