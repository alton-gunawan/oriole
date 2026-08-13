import { formatAppointment } from '@oriole/call-goals';

import { buildCallbackData } from './parse.ts';
import type { BotLanguage } from '../types.ts';

/**
 * Render pesan Telegram dari data booking (pure).
 *
 * Semua balasan mendukung dua bahasa via parameter `language` (default `en`).
 * Bahasa dipilih dari preferensi workspace (callGoalLanguage) — jadi default
 * sistem adalah bahasa Inggris, dan workspace bisa memilih bahasa Indonesia.
 */

export interface BookingReminderInput {
  businessName: string;
  customerName?: string | null;
  title: string;
  scheduledAt: string;
  timezone?: string | null;
  /** Link video call (Zoom / Google Meet) — disertakan bila ada. */
  videoLink?: string | null;
}

/** Pesan reminder + tombol aksi (confirm / reschedule / cancel). */
export function renderBookingReminder(
  input: BookingReminderInput,
  bookingId: string,
  language: BotLanguage = 'en',
): { text: string; buttons: { id: string; label: string }[] } {
  const when = formatSlotTime(input.scheduledAt, input.timezone, language);
  const customer = input.customerName?.trim();
  const greet = customer
    ? (language === 'id' ? `Halo ${customer}! 👋` : `Hello ${customer}! 👋`)
    : (language === 'id' ? 'Halo! 👋' : 'Hello! 👋');

  const videoLine = input.videoLink ? `📹 Video call: ${input.videoLink}` : null;
  const text =
    language === 'id'
      ? [
          greet,
          '',
          `Ini pengingat untuk **${input.title}** Anda di ${input.businessName}.`,
          '',
          `📅 ${when}`,
          ...(videoLine ? ['', videoLine] : []),
          '',
          'Silakan konfirmasi kehadiran Anda:',
        ].join('\n')
      : [
          greet,
          '',
          `This is a reminder for your **${input.title}** at ${input.businessName}.`,
          '',
          `📅 ${when}`,
          ...(videoLine ? ['', videoLine] : []),
          '',
          'Please confirm your attendance:',
        ].join('\n');

  return {
    text,
    buttons:
      language === 'id'
        ? [
            { id: buildCallbackData(bookingId, 'confirm'), label: '✅ Ya, hadir' },
            { id: buildCallbackData(bookingId, 'reschedule'), label: '📅 Ubah jadwal' },
            { id: buildCallbackData(bookingId, 'cancel'), label: '❌ Batalkan' },
          ]
        : [
            { id: buildCallbackData(bookingId, 'confirm'), label: '✅ Yes, I will attend' },
            { id: buildCallbackData(bookingId, 'reschedule'), label: '📅 Reschedule' },
            { id: buildCallbackData(bookingId, 'cancel'), label: '❌ Cancel' },
          ],
  };
}

/** Format jam-slot (mis. "besok 14:00") untuk dibaca manusia. */
export function formatSlotTime(
  scheduledAt: string,
  timezone?: string | null,
  language: BotLanguage = 'en',
): string {
  return formatAppointment(scheduledAt, timezone, language === 'id' ? 'id-ID' : 'en-US');
}

/** Input render pesan undangan mengisi form (channel-agnostic). */
export interface FormInvitationInput {
  businessName?: string | null;
  customerName?: string | null;
  formName: string;
  formUrl: string;
}

/**
 * Render pesan undangan mengisi form (Google Forms / Tally) — dipakai
 * saat staf mengirim tautan form ke customer via channel mana pun.
 * URL ditaruh di baris sendiri agar mudah diketuk di layar sempit.
 */
export function renderFormInvitation(
  input: FormInvitationInput,
  language: BotLanguage = 'en',
): string {
  const customer = input.customerName?.trim();
  const greet = customer
    ? (language === 'id' ? `Halo ${customer}! 👋` : `Hello ${customer}! 👋`)
    : (language === 'id' ? 'Halo! 👋' : 'Hello! 👋');
  const business = input.businessName?.trim();

  const lines =
    language === 'id'
      ? [
          greet,
          '',
          `Silakan isi ${input.formName}${business ? ` untuk ${business}` : ''} melalui tautan berikut:`,
          '',
          input.formUrl,
          '',
          'Terima kasih! 🙏',
        ]
      : [
          greet,
          '',
          `Please fill in ${input.formName}${business ? ` for ${business}` : ''} using the following link:`,
          '',
          input.formUrl,
          '',
          'Thank you! 🙏',
        ];
  return lines.join('\n');
}

