import { and, asc, eq } from 'drizzle-orm';
import { bookings, services, waitlistEntries, workspaces } from '@oriole/database';
import { canonicalPhone, normalizePhone } from '@oriole/messaging';

import { db } from '../db/index.ts';
import { inngest } from '../inngest/client.ts';
import { assertSlotAvailable } from './availability.ts';
import { syncBookingContact } from './contact-sync.ts';
import { emitAutoCallScheduled, emitBookingCreated } from './reminders.ts';
import {
  emitCalendarBookingEvent,
  emitOutgoingWebhookEvent,
  emitSlackBookingEvent,
  emitTelegramBookingAlert,
} from './integration-events.ts';

/**
 * Waitlist (daftar tunggu) — customer yang ingin slot yang belum tersedia.
 *
 * Alur end-to-end:
 *   1. `joinWaitlist` — customer masuk daftar tunggu (via tool AI / chat).
 *   2. Booking dibatalkan → pemanggil mengirim `waitlist/slot-freed` (Inngest).
 *   3. Fungsi Inngest `fillWaitlistSlot` mengklaim entri berikutnya yang cocok
 *      (`claimNextWaiting`), mengirim tawaran ke channel customer, dan menandai
 *      `offered` beserta detail slot yang dilepas.
 *   4. Customer membalas "Ya"/"Tidak" → `bookWaitlistOffer` membuat booking
 *      dari slot tersimpan, atau `markWaitlistDeclined`.
 */

export type WaitlistEntry = typeof waitlistEntries.$inferSelect;

export interface WaitlistJoinInput {
  workspaceId: string;
  serviceId?: string | null;
  staffId?: string | null;
  customerName?: string | null;
  contactPhone?: string | null;
  channelType: string;
  channelIdentifier?: string | null;
  preferredDate?: string | null;
  timePreference?: string | null;
}

/**
 * Masukkan customer ke daftar tunggu. Dedup: entri `waiting` yang sudah ada
 * untuk (workspace, channel/phone, service) yang sama tidak dibuat duplikat.
 */
export async function joinWaitlist(
  input: WaitlistJoinInput,
): Promise<{ entry: WaitlistEntry; created: boolean }> {
  // Dedup longgar: entri 'waiting' untuk workspace ini dibandingkan di JS
  // (volume waitlist kecil) — hindari index partial yang rapuh.
  const existing = await db
    .select()
    .from(waitlistEntries)
    .where(
      and(eq(waitlistEntries.workspaceId, input.workspaceId), eq(waitlistEntries.status, 'waiting')),
    )
    .limit(100);

  const match = existing.find((entry) => {
    const sameService =
      (entry.serviceId ?? null) === (input.serviceId ?? null);
    const sameChannel =
      input.channelIdentifier != null
        ? entry.channelIdentifier === input.channelIdentifier
        : false;
    const samePhone =
      input.contactPhone != null &&
      entry.contactPhone != null &&
      canonicalPhone(entry.contactPhone) === canonicalPhone(input.contactPhone);
    return sameService && (sameChannel || samePhone);
  });

  if (match) return { entry: match, created: false };

  const [entry] = await db
    .insert(waitlistEntries)
    .values({
      workspaceId: input.workspaceId,
      serviceId: input.serviceId ?? null,
      staffId: input.staffId ?? null,
      customerName: input.customerName ?? null,
      contactPhone: input.contactPhone ? (canonicalPhone(input.contactPhone) ?? input.contactPhone) : null,
      channelType: input.channelType,
      channelIdentifier: input.channelIdentifier ?? null,
      preferredDate: input.preferredDate ?? null,
      timePreference: input.timePreference ?? null,
    })
    .returning();
  return { entry, created: true };
}

/** Slot yang dilepas (booking dibatalkan) — bahan penawaran ke waitlist. */
export interface FreedSlot {
  serviceId?: string | null;
  staffId?: string | null;
  scheduledAt: Date;
  durationMinutes: number;
  timezone: string;
}

/**
 * Pilih entri waitlist berikutnya (pure — diuji unit). Prioritas:
 * layanan sama → staf sama → FIFO (urutan input = tertua dulu).
 */
export function pickWaitlistEntry<T extends { id: string; serviceId: string | null; staffId: string | null }>(
  rows: T[],
  freed: { serviceId?: string | null; staffId?: string | null },
): T | null {
  if (rows.length === 0) return null;
  return (
    rows.find((row) => freed.serviceId && row.serviceId === freed.serviceId) ??
    rows.find((row) => freed.staffId && row.staffId === freed.staffId) ??
    rows[0]
  );
}

