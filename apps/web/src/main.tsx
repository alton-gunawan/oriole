import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { QueryClientProvider } from '@tanstack/react-query';
import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { PostHogProvider } from '@posthog/react';
import posthog from 'posthog-js';

import { queryClient } from './lib/queryClient';
import { restoreSession } from './lib/session';
import { initI18n } from './i18n';
import { env } from './config/env';
import { router } from './router';
import { ErrorScreen } from './app/shell/RouteErrorElement';
import { ConsentBanner } from './app/components/ConsentBanner';
import { useTranslation } from 'react-i18next';
import { analyticsInitOptions, applyAnalyticsConsent } from './lib/analytics';
import { applyStoredTheme } from './lib/theme';
import { readStoredConsent } from './stores/consent';

// ── PostHog analytics ────────────────────────────────────────
// Inisialisasi SEBELUM render pertama: token publik `phc_...` aman di
// bundle browser. `analyticsInitOptions` (lib/analytics.ts) mencakup SPA
// pageviews otomatis, autocapture error, masking replay, dan replay yang
// MATI sampai consent diberikan. Tanpa token → PostHog tidak di-init
// (no-op).
if (env.POSTHOG_PROJECT_TOKEN) {
  posthog.init(env.POSTHOG_PROJECT_TOKEN, analyticsInitOptions);
  // Terapkan pilihan consent tersimpan: granted → mulai replay + survei;
  // undecided/denied → replay tetap mati (disable_session_recording).
  void applyAnalyticsConsent(readStoredConsent());
}

/**
 * Jaring pengaman terakhir: error yang dilempar DI LUAR router (mis. dari
 * Theme/QueryClientProvider, kode inisialisasi) tidak tertangkap errorElement
 * React Router — boundary kelas ini mencegah blank screen + pesan mentah.
 */
class RootErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('[root] Unhandled render error:', error);
    // Error tracking PostHog (best-effort) — lihat lib/analytics.ts.
    void import('./lib/analytics').then((m) => m.captureClientError(error));
  }

  render() {
    if (this.state.error) {
      return <RootErrorFallback error={this.state.error} />;
    }
    return this.props.children;
  }
}

function RootErrorFallback({ error }: { error: Error }) {
  const { t } = useTranslation();
  return (
    <ErrorScreen
      title={t('errors.routeErrorTitle')}
      description={t('errors.routeErrorDesc')}
      technicalDetails={`${error.message}\n${error.stack ?? ''}`}
      actions={
        <button
          onClick={() => window.location.reload()}
          className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700"
        >
          {t('errors.reloadPage')}
        </button>
      }
    />
  );
}

import './index.css';

// Terapkan tema tersimpan sebelum render pertama (menghindari flash &
// membuat halaman di luar AppShell — mis. auth — ikut bertema).
applyStoredTheme();

// Pulihkan sesi (token sessionStorage → status store) sebelum render pertama.
void restoreSession();

// Muat bahasa aktif (chunk locale) sebelum render — teks siap tanpa Suspense.
async function bootstrap() {
  try {
    await initI18n();
  } catch (err) {
    // Chunk locale gagal dimuat (mis. offline) — jangan biarkan app blank;
    // i18n tetap pakai fallbackLng 'en' dan key sebagai teks.
    console.error('[i18n] Gagal menginisialisasi i18n:', err);
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <RootErrorBoundary>
        <Theme theme={neutralTheme}>
          <QueryClientProvider client={queryClient}>
            <PostHogProvider client={posthog}>
              <RouterProvider router={router} />
              {/* Banner consent privasi (replay + survei) — hanya tampil
                  saat belum ada keputusan & analitik aktif. */}
              <ConsentBanner />
              {/* Kontainer survei PostHog — dirender manual setelah
                  consent, tidak pernah auto-tampil. */}
              <div id="ph-surveys-root" aria-hidden="true" />
            </PostHogProvider>
          </QueryClientProvider>
        </Theme>
      </RootErrorBoundary>
    </StrictMode>,
  );
}

void bootstrap();
