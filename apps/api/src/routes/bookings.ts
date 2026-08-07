import { and, count, desc, eq, gte, ilike, inArray, isNotNull, isNull, lt, lte, max, or, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import {
  determineCallGoal,
  composeCallGoal,
  GOAL_TYPES,
  INDUSTRIES,
  type BookingGoalContext,
  type BusinessGoalContext,
  type GoalCustomization,
  type GoalDecision,
  type GoalType,
} from '@oriole/call-goals';
import { bookings, calleCalls, workspaces } from '@oriole/database';

import { db } from '../db/index.ts';
import { env } from '../lib/env.ts';
import { calle } from '../services/calle.ts';
import { countCallAttempts } from '../lib/booking-goal.ts';
import {
  DEFAULT_AUTO_CALL_LEAD_HOURS,
  emitAutoCallCancelled,
  emitAutoCallScheduled,
  emitBookingCancelled,
  emitBookingCompleted,
  emitBookingCreated,
  resolveAutoCallSettings,
} from '../lib/reminders.ts';
import { phoneField } from '../lib/phone.ts';
import { syncBookingContact } from '../lib/contact-sync.ts';
import { emitCalendarBookingEvent, emitOutgoingWebhookEvent } from '../lib/integration-events.ts';
import { checkCallQuota } from '../lib/quota.ts';
import { dispatchTelegramReminder, TelegramDispatchError } from '../lib/telegram-handler.ts';
import { requireAuth } from '../middleware/auth.ts';
import { requireWorkspace, type WorkspaceVariables } from '../middleware/workspace.ts';

const goalOverrideSchema = z.object({
  goalType: z.enum([...GOAL_TYPES, 'auto']).optional(),
  customInstruction: z.string().trim().max(500).optional(),
});

const createBookingSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2_000).optional(),
  scheduledAt: z.iso.datetime({ offset: true }),
  timezone: z.string().trim().min(1).max(64).default('UTC'),
  customerName: z.string().trim().max(200).optional(),
  phone: phoneField.optional(),
  industry: z.enum(INDUSTRIES).optional(),
  noShowCount: z.number().int().min(0).max(99).optional(),
  changeRequested: z.boolean().optional(),
  goal: goalOverrideSchema.optional(),
});

const bookingIdParamSchema = z.object({ id: z.string().uuid() });

/** Ukuran halaman default untuk pagination offset (UI useTablePagination). */
const DEFAULT_PAGE_SIZE = 10;

/** Filter daftar booking: judul + status + rentang jadwal + customer (ISO datetime ber-offset). */
const listQuerySchema = z
  .object({
    status: z.enum(['pending', 'confirmed', 'cancelled', 'completed']).optional(),
    // Filter judul (kolom Booking): substring case-insensitive.
    title: z.string().trim().max(200).optional(),
    // Filter customer: substring case-insensitive pada nama ATAU nomor telepon
    // (saran dropdown dari GET /api/bookings/customers).
    customer: z.string().trim().max(200).optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    // Pagination kursor: posisi setelah baris terakhir halaman sebelumnya.
    cursor: z.string().max(400).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    // Pagination offset (halaman): dipakai UI untuk nomor halaman + total.
    // Bila `page` ada, mode offset dipakai (cursor diabaikan).
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(200).optional(),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: 'Rentang tanggal tidak valid: from harus sebelum to',
  });

const cursorPayloadSchema = z.object({
  at: z.iso.datetime({ offset: true }),
  id: z.string().uuid(),
});

/** Query saran customer untuk dropdown filter (GET /api/bookings/customers). */
const customersQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

/** Decode kursor pagination ({ at, id } base64url) → kondisi keyset, atau null bila tidak ada. */
function decodeCursor(cursor: string | undefined): { at: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed = cursorPayloadSchema.safeParse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    if (!parsed.success) return null;
    return { at: new Date(parsed.data.at), id: parsed.data.id };
  } catch {
    return null;
  }
}

