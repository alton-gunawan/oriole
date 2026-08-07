import { and, eq } from 'drizzle-orm';
import { loadRootEnv } from '@oriole/config';
import { bookings, contacts, createDb } from '@oriole/database';

/**
 * CLI: backfill tautan booking → contacts untuk data lama.
 *
 *   pnpm --filter @oriole/api sync:contacts [--workspace <workspaceId>]
 *
 * Setiap booking yang punya nomor telepon dicarikan kontak di workspace yang
 * sama (by nomor); bila belum ada dan booking punya nama, kontak dibuat.
 * Booking tanpa nomor telepon dilepas tautannya (contactId null).
 *
 * Idempoten — aman dijalankan ulang kapan saja.
 */

function readArg(flag: string): string | undefined {
  const prefix = `--${flag}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
}

async function main(): Promise<void> {
  loadRootEnv();

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL wajib diisi (root .env atau env platform).');
    process.exit(1);
  }
  const db = createDb(databaseUrl);

  const workspaceId = readArg('workspace');

  // Tanpa --workspace: semua booking diproses (termasuk tanpa nomor, agar
  // tautan basi ikut dilepas). Dengan --workspace: hanya booking di workspace itu.
  const baseQuery = db
    .select({
      id: bookings.id,
      userId: bookings.userId,
      workspaceId: bookings.workspaceId,
      customerName: bookings.customerName,
      phone: bookings.phone,
    })
    .from(bookings);
  const rows = workspaceId
    ? await baseQuery.where(eq(bookings.workspaceId, workspaceId))
    : await baseQuery;

  let linked = 0;
  let created = 0;
  let cleared = 0;
  let skipped = 0;

  for (const booking of rows) {
    if (!booking.workspaceId || !booking.userId) {
      skipped += 1;
      continue;
    }

    // Tanpa nomor → lepas tautan.
    if (!booking.phone) {
      await db
        .update(bookings)
        .set({ contactId: null, updatedAt: new Date() })
        .where(eq(bookings.id, booking.id));
      cleared += 1;
      continue;
    }

    let [contact] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.workspaceId, booking.workspaceId), eq(contacts.phone, booking.phone)))
      .limit(1);

    if (!contact && booking.customerName) {
      const inserted = await db
        .insert(contacts)
        .values({
          userId: booking.userId,
          workspaceId: booking.workspaceId,
          name: booking.customerName,
          phone: booking.phone,
        })
        .onConflictDoNothing()
        .returning({ id: contacts.id });
      contact = inserted[0];
      if (contact) created += 1;
      else {
        const [winner] = await db
          .select({ id: contacts.id })
          .from(contacts)
          .where(and(eq(contacts.workspaceId, booking.workspaceId), eq(contacts.phone, booking.phone)))
          .limit(1);
        contact = winner;
      }
    }

    if (!contact) {
      skipped += 1;
      continue;
    }

    await db
      .update(bookings)
      .set({ contactId: contact.id, updatedAt: new Date() })
      .where(eq(bookings.id, booking.id));
    linked += 1;
  }

  console.log(
    `✅ Sinkronisasi selesai: ${linked} booking ditautkan (${created} kontak baru), ` +
      `${cleared} tautan dilepas, ${skipped} dilewati (tanpa nomor/nama).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
