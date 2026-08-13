import { and, eq, gte, inArray, isNotNull } from 'drizzle-orm';
import { bookings, conversations, staffMembers, workspaces } from '@oriole/database';
import { canonicalPhone, normalizePhone, samePhone } from '@oriole/messaging';

import { db } from '../db/index.ts';
import { withBookingTitle, withBookingTitles } from './booking-title.ts';
import { assertSlotAvailable, getAvailableSlots, loadStaffAvailability, scheduleWindowsForDay } from './availability.ts';
import type { ServiceSnapshot } from './service-catalog.ts';
import { syncBookingContact } from './contact-sync.ts';
import { emitAutoCallCancelled, emitAutoCallScheduled, emitBookingCancelled, emitBookingCreated } from './reminders.ts';
import {
  emitCalendarBookingEvent,
  emitOutgoingWebhookEvent,
  emitSlackBookingEvent,
} from './integration-events.ts';
import { formatLocalTime, matchService, parseYmd, resolveInboundStaffAndTimezone } from './vapi-inbound.ts';
import { zonedDayStart, zonedTimeToUtc } from './timezone.ts';

/**
 * Tool/function calling untuk booking — LLM TIDAK pernah mengarang hasil.
 * LLM hanya meminta action via tool; SEMUA eksekusi ada di sini (backend,
 * tenant-scoped): availability dari mesin slot live, booking/ubah/batal dari
 * pipeline yang sama dengan route /bookings & form booking.
 *
 * Nama & parameter mengikuti arsitektur existing (vapi-inbound): service
 * dicocokkan dari katalog, staf/zona di-resolve konsisten, idempotensi via
 * sourceRef, dan post-create pipeline identik (kontak + reminder + auto-call
 * + kalender + webhook + slack).
 */

export interface AiToolContext {
  workspaceId: string;
  conversationId: string;
  /** Nomor HP customer (wa_id) — disuntikkan server-side, BUKAN dari LLM. */
  customerPhone?: string | null;
  customerName?: string | null;
  /** Id pesan masuk (wamid) — idempotensi create_booking terhadap retry webhook. */
  providerEventId?: string;
  language?: 'en' | 'id';
}

export type AiToolOutcome =
  | { ok: true; result: Record<string, unknown>; bookingIds?: string[] }
  | { ok: false; error: string };

type BookingRow = typeof bookings.$inferSelect;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Deskripsi tool per bahasa — bagian dari prompt (OpenAI function schema). */
function toolDescription(name: string, language: 'en' | 'id'): string {
  const id = language === 'id';
  const map: Record<string, string> = {
    get_available_slots: id
      ? 'Cek slot janji temu tersedia pada tanggal (dan layanan) tertentu. Panggil SEBELUM mengonfirmasi waktu apa pun — jangan pernah mengarang ketersediaan.'
      : 'Check available appointment slots for a date (and optional service). Call BEFORE confirming any time — never invent availability.',
    get_service: id
      ? 'Ambil info satu layanan dari katalog (nama, durasi, harga, deskripsi). Panggil untuk pertanyaan detail layanan.'
      : 'Fetch one service from the catalog (name, duration, price, description). Call for service detail questions.',
    get_staff_availability: id
      ? 'Cek jam kerja staf pada tanggal tertentu (dan jumlah slot kosong). Panggil saat customer menanyakan ketersediaan staf tertentu.'
      : 'Check staff working hours for a date (and open slot count). Call when the customer asks about a specific staff member.',
    get_customer_bookings: id
      ? 'Ambil daftar booking customer (yang akan datang & terbaru) untuk nomor teleponnya. Panggil saat customer bertanya status/daftar booking-nya.'
      : 'Fetch the customer\'s bookings (upcoming & recent) for their phone number. Call when the customer asks about their bookings.',
    create_booking: id
      ? 'Buat booking setelah customer setuju dengan layanan, tanggal, dan jam. Mengembalikan konfirmasi yang harus disampaikan.'
      : 'Create a booking once the customer agrees on a service, date and time. Returns the confirmation to relay.',
    reschedule_booking: id
      ? 'Ubah jadwal booking customer yang sudah ada ke tanggal/jam baru (setelah cek get_available_slots).'
      : 'Move the customer\'s existing booking to a new date/time (after checking with get_available_slots).',
    cancel_booking: id
      ? 'Batalkan booking customer yang sudah ada setelah ia meminta pembatalan dengan jelas.'
      : 'Cancel the customer\'s existing booking after they clearly ask to cancel.',
  };
  return map[name] ?? '';
}

