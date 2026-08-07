import { and, eq, inArray, isNotNull, isNull, lt } from 'drizzle-orm';
import { workspaces } from '@oriole/database';

import { db } from '../db/index.ts';

/**
 * Soft-delete project (P1).
 *
 * Alur: `DELETE /me/workspaces/:id` hanya menyetel `workspaces.deletedAt`
 * (bukan menghapus baris) — project hilang dari semua read path (setiap
 * query workspace memfilter `deleted_at IS NULL`). Job pembersih Inngest
 * (cron harian `purgeDeletedWorkspaces`) menghapus baris secara permanen
 * setelah masa tenggang lewat; FK cascade menghapus seluruh data terkait
 * (booking, kontak, chat, channel, integrasi, ...).
 *
 * Alasan: memberi jendela pemulihan (recovery) bila penghapusan tidak
 * disengaja, tanpa perlu UI restore — cukup hapus kolom deleted_at via
 * admin/DB. Menghapus langsung saat user klik = data hilang permanen tanpa
 * jaring pengaman.
 */

/** Masa tenggang soft-delete sebelum penghapusan permanen (hari). */
export const WORKSPACE_DELETE_GRACE_DAYS = 3;

export const WORKSPACE_DELETE_GRACE_MS = WORKSPACE_DELETE_GRACE_DAYS * 24 * 60 * 60 * 1000;

/** Ukuran batch per run pembersih — run berikutnya (cron berikutnya) lanjut. */
const PURGE_BATCH_SIZE = 100;

/**
 * Apakah workspace dengan `deletedAt` sudah lewat masa tenggang dan pantas
 * dihapus permanen pada waktu `now`? Murni (pure) agar mudah diuji.
 */
export function isWorkspacePurgeDue(
  deletedAt: Date,
  now: Date,
  graceMs: number = WORKSPACE_DELETE_GRACE_MS,
): boolean {
  return deletedAt.getTime() <= now.getTime() - graceMs;
}

/**
 * Hapus permanen workspace yang soft-delete-nya sudah lewat masa tenggang
 * (default 3 hari). Batas batch per run; dipanggil cron harian Inngest.
 * Menghapus baris workspace → FK `onDelete: 'cascade'` membersihkan semua
 * data terkait di tabel turunan. Bila jumlah melebihi batch, cron berikutnya
 * melanjutkan sisa.
 */
export async function purgeExpiredWorkspaces(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - WORKSPACE_DELETE_GRACE_MS);

  // 1) Ambil id yang sudah lewat masa tenggang (batch terbatas).
  const expired = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(isNotNull(workspaces.deletedAt), lt(workspaces.deletedAt, cutoff)))
    .limit(PURGE_BATCH_SIZE);

  if (expired.length === 0) return 0;

  // 2) Hapus dalam satu statement. Kondisi deletedAt diulang di WHERE delete
  //    (bukan hanya id IN ...) sebagai jaring pengaman: bila sebuah workspace
  //    dipulihkan antara select dan delete (race sempit), barisnya tidak ikut
  //    terhapus permanen. FK cascade menghapus data turunan.
  const deleted = await db
    .delete(workspaces)
    .where(
      and(
        inArray(workspaces.id, expired.map((row) => row.id)),
        isNotNull(workspaces.deletedAt),
        lt(workspaces.deletedAt, cutoff),
      ),
    )
    .returning({ id: workspaces.id });

  return deleted.length;
}

/**
 * Apakah workspace masih ada dan TIDAK soft-deleted? Dipakai entry point
 * eksternal (webhook Telegram/WhatsApp) agar project yang sedang menunggu
 * penghapusan permanen tidak lagi memproses pesan customer.
 */
export async function isWorkspaceActive(workspaceId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)))
    .limit(1);
  return Boolean(row);
}