export function renderConfirmReply(
  scheduledAt: string,
  timezone?: string | null,
  language: BotLanguage = 'en',
): string {
  return language === 'id'
    ? [
        '✅ Terima kasih, kehadiran Anda telah dikonfirmasi!',
        '',
        `Kami tunggu kedatangan Anda: ${formatSlotTime(scheduledAt, timezone, language)}.`,
      ].join('\n')
    : [
        '✅ Thank you, your attendance has been confirmed!',
        '',
        `We look forward to seeing you: ${formatSlotTime(scheduledAt, timezone, language)}.`,
      ].join('\n');
}

export function renderCancelReply(title: string, language: BotLanguage = 'en'): string {
  return language === 'id'
    ? `Baik, booking **${title}** telah dibatalkan. Semoga berjumpa lain waktu! 🙏`
    : `Okay, your booking **${title}** has been cancelled. Hope to see you another time! 🙏`;
}

export function renderReschedulePrompt(language: BotLanguage = 'en'): string {
  return language === 'id'
    ? [
        '📅 Silakan ketik waktu baru yang Anda inginkan.',
        '',
        'Format: `2026-08-15 14:00` (tanggal dan jam, waktu setempat).',
        'Atau ketik *Batal* untuk membatalkan perubahan jadwal.',
      ].join('\n')
    : [
        '📅 Please type the new time you would like.',
        '',
        'Format: `2026-08-15 14:00` (date and time, local time).',
        'Or type *Cancel* to keep your current schedule.',
      ].join('\n');
}

export function renderRescheduleSuccess(
  scheduledAt: string,
  timezone?: string | null,
  language: BotLanguage = 'en',
): string {
  const when = formatSlotTime(scheduledAt, timezone, language);
  return language === 'id'
    ? `✅ Jadwal baru Anda: ${when}. Terima kasih!`
    : `✅ Your new schedule: ${when}. Thank you!`;
}

export function renderRescheduleCancelled(language: BotLanguage = 'en'): string {
  return language === 'id'
    ? 'Baik, perubahan jadwal dibatalkan. Jadwal Anda tetap seperti semula. 👍'
    : 'Okay, the schedule change has been cancelled. Your booking stays as it is. 👍';
}

export function renderRescheduleInvalid(language: BotLanguage = 'en'): string {
  return language === 'id'
    ? ['⚠️ Maaf, format waktu tidak dikenali.', '', 'Gunakan format: `2026-08-15 14:00`'].join('\n')
    : ['⚠️ Sorry, the time format is not recognized.', '', 'Use the format: `2026-08-15 14:00`'].join('\n');
}

export function renderAlreadyHandledReply(language: BotLanguage = 'en'): string {
  return language === 'id'
    ? 'Booking ini sudah diproses sebelumnya — tidak ada perubahan lebih lanjut.'
    : 'This booking has already been processed — no further changes.';
}

export function renderBookingNotFoundReply(language: BotLanguage = 'en'): string {
  return language === 'id'
    ? 'Maaf, booking tidak ditemukan. Silakan hubungi tempat usaha Anda.'
    : 'Sorry, the booking was not found. Please contact your business.';
}

/**
 * Balasan siap-kirim ke Telegram: teks + tombol inline opsional + keyboard
 * request_contact opsional (tombol "Bagikan Nomor" sekali pakai).
 */
export interface TelegramReply {
  text: string;
  /** Tombol inline (callback data). */
  buttons?: { id: string; label: string }[];
  /** Reply keyboard sekali pakai dengan tombol "Bagikan Nomor" (request_contact). */
  requestContact?: { label: string };
}

