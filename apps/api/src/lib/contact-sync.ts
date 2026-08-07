import { and, eq } from 'drizzle-orm';
import { bookings, contacts } from '@oriole/database';

import { db } from '../db/index.ts';

/**
 * Sinkronkan customer booking dengan tabel `contacts` (find-or-create).
 *
 * Aturan:
 * - Booking tanpa nomor telepon → tautan kontak dilepas (contactId null),
 *   karena nomor adalah kunci pencocokan (unik per workspace).
 * - Nomor sudah ada sebagai kontak di workspace → booking ditautkan ke
 *   kontak tersebut (kontak TIDAK dibuat duplikat).
 * - Belum ada & booking punya nama → kontak baru dibuat otomatis dari
 *   data customer booking.
 * - Belum ada & tanpa nama → kontak tidak bisa dibuat (nama wajib diisi) →
 *   booking dibiarkan tanpa tautan.
 *
 * `onConflictDoNothing` menangani race: dua booking dengan nomor sama yang
 * masuk bersamaan memicu unique (workspace, phone) — insert kedua diabaikan
 * dan kontak yang menang dipakai.
 *
 * @returns contactId yang aktif untuk booking, atau null.
 */
export async function syncBookingContact(input: {
  userId: string;
  workspaceId: string;
  bookingId: string;
  customerName: string | null;
  phone: string | null;
}): Promise<string | null> {
  const { userId, workspaceId, bookingId, customerName, phone } = input;

  if (!phone) {
    await db
      .update(bookings)
      .set({ contactId: null, updatedAt: new Date() })
      .where(eq(bookings.id, bookingId));
    return null;
  }

  const contactId = await findOrCreateContact(userId, workspaceId, customerName, phone);

  await db
    .update(bookings)
    .set({ contactId, updatedAt: new Date() })
    .where(eq(bookings.id, bookingId));
  return contactId;
}

/** Cari kontak by nomor (unik per workspace), buat bila belum ada & ada nama. */
async function findOrCreateContact(
  userId: string,
  workspaceId: string,
  customerName: string | null,
  phone: string,
): Promise<string | null> {
  const existing = await findContactIdByPhone(workspaceId, phone);
  if (existing) return existing;

  // Tanpa nama tidak ada data minimal yang layak disimpan sebagai kontak.
  if (!customerName) return null;

  const inserted = await db
    .insert(contacts)
    .values({ userId, workspaceId, name: customerName, phone })
    .onConflictDoNothing()
    .returning({ id: contacts.id });

  // Bila kalah race (nomor sama masuk bersamaan), ambil kontak pemenang.
  return inserted[0]?.id ?? (await findContactIdByPhone(workspaceId, phone)) ?? null;
}

async function findContactIdByPhone(workspaceId: string, phone: string): Promise<string | null> {
  const [row] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.phone, phone)))
    .limit(1);
  return row?.id ?? null;
}