/** Tool schemas OpenAI-compatible — diberikan ke Groq (function calling). */
export function buildAiBookingTools(language: 'en' | 'id') {
  const dateDesc = language === 'id' ? 'Tanggal YYYY-MM-DD (contoh: 2026-08-20)' : 'Date YYYY-MM-DD (e.g. 2026-08-20)';
  return [
    {
      type: 'function' as const,
      function: {
        name: 'get_available_slots',
        description: toolDescription('get_available_slots', language),
        parameters: {
          type: 'object' as const,
          properties: {
            date: { type: 'string', description: dateDesc },
            serviceName: { type: 'string', description: 'Layanan yang ingin dipesan (opsional)' },
          },
          required: ['date'],
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'get_service',
        description: toolDescription('get_service', language),
        parameters: {
          type: 'object' as const,
          properties: {
            serviceName: { type: 'string', description: 'Nama layanan' },
          },
          required: ['serviceName'],
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'get_staff_availability',
        description: toolDescription('get_staff_availability', language),
        parameters: {
          type: 'object' as const,
          properties: {
            date: { type: 'string', description: dateDesc },
            staffName: { type: 'string', description: 'Nama staf (opsional — kosong = staf pertama)' },
          },
          required: ['date'],
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'get_customer_bookings',
        description: toolDescription('get_customer_bookings', language),
        parameters: { type: 'object' as const, properties: {} },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'create_booking',
        description: toolDescription('create_booking', language),
        parameters: {
          type: 'object' as const,
          properties: {
            serviceName: { type: 'string', description: 'Nama layanan yang dipesan' },
            date: { type: 'string', description: dateDesc },
            time: { type: 'string', description: 'Jam mulai HH:MM (dari hasil get_available_slots)' },
            notes: { type: 'string', description: 'Catatan tambahan (opsional)' },
          },
          required: ['serviceName', 'date', 'time'],
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'reschedule_booking',
        description: toolDescription('reschedule_booking', language),
        parameters: {
          type: 'object' as const,
          properties: {
            newDate: { type: 'string', description: dateDesc },
            newTime: { type: 'string', description: 'Jam mulai baru HH:MM (dari hasil get_available_slots)' },
          },
          required: ['newDate', 'newTime'],
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'cancel_booking',
        description: toolDescription('cancel_booking', language),
        parameters: { type: 'object' as const, properties: {} },
      },
    },
  ];
}

/* ──────────────────────────────────────────────────────────────
 * Eksekusi tool — satu entry, dispatching per nama (mirip vapi-inbound)
 * ────────────────────────────────────────────────────────────── */

export async function executeAiTool(
  ctx: AiToolContext,
  name: string,
  rawArguments: string | undefined,
): Promise<AiToolOutcome> {
  let args: Record<string, unknown>;
  try {
    args = rawArguments ? (JSON.parse(rawArguments) as Record<string, unknown>) : {};
  } catch {
    return { ok: false, error: 'Argumen tool bukan JSON valid.' };
  }

  switch (name) {
    case 'get_available_slots':
      return getAvailableSlotsTool(ctx, args);
    case 'get_service':
      return getServiceTool(ctx, args);
    case 'get_staff_availability':
      return getStaffAvailabilityTool(ctx, args);
    case 'get_customer_bookings':
      return getCustomerBookingsTool(ctx);
    case 'create_booking':
      return createBookingTool(ctx, args);
    case 'reschedule_booking':
      return rescheduleBookingTool(ctx, args);
    case 'cancel_booking':
      return cancelBookingTool(ctx);
    default:
      return { ok: false, error: `Tool tidak dikenal: ${name}` };
  }
}

/* ──────────────────────────────────────────────────────────────
 * get_available_slots & get_service — data live, tenant-scoped
 * ────────────────────────────────────────────────────────────── */

async function getAvailableSlotsTool(
  ctx: AiToolContext,
  args: Record<string, unknown>,
): Promise<AiToolOutcome> {
  const date = typeof args.date === 'string' ? args.date : '';
  const parsed = parseYmd(date);
  if (!parsed) return { ok: false, error: 'Format tanggal tidak valid. Gunakan YYYY-MM-DD.' };

  const matched = await matchService(
    ctx.workspaceId,
    typeof args.serviceName === 'string' ? args.serviceName : undefined,
  );
  if ('error' in matched) return { ok: false, error: matched.error };

  const { staffId, timezone } = await resolveInboundStaffAndTimezone(matched.service);
  const dayStart = zonedDayStart(parsed.year, parsed.month, parsed.day, timezone);
  const dayEnd = zonedDayStart(parsed.year, parsed.month, parsed.day + 1, timezone);

  const result = await getAvailableSlots({
    workspaceId: ctx.workspaceId,
    staffId,
    from: dayStart,
    to: dayEnd,
    durationMinutes: matched.service.durationMinutes,
  });
  if (!result.ok) return { ok: false, error: 'Staf tidak ditemukan.' };

  const slots = result.slots.map((slot) => ({
    start: slot.start.toISOString(),
    time: formatLocalTime(slot.start, timezone),
  }));

  return {
    ok: true,
    result: {
      date,
      serviceName: matched.service.name,
      serviceId: matched.service.id,
      durationMinutes: matched.service.durationMinutes,
      timezone,
      slots: slots.slice(0, 20),
      message:
        slots.length === 0
          ? `Tidak ada slot tersedia pada ${date}. Tawarkan tanggal lain.`
          : `Ditemukan ${slots.length} slot tersedia. Sebutkan waktu-waktunya ke customer.`,
    },
  };
}

async function getServiceTool(
  ctx: AiToolContext,
  args: Record<string, unknown>,
): Promise<AiToolOutcome> {
  const serviceName = typeof args.serviceName === 'string' ? args.serviceName : '';
  const matched = await matchService(ctx.workspaceId, serviceName);
  if ('error' in matched) return { ok: false, error: matched.error };
  const service = matched.service;

  return {
    ok: true,
    result: {
      serviceId: service.id,
      name: service.name,
      durationMinutes: service.durationMinutes,
      price: service.priceMinor != null ? formatServicePrice(service) : null,
      category: service.category?.length ? service.category.join(', ') : null,
      description: service.description,
    },
  };
}

/** Format harga layanan (sen → "Rp 250.000"). */
function formatServicePrice(service: ServiceSnapshot): string {
  try {
    return new Intl.NumberFormat('id-ID', {
      style: 'currency',
      currency: service.currency || 'USD',
      maximumFractionDigits: 0,
    }).format((service.priceMinor ?? 0) / 100);
  } catch {
    return `${((service.priceMinor ?? 0) / 100).toFixed(0)} ${service.currency}`;
  }
}

async function getStaffAvailabilityTool(
  ctx: AiToolContext,
  args: Record<string, unknown>,
): Promise<AiToolOutcome> {
  const date = typeof args.date === 'string' ? args.date : '';
  const parsed = parseYmd(date);
  if (!parsed) return { ok: false, error: 'Format tanggal tidak valid. Gunakan YYYY-MM-DD.' };

  const staffName = typeof args.staffName === 'string' ? args.staffName.trim() : '';
  const rows = await db
    .select()
    .from(staffMembers)
    .where(and(eq(staffMembers.workspaceId, ctx.workspaceId), eq(staffMembers.isActive, true)))
    .limit(50);

  let staff: (typeof rows)[number] | undefined = rows[0];
  if (staffName) {
    const lower = staffName.toLowerCase();
    staff =
      rows.find((row) => row.name.toLowerCase() === lower) ??
      rows.find((row) => row.name.toLowerCase().includes(lower)) ??
      undefined;
  }
  if (!staff) {
    return {
      ok: false,
      error: staffName
        ? `Staf "${staffName}" tidak ditemukan.`
        : 'Belum ada staf aktif yang dikonfigurasi.',
    };
  }

  const loaded = await loadStaffAvailability(staff.id);
  const timezone = staff.timezone || 'UTC';
  const dayStart = zonedDayStart(parsed.year, parsed.month, parsed.day, timezone);
  const dayEnd = zonedDayStart(parsed.year, parsed.month, parsed.day + 1, timezone);
  const windows = loaded ? scheduleWindowsForDay(loaded.schedules, dayStart, timezone) : [];

  const slots = await getAvailableSlots({
    workspaceId: ctx.workspaceId,
    staffId: staff.id,
    from: dayStart,
    to: dayEnd,
    durationMinutes: 60,
  });

  return {
    ok: true,
    result: {
      date,
      staffName: staff.name,
      timezone,
      workingHours:
        windows.length > 0
          ? windows.map((w) => `${formatLocalTime(w.start, timezone)}–${formatLocalTime(w.end, timezone)}`)
          : ['24/7 (tanpa jadwal khusus)'],
      openSlotCount: slots.ok ? slots.slots.length : 0,
    },
  };
}

/* ──────────────────────────────────────────────────────────────
 * get_customer_bookings — daftar booking customer (by phone, tenant)
 * ────────────────────────────────────────────────────────────── */

async function getCustomerBookingsTool(ctx: AiToolContext): Promise<AiToolOutcome> {
  const phone = normalizePhone(ctx.customerPhone ?? '');
  if (!phone) {
    return { ok: false, error: 'Nomor telepon customer tidak diketahui.' };
  }
  const rows = await db
    .select()
    .from(bookings)
    .where(
      and(
        eq(bookings.workspaceId, ctx.workspaceId),
        isNotNull(bookings.phone),
        inArray(bookings.status, ['pending', 'confirmed']),
      ),
    )
    .limit(200);
  const mine = await withBookingTitles(
    ctx.workspaceId,
    rows
      .filter((row) => row.phone && samePhone(row.phone, phone))
      .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime()),
  );

  return {
    ok: true,
    result: {
      bookings: mine.map((row) => ({
        bookingId: row.id,
        title: row.title,
        scheduledAt: row.scheduledAt.toISOString(),
        time: formatLocalTime(row.scheduledAt, row.timezone),
        timezone: row.timezone,
        status: row.status,
      })),
      message: mine.length === 0 ? 'Tidak ada booking ditemukan untuk nomor ini.' : `Ditemukan ${mine.length} booking.`,
    },
  };
}

/* ──────────────────────────────────────────────────────────────
 * create / reschedule / cancel — pipeline booking yang sama
 * ────────────────────────────────────────────────────────────── */

async function createBookingTool(
  ctx: AiToolContext,
  args: Record<string, unknown>,
): Promise<AiToolOutcome> {
  const serviceName = typeof args.serviceName === 'string' ? args.serviceName.trim() : '';
  const date = typeof args.date === 'string' ? args.date : '';
  const time = typeof args.time === 'string' ? args.time.trim() : '';
  const notes = typeof args.notes === 'string' ? args.notes.trim() : '';

  if (!serviceName) return { ok: false, error: 'Layanan wajib diisi.' };
  const parsedDate = parseYmd(date);
  const timeMatch = TIME_RE.exec(time);
  if (!parsedDate || !timeMatch) {
    return { ok: false, error: 'Format tanggal/jam tidak valid. Gunakan YYYY-MM-DD dan HH:MM.' };
  }

  const customerName = ctx.customerName?.trim();
  if (!customerName) {
    return { ok: false, error: 'Nama customer belum diketahui. Tanyakan nama lengkap pelanggan terlebih dahulu.' };
  }
  const phone = canonicalPhone(normalizePhone(ctx.customerPhone ?? '')) ?? ctx.customerPhone ?? '';
  if (!phone) {
    return { ok: false, error: 'Nomor telepon customer tidak diketahui.' };
  }

  const matched = await matchService(ctx.workspaceId, serviceName);
  if ('error' in matched) return { ok: false, error: matched.error };

  const { staffId, timezone } = await resolveInboundStaffAndTimezone(matched.service);
  const start = zonedTimeToUtc(
    parsedDate.year,
    parsedDate.month,
    parsedDate.day,
    Number(timeMatch[1]),
    Number(timeMatch[2]),
    timezone,
  );
  if (Number.isNaN(start.getTime())) return { ok: false, error: 'Tanggal/jam tidak valid.' };
  if (start.getTime() <= Date.now()) {
    return { ok: false, error: 'Slot tersebut sudah lewat. Minta customer memilih tanggal lain.' };
  }
  const end = new Date(start.getTime() + matched.service.durationMinutes * 60_000);
  const check = await assertSlotAvailable({ workspaceId: ctx.workspaceId, staffId, start, end });
  if (!check.ok) {
    return { ok: false, error: conflictText(check) };
  }

  const [workspace] = await db
    .select({ userId: workspaces.userId })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId))
    .limit(1);
  if (!workspace) return { ok: false, error: 'Workspace tidak ditemukan.' };

  // Idempotensi: unique (workspaceId, source, sourceRef) — retry webhook
  // dengan wamid sama tidak membuat booking ganda.
  const sourceRef = `${ctx.conversationId}:${ctx.providerEventId ?? 'manual'}`;
  const [row] = await db
    .insert(bookings)
    .values({
      userId: workspace.userId,
      workspaceId: ctx.workspaceId,
      description: notes || null,
      scheduledAt: start,
      timezone,
      status: 'pending',
      customerName,
      phone,
      staffId,
      durationMinutes: matched.service.durationMinutes,
      serviceId: matched.service.id,
      source: 'ai-chat',
      sourceRef,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) {
    return { ok: false, error: 'Booking untuk pesan ini sudah dibuat sebelumnya (duplikat ditolak).' };
  }

  // Pipeline pasca-buat identik dengan route POST /bookings & vapi-inbound.
  await syncBookingContact({
    userId: workspace.userId,
    workspaceId: ctx.workspaceId,
    bookingId: row.id,
    customerName: row.customerName,
    phone: row.phone,
  });
  await emitBookingCreated({ workspaceId: ctx.workspaceId, bookingId: row.id, scheduledAt: start, timezone });
  if (row.phone) {
    await emitAutoCallScheduled({ workspaceId: ctx.workspaceId, bookingId: row.id, scheduledAt: start, timezone });
  }
  await emitCalendarBookingEvent(ctx.workspaceId, row.id, 'upsert');
  await emitOutgoingWebhookEvent(ctx.workspaceId, 'booking.created', {
    id: row.id,
    workspaceId: ctx.workspaceId,
    title: matched.service.name,
    status: row.status,
    scheduledAt: row.scheduledAt.toISOString(),
    timezone: row.timezone,
    customerName: row.customerName,
    phone: row.phone,
    source: row.source,
    sourceRef: row.sourceRef,
  });
  await emitSlackBookingEvent(ctx.workspaceId, 'booking.created', {
    id: row.id,
    workspaceId: ctx.workspaceId,
    title: matched.service.name,
    status: row.status,
  });

  return {
    ok: true,
    bookingIds: [row.id],
    result: {
      bookingId: row.id,
      title: matched.service.name,
      serviceId: matched.service.id,
      date,
      scheduledAt: start.toISOString(),
      time: formatLocalTime(start, timezone),
      timezone,
      customerName,
      message: `Booking dibuat: ${matched.service.name} pada ${date} pukul ${time}.`,
    },
  };
}

/** Resolve booking target untuk reschedule/cancel (conversation → phone). */
async function resolveChatBooking(ctx: AiToolContext): Promise<BookingRow | null> {
  const [conversation] = await db
    .select({ bookingId: conversations.bookingId })
    .from(conversations)
    .where(eq(conversations.id, ctx.conversationId))
    .limit(1);
  if (conversation?.bookingId) {
    const [linked] = await db
      .select()
      .from(bookings)
      .where(
        and(
          eq(bookings.id, conversation.bookingId),
          eq(bookings.workspaceId, ctx.workspaceId),
          inArray(bookings.status, ['pending', 'confirmed']),
        ),
      )
      .limit(1);
    if (linked) return linked;
  }

  const phone = normalizePhone(ctx.customerPhone ?? '');
  if (!phone) return null;
  const rows = await db
    .select()
    .from(bookings)
    .where(
      and(
        eq(bookings.workspaceId, ctx.workspaceId),
        isNotNull(bookings.phone),
        inArray(bookings.status, ['pending', 'confirmed']),
        gte(bookings.scheduledAt, new Date()),
      ),
    )
    .orderBy(bookings.scheduledAt)
    .limit(200);
  return rows.find((row) => row.phone && samePhone(row.phone, phone)) ?? null;
}

async function rescheduleBookingTool(
  ctx: AiToolContext,
  args: Record<string, unknown>,
): Promise<AiToolOutcome> {
  const newDate = typeof args.newDate === 'string' ? args.newDate : '';
  const newTime = typeof args.newTime === 'string' ? args.newTime.trim() : '';
  const parsedDate = parseYmd(newDate);
  const timeMatch = TIME_RE.exec(newTime);
  if (!parsedDate || !timeMatch) {
    return { ok: false, error: 'Format tanggal/jam tidak valid. Gunakan YYYY-MM-DD dan HH:MM.' };
  }

  const raw = await resolveChatBooking(ctx);
  if (!raw) return { ok: false, error: 'Booking yang akan diubah tidak ditemukan.' };
  const booking = await withBookingTitle(ctx.workspaceId, raw);
  if (booking.status === 'cancelled' || booking.status === 'completed') {
    return { ok: false, error: 'Booking sudah selesai/dibatalkan — tidak bisa diubah jadwalnya.' };
  }

  const timezone = booking.timezone || 'UTC';
  const newStart = zonedTimeToUtc(
    parsedDate.year,
    parsedDate.month,
    parsedDate.day,
    Number(timeMatch[1]),
    Number(timeMatch[2]),
    timezone,
  );
  if (Number.isNaN(newStart.getTime())) return { ok: false, error: 'Tanggal/jam tidak valid.' };
  if (newStart.getTime() <= Date.now()) {
    return { ok: false, error: 'Slot tersebut sudah lewat. Minta customer memilih tanggal lain.' };
  }
  const duration = booking.durationMinutes ?? 60;
  const end = new Date(newStart.getTime() + duration * 60_000);
  const check = await assertSlotAvailable({
    workspaceId: ctx.workspaceId,
    staffId: booking.staffId,
    start: newStart,
    end,
    excludeBookingId: booking.id,
  });
  if (!check.ok) {
    return { ok: false, error: conflictText(check) };
  }

  await db
    .update(bookings)
    .set({ scheduledAt: newStart, changeRequested: false, updatedAt: new Date() })
    .where(eq(bookings.id, booking.id));
  await emitBookingCancelled(ctx.workspaceId, booking.id);
  await emitBookingCreated({
    workspaceId: ctx.workspaceId,
    bookingId: booking.id,
    scheduledAt: newStart,
    timezone,
  });
  await emitCalendarBookingEvent(ctx.workspaceId, booking.id, 'upsert');
  await emitOutgoingWebhookEvent(ctx.workspaceId, 'booking.updated', {
    id: booking.id,
    workspaceId: ctx.workspaceId,
    title: booking.title,
    scheduledAt: newStart.toISOString(),
    timezone,
    status: booking.status,
  });

  return {
    ok: true,
    bookingIds: [booking.id],
    result: {
      bookingId: booking.id,
      title: booking.title,
      date: newDate,
      scheduledAt: newStart.toISOString(),
      time: formatLocalTime(newStart, timezone),
      timezone,
      message: `Booking "${booking.title}" diubah ke ${newDate} pukul ${newTime}.`,
    },
  };
}

async function cancelBookingTool(ctx: AiToolContext): Promise<AiToolOutcome> {
  const raw = await resolveChatBooking(ctx);
  if (!raw) return { ok: false, error: 'Booking yang akan dibatalkan tidak ditemukan.' };
  const booking = await withBookingTitle(ctx.workspaceId, raw);
  if (booking.status === 'cancelled') {
    return { ok: false, error: 'Booking sudah dibatalkan sebelumnya.' };
  }

  await db
    .update(bookings)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(eq(bookings.id, booking.id));
  await emitBookingCancelled(ctx.workspaceId, booking.id);
  await emitAutoCallCancelled(ctx.workspaceId, booking.id);
  await emitCalendarBookingEvent(ctx.workspaceId, booking.id, 'delete');
  await emitOutgoingWebhookEvent(ctx.workspaceId, 'booking.cancelled', {
    id: booking.id,
    workspaceId: ctx.workspaceId,
    title: booking.title,
  });
  await emitSlackBookingEvent(ctx.workspaceId, 'booking.cancelled', {
    id: booking.id,
    workspaceId: ctx.workspaceId,
    title: booking.title,
  });

  return {
    ok: true,
    bookingIds: [booking.id],
    result: {
      bookingId: booking.id,
      title: booking.title,
      message: `Booking "${booking.title}" telah dibatalkan.`,
    },
  };
}

/** Pesan konflik slot (bahasa konsisten dengan route bookings & vapi). */
function conflictText(check: { reason: string; detail?: string }): string {
  switch (check.reason) {
    case 'staff-not-found':
      return 'Staf tidak ditemukan.';
    case 'outside-working-hours':
      return 'Waktu yang dipilih berada di luar jam kerja staf.';
    case 'time-off':
      return check.detail ? `Staf sedang cuti (${check.detail}).` : 'Staf sedang cuti pada tanggal tersebut.';
    case 'conflict':
      return check.detail ? `Slot sudah terisi: ${check.detail}` : 'Slot sudah terisi oleh booking lain.';
    default:
      return 'Slot tidak tersedia.';
  }
}
