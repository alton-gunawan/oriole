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

/**
 * IANA zone → ISO 3166-1 alpha-2 untuk zona umum. Map kurasi: zona di luar
 * daftar dilimpahkan ke fallback region locale browser (lihat
 * `browserCountryCode`), jadi tidak perlu ~400 entry lengkap.
 */
const TZ_TO_COUNTRY: Record<string, string> = {
  // Asia Tenggara & Asia
  'Asia/Jakarta': 'ID',
  'Asia/Makassar': 'ID',
  'Asia/Pontianak': 'ID',
  'Asia/Jayapura': 'ID',
  'Asia/Singapore': 'SG',
  'Asia/Bangkok': 'TH',
  'Asia/Ho_Chi_Minh': 'VN',
  'Asia/Phnom_Penh': 'KH',
  'Asia/Vientiane': 'LA',
  'Asia/Yangon': 'MM',
  'Asia/Manila': 'PH',
  'Asia/Kuala_Lumpur': 'MY',
  'Asia/Brunei': 'BN',
  'Asia/Hong_Kong': 'HK',
  'Asia/Shanghai': 'CN',
  'Asia/Taipei': 'TW',
  'Asia/Seoul': 'KR',
  'Asia/Tokyo': 'JP',
  'Asia/Kolkata': 'IN',
  'Asia/Colombo': 'LK',
  'Asia/Kathmandu': 'NP',
  'Asia/Dhaka': 'BD',
  'Asia/Karachi': 'PK',
  'Asia/Kabul': 'AF',
  'Asia/Tashkent': 'UZ',
  'Asia/Almaty': 'KZ',
  'Asia/Dubai': 'AE',
  'Asia/Muscat': 'OM',
  'Asia/Riyadh': 'SA',
  'Asia/Kuwait': 'KW',
  'Asia/Bahrain': 'BH',
  'Asia/Qatar': 'QA',
  'Asia/Jerusalem': 'IL',
  'Asia/Beirut': 'LB',
  'Asia/Amman': 'JO',
  'Asia/Baghdad': 'IQ',
  'Asia/Tehran': 'IR',
  'Asia/Yerevan': 'AM',
  'Asia/Tbilisi': 'GE',
  'Asia/Baku': 'AZ',
  // Eropa
  'Europe/Istanbul': 'TR',
  'Europe/Moscow': 'RU',
  'Europe/London': 'GB',
  'Europe/Dublin': 'IE',
  'Europe/Lisbon': 'PT',
  'Europe/Madrid': 'ES',
  'Europe/Paris': 'FR',
  'Europe/Berlin': 'DE',
  'Europe/Brussels': 'BE',
  'Europe/Amsterdam': 'NL',
  'Europe/Vienna': 'AT',
  'Europe/Zurich': 'CH',
  'Europe/Rome': 'IT',
  'Europe/Athens': 'GR',
  'Europe/Helsinki': 'FI',
  'Europe/Stockholm': 'SE',
  'Europe/Oslo': 'NO',
  'Europe/Copenhagen': 'DK',
  'Europe/Warsaw': 'PL',
  'Europe/Prague': 'CZ',
  'Europe/Budapest': 'HU',
  'Europe/Bucharest': 'RO',
  'Europe/Sofia': 'BG',
  'Europe/Kyiv': 'UA',
  'Europe/Reykjavik': 'IS',
  // Amerika Utara
  'America/New_York': 'US',
  'America/Chicago': 'US',
  'America/Denver': 'US',
  'America/Phoenix': 'US',
  'America/Los_Angeles': 'US',
  'America/Anchorage': 'US',
  'America/Honolulu': 'US',
  'America/Toronto': 'CA',
  'America/Vancouver': 'CA',
  'America/Montreal': 'CA',
  'America/Ottawa': 'CA',
  'America/Winnipeg': 'CA',
  'America/Edmonton': 'CA',
  'America/Halifax': 'CA',
  'America/Mexico_City': 'MX',
  'America/Guatemala': 'GT',
  'America/Panama': 'PA',
  'America/Havana': 'CU',
  // Amerika Selatan
  'America/Bogota': 'CO',
  'America/Lima': 'PE',
  'America/Santiago': 'CL',
  'America/Sao_Paulo': 'BR',
  'America/Argentina/Buenos_Aires': 'AR',
  'America/Caracas': 'VE',
  'America/Guayaquil': 'EC',
  'America/La_Paz': 'BO',
  'America/Asuncion': 'PY',
  'America/Montevideo': 'UY',
  // Oseania
  'Australia/Sydney': 'AU',
  'Australia/Melbourne': 'AU',
  'Australia/Brisbane': 'AU',
  'Australia/Perth': 'AU',
  'Australia/Adelaide': 'AU',
  'Australia/Darwin': 'AU',
  'Pacific/Auckland': 'NZ',
  'Pacific/Guam': 'GU',
  'Pacific/Port_Moresby': 'PG',
  'Pacific/Fiji': 'FJ',
};

/** IANA zone → ISO 3166-1 alpha-2 (dieksekpor untuk pengujian & pemetaan ulang). */
export const COUNTRY_BY_TIMEZONE: Readonly<Record<string, string>> = TZ_TO_COUNTRY;

/**
 * Kode negara (ISO 3166-1 alpha-2) terdeteksi dari browser: zona waktu IANA
 * dulu (sinyal lokasi terkuat tanpa izin), lalu region locale ('en-US' → 'US').
 * '' bila keduanya gagal.
 */
export function browserCountryCode(): string {
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions();
    const zone = resolved.timeZone;
    if (zone && TZ_TO_COUNTRY[zone]) return TZ_TO_COUNTRY[zone];
    const region = new Intl.Locale(resolved.locale).region;
    return region ?? '';
  } catch {
    return '';
  }
}