function encodeCursor(row: BookingRow): string {
  return Buffer.from(
    JSON.stringify({ at: row.scheduledAt.toISOString(), id: row.id }),
  ).toString('base64url');
}

const updateBookingSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2_000).nullable().optional(),
  scheduledAt: z.iso.datetime({ offset: true }).optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
  customerName: z.string().trim().max(200).nullable().optional(),
  phone: phoneField.nullable().optional(),
  industry: z.enum(INDUSTRIES).nullable().optional(),
  noShowCount: z.number().int().min(0).max(99).optional(),
  changeRequested: z.boolean().optional(),
  status: z.enum(['pending', 'confirmed', 'cancelled', 'completed']).optional(),
  goal: goalOverrideSchema.nullable().optional(),
});

/** Map goal override body → nilai kolom booking (auto/'empty' disimpan sebagai null). */
function toPersistedGoal(
  goal: z.infer<typeof goalOverrideSchema> | null | undefined,
): { goalType: string | null; customInstruction: string | null } {
  if (!goal) return { goalType: null, customInstruction: null };
  return {
    goalType: goal.goalType && goal.goalType !== 'auto' ? goal.goalType : null,
    customInstruction: goal.customInstruction?.trim() ? goal.customInstruction.trim() : null,
  };
}

type BookingRow = typeof bookings.$inferSelect;

/** Snapshot JSON booking untuk payload webhook keluar. */
function bookingWebhookPayload(row: BookingRow) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    description: row.description,
    status: row.status,
    scheduledAt: row.scheduledAt.toISOString(),
    timezone: row.timezone,
    customerName: row.customerName,
    phone: row.phone,
    contactId: row.contactId ?? null,
    industry: row.industry,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeBooking(
  row: BookingRow,
  attempts: { total: number; failed: number },
  decision: GoalDecision,
) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    scheduledAt: row.scheduledAt.toISOString(),
    timezone: row.timezone,
    status: row.status,
    customerName: row.customerName,
    phone: row.phone,
    contactId: row.contactId ?? null,
    industry: row.industry,
    goalType: row.goalType,
    customInstruction: row.customInstruction,
    noShowCount: row.noShowCount,
    changeRequested: row.changeRequested,
    calleCallId: row.calleCallId,
    callAttempts: attempts,
    autoGoal: { goalType: decision.goalType, reason: decision.reason },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toGoalContext(row: BookingRow, attempts: { total: number; failed: number }): BookingGoalContext {
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

async function findBooking(workspaceId: string, bookingId: string): Promise<BookingRow | undefined> {
  const [row] = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.workspaceId, workspaceId)))
    .limit(1);
  return row;
}

