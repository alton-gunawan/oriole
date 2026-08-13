import { z } from 'zod';

import type { RecurrenceRule } from '@oriole/database';

/**
 * Recurring appointments — aturan pengulangan + ekspansi ke daftar instan
 * awal. Semua aritmetika waktu memakai UTC: anchor menentukan waktu hari
 * (jam/menit), setiap kemunculan memakai jam/menit UTC yang sama.
 *
 * Batas keamanan: `RECURRENCE_MAX_OCCURRENCES` (default 52) membatasi
 * ekspansi agar satu booking recurring tidak meledak menjadi ratusan baris
 * / event reminder. Horizon default 12 bulan.
 */

export const RECURRENCE_MAX_OCCURRENCES = 52;
export const RECURRENCE_MAX_LOOKAHEAD_MONTHS = 12;

export const recurrenceSchema = z
  .object({
    frequency: z.enum(['daily', 'weekly', 'monthly']),
    interval: z.number().int().min(1).max(90).default(1),
    /** Jumlah total kemunculan (termasuk yang pertama). Menang atas `until`. */
    count: z.number().int().min(1).max(RECURRENCE_MAX_OCCURRENCES).optional(),
    /** Batas berhenti (YYYY-MM-DD, inklusif). Diabaikan bila `count` ada. */
    until: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'until harus berformat YYYY-MM-DD')
      .optional(),
    /** Hanya untuk weekly: hari dalam seminggu (0=Min..6=Sab) yang dilayani. */
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  })
  .strict()
  .refine((rule) => rule.frequency !== 'weekly' || !rule.weekdays || rule.weekdays.length > 0, {
    message: 'weekdays tidak boleh kosong untuk frequency weekly',
    path: ['weekdays'],
  });

export const DEFAULT_RECURRENCE_RULE: RecurrenceRule = {
  frequency: 'weekly',
  interval: 1,
};

const DAY_MS = 86_400_000;

function addDaysUtc(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function addMonthsUtc(date: Date, months: number): Date {
  const result = new Date(date);
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
}

/** Validasi cepat aturan — melempar bila tidak valid (dipakai data terlanjur tersimpan). */
export function assertValidRecurrence(rule: RecurrenceRule): void {
  recurrenceSchema.parse(rule);
}

/**
 * Ekspansi aturan pengulangan → daftar instant awal (urut naik, unik).
 *
 * Urutan evaluasi: (1) bangun deret mentah dari anchor; (2) terapkan
 * `count` / `until` pada deret itu (bukan hasil filter rentang!); (3) baru
 * filter `from`/`to`. Dengan begitu `count` selalu menghitung total
 * kemunculan dari anchor, bukan hanya yang jatuh di rentang.
 */
export function expandRecurrence(
  rule: RecurrenceRule,
  anchor: Date,
  options: {
    from?: Date;
    to?: Date;
    maxOccurrences?: number;
  } = {},
): Date[] {
  const { from, to, maxOccurrences = RECURRENCE_MAX_OCCURRENCES } = options;
  const interval = Math.max(1, Math.trunc(rule.interval ?? 1));
  const anchorMs = anchor.getTime();

  // ── (1) Deret mentah, dibatasi maxOccurrences (anti-loop) ──
  const raw: Date[] = [];
  if (rule.frequency === 'weekly' && rule.weekdays && rule.weekdays.length > 0) {
    const weekdays = [...new Set(rule.weekdays)].sort((a, b) => a - b);
    const anchorDow = anchor.getUTCDay();
    const weekStartMs = anchorMs - anchorDow * DAY_MS;
    const anchorTimeInWeek = anchorMs - weekStartMs; // dow×hari + jam-anchor
    for (let i = 0; raw.length < maxOccurrences; i++) {
      const weekStart = weekStartMs + i * interval * 7 * DAY_MS;
      for (const dow of weekdays) {
        raw.push(new Date(weekStart + dow * DAY_MS + (anchorTimeInWeek - anchorDow * DAY_MS)));
        if (raw.length >= maxOccurrences) break;
      }
    }
  } else if (rule.frequency === 'daily') {
    for (let i = 0; i < maxOccurrences; i++) {
      raw.push(addDaysUtc(anchor, i * interval));
    }
  } else if (rule.frequency === 'monthly') {
    for (let i = 0; i < maxOccurrences; i++) {
      raw.push(addMonthsUtc(anchor, i * interval));
    }
  } else {
    // weekly tanpa weekdays → hanya hari anchor tiap interval minggu.
    for (let i = 0; i < maxOccurrences; i++) {
      raw.push(addDaysUtc(anchor, i * interval * 7));
    }
  }

  // ── (2) Sort + dedupe + count/until ──
  raw.sort((a, b) => a.getTime() - b.getTime());
  let sequence = [...new Map(raw.map((d) => [d.getTime(), d])).values()];
  if (rule.count !== undefined) {
    sequence = sequence.slice(0, rule.count);
  } else if (rule.until) {
    const untilEnd = Date.UTC(
      Number(rule.until.slice(0, 4)),
      Number(rule.until.slice(5, 7)) - 1,
      Number(rule.until.slice(8, 10)),
      23,
      59,
      59,
    );
    sequence = sequence.filter((instant) => instant.getTime() <= untilEnd);
  }

  // ── (3) Filter rentang ──
  const fromMs = from?.getTime();
  const toMs = to?.getTime();
  if (fromMs !== undefined || toMs !== undefined) {
    sequence = sequence.filter(
      (instant) =>
        (fromMs === undefined || instant.getTime() >= fromMs) &&
        (toMs === undefined || instant.getTime() <= toMs),
    );
  }
  return sequence;
}
