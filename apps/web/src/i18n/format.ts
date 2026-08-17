import i18n from 'i18next';

/** Locale aktif untuk Intl — resolvedLanguage menjamin 'en'/'id' konsisten. */
export function activeLocale(): string {
  return i18n.resolvedLanguage ?? i18n.language ?? 'en';
}

/** Tanggal + jam — dipakai untuk daftar & kartu (mis. daftar booking). */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(activeLocale(), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Tanggal + jam tanpa tahun — dipakai detail panggilan (mis. "Aug 18 · 10:03 AM"). */
export function formatShortDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(activeLocale(), {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Tanggal panjang — dipakai untuk detail (mis. periode berlangganan). */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(activeLocale(), {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/** Tanggal + jam lengkap dengan timezone tertentu (mis. jadwal booking). */
export function formatDateTimeFull(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(activeLocale(), {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  });
}

/** Bilangan berpemisah ribuan sesuai locale (mis. statistik). */
export function formatNumber(value: number): string {
  return new Intl.NumberFormat(activeLocale()).format(value);
}