export const bookingsRoutes = new Hono<{ Variables: WorkspaceVariables }>()
  /* ── Saran nama customer untuk filter (dropdown) ──────────── */
  .get('/customers', requireAuth, requireWorkspace, zValidator('query', customersQuerySchema), async (c) => {
    const workspaceId = c.get('workspaceId');
    const { q, limit } = c.req.valid('query');

    const conditions: (SQL | undefined)[] = [
      eq(bookings.workspaceId, workspaceId),
      isNotNull(bookings.customerName),
    ];
    if (q) {
      const pattern = `%${q}%`;
      conditions.push(
        or(ilike(bookings.customerName, pattern), ilike(bookings.phone, pattern)),
      );
    }

    // Nama customer unik, diurutkan dari booking paling baru (recency menang).
    const rows = await db
      .select({ name: bookings.customerName, latestAt: max(bookings.scheduledAt) })
      .from(bookings)
      .where(and(...conditions))
      .groupBy(bookings.customerName)
      .orderBy(desc(max(bookings.scheduledAt)))
      .limit(limit);

    return c.json({ customers: rows.map((row) => ({ name: row.name })) });
  })

  /* ── List bookings workspace ─────────────────────────────── */
  .get('/', requireAuth, requireWorkspace, zValidator('query', listQuerySchema), async (c) => {
    const workspaceId = c.get('workspaceId');
    const { status, title, customer, from, to, limit, cursor: rawCursor, page, pageSize } = c.req.valid('query');

    const cursor = decodeCursor(rawCursor);
    if (rawCursor && !cursor) {
      return c.json({ error: 'Kursor pagination tidak valid' }, 400);
    }

    const conditions: (SQL | undefined)[] = [eq(bookings.workspaceId, workspaceId)];
    if (status) conditions.push(eq(bookings.status, status));
    if (title) conditions.push(ilike(bookings.title, `%${title}%`));
    if (customer) {
      const pattern = `%${customer}%`;
      conditions.push(
        or(ilike(bookings.customerName, pattern), ilike(bookings.phone, pattern)),
      );
    }
    if (from) conditions.push(gte(bookings.scheduledAt, new Date(from)));
    if (to) conditions.push(lte(bookings.scheduledAt, new Date(to)));
    // Keyset pagination: urut desc(scheduledAt), desc(id) — ambil baris setelah kursor.
    if (cursor) {
      conditions.push(
        or(
          lt(bookings.scheduledAt, cursor.at),
          and(eq(bookings.scheduledAt, cursor.at), lt(bookings.id, cursor.id)),
        ),
      );
    }

    const where = and(...conditions);

    // Window reminder workspace dipakai mesin keputusan goal (default 24 jam).
    const loadLeadHours = () =>
      db
        .select({ leadHours: workspaces.autoCallLeadHours })
        .from(workspaces)
        .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)))
        .limit(1)
        .then((rows) => rows[0]?.leadHours ?? null);
    const resolveLeadHours = (raw: number | null): number =>
      Number.isFinite(raw) && (raw ?? 0) > 0 ? (raw as number) : DEFAULT_AUTO_CALL_LEAD_HOURS;

    /** Serialisasi baris + hitung attempt CALL-E per booking (dipakai kedua mode). */
    const serializeRows = async (rows: BookingRow[], leadHours: number) => {
      const counts = new Map<string, { total: number; failed: number }>();
      if (rows.length > 0) {
        const calls = await db
          .select({ bookingId: calleCalls.bookingId, status: calleCalls.status })
          .from(calleCalls)
          .where(inArray(calleCalls.bookingId, rows.map((row) => row.id)));
        for (const row of rows) {
          counts.set(
            row.id,
            countCallAttempts(calls.filter((call) => call.bookingId === row.id)),
          );
        }
      }
      return rows.map((row) => {
        const attempts = counts.get(row.id) ?? { total: 0, failed: 0 };
        return serializeBooking(
          row,
          attempts,
          determineCallGoal(toGoalContext(row, attempts), {
            reminderWindowHours: leadHours,
          }),
        );
      });
    };

    // Mode offset (halaman) — dipakai UI dengan useTablePagination; butuh total
    // untuk menghitung jumlah halaman. Kursor tetap didukung (backward compat).
    // Query count + rows + workspace dijalankan paralel (Promise.all) — di
    // serverless setiap query = satu round-trip; paralel memangkas latensi.
    if (page !== undefined) {
      const size = pageSize ?? DEFAULT_PAGE_SIZE;
      const [countRow, rows, rawLeadHours] = await Promise.all([
        db.select({ total: count() }).from(bookings).where(where),
        db
          .select()
          .from(bookings)
          .where(where)
          .orderBy(desc(bookings.scheduledAt), desc(bookings.id))
          .limit(size)
          .offset((page - 1) * size),
        loadLeadHours(),
      ]);
      return c.json({
        bookings: await serializeRows(rows, resolveLeadHours(rawLeadHours)),
        total: countRow[0]?.total ?? 0,
        page,
        pageSize: size,
      });
    }

    // Mode kursor (lama): ambil limit+1 untuk mendeteksi halaman berikutnya.
    const [rows, rawLeadHours] = await Promise.all([
      db
        .select()
        .from(bookings)
        .where(where)
        .orderBy(desc(bookings.scheduledAt), desc(bookings.id))
        .limit(limit + 1),
      loadLeadHours(),
    ]);
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    return c.json({
      bookings: await serializeRows(pageRows, resolveLeadHours(rawLeadHours)),
      nextCursor: hasMore && pageRows.length > 0 ? encodeCursor(pageRows[pageRows.length - 1]) : null,
      hasMore,
    });
  })

  /* ── Buat booking ────────────────────────────────────────── */
  .post('/', requireAuth, requireWorkspace, zValidator('json', createBookingSchema), async (c) => {
    const body = c.req.valid('json');
    const { goal, ...fields } = body;
    const persisted = toPersistedGoal(goal);

    const [row] = await db
      .insert(bookings)
      .values({
        userId: c.get('userId'),
        workspaceId: c.get('workspaceId'),
        title: fields.title,
        description: fields.description ?? null,
        scheduledAt: new Date(fields.scheduledAt),
        timezone: fields.timezone,
        customerName: fields.customerName ?? null,
        phone: fields.phone ?? null,
        industry: fields.industry,
        noShowCount: fields.noShowCount ?? 0,
        changeRequested: fields.changeRequested ?? false,
        goalType: persisted.goalType,
        customInstruction: persisted.customInstruction,
      })
      .returning();

    // Integrasi Kontak: temukan kontak dengan nomor customer, buat bila belum
    // ada (kontak tanpa nama tidak dibuat). Mutasi `row` agar respons berisi
    // contactId yang baru disinkronkan.
    row.contactId = await syncBookingContact({
      userId: c.get('userId'),
      workspaceId: c.get('workspaceId'),
      bookingId: row.id,
      customerName: row.customerName,
      phone: row.phone,
    });

    const attempts = { total: 0, failed: 0 };

    // Jadwalkan reminder otomatis (Inngest tidur sampai reminderAt).
    await emitBookingCreated({
      workspaceId: c.get('workspaceId'),
      bookingId: row.id,
      scheduledAt: row.scheduledAt,
      timezone: row.timezone,
    });

    // Jadwalkan auto-call CALL-E bila workspace mengaktifkannya (perlu nomor
    // telepon — booking tanpa phone diskip di sini, bukan di dalam run).
    if (row.phone) {
      await emitAutoCallScheduled({
        workspaceId: c.get('workspaceId'),
        bookingId: row.id,
        scheduledAt: row.scheduledAt,
        timezone: row.timezone,
      });
    }

    // Integrasi eksternal: webhook keluar (booking.created) + mirror
    // ke Google Calendar (bila terhubung & aktif).
    await emitOutgoingWebhookEvent(c.get('workspaceId'), 'booking.created', bookingWebhookPayload(row));
    await emitCalendarBookingEvent(c.get('workspaceId'), row.id, 'upsert');

    return c.json({ booking: serializeBooking(row, attempts, determineCallGoal(toGoalContext(row, attempts))) }, 201);
  })

  /* ── Detail booking + goal preview context ───────────────── */
  .get('/:id', requireAuth, requireWorkspace, zValidator('param', bookingIdParamSchema), async (c) => {
    const { id } = c.req.valid('param');
    const row = await findBooking(c.get('workspaceId'), id);
    if (!row) return c.json({ error: 'Booking tidak ditemukan' }, 404);

    const [workspace] = await db
      .select({ name: workspaces.name, industry: workspaces.industry, callGoalLanguage: workspaces.callGoalLanguage })
      .from(workspaces)
      .where(and(eq(workspaces.id, c.get('workspaceId')), isNull(workspaces.deletedAt)))
      .limit(1);

    const calls = await db
      .select()
      .from(calleCalls)
      .where(eq(calleCalls.bookingId, row.id))
      .orderBy(desc(calleCalls.createdAt));

    const attempts = countCallAttempts(calls);
    const context = toGoalContext(row, attempts);
    const decision = determineCallGoal(context, {
      reminderWindowHours: (await resolveAutoCallSettings(c.get('workspaceId'))).leadHours,
    });
    const business: BusinessGoalContext = {
      id: c.get('workspaceId'),
      name: workspace?.name ?? null,
      industry: row.industry ?? workspace?.industry ?? null,
      language: workspace?.callGoalLanguage === 'id' ? 'id' : 'en',
    };

    return c.json({
      booking: serializeBooking(row, attempts, decision),
      bookingContext: context,
      business,
      autoGoal: decision,
      calls: calls.map((call) => ({
        id: call.id,
        calleCallId: call.calleCallId,
        phone: call.phone,
        task: call.task,
        goalType: call.goalType,
        status: call.status,
        result: call.result,
        createdAt: call.createdAt.toISOString(),
      })),
    });
  })

  /* ── Update booking (termasuk kustomisasi goal) ───────────── */
  .patch(
    '/:id',
    requireAuth,
    requireWorkspace,
    zValidator('param', bookingIdParamSchema),
    zValidator('json', updateBookingSchema),
    async (c) => {
      const { id } = c.req.valid('param');
      const existing = await findBooking(c.get('workspaceId'), id);
      if (!existing) return c.json({ error: 'Booking tidak ditemukan' }, 404);

      const body = c.req.valid('json');
      const { goal, ...fields } = body;
      const values: Record<string, unknown> = { updatedAt: new Date() };

      if (fields.title !== undefined) values.title = fields.title;
      if (fields.description !== undefined) values.description = fields.description;
      if (fields.scheduledAt !== undefined) values.scheduledAt = new Date(fields.scheduledAt);
      if (fields.timezone !== undefined) values.timezone = fields.timezone;
      if (fields.customerName !== undefined) values.customerName = fields.customerName;
      if (fields.phone !== undefined) values.phone = fields.phone;
      if (fields.industry !== undefined) values.industry = fields.industry;
      if (fields.noShowCount !== undefined) values.noShowCount = fields.noShowCount;
      if (fields.changeRequested !== undefined) values.changeRequested = fields.changeRequested;
      if (fields.status !== undefined) values.status = fields.status;
      if ('goal' in body) {
        const persisted = toPersistedGoal(goal);
        values.goalType = persisted.goalType;
        values.customInstruction = persisted.customInstruction;
      }

      const [updated] = await db
        .update(bookings)
        .set(values)
        .where(eq(bookings.id, existing.id))
        .returning();

      // Integrasi Kontak: nomor/nama customer berubah → tautkan ulang (atau
      // buat kontak baru bila nomor belum ada). Mutasi `updated` agar respons
      // memuat contactId terkini.
      if (fields.phone !== undefined || fields.customerName !== undefined) {
        updated.contactId = await syncBookingContact({
          userId: c.get('userId'),
          workspaceId: c.get('workspaceId'),
          bookingId: updated.id,
          customerName: updated.customerName,
          phone: updated.phone,
        });
      }

      const calls = await db
        .select({ status: calleCalls.status })
        .from(calleCalls)
        .where(eq(calleCalls.bookingId, updated.id));
      const attempts = countCallAttempts(calls);

      // Sinkronkan reminder terjadwal dengan perubahan status / jadwal.
      const workspaceId = c.get('workspaceId');
      const prevStatus = existing.status;
      const newStatus = (values.status as string | undefined) ?? prevStatus;
      const prevAt = existing.scheduledAt;
      const newAt = values.scheduledAt instanceof Date ? values.scheduledAt : prevAt;

      if (newStatus === 'completed' && prevStatus !== 'completed') {
        await emitBookingCompleted(workspaceId, updated.id);
        await emitAutoCallCancelled(workspaceId, updated.id);
      } else if (newStatus === 'cancelled' && prevStatus !== 'cancelled') {
        await emitBookingCancelled(workspaceId, updated.id);
        await emitAutoCallCancelled(workspaceId, updated.id);
      } else if (newStatus !== 'completed') {
        // Dijadwal ulang / diaktifkan kembali dari terminal / nomor baru ditambahkan
        // → reminder & auto-call baru. HANYA emit create (tanpa cancel dulu): run
        // lama membatalkan dirinya sendiri via guard status/schedule di dalam
        // fungsi, sehingga tidak ada race cancel-vs-create yang mematikan run baru.
        const phoneAdded = !existing.phone && Boolean(updated.phone);
        if (
          prevStatus === 'cancelled' ||
          prevStatus === 'completed' ||
          newAt.getTime() !== prevAt.getTime() ||
          phoneAdded
        ) {
          await emitBookingCreated({
            workspaceId,
            bookingId: updated.id,
            scheduledAt: newAt,
            timezone: updated.timezone,
          });
          if (updated.phone) {
            await emitAutoCallScheduled({
              workspaceId,
              bookingId: updated.id,
              scheduledAt: newAt,
              timezone: updated.timezone,
            });
          }
        }
      }

      // Integrasi eksternal: webhook + kalender mengikuti status baru.
      if (newStatus === 'completed' && prevStatus !== 'completed') {
        await emitOutgoingWebhookEvent(workspaceId, 'booking.completed', bookingWebhookPayload(updated));
      } else if (newStatus === 'cancelled' && prevStatus !== 'cancelled') {
        await emitOutgoingWebhookEvent(workspaceId, 'booking.cancelled', bookingWebhookPayload(updated));
        // Booking dibatalkan → hapus event kalender.
        await emitCalendarBookingEvent(workspaceId, updated.id, 'delete');
      } else {
        await emitOutgoingWebhookEvent(workspaceId, 'booking.updated', bookingWebhookPayload(updated));
        await emitCalendarBookingEvent(workspaceId, updated.id, 'upsert');
      }

      return c.json({
        booking: serializeBooking(updated, attempts, determineCallGoal(toGoalContext(updated, attempts))),
      });
    },
  )

  /* ── Hapus booking (workspace-scoped) ─────────────────────── */
  .delete(
    '/:id',
    requireAuth,
    requireWorkspace,
    zValidator('param', bookingIdParamSchema),
    async (c) => {
      const { id } = c.req.valid('param');
      const [deleted] = await db
        .delete(bookings)
        .where(and(eq(bookings.id, id), eq(bookings.workspaceId, c.get('workspaceId'))))
        .returning({ id: bookings.id });

      if (!deleted) {
        return c.json({ error: 'Booking tidak ditemukan' }, 404);
      }
      // Batalkan reminder & auto-call terjadwal bila ada.
      await emitBookingCancelled(c.get('workspaceId'), deleted.id);
      await emitAutoCallCancelled(c.get('workspaceId'), deleted.id);
      // Integrasi eksternal: webhook booking.deleted + hapus event kalender.
      await emitOutgoingWebhookEvent(c.get('workspaceId'), 'booking.deleted', {
        id: deleted.id,
        workspaceId: c.get('workspaceId'),
      });
      await emitCalendarBookingEvent(c.get('workspaceId'), deleted.id, 'delete');
      return c.json({ ok: true, id: deleted.id });
    },
  )

  /* ── Integrasi CALL-E: susun goal & jalankan panggilan ───── */
  .post('/:id/trigger-call', requireAuth, requireWorkspace, zValidator('param', bookingIdParamSchema), zValidator('json', goalOverrideSchema.optional()), async (c) => {
    const { id } = c.req.valid('param');
    const row = await findBooking(c.get('workspaceId'), id);
    if (!row) return c.json({ error: 'Booking tidak ditemukan' }, 404);

    const [workspace] = await db
      .select({ name: workspaces.name, industry: workspaces.industry, callGoalLanguage: workspaces.callGoalLanguage })
      .from(workspaces)
      .where(and(eq(workspaces.id, c.get('workspaceId')), isNull(workspaces.deletedAt)))
      .limit(1);

    const calls = await db
      .select({ status: calleCalls.status })
      .from(calleCalls)
      .where(eq(calleCalls.bookingId, row.id));
    const attempts = countCallAttempts(calls);
    const context = toGoalContext(row, attempts);
    const decision = determineCallGoal(context, {
      reminderWindowHours: (await resolveAutoCallSettings(c.get('workspaceId'))).leadHours,
    });
    const business: BusinessGoalContext = {
      id: c.get('workspaceId'),
      name: workspace?.name ?? null,
      industry: row.industry ?? workspace?.industry ?? null,
      language: workspace?.callGoalLanguage === 'id' ? 'id' : 'en',
    };

    // Prioritas kustomisasi: override dari request > tersimpan di booking > auto.
    const requestOverride = c.req.valid('json');
    const requestCustomization: GoalCustomization | undefined =
      requestOverride && Object.keys(requestOverride).length > 0 ? requestOverride : undefined;
    const persistedCustomization: GoalCustomization | undefined =
      row.goalType || row.customInstruction
        ? {
            goalType: row.goalType as GoalType | undefined,
            customInstruction: row.customInstruction,
          }
        : undefined;
    const customization = requestCustomization ?? persistedCustomization;

    const config = composeCallGoal({ booking: context, business, customization }, decision);
    if (!config) {
      return c.json({ error: 'Tidak ada goal untuk status booking ini (dibatalkan / selesai).' }, 400);
    }
    if (!context.phone) {
      return c.json({ error: 'Booking belum memiliki nomor telepon customer.' }, 400);
    }

    // Kuota bulanan sesuai paket (free = 10 panggilan/bulan) — cegah
    // abuse biaya CALL-E oleh user tanpa langganan aktif.
    const quota = await checkCallQuota(c.get('userId'));
    if (!quota.ok) {
      return c.json({ error: quota.message }, quota.status);
    }

    const createdCall = await calle.calls.create({
      task: config.prompt,
      recipient: { phone: context.phone, locale: config.language === 'id' ? 'id-ID' : 'en-US' },
      resultSchema: config.resultSchema,
      metadata: {
        bookingId: row.id,
        workspaceId: c.get('workspaceId'),
        userId: c.get('userId'),
        goalType: config.goalType,
      },
      webhookUrl: `${env.API_URL}/api/webhooks/calle`,
    });

    await db.insert(calleCalls).values({
      calleCallId: createdCall.id,
      userId: c.get('userId'),
      workspaceId: c.get('workspaceId'),
      bookingId: row.id,
      phone: context.phone,
      task: config.prompt,
      goalType: config.goalType,
      status: createdCall.status,
    });
    await db
      .update(bookings)
      .set({ calleCallId: createdCall.id, updatedAt: new Date() })
      .where(eq(bookings.id, row.id));

    return c.json({
      call: { id: createdCall.id, status: createdCall.status },
      goal: { goalType: config.goalType, title: config.title },
    });
  })

  /* ── Integrasi chat: kirim reminder Telegram ─────────────── */
  .post('/:id/trigger-telegram', requireAuth, requireWorkspace, zValidator('param', bookingIdParamSchema), async (c) => {
    const { id } = c.req.valid('param');
    const row = await findBooking(c.get('workspaceId'), id);
    if (!row) return c.json({ error: 'Booking tidak ditemukan' }, 404);

    const [workspace] = await db
      .select({ name: workspaces.name, industry: workspaces.industry })
      .from(workspaces)
      .where(and(eq(workspaces.id, c.get('workspaceId')), isNull(workspaces.deletedAt)))
      .limit(1);

    // Mesin goal yang sama dengan CALL-E — keputusan channel-agnostic.
    const calls = await db
      .select({ status: calleCalls.status })
      .from(calleCalls)
      .where(eq(calleCalls.bookingId, row.id));
    const attempts = countCallAttempts(calls);
    const context = toGoalContext(row, attempts);
    const decision = determineCallGoal(context);

    if (decision.goalType === null) {
      return c.json({ error: 'Tidak ada goal untuk status booking ini (dibatalkan / selesai).' }, 400);
    }

    try {
      const { messageId } = await dispatchTelegramReminder({
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
        message: { messageId },
        channel: 'telegram',
        goal: { goalType: decision.goalType, reason: decision.reason },
      });
    } catch (error) {
      if (error instanceof TelegramDispatchError) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }
  });
