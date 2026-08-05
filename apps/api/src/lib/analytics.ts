/**
 * Agregasi analytics MURNI (tanpa akses DB) — semua fungsi menerima baris
 * mentah dan mengembalikan data siap-chart. Dipisahkan dari route agar bisa
 * di-unit-test tanpa database & dipakai ulang.
 *
 * Kunci bulan memakai format `YYYY-MM` (lokal, bukan timezone DB) —
 * konsisten dengan label bulan di frontend (Intl).
 */

export interface BookingRow {
  status: string;
  createdAt: Date;
}

export interface CallRow {
  status: string | null;
  createdAt: Date;
}

export interface MessageRow {
  channel: string;
  direction: string;
}

export interface ConversationRow {
  state: Record<string, unknown> | null;
}

/** Kunci bulan lokal: `YYYY-MM` dari sebuah Date. */
export function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** Deret 12 bulan terakhir (termasuk bulan berjalan), urut naik. */
export function lastTwelveMonths(now = new Date()): string[] {
  const months: string[] = [];
  for (let i = 11; i >= 0; i--) {
    months.push(monthKey(new Date(now.getFullYear(), now.getMonth() - i, 1)));
  }
  return months;
}

/** Booking per bulan (12 bulan terakhir), bulan kosong diisi 0. */
export function aggregateBookingsByMonth(
  rows: BookingRow[],
  now = new Date(),
): { month: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = monthKey(row.createdAt);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return lastTwelveMonths(now).map((month) => ({ month, count: counts.get(month) ?? 0 }));
}

/** Distribusi status booking. */
export function aggregateBookingStatus(
  rows: BookingRow[],
): { status: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  }
  return [...counts.entries()].map(([status, count]) => ({ status, count }));
}

/**
 * Funnel konversi: created → confirmed → completed.
 * Status bersifat eksklusif (satu booking satu status), jadi "confirmed"
 * dihitung sebagai booking yang pernah/berada di tahap konfirmasi
 * (confirmed + completed) — turun secara alami menuju completed.
 */
export function buildFunnel(
  rows: BookingRow[],
): { step: 'created' | 'confirmed' | 'completed'; count: number }[] {
  const byStatus = aggregateBookingStatus(rows);
  const total = byStatus.reduce((acc, row) => acc + row.count, 0);
  const confirmed = byStatus.find((row) => row.status === 'confirmed')?.count ?? 0;
  const completed = byStatus.find((row) => row.status === 'completed')?.count ?? 0;
  return [
    { step: 'created', count: total },
    { step: 'confirmed', count: confirmed + completed },
    { step: 'completed', count: completed },
  ];
}

/** Distribusi hasil panggilan CALL-E (status provider; null → 'unknown'). */
export function aggregateCallOutcomes(
  rows: CallRow[],
): { status: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = row.status ?? 'unknown';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([status, count]) => ({ status, count }));
}

/** Pesan per channel, dipecah inbound/outbound. */
export function aggregateMessagesByChannel(
  rows: MessageRow[],
): { channel: string; inbound: number; outbound: number }[] {
  const map = new Map<string, { inbound: number; outbound: number }>();
  for (const row of rows) {
    const entry = map.get(row.channel) ?? { inbound: 0, outbound: 0 };
    if (row.direction === 'inbound') entry.inbound += 1;
    else entry.outbound += 1;
    map.set(row.channel, entry);
  }
  return [...map.entries()].map(([channel, counts]) => ({ channel, ...counts }));
}

/** Jumlah percakapan yang butuh perhatian staf/AI. */
export function countNeedsAttention(rows: ConversationRow[]): number {
  return rows.filter((row) => (row.state ?? {}).needsAttention === true).length;
}

/** Jumlah baris pada bulan berjalan (dipakai stat "bulan ini"). */
export function countThisMonth(rows: { createdAt: Date }[], now = new Date()): number {
  return rows.filter((row) => monthKey(row.createdAt) === monthKey(now)).length;
}
