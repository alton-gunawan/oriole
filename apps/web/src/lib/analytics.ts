import type posthogType from 'posthog-js';

import { env } from '../config/env';
import { readStoredConsent, type ReplayConsent } from '../stores/consent';

/**
 * PostHog analytics (frontend) — wrapper tipis di atas posthog-js.
 *
 * - Tanpa `VITE_POSTHOG_PROJECT_TOKEN` → semua panggilan no-op (app jalan
 *   normal, tidak ada network ke PostHog).
 * - posthog-js dimuat LAZY (dynamic import) — modul ini aman di-import dari
 *   mana pun (termasuk test di environment node tanpa window/document), dan
 *   kode analitik tidak menambah waktu boot bila token kosong.
 * - Inisialisasi (`initAnalytics`) dipanggil sekali di `main.tsx` sebelum
 *   render — posthog-js adalah singleton, jadi import di sini mengembalikan
 *   instance yang sama dengan yang dipakai `<PostHogProvider>`.
 * - PRIVASI: jangan pernah mengirim PII (nomor telepon, isi pesan) lewat
 *   properti event. Input sensitif sudah diberi kelas `ph-no-capture`.
 */

type PostHogClient = typeof posthogType;

/** True bila token proyek disetel (guard, bukan aliran data). */
export const isAnalyticsEnabled = Boolean(env.POSTHOG_PROJECT_TOKEN);

let client: PostHogClient | null | undefined;

async function getClient(): Promise<PostHogClient | null> {
  if (!isAnalyticsEnabled) return null;
  if (client) return client;
  const { default: posthog } = await import('posthog-js');
  client = posthog;
  return client;
}

/**
 * Opsi init PostHog — satu sumber kebenaran, dipakai main.tsx (init
 * langsung) maupun initAnalytics().
 *
 * - `capture_exceptions` → autocapture error (error tracking) di sisi
 *   client (selain boundary React yang manual).
 * - `session_recording` → masking DEFENSIF: semua input + elemen
 *   `ph-no-capture` (isi inbox, nomor telepon, nama/email customer).
 * - `disable_session_recording` → replay HANYA jalan setelah consent
 *   (dibaca dari localStorage; saat undecided/denied tetap mati).
 * - `disable_surveys_automatic_display` → survei tidak pernah auto-tampil;
 *   dirender manual setelah consent (renderConsentedSurveys).
 */
export const analyticsInitOptions = {
  api_host: env.POSTHOG_HOST,
  // Default modern: autocapture terbaru + SPA pageviews (history_change).
  defaults: '2026-05-30',
  capture_pageview: 'history_change',
  // Error tracking: autocapture uncaught exceptions (best-effort).
  capture_exceptions: true,
  // Replay: masking semua input + teks ph-no-capture; mati tanpa consent.
  session_recording: {
    maskAllInputs: true,
    maskTextSelector: '.ph-no-capture',
  },
  disable_session_recording: readStoredConsent() !== 'granted',
  // Survei dirender manual setelah consent — tidak pernah auto-tampil.
  disable_surveys_automatic_display: true,
} as const;

/**
 * Inisialisasi PostHog — panggil SEKALI di bootstrap (main.tsx), sebelum
 * render pertama. `defaults` + `capture_pageview: 'history_change'` membuat
 * navigasi SPA (React Router v7 data mode) ter-capture otomatis via History
 * API — tanpa perlu router hook.
 */
export async function initAnalytics(): Promise<void> {
  const ph = await getClient();
  if (!ph) return;
  ph.init(env.POSTHOG_PROJECT_TOKEN, analyticsInitOptions);
}

/**
 * Terapkan pilihan consent ke PostHog (replay + survei).
 *
 * - granted → mulai session recording + render survei yang match targeting.
 * - denied / undecided → hentikan recording (survei tetap tidak dirender).
 *
 * Dipanggil saat boot (main.tsx, setelah init) dan setiap kali pilihan
 * berubah (banner consent / toggle Settings). Idempoten — aman dipanggil
 * berkali-kali. No-op bila analitik nonaktif.
 */
export async function applyAnalyticsConsent(consent: ReplayConsent): Promise<void> {
  const ph = await getClient();
  if (!ph) return;
  if (consent === 'granted') {
    ph.startSessionRecording();
    renderConsentedSurveys(ph);
  } else {
    ph.stopSessionRecording();
  }
}

/**
 * Render survei PostHog yang match kondisi targeting ke kontainer sendiri
 * (`#ph-surveys-root`, lihat main.tsx). Dipanggil HANYA setelah consent
 * diberikan — `disable_surveys_automatic_display` memastikan survei tidak
 * pernah muncul tanpa izin. Kegagalan (mis. tidak ada survei aktif) di-
 * abaikan — fitur opsional, bukan jalur kritis.
 */
async function renderConsentedSurveys(ph: PostHogClient): Promise<void> {
  try {
    ph.getActiveMatchingSurveys((surveys) => {
      for (const survey of surveys) {
        try {
          ph.renderSurvey(survey.id, '#ph-surveys-root');
        } catch {
          // Survei gagal dirender (mis. kontainer belum ada) — lanjut.
        }
      }
    });
  } catch {
    // API survei tidak tersedia — abaikan.
  }
}

/**
 * Cek satu feature flag (boolean) dengan fallback aman. No-op bila
 * analitik nonaktif atau flag belum dimuat → fallback.
 */
export async function isFeatureFlagEnabled(key: string, fallback: boolean): Promise<boolean> {
  const ph = await getClient();
  if (!ph) return fallback;
  try {
    return ph.isFeatureEnabled(key) ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Baca payload JSON feature flag (dipakai eksperimen A/B) dengan fallback.
 * `null`/`undefined` dari SDK (flag tidak ada / belum dimuat) → fallback.
 */
export async function getFeatureFlagPayload<T>(key: string, fallback: T): Promise<T> {
  const ph = await getClient();
  if (!ph) return fallback;
  try {
    const payload = ph.getFeatureFlagPayload(key);
    return payload === null || payload === undefined ? fallback : (payload as T);
  } catch {
    return fallback;
  }
}

/**
 * Tautkan event anonim → user dikenal. Panggil saat sesi dipulihkan
 * (setelah /me) dengan ID stabil dari auth system (bukan email).
 */
export async function identifyAnalyticsUser(input: {
  id: string;
  email?: string;
  name?: string;
  workspaceId?: string;
}): Promise<void> {
  const ph = await getClient();
  if (!ph) return;
  ph.identify(input.id, {
    ...(input.email ? { email: input.email } : {}),
    ...(input.name ? { name: input.name } : {}),
  });
  if (input.workspaceId) ph.group('workspace', input.workspaceId);
}

/** Pindahkan group workspace aktif (dipanggil saat switch bisnis). */
export async function groupAnalyticsWorkspace(workspaceId: string): Promise<void> {
  const ph = await getClient();
  if (!ph) return;
  ph.group('workspace', workspaceId);
}

/** Lepas identitas (logout) — user berikutnya di browser yang sama tidak
 *  mewarisi identitas sebelumnya. */
export async function resetAnalytics(): Promise<void> {
  const ph = await getClient();
  if (!ph) return;
  ph.reset();
}

/** Capture satu event custom (no-PII properties). */
export async function trackEvent(
  event: string,
  properties?: Record<string, unknown>,
): Promise<void> {
  const ph = await getClient();
  if (!ph) return;
  ph.capture(event, properties);
}

/** Capture exception client-side untuk error tracking. */
export async function captureClientError(error: unknown): Promise<void> {
  const ph = await getClient();
  if (!ph) return;
  ph.captureException(error);
}
