import { and, eq } from 'drizzle-orm';
import { bookings, workspaceIntegrations } from '@oriole/database';

import { db } from '../db/index.ts';
import { withBookingTitle } from './booking-title.ts';
import { createZoomMeeting, isZoomConfigured, ZoomApiError } from './zoom.ts';

/* ────────────────────────────────────────────────────────────
 * Video calls — link otomatis untuk setiap booking.
 *
 * Provider (disimpan di providerConfig integrasi `video`):
 * - `zoom` : meeting Zoom dibuat server-side (Server-to-Server OAuth,
 *            kredensial env ZOOM_*) → join_url disimpan di booking.video_link.
 * - `meet` : link Google Meet datang dari event Google Calendar
 *            (conferenceData hangoutsMeet) — sync kalender yang menulis
 *            hangoutLink ke booking.video_link (lihat google-calendar.ts).
 * ──────────────────────────────────────────────────────────── */

export interface VideoConfig {
  provider: 'zoom' | 'meet';
}

/** Muat integrasi video AKTIF untuk sebuah workspace. */
export async function loadVideoConfig(workspaceId: string): Promise<VideoConfig | null> {
  const [integration] = await db
    .select()
    .from(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, workspaceId),
        eq(workspaceIntegrations.integrationType, 'video'),
      ),
    )
    .limit(1);
  if (!integration || !integration.isActive) return null;
  const config = integration.providerConfig as unknown as VideoConfig;
  return config.provider === 'zoom' || config.provider === 'meet' ? config : null;
}

/**
 * Buat link Zoom untuk satu booking lalu simpan ke `video_link`.
 * Melempar ZoomApiError bila gagal — Inngest me-retry dengan backoff
 * (dipanggil dari fungsi `video/link.required`).
 */
export async function createZoomLinkForBooking(
  workspaceId: string,
  bookingId: string,
): Promise<{ created: boolean; reason?: string }> {
  const config = await loadVideoConfig(workspaceId);
  if (!config) return { created: false, reason: 'not-configured' };
  if (config.provider !== 'zoom') return { created: false, reason: 'provider-meet' };

  const [row] = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.workspaceId, workspaceId)))
    .limit(1);
  if (!row) return { created: false, reason: 'booking-not-found' };
  // Title booking = nama layanan katalog (kolom title sudah dihapus).
  const booking = await withBookingTitle(workspaceId, row);
  if (booking.status === 'cancelled' || booking.status === 'completed') {
    return { created: false, reason: `status-${booking.status}` };
  }
  // Link sudah ada — jangan buat ulang (idempoten per retry).
  if (booking.videoLink) return { created: true, reason: 'already-exists' };

  const meeting = await createZoomMeeting({
    topic: booking.title,
    startTime: booking.scheduledAt,
    durationMinutes: booking.durationMinutes ?? 60,
    timezone: booking.timezone,
  });

  await db
    .update(bookings)
    .set({ videoLink: meeting.joinUrl, updatedAt: new Date() })
    .where(eq(bookings.id, booking.id));
  return { created: true };
}

/** Simpan link video (dipakai sync Google Calendar untuk hangoutLink). */
export async function setBookingVideoLink(
  bookingId: string,
  videoLink: string,
): Promise<void> {
  await db
    .update(bookings)
    .set({ videoLink, updatedAt: new Date() })
    .where(eq(bookings.id, bookingId));
}

/** Provider yang bisa dipilih user di UI connect (zoom butuh env server). */
export function availableVideoProviders(): { provider: 'zoom' | 'meet'; ready: boolean; reason?: string }[] {
  const zoomReady = isZoomConfigured();
  return [
    { provider: 'zoom', ready: zoomReady, reason: zoomReady ? undefined : 'ZOOM_ACCOUNT_ID / ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET belum dikonfigurasi di server.' },
    { provider: 'meet', ready: true },
  ];
}

export { ZoomApiError };
