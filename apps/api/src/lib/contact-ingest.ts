import { and, eq } from 'drizzle-orm';
import { contacts as contactsTable } from '@oriole/database';

import { db } from '../db/index.ts';

/* ────────────────────────────────────────────────────────────
 * Contact ingest — find-or-create kontak dari submission form.
 *
 * Dipakai bersama oleh Google Forms (polling) dan Tally
 * (webhook) agar perilaku konsisten:
 * - Dedup by nomor telepon (unik per workspace).
 * - Nomor yang sudah dikenal → perbarui email/catatan bila kosong.
 * - Nomor baru butuh nama untuk membuat kontak.
 * ──────────────────────────────────────────────────────────── */

export interface ContactSubmission {
  name: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
}

export type ContactIngestOutcome = 'imported' | 'skipped';

/** Jumlah digit nomor (tanpa +) — untuk validasi minimal ala E.164. */
function hasPlausiblePhone(phone: string): boolean {
  return /^\d{8,15}$/.test(phone.replace('+', ''));
}

/**
 * Masukkan satu submission sebagai kontak workspace.
 *
 * - Telepon tidak ada / tidak masuk akal → `skipped`.
 * - Nomor sudah dikenal → isi email/catatan yang masih kosong → `imported`.
 * - Nomor baru tanpa nama → `skipped` (nama wajib saat membuat baru).
 * - Nomor baru + nama → insert (onConflictDoNothing untuk kalah race) → `imported`.
 */
export async function upsertContactFromSubmission(
  userId: string,
  workspaceId: string,
  contact: ContactSubmission,
): Promise<ContactIngestOutcome> {
  if (!contact.phone || !hasPlausiblePhone(contact.phone)) {
    return 'skipped';
  }

  const [existing] = await db
    .select({ id: contactsTable.id })
    .from(contactsTable)
    .where(and(eq(contactsTable.workspaceId, workspaceId), eq(contactsTable.phone, contact.phone)))
    .limit(1);

  if (existing) {
    const [contactRow] = await db
      .select({ email: contactsTable.email, notes: contactsTable.notes })
      .from(contactsTable)
      .where(eq(contactsTable.id, existing.id))
      .limit(1);
    const needsUpdate = (contact.email && !contactRow?.email) || (contact.notes && !contactRow?.notes);
    if (needsUpdate) {
      await db
        .update(contactsTable)
        .set({
          ...(contact.email && !contactRow?.email ? { email: contact.email } : {}),
          ...(contact.notes && !contactRow?.notes ? { notes: contact.notes } : {}),
          updatedAt: new Date(),
        })
        .where(eq(contactsTable.id, existing.id));
    }
    return 'imported';
  }

  if (!contact.name) {
    return 'skipped';
  }
  await db
    .insert(contactsTable)
    .values({
      userId,
      workspaceId,
      name: contact.name,
      phone: contact.phone,
      email: contact.email ?? null,
      notes: contact.notes ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: contactsTable.id });
  return 'imported';
}
