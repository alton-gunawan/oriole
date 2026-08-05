/** Jam tersisa sampai appointment. Negatif berarti jadwal sudah lewat. */
export function hoursUntil(scheduledAt: string, now: Date = new Date()): number {
  const scheduled = new Date(scheduledAt).getTime();
  if (Number.isNaN(scheduled)) return Number.POSITIVE_INFINITY;
  return (scheduled - now.getTime()) / 3_600_000;
}

/** Format appointment ke string ramah-suara sesuai timezone booking. */
export function formatAppointment(
  scheduledAt: string,
  timezone?: string | null,
  locale = 'en-US',
): string {
  const date = new Date(scheduledAt);
  if (Number.isNaN(date.getTime())) return scheduledAt;

  return new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timezone ?? undefined,
  }).format(date);
}