/**
 * Klaim entri 'waiting' berikutnya yang paling cocok dengan slot kosong
 * (prioritas: layanan sama → staf sama → FIFO). Klaim ATOMIK via conditional
 * UPDATE (status harus masih 'waiting') — aman terhadap race/retry Inngest.
 */
export async function claimNextWaiting(
  workspaceId: string,
  freed: FreedSlot,
): Promise<WaitlistEntry | null> {
  const rows = await db
    .select()
    .from(waitlistEntries)
    .where(
      and(eq(waitlistEntries.workspaceId, workspaceId), eq(waitlistEntries.status, 'waiting')),
    )
    .orderBy(asc(waitlistEntries.createdAt))
    .limit(100);

  const pick = pickWaitlistEntry(rows, freed);
  if (!pick) return null;

  const [claimed] = await db
    .update(waitlistEntries)
    .set({
      status: 'offered',
      offeredAt: new Date(),
      offeredSlotAt: freed.scheduledAt,
      offeredServiceId: freed.serviceId ?? pick.serviceId,
      offeredStaffId: freed.staffId ?? pick.staffId,
      offeredDurationMinutes: freed.durationMinutes,
      offeredTimezone: freed.timezone,
      updatedAt: new Date(),
    })
    .where(and(eq(waitlistEntries.id, pick.id), eq(waitlistEntries.status, 'waiting')))
    .returning();

  return claimed ?? null;
}

/** Lepaskan tawaran yang gagal terkirim — kembalikan ke 'waiting' agar slot lain bisa menawari. */
export async function releaseWaitlistOffer(entryId: string): Promise<void> {
  await db
    .update(waitlistEntries)
    .set({
      status: 'waiting',
      offeredAt: null,
      offeredSlotAt: null,
      offeredServiceId: null,
      offeredStaffId: null,
      offeredDurationMinutes: null,
      offeredTimezone: null,
      updatedAt: new Date(),
    })
    .where(eq(waitlistEntries.id, entryId));
}

/** Entri 'offered' milik chat tertentu — dipakai saat customer membalas tawaran. */
export async function findOfferedForChat(
  workspaceId: string,
  channelType: string,
  channelIdentifier: string,
): Promise<WaitlistEntry | null> {
  const rows = await db
    .select()
    .from(waitlistEntries)
    .where(
      and(
        eq(waitlistEntries.workspaceId, workspaceId),
        eq(waitlistEntries.status, 'offered'),
        eq(waitlistEntries.channelType, channelType),
        eq(waitlistEntries.channelIdentifier, channelIdentifier),
      ),
    )
    .orderBy(asc(waitlistEntries.offeredAt))
    .limit(1);
  return rows[0] ?? null;
}

/** Customer menolak tawaran slot. */
export async function markWaitlistDeclined(entryId: string): Promise<void> {
  await db
    .update(waitlistEntries)
    .set({ status: 'declined', updatedAt: new Date() })
    .where(eq(waitlistEntries.id, entryId));
}

export type WaitlistBookResult =
  | { ok: true; bookingId: string; serviceName: string; customerName: string; scheduledAt: Date; timezone: string }
  | { ok: false; error: string };

/**
 * Customer menerima tawaran ("Ya") → buat booking dari slot tersimpan.
 * Ketersediaan dicek ulang (slot bisa terisi lagi sejak ditawarkan), lalu
 * pipeline pasca-buat identik dengan createBookingTool.
 */
