import { and, eq, inArray } from 'drizzle-orm';
import { bookings, workspaceIntegrations, workspaces } from '@oriole/database';

import { db } from '../db/index.ts';
import { withBookingTitle } from './booking-title.ts';
import { GoogleApiError, googleFetch, parseServiceAccount, type GoogleServiceAccount } from './google-auth.ts';
import { setBookingVideoLink } from './video.ts';

/* ────────────────────────────────────────────────────────────
 * Google Calendar integration — booking bisnis dicerminkan
 * menjadi event di kalender Google yang dibagikan ke service
 * account. Mapping booking → event disimpan di providerConfig
 * (`eventIds: Record<bookingId, googleEventId>`) sehingga tidak
 * perlu perubahan schema.
 * ──────────────────────────────────────────────────────────── */

export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';

/** Durasi event default (menit) — booking tidak punya kolom durasi. */
export const DEFAULT_EVENT_DURATION_MINUTES = 60;

/** Konfigurasi privat integrasi Google Calendar (disimpan di providerConfig). */
export interface GoogleCalendarConfig {
  serviceAccountJson: string;
  serviceAccountEmail: string;
  calendarId: string;
  calendarName?: string | null;
  /** Durasi event (menit) — override opsional, default 60. */
  eventDurationMinutes?: number | null;
  /** Mapping bookingId → googleEventId (dedup & update event yang sama). */
  eventIds?: Record<string, string>;
}

export interface GoogleCalendarOption {
  id: string;
  summary: string;
  primary: boolean;
  accessRole: string;
}

/** Daftar kalender yang bisa diakses service account (calendarList.list). */
export async function listGoogleCalendars(
  serviceAccount: GoogleServiceAccount,
): Promise<GoogleCalendarOption[]> {
  const result = await googleFetch<{ items?: GoogleCalendarOption[] }>(
    serviceAccount,
    [GOOGLE_CALENDAR_SCOPE],
    '/calendar/v3/users/me/calendarList',
  );
  return (result.items ?? []).map((item) => ({
    id: item.id,
    summary: item.summary,
    primary: item.primary ?? false,
    accessRole: item.accessRole,
  }));
}

/** Validasi akses ke satu kalender (GET /calendar/v3/calendars/{id}). */
export async function getGoogleCalendar(
  serviceAccount: GoogleServiceAccount,
  calendarId: string,
): Promise<{ id: string; summary: string }> {
  const calendar = await googleFetch<{ id?: string; summary?: string }>(
    serviceAccount,
    [GOOGLE_CALENDAR_SCOPE],
    `/calendar/v3/calendars/${encodeURIComponent(calendarId)}`,
  );
  return { id: calendar.id ?? calendarId, summary: calendar.summary ?? 'Untitled' };
}

interface CalendarEventInput {
  summary: string;
  description?: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  extendedProperties: { private: Record<string, string> };
  status: string;
  /**
   * Google Meet — hanya dikirim saat INSERT (conferenceData tidak bisa
   * ditambahkan lewat PATCH). Saat ada, Google membuat hangoutsMeet dan
   * mengembalikan hangoutLink di respons.
   */
  conferenceData?: {
    createRequest: {
      requestId: string;
      conferenceSolutionKey: { type: 'hangoutsMeet' };
    };
  };
}

/** Respons event dari Calendar API — termasuk hangoutLink untuk Google Meet. */
interface CalendarEventWithConference {
  id: string;
  hangoutLink?: string;
}

/** Offset UTC (menit) dari sebuah timezone IANA pada instant tertentu. */
function timeZoneOffsetMinutes(date: Date, timeZone: string): number {
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
  const asEpoch = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asEpoch - date.getTime()) / 60_000);
}

