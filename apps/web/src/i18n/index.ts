import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import resourcesToBackend from 'i18next-resources-to-backend';

import type en from './locales/en/translation.json';

// Catatan: `en` hanya dipakai di posisi type (typeof/NestedKeys) — import type
// mencegah JSON ikut di-bundle sebagai nilai runtime.

/** Bahasa resmi aplikasi. Menambah bahasa baru = folder locales/<code> + entry di sini. */
export const SUPPORTED_LOCALES = ['en', 'id'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** Kunci bertitik (nested) dari tipe katalog — dasar tipe kunci ketat. */
type NestedKeys<T> = {
  [K in keyof T & string]: T[K] extends Record<string, unknown>
    ? `${K}.${NestedKeys<T[K]>}`
    : K;
}[keyof T & string];

/**
 * Kunci i18n yang diketik ketat terhadap katalog `en` — dipakai untuk
 * nilai dinamis (labelKey, helper enum) agar `t()` tetap terverifikasi.
 */
export type TranslationKey = NestedKeys<typeof en>;

/** Kunci localStorage untuk preferensi bahasa user. */
export const LOCALE_STORAGE_KEY = 'oriole.locale';

/**
 * Chunk terpisah per bahasa (import.meta.glob lazy) — hanya bahasa aktif yang
 * diunduh, sisanya dimuat on-demand saat user mengganti bahasa.
 */
const localeChunks = import.meta.glob<{ default: Record<string, unknown> }>(
  './locales/*/translation.json',
);

function loadLocaleChunk(language: string): Promise<Record<string, unknown>> {
  const match = Object.keys(localeChunks).find((path) =>
    path.includes(`/locales/${language}/`),
  );
  if (!match) return Promise.reject(new Error(`Locale chunk tidak ditemukan: ${language}`));
  return localeChunks[match]().then((module) => module.default);
}

/** Sinkronkan <html lang>, judul tab, dan meta description dengan bahasa aktif. */
function syncDocumentLanguage() {
  const language = i18n.resolvedLanguage ?? i18n.language ?? 'en';
  document.documentElement.lang = language;
  document.title = i18n.t('meta.title');
  const description = document.querySelector('meta[name="description"]');
  if (description) description.setAttribute('content', i18n.t('meta.description'));
}

/**
 * Inisialisasi i18n — dipanggil SEKALI sebelum render pertama (main.tsx).
 * `await` menjamin chunk bahasa aktif sudah termuat sebelum UI menggambar,
 * sehingga komponen tidak perlu Suspense untuk teks.
 */
export async function initI18n(): Promise<void> {
  await i18n
    .use(LanguageDetector)
    .use(initReactI18next)
    .use(resourcesToBackend(loadLocaleChunk))
    .init({
      // 'en-US' → 'en' — kode 2 huruf dipakai di seluruh path (chunk, URL).
      supportedLngs: [...SUPPORTED_LOCALES],
      fallbackLng: 'en',
      load: 'languageOnly',
      nonExplicitSupportedLngs: true,

      ns: ['translation'],
      defaultNS: 'translation',
      fallbackNS: 'translation',

      // Preferensi user (localStorage) > bahasa browser > atribut <html>.
      detection: {
        order: ['localStorage', 'navigator', 'htmlTag'],
        caches: ['localStorage'],
        lookupLocalStorage: LOCALE_STORAGE_KEY,
      },

      interpolation: { escapeValue: false },
      // init() sudah di-await — useTranslation tidak perlu mode Suspense.
      // <code>/<br>/<strong> dipertahankan saat dipakai bersama komponen <Trans>.
      react: {
        useSuspense: false,
        transKeepBasicHtmlNodesFor: ['code', 'br', 'strong'],
      },

      // Jangan pernah menampilkan raw key ke user.
      missingKeyHandler: (_lng, _ns, key) => {
        if (import.meta.env.DEV) console.warn(`[i18n] Missing translation key: ${key}`);
      },
      returnNull: false,
      returnEmptyString: false,
    });

  syncDocumentLanguage();
  i18n.on('languageChanged', syncDocumentLanguage);
}

export default i18n;