export async function bookWaitlistOffer(input: {
  workspaceId: string;
  entry: WaitlistEntry;
  customerName?: string | null;
  phone?: string | null;
}): Promise<WaitlistBookResult> {
  const entry = input.entry;
  if (entry.status !== 'offered' || !entry.offeredSlotAt || !entry.offeredServiceId) {
    return { ok: false, error: 'Tawaran tidak valid atau sudah diproses.' };
  }

  const customerName = (input.customerName ?? entry.customerName ?? '').trim();
  const phone = canonicalPhone(normalizePhone(input.phone ?? entry.contactPhone ?? '')) ?? null;
  if (!customerName) return { ok: false, error: 'Nama customer belum diketahui.' };
  if (!phone) return { ok: false, error: 'Nomor telepon customer belum diketahui.' };

  const duration = entry.offeredDurationMinutes ?? 60;
  const start = entry.offeredSlotAt;
  const end = new Date(start.getTime() + duration * 60_000);
  const timezone = entry.offeredTimezone ?? 'UTC';

  const check = await assertSlotAvailable({
    workspaceId: input.workspaceId,
    staffId: entry.offeredStaffId,
    start,
    end,
  });
  if (!check.ok) {
    await markWaitlistDeclined(entry.id);
    return { ok: false, error: 'Slot tersebut sudah terisi kembali.' };
  }

  const [workspace] = await db
    .select({ userId: workspaces.userId })
    .from(workspaces)
    .where(eq(workspaces.id, input.workspaceId))
    .limit(1);
  if (!workspace) return { ok: false, error: 'Workspace tidak ditemukan.' };

  const sourceRef = `waitlist:${entry.id}`;
  const [row] = await db
    .insert(bookings)
    .values({
      userId: workspace.userId,
      workspaceId: input.workspaceId,
      scheduledAt: start,
      timezone,
      status: 'pending',
      customerName,
      phone,
      staffId: entry.offeredStaffId,
      durationMinutes: duration,
      serviceId: entry.offeredServiceId,
      source: 'waitlist',
      sourceRef,
    })
    .returning();
  if (!row) return { ok: false, error: 'Gagal membuat booking (duplikat).' };

  // Tandai waitlist terpenuhi + pipeline pasca-buat (kontak, reminder,
  // auto-call, kalender, webhook, slack).
  await db
    .update(waitlistEntries)
    .set({ status: 'booked', filledAt: new Date(), updatedAt: new Date() })
    .where(eq(waitlistEntries.id, entry.id));

  await syncBookingContact({
    userId: workspace.userId,
    workspaceId: input.workspaceId,
    bookingId: row.id,
    customerName: row.customerName,
    phone: row.phone,
  });
  await emitBookingCreated({ workspaceId: input.workspaceId, bookingId: row.id, scheduledAt: start, timezone });
  if (row.phone) {
    await emitAutoCallScheduled({ workspaceId: input.workspaceId, bookingId: row.id, scheduledAt: start, timezone });
  }
  await emitCalendarBookingEvent(input.workspaceId, row.id, 'upsert');
  await emitOutgoingWebhookEvent(input.workspaceId, 'booking.created', {
    id: row.id,
    workspaceId: input.workspaceId,
    status: row.status,
    scheduledAt: row.scheduledAt.toISOString(),
    timezone: row.timezone,
    customerName: row.customerName,
    phone: row.phone,
    source: row.source,
    sourceRef: row.sourceRef,
  });
  await emitSlackBookingEvent(input.workspaceId, 'booking.created', {
    id: row.id,
    workspaceId: input.workspaceId,
    status: row.status,
  });
  // Telegram alerts — kartu lengkap (customer/waktu/telepon) untuk bisnis.
  await emitTelegramBookingAlert(input.workspaceId, 'booking.created', {
    id: row.id,
    workspaceId: input.workspaceId,
    status: row.status,
    scheduledAt: row.scheduledAt.toISOString(),
    timezone: row.timezone,
    customerName: row.customerName,
    phone: row.phone,
  });

  const [service] = await db
    .select({ name: services.name })
    .from(services)
    .where(eq(services.id, entry.offeredServiceId))
    .limit(1);

  return {
    ok: true,
    bookingId: row.id,
    serviceName: service?.name ?? '',
    customerName: row.customerName ?? '',
    scheduledAt: start,
    timezone,
  };
}

/**
 * Kirim event Inngest `waitlist/slot-freed` — ditangani `fillWaitlistSlot`.
 * Best-effort: kegagalan queue TIDAK menggagalkan pembatalan booking utama.
 */
export async function emitWaitlistSlotFreed(input: {
  workspaceId: string;
  bookingId: string;
  serviceId?: string | null;
  staffId?: string | null;
  scheduledAt: Date;
  durationMinutes: number;
  timezone: string;
}): Promise<void> {
  // Slot yang sudah lewat tidak berguna untuk ditawarkan — skip.
  if (input.scheduledAt.getTime() <= Date.now()) return;
  try {
    await inngest.send({
      name: 'waitlist/slot-freed',
      data: {
        workspaceId: input.workspaceId,
        bookingId: input.bookingId,
        serviceId: input.serviceId ?? null,
        staffId: input.staffId ?? null,
        scheduledAt: input.scheduledAt.toISOString(),
        durationMinutes: input.durationMinutes,
        timezone: input.timezone,
      },
    });
  } catch (error) {
    // Event hilang = waitlist tidak ditawari slot ini (bukan kegagalan fatal).
    console.error('[waitlist] GAGAL mengirim event waitlist/slot-freed:', error);
  }
}
