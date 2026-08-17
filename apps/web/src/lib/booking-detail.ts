import type { CallRecord } from './bookings';

/**
 * Hasil interaksi AI dengan customer — bahasa bisnis, bukan status teknis
 * panggilan. Ditampilkan di hero "AI confirmation" Booking Detail.
 *
 * - `confirmed`            — customer mengonfirmasi kehadiran
 * - `reschedule-requested` — customer minta jadwal ulang
 * - `cancelled`            — customer membatalkan
 * - `no-answer`            — panggilan tidak diangkat (voicemail / sibuk)
 * - `failed`               — kegagalan teknis / panggilan tidak terjadi
 * - `unknown`              — belum ada hasil (panggilan berjalan / tanpa data)
 */
export type CallOutcome =
  | 'confirmed'
  | 'reschedule-requested'
  | 'cancelled'
  | 'no-answer'
  | 'failed'
  | 'unknown';

export interface CallOutcomeOptions {
  /**
   * Booking sudah berstatus completed — panggilan yang selesai (percakapan
   * terjadi) dianggap menghasilkan konfirmasi, karena alur auto-call menandai
   * booking completed saat goal tercapai.
   */
  bookingCompleted?: boolean;
}

/** Petunjuk kata yang menandakan customer tidak bisa dihubungi. */
const NO_ANSWER_HINTS = [
  'no-answer',
  'no answer',
  'noanswer',
  'did-not-answer',
  'did not answer',
  'customer-busy',
  'customer busy',
  'busy',
  'voicemail',
  'not answering',
];

/** Baca string dari kunci result (pertama yang terisi menang). */
function readString(
  result: Record<string, unknown> | null | undefined,
  keys: string[],
): string | null {
  if (!result) return null;
  for (const key of keys) {
    const value = result[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Derive outcome AI call dari data yang tersedia — murni & deterministik agar
 * mudah diuji. Prioritas:
 *
 * 1. `result.outcome` / `result.result` eksplisit (ditulis pipeline analisis)
 *    — paling dipercaya, dinormalisasi lewat pencocokan kata kunci.
 * 2. Status panggilan + `endedReason` Vapi:
 *    - canceled → cancelled
 *    - failed + endedReason no-answer/busy/voicemail → no-answer
 *    - failed selain itu → failed
 *    - completed + booking completed → confirmed (goal tercapai)
 *    - completed tanpa booking completed → unknown (percakapan terjadi tapi
 *      tidak ada komitmen)
 * 3. Status lain (queued/ringing/in_progress) → unknown.
 */
export function deriveCallOutcome(
  call: Pick<CallRecord, 'status' | 'result'> | null | undefined,
  options: CallOutcomeOptions = {},
): CallOutcome {
  if (!call) return 'unknown';

  // 1. Outcome eksplisit yang ditulis pipeline (future-proof).
  const explicit = readString(call.result, ['outcome', 'result']);
  if (explicit) {
    const normalized = explicit.toLowerCase();
    if (/resched|postpone|reschedule/.test(normalized)) return 'reschedule-requested';
    if (/cancel/.test(normalized)) return 'cancelled';
    if (/confirm/.test(normalized)) return 'confirmed';
    if (NO_ANSWER_HINTS.some((hint) => normalized.includes(hint))) return 'no-answer';
    if (/fail|error/.test(normalized)) return 'failed';
  }

  // 2. Status panggilan + endedReason.
  const status = call.status ?? readString(call.result, ['status']);
  const endedReason = (readString(call.result, ['endedReason']) ?? '').toLowerCase();

  if (status === 'canceled' || status === 'cancelled' || /cancel/.test(endedReason)) {
    return 'cancelled';
  }
  if (status === 'failed' || status === 'error' || /fail|error/.test(endedReason)) {
    return NO_ANSWER_HINTS.some((hint) => endedReason.includes(hint)) ? 'no-answer' : 'failed';
  }
  if (status === 'completed' || status === 'success') {
    return options.bookingCompleted ? 'confirmed' : 'unknown';
  }

  return 'unknown';
}

/** Durasi panggilan dalam menit + detik (dibulatkan ke detik terdekat). */
export interface CallDurationParts {
  minutes: number;
  seconds: number;
}

/**
 * Pecah durasi (detik) menjadi menit + detik untuk ditampilkan. Nilai
 * non-positif / tidak valid → null (panggilan tanpa durasi tercatat).
 */
export function callDurationParts(
  seconds: number | null | undefined,
): CallDurationParts | null {
  if (seconds === null || seconds === undefined) return null;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const total = Math.round(seconds);
  return { minutes: Math.floor(total / 60), seconds: total % 60 };
}

/**
 * Ringkasan eksplisit hasil panggilan (ditulis pipeline analisis), bila ada.
 * Kosong → null; halaman memakai kalimat turunan dari outcome sebagai gantinya.
 */
export function callSummaryText(
  call: Pick<CallRecord, 'result'> | null | undefined,
): string | null {
  if (!call) return null;
  const summary = readString(call.result, ['summary', 'resultSummary']);
  return summary || null;
}
