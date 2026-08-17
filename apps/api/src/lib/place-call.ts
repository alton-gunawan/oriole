import { and, eq } from 'drizzle-orm';
import type { GoalType } from '@oriole/call-goals';
import { bookings, calleCalls, workspaceIntegrations } from '@oriole/database';

import { db } from '../db/index.ts';
import { env } from './env.ts';
import { findVapiCallByName, placeVapiCall, VapiNotConfiguredError } from '../services/vapi.ts';
import { findInFlightCall } from './booking-goal.ts';

/**
 * Nomor keluar (phoneNumberId Vapi) untuk sebuah workspace: nomor yang
 * dipilih di halaman Integrations (integrasi 'vapi') bila ada, kalau tidak
 * jatuh ke default server (env VAPI_PHONE_NUMBER_ID). Dipanggil pada setiap
 * penempatan panggilan — satu sumber kebenaran untuk semua caller
 * (trigger manual, auto-call, retry Inngest).
 */
export async function resolveOutboundPhoneNumber(
  db: typeof import('../db/index.ts').db,
  workspaceId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ providerConfig: workspaceIntegrations.providerConfig })
    .from(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, workspaceId),
        eq(workspaceIntegrations.integrationType, 'vapi'),
        eq(workspaceIntegrations.isActive, true),
      ),
    )
    .limit(1);
  const config = row?.providerConfig as {
    vapiPhoneNumberId?: unknown;
    provisionPending?: unknown;
  } | null;
  // Nomor yang baru diprovision (wizard belum selesai) TIDAK dipakai untuk
  // panggilan nyata — fallback ke default server sampai user mengonfirmasi.
  const pending = config?.provisionPending === true;
  const selected =
    !pending &&
    config &&
    typeof config.vapiPhoneNumberId === 'string' &&
    config.vapiPhoneNumberId.length > 0
      ? config.vapiPhoneNumberId
      : null;
  return selected ?? env.VAPI_PHONE_NUMBER_ID ?? null;
}

/**
 * Place-then-commit yang aman terhadap retry (at-least-once).
 *
 * Masalah: `vapi.calls.create` tidak idempoten di sisi provider, dan Inngest
 * me-retry step yang gagal. Urutan naif (create → insert → update booking)
 * menggandakan panggilan bila create sukses tapi commit DB gagal. Solusinya
 * reserve-then-place:
 *
 *   1. RESERVE  — insert baris calle_calls dengan id deterministik
 *                 `pending:<callName>` (status queued). Unique index
 *                 calle_call_id menolak reservasi ganda untuk panggilan
 *                 logis yang sama.
 *   2. RECONCILE— hanya pada konflik/retry: cari call Vapi yang sudah dibuat
 *                 dengan nama yang sama (attempt sebelumnya mati antara
 *                 create dan commit) → adopsi tanpa create baru.
 *   3. CREATE   — placeVapiCall. Gagal → reservasi dihapus agar retry bisa
 *                 menempatkan ulang, lalu error dilempar.
 *   4. COMMIT   — update row reservasi ke id asli + status, tautkan ke booking.
 *
 * Kegagalan yang tersisa: crash proses antara (2) dan (3) meninggalkan
 * reservasi basi. Retry berikutnya mendeteksi umurnya (reservationStaleMs)
 * dan mengambil alih (create) atau menunggu pemilik lama (skip). Panggilan
 * yang ter-orphan (create sukses, commit tidak pernah terjadi) selalu
 * dipulihkan oleh webhook end-of-call-report: fallback rekonstruksi dari
 * nama panggilan (lihat inngest/functions.ts → onVapiEvent).
 */

/** Prefix id reservasi — baris calle_calls sebelum call Vapi benar-benar dibuat. */
const PENDING_PREFIX = 'pending:';

/** Id deterministik untuk reservasi — unik per panggilan logis (per callName). */
export function reservationIdFor(callName: string): string {
  return `${PENDING_PREFIX}${callName}`;
}

/** True bila calleCallId adalah reservasi (belum di-commit ke id asli Vapi). */
export function isPendingReservation(calleCallId: string | null | undefined): boolean {
  return typeof calleCallId === 'string' && calleCallId.startsWith(PENDING_PREFIX);
}

export interface PlaceBookingCallInput {
  workspaceId: string;
  bookingId: string;
  userId: string | null;
  /** Nomor tujuan E.164 (sudah divalidasi pemanggil). */
  phone: string;
  /** System prompt goal — sumber perilaku asisten Vapi. */
  prompt: string;
  language: 'en' | 'id';
  businessName?: string | null;
  customerName?: string | null;
  /** Nama asisten voice AI — greeting + label asisten Vapi. */
  assistantName?: string | null;
  /** Voice ID ElevenLabs — null = default server (env). */
  voiceId?: string | null;
  goalType: GoalType;
  /**
   * Nama panggilan Vapi (`booking:<id>:<goalType>:<source>[:...]`) — unik
   * per panggilan logis; dasar reservasi + rekonsiliasi retry.
   */
  callName: string;
  /** Umur reservasi yang dianggap basi (ms). Default 60 detik. */
  reservationStaleMs?: number;
}

export type PlaceBookingCallResult =
  | {
      status: 'placed';
      callId: string;
      goalType: GoalType;
      calleStatus: string | null;
      /** true bila call yang sudah ada diadopsi (retry) — bukan create baru. */
      adopted: boolean;
    }
  | { status: 'skipped'; reason: string };