/** Format instant sebagai RFC3339 dengan offset sesuai timezone booking. */
function formatInTimeZone(date: Date, timeZone: string): string {
  const offset = timeZoneOffsetMinutes(date, timeZone);
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  // Ambil jam/menit dari representasi UTC lalu tambahkan offset manual —
  // pendekatan ini menghindari ambiguitas DST di sisi Google.
  const utcDate = new Date(date.getTime());
  const local = new Date(utcDate.getTime() + offset * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * Susun payload event Google Calendar dari satu booking.
 * `status` mengikuti status booking (confirmed → event confirmed).
 */
export function buildCalendarEvent(
  booking: { id: string; title: string; description: string | null; scheduledAt: Date; timezone: string; status: string },
  workspaceName: string | null,
  durationMinutes = DEFAULT_EVENT_DURATION_MINUTES,
  options: { withConference?: boolean } = {},
): CalendarEventInput {
  const duration = Number.isFinite(durationMinutes) && durationMinutes > 0 ? durationMinutes : DEFAULT_EVENT_DURATION_MINUTES;
  const end = new Date(booking.scheduledAt.getTime() + duration * 60_000);
  const description =
    booking.description?.trim()
      ? `${booking.description.trim()}\n\n— ${workspaceName ?? 'Oriole'}`
      : workspaceName
        ? `— ${workspaceName}`
        : '';
  return {
    summary: booking.title,
    description,
    start: { dateTime: formatInTimeZone(booking.scheduledAt, booking.timezone), timeZone: booking.timezone },
    end: { dateTime: formatInTimeZone(end, booking.timezone), timeZone: booking.timezone },
    extendedProperties: { private: { orioleBookingId: booking.id, orioleSource: 'oriole' } },
    // Event untuk booking yang dibatalkan/selesai dihapus, bukan di-cancel —
    // semua event yang tersimpan berstatus confirmed.
    status: 'confirmed',
    // Google Meet — hanya pada INSERT (lihat doc CalendarEventInput).
    ...(options.withConference
      ? {
          conferenceData: {
            createRequest: {
              requestId: `oriole-${booking.id}`,
              conferenceSolutionKey: { type: 'hangoutsMeet' },
            },
          },
        }
      : {}),
  };
}

/**
 * Item event mentah dari Calendar API — dipakai untuk membaca event
 * EKSTERNAL (dua arah): apa pun yang ada di kalender tapi BUKAN milik
 * Oriole (tanpa extendedProperties.private.orioleBookingId) diperlakukan
 * sebagai waktu sibuk yang memblokir slot booking.
 */
export interface CalendarEventItem {
  id: string;
  summary?: string;
  status?: string | null;
  start?: { dateTime?: string; date?: string } | null;
  end?: { dateTime?: string; date?: string } | null;
  extendedProperties?: { private?: Record<string, string> } | null;
}

/**
 * Ambil event kalender dalam rentang [timeMin, timeMax] (events.list).
 * Pakai singleEvents=true agar recurring event dibentangkan.
 */
export async function listCalendarEvents(
  serviceAccount: GoogleServiceAccount,
  calendarId: string,
  timeMin: Date,
  timeMax: Date,
): Promise<CalendarEventItem[]> {
  const params = new URLSearchParams({
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '2500',
  });
  const result = await googleFetch<{ items?: CalendarEventItem[] }>(
    serviceAccount,
    [GOOGLE_CALENDAR_SCOPE],
    `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
  );
  return result.items ?? [];
}

/**
 * Interval sibuk dari event EKSTERNAL kalender (bukan mirror Oriole) dalam
 * rentang [from, to] — dua arah: waktu yang dipakai di kalender tidak bisa
 * di-book.
 *
 * - Event milik Oriole dikenali via extendedProperties.private.orioleBookingId
 *   dan dilewati (itu cermin booking kita sendiri).
 * - Event all-day (start.date) dilewati — blokir per hari penuh membutuhkan
 *   zona waktu kalender yang tidak tersedia lewat service account.
 * - Kegagalan Google bersifat fail-open ([] + log): kalender yang sedang
 *   bermasalah tidak boleh mematikan pembuatan booking di DB.
 */
export async function getExternalCalendarBusyIntervals(
  workspaceId: string,
  from: Date,
  to: Date,
): Promise<{ start: Date; end: Date }[]> {
  let loaded: Awaited<ReturnType<typeof loadCalendarIntegration>>;
  try {
    loaded = await loadCalendarIntegration(workspaceId);
  } catch (error) {
    console.warn('[google-calendar] gagal memuat integrasi (busy blocks):', error);
    return [];
  }
  if (!loaded) return [];

  const { config, serviceAccount } = loaded;
  let items: CalendarEventItem[];
  try {
    items = await listCalendarEvents(serviceAccount, config.calendarId, from, to);
  } catch (error) {
    console.warn('[google-calendar] gagal membaca event eksternal (busy blocks):', error);
    return [];
  }

  const busy: { start: Date; end: Date }[] = [];
  for (const item of items) {
    if (item.status === 'cancelled') continue;
    // Event all-day tidak punya dateTime — lewati (lihat doc di atas).
    if (!item.start?.dateTime || !item.end?.dateTime) continue;
    // Cermin booking kita sendiri — bukan waktu sibuk tambahan.
    if (item.extendedProperties?.private?.orioleBookingId) continue;
    const start = new Date(item.start.dateTime);
    const end = new Date(item.end.dateTime);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end.getTime() <= start.getTime()) continue;
    busy.push({ start, end });
  }
  return busy;
}

/** Muat integrasi Google Calendar + konfigurasi workspace (nama untuk description). */
async function loadCalendarIntegration(workspaceId: string): Promise<{
  config: GoogleCalendarConfig;
  serviceAccount: GoogleServiceAccount;
  workspaceName: string | null;
} | null> {
  const [integration] = await db
    .select()
    .from(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, workspaceId),
        eq(workspaceIntegrations.integrationType, 'google-calendar'),
      ),
    )
    .limit(1);
  if (!integration || !integration.isActive) return null;

  const config = integration.providerConfig as unknown as GoogleCalendarConfig;
  if (!config.serviceAccountJson || !config.calendarId) {
    throw new GoogleApiError('Konfigurasi Google Calendar tidak lengkap', 400);
  }
  const [workspace] = await db
    .select({ name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return {
    config,
    serviceAccount: parseServiceAccount(config.serviceAccountJson),
    workspaceName: workspace?.name ?? null,
  };
}

/** Simpan providerConfig integrasi (eventIds terbaru dll). */
async function persistCalendarConfig(workspaceId: string, config: GoogleCalendarConfig): Promise<void> {
  await db
    .update(workspaceIntegrations)
    // Spread: hindari masalah index signature interface → Record<string, unknown>.
    .set({ providerConfig: { ...config }, lastSyncAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, workspaceId),
        eq(workspaceIntegrations.integrationType, 'google-calendar'),
      ),
    );
}

export type CalendarSyncResult =
  | { action: 'created'; eventId: string }
  | { action: 'updated'; eventId: string }
  | { action: 'skipped'; reason: string };

/**
 * Cerminkan satu booking ke kalender (create bila belum ada event,
 * update event yang sudah ada). Booking terminal (cancelled/completed)
 * di-skip — pemanggil mengurus penghapusan event-nya.
 */
export async function upsertBookingCalendarEvent(
  workspaceId: string,
  bookingId: string,
): Promise<CalendarSyncResult> {
  const loaded = await loadCalendarIntegration(workspaceId);
  if (!loaded) return { action: 'skipped', reason: 'not-connected' };

  const [row] = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.workspaceId, workspaceId)))
    .limit(1);
  if (!row) return { action: 'skipped', reason: 'booking-not-found' };
  if (row.status !== 'pending' && row.status !== 'confirmed') {
    return { action: 'skipped', reason: `status-${row.status}` };
  }
  // Title booking = nama layanan katalog (kolom title sudah dihapus).
  const booking = await withBookingTitle(workspaceId, row);

  const { config, serviceAccount } = loaded;
  const eventIds = config.eventIds ?? {};
  const existingEventId = eventIds[bookingId];
  // Durasi event mengikuti durasi booking (kolom baru); fallback ke override
  // integrasi, lalu default 60 menit.
  const payload = buildCalendarEvent(
    booking,
    loaded.workspaceName,
    booking.durationMinutes ?? config.eventDurationMinutes ?? DEFAULT_EVENT_DURATION_MINUTES,
  );

  if (existingEventId) {
    try {
      const event = await googleFetch<CalendarEventWithConference>(
        serviceAccount,
        [GOOGLE_CALENDAR_SCOPE],
        `/calendar/v3/calendars/${encodeURIComponent(config.calendarId)}/events/${encodeURIComponent(existingEventId)}`,
        { method: 'PATCH', body: JSON.stringify(payload) },
      );
      // Event sudah ada (mungkin sudah punya Meet) — sinkronkan hangoutLink
      // ke booking bila ada.
      if (event.hangoutLink && booking.videoLink !== event.hangoutLink) {
        await setBookingVideoLink(bookingId, event.hangoutLink);
      }
      return { action: 'updated', eventId: event.id };
    } catch (err) {
      // Event lama dihapus dari kalender (mis. manual di Google) → mapping
      // basi; buat event baru (jangan biarkan Inngest me-retry PATCH 404
      // selamanya).
      if (!(err instanceof GoogleApiError && err.status === 404)) throw err;
    }
  }

  // INSERT dengan conferenceData → Google membuat Meet link (hanya valid
  // saat create; conferenceData diabaikan Google pada PATCH).
  const event = await googleFetch<CalendarEventWithConference>(
    serviceAccount,
    [GOOGLE_CALENDAR_SCOPE],
    `/calendar/v3/calendars/${encodeURIComponent(config.calendarId)}/events?conferenceDataVersion=1`,
    { method: 'POST', body: JSON.stringify({ ...payload, conferenceData: { createRequest: { requestId: `oriole-${bookingId}`, conferenceSolutionKey: { type: 'hangoutsMeet' } } } }) },
  );
  if (event.hangoutLink && booking.videoLink !== event.hangoutLink) {
    await setBookingVideoLink(bookingId, event.hangoutLink);
  }
  await persistCalendarConfig(workspaceId, { ...config, eventIds: { ...eventIds, [bookingId]: event.id } });
  return { action: 'created', eventId: event.id };
}

/** Hapus event kalender milik booking (bila ada) + bersihkan mapping. */
export async function deleteBookingCalendarEvent(
  workspaceId: string,
  bookingId: string,
): Promise<{ deleted: boolean }> {
  const loaded = await loadCalendarIntegration(workspaceId);
  if (!loaded) return { deleted: false };

  const { config, serviceAccount } = loaded;
  const eventIds = config.eventIds ?? {};
  const eventId = eventIds[bookingId];
  if (!eventId) return { deleted: false };

  try {
    await googleFetch<void>(
      serviceAccount,
      [GOOGLE_CALENDAR_SCOPE],
      `/calendar/v3/calendars/${encodeURIComponent(config.calendarId)}/events/${encodeURIComponent(eventId)}`,
      { method: 'DELETE' },
    );
  } catch (err) {
    // Event sudah tidak ada di kalender (dihapus manual / oleh run lain) →
    // idempoten: mapping tetap dibersihkan, jangan retry DELETE 404.
    if (!(err instanceof GoogleApiError && err.status === 404)) throw err;
  }
  const { [bookingId]: _removed, ...rest } = eventIds;
  void _removed;
  await persistCalendarConfig(workspaceId, { ...config, eventIds: rest });
  return { deleted: true };
}

export interface CalendarBulkSyncResult {
  created: number;
  updated: number;
  skipped: number;
}

/**
 * Sinkronkan SEMUA booking aktif → kalender (catch-up manual / setelah
 * koneksi baru). Event untuk booking yang sudah tidak aktif tidak dihapus
 * di sini (hanya upsert) — penghapusan terjadi per-booking saat status
 * berubah ke terminal.
 */
export async function syncBookingsToCalendar(workspaceId: string): Promise<CalendarBulkSyncResult> {
  const loaded = await loadCalendarIntegration(workspaceId);
  if (!loaded) throw new GoogleApiError('Integrasi Google Calendar belum terhubung', 409);

  const rows = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        eq(bookings.workspaceId, workspaceId),
        inArray(bookings.status, ['pending', 'confirmed']),
      ),
    );

  let created = 0;
  let updated = 0;
  let skipped = 0;
  for (const row of rows) {
    const result = await upsertBookingCalendarEvent(workspaceId, row.id);
    if (result.action === 'created') created += 1;
    else if (result.action === 'updated') updated += 1;
    else skipped += 1;
  }
  return { created, updated, skipped };
}
