import { and, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { staffMembers, staffSchedules, staffTimeOff } from '@oriole/database';

import { db } from '../db/index.ts';
import { requireAuth } from '../middleware/auth.ts';
import { requireWorkspace, type WorkspaceVariables } from '../middleware/workspace.ts';

/** Zona waktu IANA yang valid (Intl melempar untuk nama tidak dikenal). */
const ianaTimeZone = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'Zona waktu tidak dikenal');

const createStaffSchema = z.object({
  name: z.string().trim().min(1).max(100),
  // Whitespace-only / kosong → null di handler; non-kosong wajib email valid.
  email: z
    .string()
    .trim()
    .max(200)
    .optional()
    .refine(
      (value) => value === undefined || value === '' || z.string().email().safeParse(value).success,
      'Email tidak valid',
    ),
  phone: z.string().trim().max(30).optional().or(z.literal('')),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Warna harus hex (#rrggbb)').default('#f59e0b'),
  timezone: ianaTimeZone.default('UTC'),
  bufferMinutes: z.number().int().min(0).max(120).default(0),
});

const updateStaffSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  email: z.string().trim().email().max(200).nullable().optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  timezone: ianaTimeZone.optional(),
  bufferMinutes: z.number().int().min(0).max(120).optional(),
  isActive: z.boolean().optional(),
});

const scheduleItemSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startMinutes: z.number().int().min(0).max(1439),
  endMinutes: z.number().int().min(0).max(1440),
});

/** Jadwal mingguan: max 3 rentang per hari (pagi/siang/sore) + wajib end > start. */
const schedulesSchema = z
  .object({
    schedules: z.array(scheduleItemSchema).max(21),
  })
  .refine((value) => value.schedules.every((s) => s.endMinutes > s.startMinutes), {
    message: 'endMinutes harus lebih besar dari startMinutes',
    path: ['schedules'],
  })
  .refine(
    (value) => {
      // Tolak rentang yang saling tumpang-tindih pada hari yang sama.
      for (let day = 0; day <= 6; day++) {
        const entries = value.schedules
          .filter((s) => s.dayOfWeek === day)
          .sort((a, b) => a.startMinutes - b.startMinutes);
        for (let i = 1; i < entries.length; i++) {
          if (entries[i].startMinutes < entries[i - 1].endMinutes) return false;
        }
      }
      return true;
    },
    { message: 'Rentang jadwal saling tumpang-tindih pada hari yang sama', path: ['schedules'] },
  );

const timeOffSchema = z
  .object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'startDate harus YYYY-MM-DD'),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'endDate harus YYYY-MM-DD'),
    reason: z.string().trim().max(200).optional(),
  })
  .refine((value) => value.endDate >= value.startDate, {
    message: 'endDate harus setelah atau sama dengan startDate',
    path: ['endDate'],
  });

const staffIdParamSchema = z.object({ id: z.string().uuid() });
const timeOffIdParamSchema = z.object({ id: z.string().uuid(), timeOffId: z.string().uuid() });

type StaffRow = typeof staffMembers.$inferSelect;

function serializeStaff(staff: StaffRow) {
  const phoneIsEmail = Boolean(staff.phone && staff.phone.includes('@'));
  const email = staff.email ?? (phoneIsEmail ? staff.phone : null);
  const phone = phoneIsEmail ? null : (staff.phone ?? null);

  return {
    id: staff.id,
    name: staff.name,
    email,
    phone,
    color: staff.color,
    timezone: staff.timezone,
    isActive: staff.isActive,
    bufferMinutes: staff.bufferMinutes,
    createdAt: staff.createdAt.toISOString(),
    updatedAt: staff.updatedAt.toISOString(),
  };
}

