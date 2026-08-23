import { randomUUID } from 'node:crypto';
import { and, count, desc, eq, gte, ilike, inArray, isNotNull, isNull, lt, lte, max, ne, or, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import {
  determineCallGoal,
  GOAL_TYPES,
  INDUSTRIES,
  type BookingGoalContext,
  type BusinessGoalContext,
  type GoalDecision,
} from '@oriole/call-goals';
import { bookings, calleCalls, services, staffMembers, workspaces } from '@oriole/database';

import { db } from '../db/index.ts';
import { DEFAULT_BOOKING_TITLE, loadServiceNames } from '../lib/booking-title.ts';
import { findService } from '../lib/service-catalog.ts';
import { countCallAttempts } from '../lib/booking-goal.ts';
import { assertSlotAvailable, type AvailabilityAssert } from '../lib/availability.ts';
import {
  expandRecurrence,
  recurrenceSchema,
  RECURRENCE_MAX_OCCURRENCES,
  RECURRENCE_MAX_LOOKAHEAD_MONTHS,
} from '../lib/recurrence.ts';
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
import {
  emitCalendarBookingEvent,
  emitOutgoingWebhookEvent,
  emitSlackBookingEvent,
  emitTelegramBookingAlert,
  emitVideoLinkEvent,
} from '../lib/integration-events.ts';
import { captureBookingEvent } from '../lib/analytics.ts';
import { dispatchTelegramReminder, TelegramDispatchError } from '../lib/telegram-handler.ts';
import { requireAuth } from '../middleware/auth.ts';
import { requireWorkspace, type WorkspaceVariables } from '../middleware/workspace.ts';

const goalOverrideSchema = z.object({
  goalType: z.enum([...GOAL_TYPES, 'auto']).optional(),
  customInstruction: z.string().trim().max(500).optional(),
});

const createBookingSchema = z.object({
  // Title TIDAK dikirim — selalu diambil dari nama layanan katalog.
  description: z.string().trim().max(2_000).optional(),
  scheduledAt: z.iso.datetime({ offset: true }),
  timezone: z.string().trim().min(1).max(64).default('UTC'),
  customerName: z.string().trim().max(200).optional(),
  phone: phoneField.optional(),
  industry: z.enum(INDUSTRIES).optional(),
  noShowCount: z.number().int().min(0).max(99).optional(),
  changeRequested: z.boolean().optional(),
  goal: goalOverrideSchema.optional(),
  /** Staf penanggung jawab booking — divalidasi milik workspace & aktif. */
  staffId: z.string().uuid().nullable().optional(),
  /**
   * Durasi layanan (menit, 5..720) — dipakai slot engine & event kalender.
   * Opsional: bila tidak dikirim, diambil dari durasi layanan katalog.
   */
  durationMinutes: z.number().int().min(5).max(720).optional(),
  /**
   * Layanan katalog — WAJIB. Booking diambil dari services, bukan input
   * manual: title & durasi yang tidak dikirim eksplisit diisi dari katalog
   * (auto-fill); override eksplisit selalu menang. Layanan harus milik
   * workspace ini (tenant-scoped, divalidasi di resolveServiceDefaults).
   */
  serviceId: z.string().uuid(),
  /** Aturan pengulangan — ekspansi jadi banyak instance booking (satu seri). */
  recurrence: recurrenceSchema.nullable().optional(),
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
  staffId: z.string().uuid().nullable().optional(),
  durationMinutes: z.number().int().min(5).max(720).optional(),
  /** Ganti layanan katalog — title/durasi/staf auto-fill bila tidak di-override. */
  serviceId: z.string().uuid().nullable().optional(),
  /** true + status=cancelled → batalkan SELURUH instance seri pengulangan. */
  applyToSeries: z.boolean().optional(),
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
function bookingWebhookPayload(
  row: BookingRow,
  serviceName: string | null = null,
) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: serviceName ?? DEFAULT_BOOKING_TITLE,
    description: row.description,
    status: row.status,
    scheduledAt: row.scheduledAt.toISOString(),
    timezone: row.timezone,
    customerName: row.customerName,
    phone: row.phone,
    contactId: row.contactId ?? null,
    staffId: row.staffId ?? null,
    durationMinutes: row.durationMinutes,
    recurrence: row.recurrence,
    recurrenceSeriesId: row.recurrenceSeriesId ?? null,
    industry: row.industry,
    serviceId: row.serviceId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeBooking(
  row: BookingRow,
  attempts: { total: number; failed: number },
  decision: GoalDecision,
  /** Nama layanan katalog — title booking selalu diturunkan dari service. */
  serviceName: string | null = null,
) {
  return {
    id: row.id,
    title: serviceName ?? DEFAULT_BOOKING_TITLE,
    description: row.description,
    scheduledAt: row.scheduledAt.toISOString(),
    timezone: row.timezone,
    status: row.status,
    customerName: row.customerName,
    phone: row.phone,
    contactId: row.contactId ?? null,
    staffId: row.staffId ?? null,
    durationMinutes: row.durationMinutes,
    recurrence: row.recurrence,
    recurrenceSeriesId: row.recurrenceSeriesId ?? null,
    industry: row.industry,
    serviceId: row.serviceId ?? null,
    serviceName,
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

function toGoalContext(
  row: BookingRow,
  attempts: { total: number; failed: number },
  title: string,
): BookingGoalContext {
  return {
    id: row.id,
    title,
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

/**
 * Resolve default booking dari layanan katalog saat serviceId di-set (create)
 * atau diubah (patch). Hanya field yang TIDAK dikirim eksplisit yang diambil
 * dari katalog — override eksplisit selalu menang.
 *
 * - serviceName: nama layanan — SELALU menjadi title booking (kolom title
 *   sudah dihapus; lihat lib/booking-title.ts),
 * - durationMinutes: durasi layanan (bila tidak dikirim),
 * - staffId: staf tunggal ter-assign (bila tidak dikirim & layanan punya
 *   tepat satu staf — layanan dengan banyak staf menyerahkan pilihan ke user).
 */
async function resolveServiceDefaults(
  workspaceId: string,
  serviceId: string | null | undefined,
  provided: { durationMinutes?: number; staffId?: string | null },
): Promise<
  | {
      serviceId: string | null;
      serviceName: string | null;
      durationMinutes: number;
      staffId: string | null;
    }
  | { error: string }
> {
  if (!serviceId) {
    return {
      serviceId: null,
      serviceName: null,
      durationMinutes: provided.durationMinutes ?? 60,
      staffId: provided.staffId ?? null,
    };
  }

  const service = await findService(workspaceId, serviceId);
  if (!service) return { error: 'Layanan tidak ditemukan' };

  const staffId =
    provided.staffId !== undefined
      ? (provided.staffId ?? null)
      : service.staffIds.length === 1
        ? service.staffIds[0]
        : null;

  return {
    serviceId: service.id,
    serviceName: service.name,
    durationMinutes: provided.durationMinutes ?? service.durationMinutes,
    staffId,
  };
}

/** Pesan 409 yang bisa ditampilkan dari hasil cek availabilitas. */
function conflictMessage(check: Extract<AvailabilityAssert, { ok: false }>): string {
  switch (check.reason) {
    case 'staff-not-found':
      return 'Staf tidak ditemukan.';
    case 'outside-working-hours':
      return 'Waktu yang dipilih berada di luar jam kerja staf.';
    case 'time-off':
      return check.detail ? `Staf sedang cuti (${check.detail}).` : 'Staf sedang cuti pada tanggal tersebut.';
    case 'conflict':
      return check.detail ? `Slot sudah terisi: ${check.detail}` : 'Slot sudah terisi oleh booking lain.';
  }
}

/**
 * Validasi staf (bila di-set): harus milik workspace aktif & tidak dinonaktifkan.
 * Mengembalikan pesan error bila tidak valid, atau null bila OK.
 */
async function validateStaffAssignment(workspaceId: string, staffId: string): Promise<string | null> {
  const [staff] = await db
    .select({ id: staffMembers.id, isActive: staffMembers.isActive })
    .from(staffMembers)
    .where(and(eq(staffMembers.id, staffId), eq(staffMembers.workspaceId, workspaceId)))
    .limit(1);
  if (!staff) return 'Staf tidak ditemukan';
  if (!staff.isActive) return 'Staf dinonaktifkan';
  return null;
}

/**
 * Batalkan semua instance seri pengulangan (kecuali `excludeId` yang sudah
 * dibatalkan oleh alur utama). Setiap instance: update status + batalkan
 * reminder/auto-call + webhook + hapus event kalender.
 */
async function cancelSeriesInstances(
  workspaceId: string,
  seriesId: string,
  excludeId: string,
): Promise<{ cancelled: number }> {
  const rows = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        eq(bookings.workspaceId, workspaceId),
        eq(bookings.recurrenceSeriesId, seriesId),
        ne(bookings.id, excludeId),
        ne(bookings.status, 'cancelled'),
      ),
    );

  for (const row of rows) {
    await db
      .update(bookings)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(eq(bookings.id, row.id));
    await emitBookingCancelled(workspaceId, row.id);
    await emitAutoCallCancelled(workspaceId, row.id);
    await emitOutgoingWebhookEvent(workspaceId, 'booking.cancelled', {
      id: row.id,
      workspaceId,
    });
    await emitSlackBookingEvent(workspaceId, 'booking.cancelled', { id: row.id, workspaceId });
    await emitCalendarBookingEvent(workspaceId, row.id, 'delete');
  }
  return { cancelled: rows.length };
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
    // Filter title (label UI: Service) — title booking = nama layanan katalog
    // (kolom bookings.title sudah dihapus). Cari id layanan yang namanya
    // cocok dulu, lalu filter booking berdasarkan serviceId.
    if (title) {
      const pattern = `%${title}%`;
      const matches = await db
        .select({ id: services.id })
        .from(services)
        .where(and(eq(services.workspaceId, workspaceId), ilike(services.name, pattern)));
      conditions.push(inArray(bookings.serviceId, matches.map((row) => row.id)));
    }
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
      // Nama layanan katalog (tenant-scoped) — paralel dengan hitungan panggilan.
      const [counts, serviceNames] = await Promise.all([
        (async () => {
          const map = new Map<string, { total: number; failed: number }>();
          if (rows.length > 0) {
            const calls = await db
              .select({ bookingId: calleCalls.bookingId, status: calleCalls.status })
              .from(calleCalls)
              .where(inArray(calleCalls.bookingId, rows.map((row) => row.id)));
            for (const row of rows) {
              map.set(
                row.id,
                countCallAttempts(calls.filter((call) => call.bookingId === row.id)),
              );
            }
          }
          return map;
        })(),
        loadServiceNames(workspaceId, rows.map((row) => row.serviceId)),
      ]);
      return rows.map((row) => {
        const attempts = counts.get(row.id) ?? { total: 0, failed: 0 };
        const serviceName = row.serviceId ? (serviceNames.get(row.serviceId) ?? null) : null;
        return serializeBooking(
          row,
          attempts,
          determineCallGoal(toGoalContext(row, attempts, serviceName ?? DEFAULT_BOOKING_TITLE), {
            reminderWindowHours: leadHours,
          }),
          serviceName,
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

  /* ── Buat booking (1 instance; atau N instance bila recurrence) ── */
  .post('/', requireAuth, requireWorkspace, zValidator('json', createBookingSchema), async (c) => {
    const body = c.req.valid('json');
    const { goal, recurrence, staffId, durationMinutes, serviceId, ...fields } = body;
    const persisted = toPersistedGoal(goal);
    const workspaceId = c.get('workspaceId');

    // Auto-fill dari katalog layanan (serviceName/durasi/staf) bila serviceId
    // di-set — title booking = nama layanan (kolom title sudah tidak ada).
    const defaults = await resolveServiceDefaults(workspaceId, serviceId, {
      durationMinutes,
      staffId,
    });
    if ('error' in defaults) return c.json({ error: defaults.error }, 400);
    const duration = defaults.durationMinutes;

    // Staf harus milik workspace ini & aktif.
    if (defaults.staffId) {
      const staffError = await validateStaffAssignment(workspaceId, defaults.staffId);
      if (staffError) return c.json({ error: staffError }, 400);
    }

    // Ekspansi pengulangan → daftar instance (dibatasi horizon & jumlah).
    const anchor = new Date(fields.scheduledAt);
    let instances: Date[];
    let recurrenceSeriesId: string | null = null;
    if (recurrence) {
      const horizon = new Date(anchor);
      horizon.setUTCMonth(horizon.getUTCMonth() + RECURRENCE_MAX_LOOKAHEAD_MONTHS);
      instances = expandRecurrence(recurrence, anchor, {
        to: horizon,
        maxOccurrences: RECURRENCE_MAX_OCCURRENCES,
      });
      if (instances.length === 0) {
        return c.json({ error: 'Aturan pengulangan tidak menghasilkan jadwal dalam 12 bulan.' }, 400);
      }
      if (instances.length > 1) recurrenceSeriesId = randomUUID();
    } else {
      instances = [anchor];
    }

    // Double-booking prevention: periksa SEMUA instance dulu (jadwal staf,
    // cuti, booking aktif, kalender eksternal) sebelum insert apa pun —
    // gagal total dengan 409 bila salah satu slot bertabrakan.
    for (const start of instances) {
      const end = new Date(start.getTime() + duration * 60_000);
      const check = await assertSlotAvailable({
        workspaceId,
        staffId: defaults.staffId,
        start,
        end,
      });
      if (!check.ok) {
        return c.json({ error: conflictMessage(check) }, 409);
      }
    }

    // Insert tiap instance (satu seri bila recurrence).
    const inserted: BookingRow[] = [];
    for (const start of instances) {
      const [row] = await db
        .insert(bookings)
        .values({
          userId: c.get('userId'),
          workspaceId,
          description: fields.description ?? null,
          scheduledAt: start,
          timezone: fields.timezone,
          customerName: fields.customerName ?? null,
          phone: fields.phone ?? null,
          industry: fields.industry,
          noShowCount: fields.noShowCount ?? 0,
          changeRequested: fields.changeRequested ?? false,
          goalType: persisted.goalType,
          customInstruction: persisted.customInstruction,
          staffId: defaults.staffId,
          durationMinutes: duration,
          serviceId: defaults.serviceId,
          recurrence: recurrence ?? null,
          recurrenceSeriesId,
        })
        .returning();
      inserted.push(row);
    }

    const primary = inserted[0];

    // Integrasi Kontak: sinkronkan SEKALI untuk customer, lalu tautkan semua
    // instance ke kontak yang sama (mereka customer yang sama).
    primary.contactId = await syncBookingContact({
      userId: c.get('userId'),
      workspaceId,
      bookingId: primary.id,
      customerName: primary.customerName,
      phone: primary.phone,
    });
    if (inserted.length > 1 && primary.contactId) {
      await db
        .update(bookings)
        .set({ contactId: primary.contactId })
        .where(inArray(bookings.id, inserted.map((row) => row.id)));
      for (const row of inserted) row.contactId = primary.contactId;
    }

    // Reminder + auto-call + kalender per instance; webhook keluar hanya
    // untuk instance utama (hindari spam N event untuk satu seri).
    // Jalankan semua emit secara paralel agar tidak menimbulkan latensi serial Inngest.
    const emitTasks: Promise<unknown>[] = [];
    for (const row of inserted) {
      emitTasks.push(
        emitBookingCreated({
          workspaceId,
          bookingId: row.id,
          scheduledAt: row.scheduledAt,
          timezone: row.timezone,
        }),
      );
      if (row.phone) {
        emitTasks.push(
          emitAutoCallScheduled({
            workspaceId,
            bookingId: row.id,
            scheduledAt: row.scheduledAt,
            timezone: row.timezone,
          }),
        );
      }
      emitTasks.push(emitCalendarBookingEvent(workspaceId, row.id, 'upsert'));
    }
    const webhookPayload = bookingWebhookPayload(primary, defaults.serviceName);
    emitTasks.push(emitOutgoingWebhookEvent(workspaceId, 'booking.created', webhookPayload));
    emitTasks.push(emitSlackBookingEvent(workspaceId, 'booking.created', webhookPayload));
    emitTasks.push(emitTelegramBookingAlert(workspaceId, 'booking.created', webhookPayload));
    emitTasks.push(emitVideoLinkEvent(workspaceId, primary.id));

    // Tunggu emit selesai secara paralel dengan batas waktu agar tidak memicu timeout pada client
    await Promise.race([
      Promise.allSettled(emitTasks),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);

    // Analitik: hanya instance utama (satu event per seri, mirror webhook).
    captureBookingEvent('booking.created', {
      workspaceId,
      bookingId: primary.id,
      userId: c.get('userId'),
      source: primary.source,
      goalType: primary.goalType,
      status: primary.status,
    });

    const attempts = { total: 0, failed: 0 };
    return c.json(
      {
        booking: serializeBooking(
          primary,
          attempts,
          determineCallGoal(toGoalContext(primary, attempts, defaults.serviceName ?? DEFAULT_BOOKING_TITLE)),
          defaults.serviceName,
        ),
        recurrence: recurrenceSeriesId
          ? { seriesId: recurrenceSeriesId, occurrences: inserted.length }
          : undefined,
      },
      201,
    );
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
    const serviceName = (await loadServiceNames(c.get('workspaceId'), [row.serviceId])).get(row.serviceId ?? '') ?? null;
    const context = toGoalContext(row, attempts, serviceName ?? DEFAULT_BOOKING_TITLE);
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
      booking: serializeBooking(row, attempts, decision, serviceName),
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
      const { goal, applyToSeries, serviceId, ...fields } = body;
      const values: Record<string, unknown> = { updatedAt: new Date() };

      if (fields.description !== undefined) values.description = fields.description;
      if (fields.scheduledAt !== undefined) values.scheduledAt = new Date(fields.scheduledAt);
      if (fields.timezone !== undefined) values.timezone = fields.timezone;
      if (fields.customerName !== undefined) values.customerName = fields.customerName;
      if (fields.phone !== undefined) values.phone = fields.phone;
      if (fields.industry !== undefined) values.industry = fields.industry;
      if (fields.noShowCount !== undefined) values.noShowCount = fields.noShowCount;
      if (fields.changeRequested !== undefined) values.changeRequested = fields.changeRequested;
      if (fields.status !== undefined) values.status = fields.status;
      if (fields.staffId !== undefined) values.staffId = fields.staffId;
      if (fields.durationMinutes !== undefined) values.durationMinutes = fields.durationMinutes;
      if ('goal' in body) {
        const persisted = toPersistedGoal(goal);
        values.goalType = persisted.goalType;
        values.customInstruction = persisted.customInstruction;
      }

      // Ganti layanan katalog → auto-fill durasi/staf yang TIDAK di-override
      // eksplisit. serviceId: null = lepas dari katalog (field lain tidak
      // disentuh). Title booking SELALU = nama layanan (kolom title sudah
      // dihapus — turunan saat dibaca, lihat lib/booking-title.ts).
      if ('serviceId' in body) {
        if (body.serviceId === null) {
          values.serviceId = null;
        } else {
          const defaults = await resolveServiceDefaults(c.get('workspaceId'), body.serviceId, {
            durationMinutes: fields.durationMinutes,
            staffId: fields.staffId,
          });
          if ('error' in defaults) return c.json({ error: defaults.error }, 400);
          values.serviceId = defaults.serviceId;
          if (fields.durationMinutes === undefined) values.durationMinutes = defaults.durationMinutes;
          if (fields.staffId === undefined) values.staffId = defaults.staffId;
        }
      }

      // Staf baru (eksplisit ATAU auto-fill dari layanan) harus milik
      // workspace ini & aktif.
      const nextStaffId =
        values.staffId !== undefined
          ? (values.staffId as string | null)
          : (existing.staffId ?? null);
      if (nextStaffId) {
        const staffError = await validateStaffAssignment(c.get('workspaceId'), nextStaffId);
        if (staffError) return c.json({ error: staffError }, 400);
      }

      // Double-booking prevention saat jadwal/staf/durasi berubah (termasuk
      // auto-fill dari ganti layanan). Instance ini dikecualikan
      // (excludeBookingId) — pindah slot tidak boleh menabrak dirinya sendiri.
      // Booking dibatalkan tidak memblokir.
      const nextStatus = fields.status ?? existing.status;
      const schedulingChanged =
        fields.scheduledAt !== undefined ||
        values.staffId !== undefined ||
        values.durationMinutes !== undefined;
      if (schedulingChanged && nextStatus !== 'cancelled') {
        const nextStart =
          fields.scheduledAt !== undefined ? new Date(fields.scheduledAt) : existing.scheduledAt;
        const nextDuration =
          (values.durationMinutes as number | undefined) ?? existing.durationMinutes ?? 60;
        const check = await assertSlotAvailable({
          workspaceId: c.get('workspaceId'),
          staffId: nextStaffId,
          start: nextStart,
          end: new Date(nextStart.getTime() + nextDuration * 60_000),
          excludeBookingId: existing.id,
        });
        if (!check.ok) {
          return c.json({ error: conflictMessage(check) }, 409);
        }
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
      const serviceName =
        (await loadServiceNames(c.get('workspaceId'), [updated.serviceId])).get(updated.serviceId ?? '') ?? null;

      // Sinkronkan reminder terjadwal dengan perubahan status / jadwal.
      const workspaceId = c.get('workspaceId');
      const prevStatus = existing.status;
      const newStatus = (values.status as string | undefined) ?? prevStatus;
      const prevAt = existing.scheduledAt;
      const newAt = values.scheduledAt instanceof Date ? values.scheduledAt : prevAt;
      const emitTasks: Promise<unknown>[] = [];

      if (newStatus === 'completed' && prevStatus !== 'completed') {
        emitTasks.push(emitBookingCompleted(workspaceId, updated.id));
        emitTasks.push(emitAutoCallCancelled(workspaceId, updated.id));
      } else if (newStatus === 'cancelled' && prevStatus !== 'cancelled') {
        emitTasks.push(emitBookingCancelled(workspaceId, updated.id));
        emitTasks.push(emitAutoCallCancelled(workspaceId, updated.id));
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
          emitTasks.push(
            emitBookingCreated({
              workspaceId,
              bookingId: updated.id,
              scheduledAt: newAt,
              timezone: updated.timezone,
            }),
          );
          if (updated.phone) {
            emitTasks.push(
              emitAutoCallScheduled({
                workspaceId,
                bookingId: updated.id,
                scheduledAt: newAt,
                timezone: updated.timezone,
              }),
            );
          }
        }
      }

      // Integrasi eksternal: webhook + kalender mengikuti status baru.
      const payload = bookingWebhookPayload(updated, serviceName);
      if (newStatus === 'completed' && prevStatus !== 'completed') {
        emitTasks.push(emitOutgoingWebhookEvent(workspaceId, 'booking.completed', payload));
        emitTasks.push(emitSlackBookingEvent(workspaceId, 'booking.completed', payload));
        captureBookingEvent('booking.completed', {
          workspaceId,
          bookingId: updated.id,
          userId: c.get('userId'),
          goalType: updated.goalType,
          status: updated.status,
        });
      } else if (newStatus === 'cancelled' && prevStatus !== 'cancelled') {
        emitTasks.push(emitOutgoingWebhookEvent(workspaceId, 'booking.cancelled', payload));
        emitTasks.push(emitSlackBookingEvent(workspaceId, 'booking.cancelled', payload));
        // Booking dibatalkan → hapus event kalender.
        emitTasks.push(emitCalendarBookingEvent(workspaceId, updated.id, 'delete'));
        captureBookingEvent('booking.cancelled', {
          workspaceId,
          bookingId: updated.id,
          userId: c.get('userId'),
          status: updated.status,
        });
      } else {
        emitTasks.push(emitOutgoingWebhookEvent(workspaceId, 'booking.updated', payload));
        emitTasks.push(emitSlackBookingEvent(workspaceId, 'booking.updated', payload));
        emitTasks.push(emitCalendarBookingEvent(workspaceId, updated.id, 'upsert'));
        captureBookingEvent('booking.updated', {
          workspaceId,
          bookingId: updated.id,
          userId: c.get('userId'),
          goalType: updated.goalType,
          status: updated.status,
        });
      }

      await Promise.race([
        Promise.allSettled(emitTasks),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);

      // Batalkan seluruh seri pengulangan bila diminta (status → cancelled).
      let seriesCancelled = 0;
      if (newStatus === 'cancelled' && applyToSeries === true && existing.recurrenceSeriesId) {
        const result = await cancelSeriesInstances(
          workspaceId,
          existing.recurrenceSeriesId,
          updated.id,
        );
        seriesCancelled = result.cancelled;
      }

      return c.json({
        booking: serializeBooking(
          updated,
          attempts,
          determineCallGoal(toGoalContext(updated, attempts, serviceName ?? DEFAULT_BOOKING_TITLE)),
          serviceName,
        ),
        seriesCancelled: seriesCancelled > 0 ? seriesCancelled : undefined,
      });
    },
  )

  /* ── Pastikan kontak customer ada (link-on-demand) ──────────
   * Dipakai kolom customer di daftar booking: booking lama (sebelum fitur
   * contact-sync) belum punya contactId — endpoint ini mencari kontak by
   * nomor (atau membuatnya bila belum ada & ada nama), lalu mengembalikan
   * contactId untuk membuka detail customer. Idempoten: nomor sama → kontak
   * yang sama. */
  .post(
    '/:id/ensure-contact',
    requireAuth,
    requireWorkspace,
    zValidator('param', bookingIdParamSchema),
    async (c) => {
      const { id } = c.req.valid('param');
      const booking = await findBooking(c.get('workspaceId'), id);
      if (!booking) {
        return c.json({ error: 'Booking tidak ditemukan' }, 404);
      }

      const contactId = await syncBookingContact({
        userId: c.get('userId'),
        workspaceId: c.get('workspaceId'),
        bookingId: booking.id,
        customerName: booking.customerName,
        phone: booking.phone,
      });
      return c.json({ contactId });
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
      const workspaceId = c.get('workspaceId');
      const emitTasks: Promise<unknown>[] = [
        emitBookingCancelled(workspaceId, deleted.id),
        emitAutoCallCancelled(workspaceId, deleted.id),
        emitOutgoingWebhookEvent(workspaceId, 'booking.deleted', {
          id: deleted.id,
          workspaceId,
        }),
        emitSlackBookingEvent(workspaceId, 'booking.deleted', {
          id: deleted.id,
          workspaceId,
        }),
        emitCalendarBookingEvent(workspaceId, deleted.id, 'delete'),
      ];
      await Promise.race([
        Promise.allSettled(emitTasks),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
      captureBookingEvent('booking.deleted', {
        workspaceId,
        bookingId: deleted.id,
        userId: c.get('userId'),
      });
      return c.json({ ok: true, id: deleted.id });
    },
  )

  /* ── Integrasi chat: kirim reminder Telegram ─────────────── */
  .post('/:id/trigger-telegram', requireAuth, requireWorkspace, zValidator('param', bookingIdParamSchema), async (c) => {
    const { id } = c.req.valid('param');
    const row = await findBooking(c.get('workspaceId'), id);
    if (!row) return c.json({ error: 'Booking tidak ditemukan' }, 404);

    const [workspace] = await db
      .select({
        name: workspaces.name,
        industry: workspaces.industry,
        chatLanguage: workspaces.chatLanguage,
      })
      .from(workspaces)
      .where(and(eq(workspaces.id, c.get('workspaceId')), isNull(workspaces.deletedAt)))
      .limit(1);

    // Mesin goal yang sama dengan CALL-E — keputusan channel-agnostic.
    const calls = await db
      .select({ status: calleCalls.status })
      .from(calleCalls)
      .where(eq(calleCalls.bookingId, row.id));
    const attempts = countCallAttempts(calls);
    const serviceName = (await loadServiceNames(c.get('workspaceId'), [row.serviceId])).get(row.serviceId ?? '') ?? null;
    const context = toGoalContext(row, attempts, serviceName ?? DEFAULT_BOOKING_TITLE);
    const decision = determineCallGoal(context);

    if (decision.goalType === null) {
      return c.json({ error: 'Tidak ada goal untuk status booking ini (dibatalkan / selesai).' }, 400);
    }

    try {
      const { messageId } = await dispatchTelegramReminder({
        workspaceId: c.get('workspaceId'),
        booking: {
          id: row.id,
          title: serviceName ?? DEFAULT_BOOKING_TITLE,
          customerName: row.customerName,
          phone: row.phone,
          scheduledAt: row.scheduledAt,
          timezone: row.timezone,
          videoLink: row.videoLink,
        },
        businessName: workspace?.name ?? null,
        language: workspace?.chatLanguage === 'id' ? 'id' : 'en',
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
