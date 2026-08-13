import { create } from 'zustand';

/**
 * Persetujuan privasi untuk fitur PostHog yang sensitif (session replay +
 * survei in-app).
 *
 * - `undecided` → banner consent ditampilkan; replay & survei MATI.
 * - `granted` → replay & survei diaktifkan (`applyAnalyticsConsent`).
 * - `denied` → replay & survei tetap mati, banner tidak muncul lagi.
 *
 * Analytics dasar (pageviews + event bisnis tanpa PII) TIDAK digate —
 * berjalan tanpa consent, sesuai desain yang sudah ada di lib/analytics.ts.
 * Pilihan disimpan di localStorage (per-device) — dipakai sync oleh
 * `readStoredConsent()` saat init PostHog (sebelum store zustand siap).
 */

export type ReplayConsent = 'undecided' | 'granted' | 'denied';

const STORAGE_KEY = 'oriole.analytics.consent.v1';

/** Baca pilihan tersimpan secara sinkron (dipakai config init PostHog). */
export function readStoredConsent(): ReplayConsent {
  if (typeof window === 'undefined') return 'undecided';
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === 'granted' || raw === 'denied' ? raw : 'undecided';
  } catch {
    return 'undecided';
  }
}

function writeStoredConsent(consent: ReplayConsent): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, consent);
  } catch {
    // localStorage tidak tersedia (private mode) — pilihan tetap berlaku
    // untuk sesi ini via state store.
  }
}

interface ConsentState {
  replayConsent: ReplayConsent;
  /** Set pilihan apa pun (granted/denied/undecided). */
  setReplayConsent: (consent: ReplayConsent) => void;
  grantReplayConsent: () => void;
  denyReplayConsent: () => void;
}

export const useConsentStore = create<ConsentState>()((set) => ({
  replayConsent: readStoredConsent(),
  setReplayConsent: (consent) => {
    writeStoredConsent(consent);
    set({ replayConsent: consent });
  },
  grantReplayConsent: () => {
    writeStoredConsent('granted');
    set({ replayConsent: 'granted' });
  },
  denyReplayConsent: () => {
    writeStoredConsent('denied');
    set({ replayConsent: 'denied' });
  },
}));