/** Muat schedules + timeOff untuk daftar staf (2 query, group di JS). */
async function loadStaffDetails(staffRows: StaffRow[]) {
  const ids = staffRows.map((s) => s.id);
  const [schedules, timeOff] =
    ids.length > 0
      ? await Promise.all([
          db.select().from(staffSchedules).where(inArray(staffSchedules.staffId, ids)),
          db.select().from(staffTimeOff).where(inArray(staffTimeOff.staffId, ids)),
        ])
      : [[], []];

  const schedulesByStaff = new Map<string, typeof schedules>();
  const timeOffByStaff = new Map<string, typeof timeOff>();
  for (const schedule of schedules) {
    const list = schedulesByStaff.get(schedule.staffId) ?? [];
    list.push(schedule);
    schedulesByStaff.set(schedule.staffId, list);
  }
  for (const entry of timeOff) {
    const list = timeOffByStaff.get(entry.staffId) ?? [];
    list.push(entry);
    timeOffByStaff.set(entry.staffId, list);
  }

  return staffRows.map((staff) => {
    const staffSchedulesRows = schedulesByStaff.get(staff.id) ?? [];
    const timeOffRows = timeOffByStaff.get(staff.id) ?? [];
    return {
      ...serializeStaff(staff),
      schedules: staffSchedulesRows
        .map((s) => ({
          id: s.id,
          dayOfWeek: s.dayOfWeek,
          startMinutes: s.startMinutes,
          endMinutes: s.endMinutes,
        }))
        .sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startMinutes - b.startMinutes),
      timeOff: timeOffRows
        .map((t) => ({
          id: t.id,
          startDate: t.startDate.toISOString(),
          endDate: t.endDate.toISOString(),
          reason: t.reason ?? null,
        }))
        .sort((a, b) => a.startDate.localeCompare(b.startDate)),
    };
  });
}

async function findStaff(workspaceId: string, staffId: string): Promise<StaffRow | undefined> {
  const [row] = await db
    .select()
    .from(staffMembers)
    .where(and(eq(staffMembers.id, staffId), eq(staffMembers.workspaceId, workspaceId)))
    .limit(1);
  return row;
}

