import { formatAppointment } from '@oriole/call-goals';

import { buildCallbackData } from './parse.ts';

/**
 * Render pesan Telegram dari data booking (pure).
 * Copy berbahasa Indonesia — bot berbicara langsung ke customer akhir.
 */

export interface BookingReminderInput {
  businessName: string;
  customerName?: string | null;
  title: string;
  scheduledAt: string;
  timezone?: string | null;
}

/** Pesan reminder + tombol aksi (confirm / reschedule / cancel). */
export function renderBookingReminder(
  input: BookingReminderInput,
  bookingId: string,
): { text: string; buttons: { id: string; label: string }[] } {
  const when = formatSlotTime(input.scheduledAt, input.timezone);
  const customer = input.customerName?.trim();
  const greet = customer ? `Halo ${customer}! 👋` : 'Halo! 👋';

  const text = [
    greet,
    '',
    `Ini pengingat untuk **${input.title}** Anda di ${input.businessName}.`,
    '',
    `📅 ${when}`,
    '',
    'Silakan konfirmasi kehadiran Anda:',
  ].join('\n');

  return {
    text,
    buttons: [
      { id: buildCallbackData(bookingId, 'confirm'), label: '✅ Ya, hadir' },
      { id: buildCallbackData(bookingId, 'reschedule'), label: '📅 Ubah jadwal' },
      { id: buildCallbackData(bookingId, 'cancel'), label: '❌ Batalkan' },
    ],
  };
}

/** Format jam-slot (mis. "besok 14:00") untuk dibaca manusia. */
export function formatSlotTime(scheduledAt: string, timezone?: string | null): string {
  return formatAppointment(scheduledAt, timezone, 'id-ID');
}

export function renderConfirmReply(scheduledAt: string, timezone?: string | null): string {
  return [
    '✅ Terima kasih, kehadiran Anda telah dikonfirmasi!',
    '',
    `Kami tunggu kedatangan Anda: ${formatSlotTime(scheduledAt, timezone)}.`,
  ].join('\n');
}

export function renderCancelReply(title: string): string {
  return `Baik, booking **${title}** telah dibatalkan. Semoga berjumpa lain waktu! 🙏`;
}

export function renderReschedulePrompt(): string {
  return [
    '📅 Silakan ketik waktu baru yang Anda inginkan.',
    '',
    'Format: `2026-08-15 14:00` (tanggal dan jam, waktu setempat).',
    'Atau ketik *Batal* untuk membatalkan perubahan jadwal.',
  ].join('\n');
}

export function renderRescheduleSuccess(scheduledAt: string, timezone?: string | null): string {
  return `✅ Jadwal baru Anda: ${formatSlotTime(scheduledAt, timezone)}. Terima kasih!`;
}

export function renderRescheduleCancelled(): string {
  return 'Baik, perubahan jadwal dibatalkan. Jadwal Anda tetap seperti semula. 👍';
}

export function renderRescheduleInvalid(): string {
  return [
    '⚠️ Maaf, format waktu tidak dikenali.',
    '',
    'Gunakan format: `2026-08-15 14:00`',
  ].join('\n');
}

export function renderAlreadyHandledReply(): string {
  return 'Booking ini sudah diproses sebelumnya — tidak ada perubahan lebih lanjut.';
}

export function renderBookingNotFoundReply(): string {
  return 'Maaf, booking tidak ditemukan. Silakan hubungi tempat usaha Anda.';
}

export function renderAskPhoneReply(): string {
  return [
    'Terima kasih sudah menghubungi kami! 🙌',
    '',
    'Agar kami bisa mengirimkan pengingat booking lewat Telegram,',
    'silakan ketik nomor HP Anda, contoh: `081234567890`.',
  ].join('\n');
}

export function renderLinkedReply(): string {
  return '✅ Nomor Anda telah terhubung! Anda akan menerima pengingat booking di sini.';
}

export function renderPhoneMismatchReply(): string {
  return [
    '⚠️ Nomor ini tidak cocok dengan nomor pada booking Anda.',
    'Pastikan mengetik nomor yang sama dengan yang didaftarkan saat booking.',
  ].join('\n');
}

export function renderOptOutReply(): string {
  return 'Anda telah berhenti menerima pesan dari kami. Untuk berlangganan kembali, kirim pesan apa pun.';
}

export function renderGenericReply(): string {
  return [
    'Terima kasih atas pesan Anda!',
    'Anda dapat membalas dengan *STOP* kapan saja untuk berhenti menerima pesan.',
  ].join('\n');
}

/**
 * Parse teks waktu baru menjadi Date.
 *
 * Mendukung:
 * - ISO datetime ber-offset: `2026-08-15T14:00:00+07:00`
 * - Naive `YYYY-MM-DD HH:mm` (atau `YYYY-MM-DDTHH:mm`) — ditafsirkan
 *   sebagai waktu setempat booking (timezone), default UTC.
 * Return null bila tidak dapat diparse.
 */
export function parseSlotTime(
  text: string,
  timezone?: string | null,
  now: Date = new Date(),
): Date | null {
  const trimmed = text.trim();

  // ISO dengan offset / zona (mis. "2026-08-15T14:00:00+07:00" atau "...Z").
  const isoMatch = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(
    trimmed,
  );
  if (isoMatch) {
    const date = new Date(trimmed);
    if (Number.isNaN(date.getTime())) return null;
    return date;
  }

  // Naive lokal: "2026-08-15 14:00" / "2026-08-15T14:00"
  const naiveMatch = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(trimmed);
  if (!naiveMatch) return null;

  const [, year, month, day, hour, minute] = naiveMatch.map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;

  const tz = timezone && timezone.length > 0 ? timezone : 'UTC';
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, 0);

  // Offset zona (mis. +07:00) pada waktu perkiraan; iterasi agar akurat
  // meski melintasi pergeseran DST.
  let utc = naiveUtc;
  for (let i = 0; i < 3; i++) {
    const offset = zonedPartsAsUtc(utc, tz) - utc;
    const next = naiveUtc - offset;
    if (next === utc) break;
    utc = next;
  }

  const parsed = new Date(utc);
  if (Number.isNaN(parsed.getTime()) || parsed.getTime() < now.getTime()) return null;
  return parsed;
}

/**
 * Interpretasikan komponen wall-clock dari epoch `utcMs` di zona `tz`
 * sebagai timestamp UTC (dipakai untuk menghitung offset zona).
 */
function zonedPartsAsUtc(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
    .formatToParts(utcMs)
    .reduce<Record<string, string>>((acc, part) => {
      if (part.type !== 'literal') acc[part.type] = part.value;
      return acc;
    }, {});

  const hour = Number(parts.hour) % 24; // '24' = tengah malam
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second),
  );
}