/**
 * Minta nomor HP untuk menghubungkan chat ke booking.
 *
 * Mengutamakan tombol `request_contact` (nomor VERIFIED dari Telegram,
 * satu ketukan, tanpa typo) — ketikan manual tetap didukung sebagai fallback
 * untuk user yang tidak ingin berbagi kontak via tombol.
 */
export function renderAskPhoneReply(language: BotLanguage = 'en'): TelegramReply {
  return {
    text:
      language === 'id'
        ? [
            'Terima kasih sudah menghubungi kami! 🙌',
            '',
            'Agar kami bisa mengirimkan pengingat booking lewat Telegram,',
            'bagikan nomor HP Anda lewat tombol di bawah, atau ketik manual,',
            'contoh: `081234567890`.',
          ].join('\n')
        : [
            'Thank you for contacting us! 🙌',
            '',
            'So we can send your booking reminder via Telegram,',
            'please share your phone number using the button below,',
            'or type it manually, e.g.: `+6281234567890`.',
          ].join('\n'),
    requestContact: {
      label: language === 'id' ? '📱 Bagikan Nomor' : '📱 Share phone number',
    },
  };
}

export function renderLinkedReply(language: BotLanguage = 'en'): string {
  return language === 'id'
    ? '✅ Nomor Anda telah terhubung! Anda akan menerima pengingat booking di sini.'
    : '✅ Your number has been linked! You will receive booking reminders here.';
}

export function renderPhoneMismatchReply(language: BotLanguage = 'en'): string {
  return language === 'id'
    ? [
        '⚠️ Nomor ini tidak cocok dengan nomor pada booking Anda.',
        'Pastikan mengetik nomor yang sama dengan yang didaftarkan saat booking.',
        'Contoh format: `081234567890` atau `+6281234567890` — keduanya dianggap sama.',
      ].join('\n')
    : [
        '⚠️ This number does not match the number on your booking.',
        'Please type the same number you registered when booking.',
        'Example formats: `081234567890` or `+6281234567890` — both are accepted.',
      ].join('\n');
}

export function renderOptOutReply(language: BotLanguage = 'en'): string {
  return language === 'id'
    ? 'Anda telah berhenti menerima pesan dari kami. Untuk berlangganan kembali, kirim pesan apa pun.'
    : 'You have stopped receiving messages from us. To resubscribe, send any message.';
}

export function renderGenericReply(language: BotLanguage = 'en'): string {
  return language === 'id'
    ? [
        'Terima kasih atas pesan Anda!',
        'Anda dapat membalas dengan *STOP* kapan saja untuk berhenti menerima pesan.',
      ].join('\n')
    : [
        'Thank you for your message!',
        'You can reply with *STOP* at any time to stop receiving messages.',
      ].join('\n');
}

/** Input render pesan info bisnis (channel-agnostic). */
export interface BusinessInfoReplyInput {
  businessName: string;
  /** Industri workspace (opsional — mis. "Kesehatan" / "Klinik Gigi"). */
  industry?: string | null;
  /**
   * Tautan form booking aktif (Google Forms / Tally) — disematkan bila
   * ada agar customer tanpa booking bisa langsung mengisi formulir.
   */
  bookingUrl?: string | null;
}

/**
 * Balasan info bisnis saat customer mengirim pesan bebas TANPA booking aktif:
 * sapaan + nama bisnis (+ industri), dan tautan booking bila tersedia.
 * Ini pengganti renderGenericReply untuk kasus "belum punya booking".
 */
