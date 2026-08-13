import type { DateRange } from '@astryxdesign/core';
import type {
  BookingGoalContext,
  BusinessGoalContext,
  GoalDecision,
  Industry,
} from '@oriole/call-goals';

/** Mirrors GET /api/bookings — baris booking + konteks untuk mesin keputusan. */
export interface BookingRecord {
  id: string;
  title: string;
  description: string | null;
  scheduledAt: string;
  timezone: string;
  status: BookingGoalContext['status'];
  customerName: string | null;
  phone: string | null;
  /** Kontak terkait di halaman Contacts (null = belum tertaut). */
  contactId: string | null;
  industry: Industry | null;
  goalType: string | null;
  customInstruction: string | null;
  noShowCount: number;
  changeRequested: boolean;
  calleCallId: string | null;
  /** Staf penanggung jawab — null = tanpa penugasan (mode tanpa staf). */
  staffId: string | null;
  /** Layanan katalog terkait — null = booking tanpa katalog (mode lama). */
  serviceId: string | null;
  /** Nama layanan katalog (diisi API list bookings — null bila tidak tertaut). */
  serviceName: string | null;
  /** Durasi layanan (menit) — dipakai slot engine & event kalender. */
  durationMinutes: number;
  /** Aturan pengulangan — ada bila booking adalah bagian dari seri. */
  recurrence: RecurrenceRule | null;
  /** Id seri pengulangan — semua instance satu seri berbagi id ini. */
  recurrenceSeriesId: string | null;
  callAttempts: { total: number; failed: number };
  autoGoal: GoalDecision;
  createdAt: string;
  updatedAt: string;
}

/** Aturan pengulangan booking (mirror schema DB packages/database). */
export interface RecurrenceRule {
  frequency: 'daily' | 'weekly' | 'monthly';
  interval?: number;
  count?: number;
  until?: string;
  weekdays?: number[];
}

/** Respons POST /api/bookings saat recurrence → { recurrence: { seriesId, occurrences } }. */
export interface BookingCreateResponse {
  booking: BookingRecord;
  recurrence?: { seriesId: string; occurrences: number };
}

export interface CallRecord {
  id: string;
  calleCallId: string;
  phone: string;
  task: string | null;
  goalType: string | null;
  status: string | null;
  result: Record<string, unknown> | null;
  createdAt: string;
}

export interface BookingDetailResponse {
  booking: BookingRecord;
  bookingContext: BookingGoalContext;
  business: BusinessGoalContext;
  autoGoal: GoalDecision;
  calls: CallRecord[];
}

export interface BookingsListResponse {
  bookings: BookingRecord[];
  /** Total item (mode pagination offset) — untuk menghitung jumlah halaman. */
  total?: number;
  /** Mode kursor: kursor base64url halaman berikutnya, null bila sudah di akhir. */
  nextCursor?: string | null;
  hasMore?: boolean;
}

/** Saran customer untuk filter dropdown (GET /api/bookings/customers). */
export interface CustomerSuggestion {
  name: string;
}

export interface CustomersResponse {
  customers: CustomerSuggestion[];
}

/**
 * Terapkan filter rentang tanggal ke URL search params secara ATOMIK.
 *
 * Rentang DateRangeInput (Astryx) disimpan sebagai dua param URL terpisah
 * (`from`/`to`) agar API & shareable URL tidak berubah. Kedua ujung HARUS
 * ditulis dalam satu panggilan `setSearchParams` — dua panggilan terpisah di
 * handler yang sama saling menimpa (update kedua membaca searchParams basi),
 * membuat `from` hilang dan trigger picker tidak menampilkan tanggal.
 *
 * Fungsi ini murni (tanpa React) supaya bisa diuji unit: input `prev` adalah
 * searchParams saat ini, output adalah params berikutnya. Param lain (status,
 * title, customer, pagination, dll.) tidak tersentuh.
 */
export function applyRangeFilter(prev: URLSearchParams, range: DateRange | null): URLSearchParams {
  const next = new URLSearchParams(prev);
  if (range) {
    next.set('from', range.start);
    next.set('to', range.end);
  } else {
    next.delete('from');
    next.delete('to');
  }
  return next;
}
