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
  callAttempts: { total: number; failed: number };
  autoGoal: GoalDecision;
  createdAt: string;
  updatedAt: string;
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
