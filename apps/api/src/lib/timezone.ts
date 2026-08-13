/**
 * Helper zona waktu untuk mesin availabilitas.
 *
 * Semua jadwal staf disimpan sebagai (dayOfWeek, menit-sejak-tengah-malam)
 * dalam zona waktu staf. Untuk mengubahnya menjadi instant absolut, kita
 * butuh konversi "waktu lokal → UTC" tanpa library eksternal:
 *   zonedTimeToUtc(y, m, d, hh, mm, tz)
 * dengan trik offset (pola yang sama seperti date-fns-tz): hitung instan
 * UTC naif, ambil offset zona pada instan itu, kurangi offset-nya.
 *
 * Akurasi: benar untuk semua kasus kecuali dalam 1 jam ambigu DST (slip/gap)
 * — zona tanpa DST (Asia/Jakarta, dst.) tidak terpengaruh.
 */

/** Offset zona waktu (menit, UTC+) dari sebuah instant. */
export function timeZoneOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asEpoch = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return Math.round((asEpoch - date.getTime()) / 60_000);
}

/** Tanggal lokal (y/m/d) sebuah instant dalam zona waktu. */
export function localDateParts(date: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

/** Konversi waktu lokal (zona tz) → instant UTC. */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hours: number,
  minutes: number,
  timeZone: string,
): Date {
  const asUtc = Date.UTC(year, month - 1, day, hours, minutes);
  const offset = timeZoneOffsetMinutes(new Date(asUtc), timeZone);
  return new Date(asUtc - offset * 60_000);
}

/** Awal hari lokal (00:00) untuk tanggal lokal tertentu. */
export function zonedDayStart(
  year: number,
  month: number,
  day: number,
  timeZone: string,
): Date {
  return zonedTimeToUtc(year, month, day, 0, 0, timeZone);
}

/**
 * Awal hari lokal sebuah instant (hari kalender tempat instant berada,
 * dihitung dalam zona waktu).
 */
export function startOfLocalDay(date: Date, timeZone: string): Date {
  const { year, month, day } = localDateParts(date, timeZone);
  return zonedDayStart(year, month, day, timeZone);
}

/** Akhir hari lokal (tepat sebelum tengah malam berikutnya) sebuah instant. */
export function endOfLocalDay(date: Date, timeZone: string): Date {
  const { year, month, day } = localDateParts(date, timeZone);
  return zonedDayStart(year, month, day + 1, timeZone);
}
