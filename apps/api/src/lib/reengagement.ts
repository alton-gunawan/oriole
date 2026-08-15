import { and, eq, gte, isNull } from 'drizzle-orm';
import { bookings, contacts, workspaces } from '@oriole/database';
import { canonicalPhone, renderReEngagement } from '@oriole/messaging';

import { db } from '../db/index.ts';
import { findChatByPhone } from './chat-engine.ts';
import { dispatchTelegramText, TelegramDispatchError } from './telegram-handler.ts';

/**
 * Re-engagement otomatis — hubungi pelanggan yang dorman (sudah lama tidak
 * booking) atau no-show (melewatkan jadwal) lewat Telegram, dengan cooldown
 * agar tidak spam. Dipicu cron harian `reengageCustomers`.
 */

export const DORMANT_DAYS = 60;
export const NO_SHOW_WINDOW_DAYS = 30;
export const COOLDOWN_DAYS = 30;
/** Jendela fetch booking ke belakang (hari) — cukup untuk deteksi dorman. */
const LOOKBACK_DAYS = 120;
/** Batas kontak per workspace per run — jaga volume cron. */
const MAX_PER_WORKSPACE = 25;

export interface ReEngagementContact {
  id: string;
  phone: string;
  name: string | null;
  lastReEngagedAt: Date | null;
}

export interface ReEngagementBooking {
  phone: string | null;
  customerName: string | null;
  scheduledAt: Date;
  status: string;
  noShowCount: number;
}

export interface ReEngagementOptions {
  dormantDays: number;
  noShowWindowDays: number;
  cooldownDays: number;
}

export interface ReEngagementCandidate {
  contactId: string | null;
  phone: string;
  name: string | null;
  reason: 'no-show' | 'dormant';
}

/**
 * Klasifikasi pelanggan (pure — diuji unit). Aturan per nomor telepon:
 * - Ada booking aktif (pending/confirmed) → skip.
 * - Sudah di-re-engage dalam cooldown → skip.
 * - No-show dalam window → reason 'no-show'.
 * - Booking terakhir lebih lama dari `dormantDays` → reason 'dormant'.
 */
export function classifyReEngagement(
  bookingRows: ReEngagementBooking[],
  contactRows: ReEngagementContact[],
  now: Date,
  opts: ReEngagementOptions,
): ReEngagementCandidate[] {
  const nowMs = now.getTime();
  const dayMs = 86_400_000;
  const dormantCutoff = nowMs - opts.dormantDays * dayMs;
  const noShowCutoff = nowMs - opts.noShowWindowDays * dayMs;
  const cooldownCutoff = nowMs - opts.cooldownDays * dayMs;

  const contactByPhone = new Map<string, ReEngagementContact>();
  for (const contact of contactRows) {
    const key = canonicalPhone(contact.phone);
    if (key && !contactByPhone.has(key)) contactByPhone.set(key, contact);
  }

  const byPhone = new Map<string, ReEngagementBooking[]>();
  for (const booking of bookingRows) {
    const key = booking.phone ? canonicalPhone(booking.phone) : null;
    if (!key) continue;
    const list = byPhone.get(key) ?? [];
    list.push(booking);
    byPhone.set(key, list);
  }

  const candidates: ReEngagementCandidate[] = [];
  for (const [phone, list] of byPhone) {
    const hasActive = list.some((b) => b.status === 'pending' || b.status === 'confirmed');
    if (hasActive) continue;

    const contact = contactByPhone.get(phone);
    if (contact?.lastReEngagedAt && contact.lastReEngagedAt.getTime() >= cooldownCutoff) continue;

    const latestAt = Math.max(...list.map((b) => b.scheduledAt.getTime()));
    const recentNoShow = list.some((b) => b.noShowCount > 0 && b.scheduledAt.getTime() >= noShowCutoff);

    let reason: 'no-show' | 'dormant' | null = null;
    if (recentNoShow) reason = 'no-show';
    else if (latestAt < dormantCutoff) reason = 'dormant';
    if (!reason) continue;

    candidates.push({
      contactId: contact?.id ?? null,
      phone,
      name: contact?.name ?? list[0]?.customerName ?? null,
      reason,
    });
  }

  return candidates;
}

/**
 * Jalankan re-engagement untuk satu workspace: muat kontak + booking,
 * klasifikasi kandidat, kirim via Telegram, tandai `lastReEngagedAt`.
 */
export async function reengageWorkspaceCustomers(
  workspaceId: string,
): Promise<{ contacted: number; skipped: number }> {
  const [workspace] = await db
    .select({ name: workspaces.name, chatLanguage: workspaces.chatLanguage })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)))
    .limit(1);
  if (!workspace) return { contacted: 0, skipped: 0 };

  const language = workspace.chatLanguage === 'id' ? 'id' : 'en';

  const lookbackFrom = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);
  const [contactRows, bookingRows] = await Promise.all([
    db
      .select({
        id: contacts.id,
        phone: contacts.phone,
        name: contacts.name,
        lastReEngagedAt: contacts.lastReEngagedAt,
      })
      .from(contacts)
      .where(eq(contacts.workspaceId, workspaceId))
      .limit(2000),
    db
      .select({
        phone: bookings.phone,
        customerName: bookings.customerName,
        scheduledAt: bookings.scheduledAt,
        status: bookings.status,
        noShowCount: bookings.noShowCount,
      })
      .from(bookings)
      .where(
        and(
          eq(bookings.workspaceId, workspaceId),
          gte(bookings.scheduledAt, lookbackFrom),
        ),
      )
      .limit(5000),
  ]);

  const candidates = classifyReEngagement(bookingRows, contactRows, new Date(), {
    dormantDays: DORMANT_DAYS,
    noShowWindowDays: NO_SHOW_WINDOW_DAYS,
    cooldownDays: COOLDOWN_DAYS,
  });

  let contacted = 0;
  let skipped = 0;
  for (const candidate of candidates.slice(0, MAX_PER_WORKSPACE)) {
    const chat = await findChatByPhone(workspaceId, candidate.phone, 'telegram');
    if (!chat) {
      skipped += 1;
      continue;
    }

    const text = renderReEngagement(
      {
        businessName: workspace.name,
        customerName: candidate.name,
        reason: candidate.reason,
      },
      language,
    );

    try {
      await dispatchTelegramText(workspaceId, chat.identifier, text);
    } catch (error) {
      // Channel belum dikonfigurasi / dijeda → skip tanpa menandai kontak.
      if (error instanceof TelegramDispatchError) {
        skipped += 1;
        continue;
      }
      throw error;
    }

    if (candidate.contactId) {
      await db
        .update(contacts)
        .set({ lastReEngagedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(contacts.id, candidate.contactId), eq(contacts.workspaceId, workspaceId)));
    }
    contacted += 1;
  }

  return { contacted, skipped };
}
