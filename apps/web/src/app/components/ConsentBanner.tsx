import { Button } from '@astryxdesign/core';
import { useTranslation } from 'react-i18next';

import { applyAnalyticsConsent, isAnalyticsEnabled } from '../../lib/analytics';
import { useConsentStore } from '../../stores/consent';

/**
 * Banner persetujuan privasi (session replay + survei in-app).
 *
 * Hanya tampil saat:
 * 1. Analitik PostHog aktif (token proyek disetel), DAN
 * 2. Belum ada keputusan consent (`undecided`).
 *
 * Keputusan disimpan di localStorage (stores/consent.ts) dan diterapkan ke
 * PostHog via `applyAnalyticsConsent`: granted → mulai session recording +
 * render survei; denied → recording tetap mati. Setelah memilih, banner
 * tidak muncul lagi — pilihan bisa diubah di Settings → Privacy.
 *
 * Analytics dasar (pageviews + event bisnis tanpa PII) TIDAK digate banner
 * ini — hanya fitur sensitif (replay yang merekam seluruh UI & survei).
 */
export function ConsentBanner() {
  const { t } = useTranslation();
  const replayConsent = useConsentStore((s) => s.replayConsent);
  const grantReplayConsent = useConsentStore((s) => s.grantReplayConsent);
  const denyReplayConsent = useConsentStore((s) => s.denyReplayConsent);

  if (!isAnalyticsEnabled || replayConsent !== 'undecided') return null;

  const choose = (chooseFn: () => void) => {
    chooseFn();
    // Baca state terbaru setelah update store, lalu terapkan ke PostHog.
    void applyAnalyticsConsent(useConsentStore.getState().replayConsent);
  };

  return (
    <div
      role="region"
      aria-label={t('consent.bannerLabel')}
      className="fixed inset-x-0 bottom-0 z-[70] border-t border-zinc-200 bg-white/95 px-4 py-3 shadow-[0_-4px_20px_rgba(0,0,0,0.08)] backdrop-blur-sm sm:px-6"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-2xl text-sm leading-relaxed text-zinc-600">
          {t('consent.bannerBody')}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            label={t('consent.decline')}
            variant="ghost"
            size="sm"
            onClick={() => choose(denyReplayConsent)}
          />
          <Button
            label={t('consent.accept')}
            variant="primary"
            size="sm"
            onClick={() => choose(grantReplayConsent)}
          />
        </div>
      </div>
    </div>
  );
}