export const staffRoutes = new Hono<{ Variables: WorkspaceVariables }>()
  /* ── Daftar staf + jadwal + cuti ─────────────────────────── */
  .get('/', requireAuth, requireWorkspace, async (c) => {
    const rows = await db
      .select()
      .from(staffMembers)
      .where(eq(staffMembers.workspaceId, c.get('workspaceId')))
      .orderBy(staffMembers.createdAt);
    return c.json({ staff: await loadStaffDetails(rows) });
  })

  /* ── Buat staf ───────────────────────────────────────────── */
  .post('/', requireAuth, requireWorkspace, zValidator('json', createStaffSchema), async (c) => {
    const body = c.req.valid('json');
    const [row] = await db
      .insert(staffMembers)
      .values({
        userId: c.get('userId'),
        workspaceId: c.get('workspaceId'),
        name: body.name,
        email: body.email?.trim() ? body.email.trim() : null,
        phone: body.phone?.trim() ? body.phone.trim() : null,
        color: body.color,
        timezone: body.timezone,
        bufferMinutes: body.bufferMinutes,
      })
      .returning();
    const [detailed] = await loadStaffDetails([row]);
    return c.json({ staff: detailed }, 201);
  })

  /* ── Detail staf ─────────────────────────────────────────── */
  .get('/:id', requireAuth, requireWorkspace, zValidator('param', staffIdParamSchema), async (c) => {
    const { id } = c.req.valid('param');
    const row = await findStaff(c.get('workspaceId'), id);
    if (!row) return c.json({ error: 'Staf tidak ditemukan' }, 404);
    const [detailed] = await loadStaffDetails([row]);
    return c.json({ staff: detailed });
  })

  /* ── Update staf ─────────────────────────────────────────── */
  .patch(
    '/:id',
    requireAuth,
    requireWorkspace,
    zValidator('param', staffIdParamSchema),
    zValidator('json', updateStaffSchema),
    async (c) => {
      const { id } = c.req.valid('param');
      const existing = await findStaff(c.get('workspaceId'), id);
      if (!existing) return c.json({ error: 'Staf tidak ditemukan' }, 404);

      const body = c.req.valid('json');
      const values: Record<string, unknown> = { updatedAt: new Date() };
      if (body.name !== undefined) values.name = body.name;
      if (body.email !== undefined) values.email = body.email?.trim() ? body.email.trim() : null;
      if (body.phone !== undefined) values.phone = body.phone?.trim() ? body.phone.trim() : null;
      if (body.color !== undefined) values.color = body.color;
      if (body.timezone !== undefined) values.timezone = body.timezone;
      if (body.bufferMinutes !== undefined) values.bufferMinutes = body.bufferMinutes;
      if (body.isActive !== undefined) values.isActive = body.isActive;

      const [updated] = await db
        .update(staffMembers)
        .set(values)
        .where(eq(staffMembers.id, existing.id))
        .returning();
      const [detailed] = await loadStaffDetails([updated]);
      return c.json({ staff: detailed });
    },
  )

  /* ── Hapus staf (booking tertaut otomatis ke-stafId null) ── */
  .delete('/:id', requireAuth, requireWorkspace, zValidator('param', staffIdParamSchema), async (c) => {
    const { id } = c.req.valid('param');
    const [deleted] = await db
      .delete(staffMembers)
      .where(and(eq(staffMembers.id, id), eq(staffMembers.workspaceId, c.get('workspaceId'))))
      .returning({ id: staffMembers.id });
    if (!deleted) return c.json({ error: 'Staf tidak ditemukan' }, 404);
    return c.json({ ok: true, id: deleted.id });
  })

  /* ── Ganti jadwal mingguan (replace-all) ─────────────────── */
  .put(
    '/:id/schedules',
    requireAuth,
    requireWorkspace,
    zValidator('param', staffIdParamSchema),
    zValidator('json', schedulesSchema),
    async (c) => {
      const { id } = c.req.valid('param');
      const existing = await findStaff(c.get('workspaceId'), id);
      if (!existing) return c.json({ error: 'Staf tidak ditemukan' }, 404);

      const { schedules } = c.req.valid('json');
      // Replace-all dalam transaksi logis: hapus dulu, lalu insert. Tanpa
      // exclusion constraint, urutan hapus→insert cukup aman untuk jadwal
      // (bukan slot booking).
      await db.delete(staffSchedules).where(eq(staffSchedules.staffId, id));
      if (schedules.length > 0) {
        await db.insert(staffSchedules).values(
          schedules.map((s) => ({ staffId: id, dayOfWeek: s.dayOfWeek, startMinutes: s.startMinutes, endMinutes: s.endMinutes })),
        );
      }
      const [detailed] = await loadStaffDetails([existing]);
      return c.json({ staff: detailed });
    },
  )

  /* ── Tambah cuti ─────────────────────────────────────────── */
  .post(
    '/:id/time-off',
    requireAuth,
    requireWorkspace,
    zValidator('param', staffIdParamSchema),
    zValidator('json', timeOffSchema),
    async (c) => {
      const { id } = c.req.valid('param');
      const existing = await findStaff(c.get('workspaceId'), id);
      if (!existing) return c.json({ error: 'Staf tidak ditemukan' }, 404);

      const body = c.req.valid('json');
      const [row] = await db
        .insert(staffTimeOff)
        .values({
          staffId: id,
          // Simpan tanggal (tanpa zona) sebagai tengah malam UTC — interpretasi
          // hari lokal dilakukan mesin availabilitas via zona staf.
          startDate: new Date(`${body.startDate}T00:00:00.000Z`),
          endDate: new Date(`${body.endDate}T00:00:00.000Z`),
          reason: body.reason?.trim() ? body.reason.trim() : null,
        })
        .returning();
      return c.json(
        {
          timeOff: {
            id: row.id,
            startDate: row.startDate.toISOString(),
            endDate: row.endDate.toISOString(),
            reason: row.reason ?? null,
          },
        },
        201,
      );
    },
  )

  /* ── Hapus cuti ──────────────────────────────────────────── */
  .delete(
    '/:id/time-off/:timeOffId',
    requireAuth,
    requireWorkspace,
    zValidator('param', timeOffIdParamSchema),
    async (c) => {
      const { id, timeOffId } = c.req.valid('param');
      const existing = await findStaff(c.get('workspaceId'), id);
      if (!existing) return c.json({ error: 'Staf tidak ditemukan' }, 404);

      const [deleted] = await db
        .delete(staffTimeOff)
        .where(and(eq(staffTimeOff.id, timeOffId), eq(staffTimeOff.staffId, id)))
        .returning({ id: staffTimeOff.id });
      if (!deleted) return c.json({ error: 'Cuti tidak ditemukan' }, 404);
      return c.json({ ok: true, id: deleted.id });
    },
  );
