import { and, eq, inArray } from 'drizzle-orm';
import { services } from '@oriole/database';

import { db } from '../db/index.ts';

/**
 * Title booking TIDAK disimpan di database — selalu diturunkan dari layanan
 * katalog (services.name), tenant-scoped. Kolom `bookings.title` dihapus
 * (migrasi 0020); pemanggil yang butuh nama booking memakai helper ini.
 *
 * Booking lama (mode tanpa katalog, serviceId null) memakai fallback netral —
 * konsisten di semua channel (reminder, auto-call, kalender, webhook).
 */

/** Fallback nama booking bila tidak tertaut layanan (booking legacy). */
export const DEFAULT_BOOKING_TITLE = 'Appointment';

/**
 * Nama layanan katalog untuk daftar id (tenant-scoped, batch). Query tunggal
 * per panggilan — hasil Map(id → name). Id tanpa layanan / layanan workspace
 * lain TIDAK muncul (tidak bocor lintas tenant).
 */
export async function loadServiceNames(
  workspaceId: string,
  ids: Array<string | null>,
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  const names = new Map<string, string>();
  if (unique.length === 0) return names;
  const rows = await db
    .select({ id: services.id, name: services.name })
    .from(services)
    .where(and(eq(services.workspaceId, workspaceId), inArray(services.id, unique)));
  for (const row of rows) names.set(row.id, row.name);
  return names;
}

/** Title booking = nama layanan katalog; fallback bila tidak tertaut. */
export function bookingTitle(
  serviceNames: Map<string, string>,
  row: { serviceId: string | null },
  fallback: string = DEFAULT_BOOKING_TITLE,
): string {
  return row.serviceId ? (serviceNames.get(row.serviceId) ?? fallback) : fallback;
}

/** Augment SATU baris booking dengan `title` (nama layanan katalog). */
export async function withBookingTitle<T extends { serviceId: string | null }>(
  workspaceId: string,
  row: T,
): Promise<T & { title: string }> {
  const names = await loadServiceNames(workspaceId, [row.serviceId]);
  return { ...row, title: bookingTitle(names, row) };
}

/** Augment BANYAK baris booking dengan `title` (satu query batch). */
export async function withBookingTitles<
  T extends { serviceId: string | null },
>(workspaceId: string, rows: T[]): Promise<Array<T & { title: string }>> {
  if (rows.length === 0) return [];
  const names = await loadServiceNames(workspaceId, rows.map((row) => row.serviceId));
  return rows.map((row) => ({ ...row, title: bookingTitle(names, row) }));
}