export function renderBusinessInfoReply(
  input: BusinessInfoReplyInput,
  language: BotLanguage = 'en',
): string {
  const business = input.businessName.trim();
  const industry = input.industry?.trim();

  const lines = language === 'id'
    ? [
        `Halo! 👋 Selamat datang di ${business}${industry ? ` — ${industry}` : ''}.`,
        '',
      ]
    : [
        `Hello! 👋 Welcome to ${business}${industry ? ` — ${industry}` : ''}.`,
        '',
      ];
  if (input.bookingUrl) {
    lines.push(
      language === 'id'
        ? 'Anda dapat langsung membuat booking melalui tautan berikut:'
        : 'You can book directly using the following link:',
      '',
      input.bookingUrl,
      '',
    );
  }
  lines.push(
    language === 'id'
      ? 'Kami siap membantu — kirim pertanyaan atau permintaan Anda kapan saja. 🙏'
      : "We're happy to help — send your question or request anytime. 🙏",
    '',
    // Tetap cantumkan instruksi opt-out (kepatuhan): customer tahu bisa
    // membalas *STOP* kapan saja — sama seperti balasan generik lama.
    language === 'id'
      ? 'Anda dapat membalas dengan *STOP* kapan saja untuk berhenti menerima pesan.'
      : 'You can reply with *STOP* at any time to stop receiving messages.',
  );
  return lines.join('\n');
}

/**
 * Balasan handoff saat AI chat tidak yakin / pertanyaan di luar knowledge
 * base — customer dialihkan ke staf (percakapan ditandai needsAttention).
 * Tidak menyebut AI agar konsisten dengan aturan prompt (identitas bot
 * tidak diekspos ke customer).
 */
export function renderAiHandoffReply(language: BotLanguage = 'en'): string {
  return language === 'id'
    ? [
        'Terima kasih atas pertanyaannya! 🙏',
        'Agar jawabannya tepat, kami hubungkan Anda dengan tim kami —',
        'mereka akan segera membalas di chat ini.',
      ].join('\n')
    : [
        'Thank you for your question! 🙏',
        "To give you an accurate answer, we're connecting you with our team —",
        'they will reply here shortly.',
      ].join('\n');
}

/**
 * Balasan saat AI chat dinonaktifkan untuk workspace ini (opsional — tidak
 * dipakai alur handler saat ini; tersedia untuk UI settings / kasus lanjutan
 * saat owner menyalakan AI tetapi fitur belum tersedia di platform).
 */
export function renderAiDisabledReply(language: BotLanguage = 'en'): string {
  return language === 'id'
    ? [
        'Maaf, layanan tanya-jawab otomatis kami sedang tidak aktif.',
        'Silakan hubungi tim kami langsung — mereka akan segera membantu.',
      ].join('\n')
    : [
        'Sorry, our automated chat service is currently turned off.',
        'Please contact our team directly — they will get back to you soon.',
      ].join('\n');
}

/** Balasan saat customer minta booking tapi belum ada form terhubung. */
export function renderNoFormReply(language: BotLanguage = 'en'): string {
  return language === 'id'
    ? [
        'Terima kasih atas minat Anda untuk booking! 🙌',
        'Saat ini kami sedang tidak menerima booking otomatis.',
        'Silakan hubungi admin kami langsung — kami akan segera membalas.',
      ].join('\n')
    : [
        'Thank you for your interest in booking! 🙌',
        'We are not accepting online bookings at the moment.',
        'Please contact our admin directly — we will reply as soon as possible.',
      ].join('\n');
}

/**
 * Balasan saat nomor customer tidak punya booking AKTIF (pending/confirmed):
 * jelaskan kondisinya + arahkan ke form booking bila tersedia (customer yang
 * ingin booking dari awal). Tanpa form → caller memakai renderNoFormReply
 * (handoff staf) dan tandai percakapan needsAttention.
 */
export function renderNoBookingReply(
  formUrl: string | null | undefined,
  language: BotLanguage = 'en',
): string {
  const lines =
    language === 'id'
      ? ['Kami tidak menemukan booking aktif dengan nomor ini. 🙏', '']
      : ['We could not find an active booking for this number. 🙏', ''];
  if (formUrl) {
    lines.push(
      language === 'id'
        ? 'Mau membuat booking baru? Silakan isi formulir berikut:'
        : 'Would you like to make a new booking? Please fill in the form below:',
      '',
      formUrl,
      '',
    );
  }
  lines.push(
    language === 'id'
      ? 'Setelah mengisi form, kirim pesan lagi di sini agar booking Anda terhubung.'
      : 'Once you have filled the form, message us again here to connect your booking.',
  );
  return lines.join('\n');
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