export async function placeBookingCall(
  input: PlaceBookingCallInput,
): Promise<PlaceBookingCallResult> {
  const pendingId = reservationIdFor(input.callName);
  const staleMs = input.reservationStaleMs ?? 60_000;

  // Guard (booking, goalType): ada panggilan yang masih berjalan?
  const active = await findInFlightCall(db, input.bookingId, input.goalType);
  if (active && active.calleCallId !== pendingId) {
    if (!isPendingReservation(active.calleCallId)) {
      // Panggilan nyata sedang berjalan — jangan tempatkan paralel.
      return { status: 'skipped', reason: 'call-in-flight' };
    }
    // Reservasi panggilan logis LAIN (source/attempt berbeda). Kalau masih
    // segar berarti pemiliknya sedang aktif — skip. Kalau basi (pemilik mati
    // sebelum create), bersihkan dan lanjut; panggilan ter-orphan (create
    // sukses tapi commit gagal) tetap dipulihkan webhook via nama panggilan.
    const stale = await isReservationStale(db, active.calleCallId, staleMs);
    if (!stale) return { status: 'skipped', reason: 'call-in-flight' };
    await db.delete(calleCalls).where(eq(calleCalls.calleCallId, active.calleCallId));
  }

  // RESERVE — insert idempotent (unique index calle_call_id).
  const inserted = await db
    .insert(calleCalls)
    .values({
      calleCallId: pendingId,
      userId: input.userId,
      workspaceId: input.workspaceId,
      bookingId: input.bookingId,
      phone: input.phone,
      task: input.prompt,
      goalType: input.goalType,
      status: 'queued',
    })
    .onConflictDoNothing({ target: calleCalls.calleCallId })
    .returning({ id: calleCalls.id });

  // CONFLICT — attempt dengan panggilan logis yang sama pernah mulai
  // (retry Inngest / crash). Reconcile: adopsi call yang sudah dibuat, atau
  // (bila reservasi basi) lanjutkan create sendiri.
  if (inserted.length === 0) {
    const adopted = await reconcileOrWait(input, pendingId, staleMs);
    if (adopted) return adopted;
  }

  // CREATE
  const phoneNumberId = await resolveOutboundPhoneNumber(db, input.workspaceId);
  let created: { id: string; status: string | null };
  try {
    created = await placeVapiCall({
      prompt: input.prompt,
      language: input.language,
      businessName: input.businessName,
      customerName: input.customerName,
      assistantName: input.assistantName,
      voiceId: input.voiceId,
      callName: input.callName,
      phone: input.phone,
      phoneNumberId: phoneNumberId ?? undefined,
    });
  } catch (error) {
    // Create belum pernah berhasil → hapus reservasi agar retry berikutnya
    // bisa menempatkan ulang. Kalau create ternyata sukses di sisi Vapi
    // (response hilang), reconcile pada retry mengadopsi call itu.
    await db.delete(calleCalls).where(eq(calleCalls.calleCallId, pendingId)).catch(() => undefined);
    // Vapi belum dikonfigurasi = kondisi permanen, bukan transien — jangan
    // dilempar (Inngest akan retry tanpa henti); lapor sebagai skip agar
    // pemanggil bisa menampilkan pesan yang tepat.
    if (error instanceof VapiNotConfiguredError) {
      return { status: 'skipped', reason: 'vapi-not-configured' };
    }
    throw error;
  }

  await commitCall(pendingId, created.id, created.status, input.bookingId);
  return {
    status: 'placed',
    callId: created.id,
    goalType: input.goalType,
    calleStatus: created.status,
    adopted: false,
  };
}

/**
 * Reconcile pada konflik reservasi: adopsi call Vapi yang sudah ada dengan
 * nama panggilan yang sama, atau — bila reservasi basi — kembali null agar
 * pemanggil melanjutkan create. Reservasi segar milik attempt lain yang
 * sedang aktif → skip.
 */
async function reconcileOrWait(
  input: PlaceBookingCallInput,
  pendingId: string,
  staleMs: number,
): Promise<PlaceBookingCallResult | null> {
  const existing = await findVapiCallByName(input.callName);
  if (existing) {
    await commitCall(pendingId, existing.id, existing.status, input.bookingId);
    return {
      status: 'placed',
      callId: existing.id,
      goalType: input.goalType,
      calleStatus: existing.status,
      adopted: true,
    };
  }
  if (await isReservationStale(db, pendingId, staleMs)) return null;
  return { status: 'skipped', reason: 'call-in-flight' };
}

/** True bila reservasi lebih tua dari staleMs (pemiliknya mati / hang). */
async function isReservationStale(
  db: typeof import('../db/index.ts').db,
  calleCallId: string,
  staleMs: number,
): Promise<boolean> {
  const [row] = await db
    .select({ createdAt: calleCalls.createdAt })
    .from(calleCalls)
    .where(eq(calleCalls.calleCallId, calleCallId))
    .limit(1);
  if (!row) return true; // baris hilang — tidak ada yang menghalangi
  return Date.now() - row.createdAt.getTime() >= staleMs;
}

/** Commit: ubah reservasi → id asli Vapi + tautkan ke booking (idempotent). */
async function commitCall(
  pendingId: string,
  realCallId: string,
  status: string | null,
  bookingId: string,
): Promise<void> {
  await db
    .update(calleCalls)
    .set({ calleCallId: realCallId, status, updatedAt: new Date() })
    .where(eq(calleCalls.calleCallId, pendingId));
  await db
    .update(bookings)
    .set({ calleCallId: realCallId, updatedAt: new Date() })
    .where(eq(bookings.id, bookingId));
}
