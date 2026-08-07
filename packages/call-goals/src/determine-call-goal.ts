import { hoursUntil } from './format.ts';
import type {
  BookingGoalContext,
  BookingStatus,
  GoalDecision,
  GoalDecisionOptions,
} from './types.ts';

/** Jendela reminder default: di bawah nilai ini, booking terkonfirmasi diingatkan ulang. */
export const REMINDER_WINDOW_HOURS = 24;

/** Ambang percobaan gagal sebelum goal jadi final follow-up. */
export const FAILED_ATTEMPT_THRESHOLD = 2;

const VALID_STATUSES: readonly BookingStatus[] = ['pending', 'confirmed', 'cancelled', 'completed'];

/**
 * Mesin keputusan goal CALL-E — pure & deterministik agar mudah diuji.
 *
 * Prioritas (pertama yang cocok menang):
 * 1. cancelled / completed  → tidak perlu panggilan
 * 2. customer minta ubah   → reschedule-assistance
 * 3. jadwal sudah lewat    → final-follow-up (kejar untuk jadwal ulang)
 * 4. banyak panggilan gagal→ final-follow-up
 * 5. riwayat no-show       → confirm-with-accountability
 * 6. confirmed & ≤24 jam   → reminder-reconfirm
 * 7. belum pernah dihubungi→ confirm-attendance
 * 8. sudah dihubungi       → reminder-reconfirm (lanjutan)
 */
export function determineCallGoal(
  booking: BookingGoalContext,
  options: GoalDecisionOptions = {},
): GoalDecision {
  // Jendela reminder bisa dikonfigurasi per workspace (auto-call lead hours).
  const reminderWindowHours = options.reminderWindowHours ?? REMINDER_WINDOW_HOURS;

  // Status asing dari DB di-koersi ke 'pending' — jangan pernah crash.
  const status: BookingStatus = VALID_STATUSES.includes(booking.status)
    ? booking.status
    : 'pending';

  if (status === 'cancelled') {
    return { goalType: null, reason: 'Booking dibatalkan — tidak perlu panggilan.' };
  }
  if (status === 'completed') {
    return { goalType: null, reason: 'Booking sudah selesai — tidak perlu panggilan.' };
  }

  if (booking.changeRequested) {
    return {
      goalType: 'reschedule-assistance',
      reason: 'Customer meminta perubahan jadwal.',
    };
  }

  if (hoursUntil(booking.scheduledAt) < 0) {
    return {
      goalType: 'final-follow-up',
      reason: 'Waktu appointment sudah lewat — follow-up terakhir untuk menjadwalkan ulang.',
    };
  }

  if (booking.failedCallAttempts >= FAILED_ATTEMPT_THRESHOLD) {
    return {
      goalType: 'final-follow-up',
      reason: `${booking.failedCallAttempts} percobaan panggilan gagal — final follow-up.`,
    };
  }

  if (booking.noShowCount > 0) {
    return {
      goalType: 'confirm-with-accountability',
      reason: 'Customer punya riwayat no-show — konfirmasi dengan soft accountability.',
    };
  }

  if (status === 'confirmed' && hoursUntil(booking.scheduledAt) <= reminderWindowHours) {
    return {
      goalType: 'reminder-reconfirm',
      reason: `Booking terkonfirmasi ≤ ${reminderWindowHours} jam sebelum jadwal — reminder + re-confirm.`,
    };
  }

  if (booking.previousCallAttempts === 0) {
    return {
      goalType: 'confirm-attendance',
      reason: 'Booking baru dan belum pernah dihubungi — konfirmasi kehadiran.',
    };
  }

  if (status === 'pending' || status === 'confirmed') {
    return {
      goalType: 'reminder-reconfirm',
      reason: 'Sudah pernah dihubungi, masih menunggu — reminder lanjutan.',
    };
  }

  return {
    goalType: 'confirm-attendance',
    reason: 'Fallback default — konfirmasi kehadiran.',
  };
}
