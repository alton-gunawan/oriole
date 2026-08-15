/**
 * Zona waktu umum untuk pilihan di Settings. Daftar kurasi (bukan semua
 * ~400 IANA zone) agar dropdown tetap ringkas; label menampilkan offset UTC
 * saat ini supaya user langsung tahu bedanya jam.
 */
export const TIMEZONE_CURATED: string[] = [
  'UTC',
  'Asia/Jakarta',
  'Asia/Singapore',
  'Asia/Bangkok',
  'Asia/Ho_Chi_Minh',
  'Asia/Manila',
  'Asia/Kuala_Lumpur',
  'Asia/Hong_Kong',
  'Asia/Shanghai',
  'Asia/Taipei',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Asia/Kolkata',
  'Asia/Dhaka',
  'Asia/Karachi',
  'Asia/Dubai',
  'Asia/Riyadh',
  'Asia/Yerevan',
  'Asia/Tbilisi',
  'Europe/Istanbul',
  'Europe/Moscow',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Madrid',
  'Europe/Rome',
  'Europe/Amsterdam',
  'Europe/Warsaw',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Toronto',
  'America/Vancouver',
  'America/Mexico_City',
  'America/Bogota',
  'America/Lima',
  'America/Sao_Paulo',
  'America/Argentina/Buenos_Aires',
  'Australia/Sydney',
  'Australia/Melbourne',
  'Australia/Brisbane',
  'Australia/Perth',
  'Pacific/Auckland',
  'Pacific/Guam',
  'Pacific/Port_Moresby',
];

/** Offset UTC saat ini untuk sebuah IANA zone (mis. 'UTC+7') — '' bila gagal. */
export function timezoneOffsetLabel(timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'shortOffset',
    }).formatToParts(new Date());
    const offset = parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
    return offset.replace('GMT', 'UTC');
  } catch {
    return '';
  }
}

/** Label kota + offset, mis. 'Jakarta (UTC+7)'. */
export function timezoneLabel(timeZone: string): string {
  const city = timeZone.split('/').pop()?.replace(/_/g, ' ') ?? timeZone;
  const offset = timezoneOffsetLabel(timeZone);
  return offset ? `${city} (${offset})` : city;
}

/** Opsi zona waktu untuk dropdown Settings — label siap tampil. */
export const TIMEZONE_OPTIONS: { value: string; label: string }[] = TIMEZONE_CURATED.map(
  (value) => ({ value, label: timezoneLabel(value) }),
);

/** Zona waktu browser saat ini — fallback 'UTC' bila tidak tersedia. */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
