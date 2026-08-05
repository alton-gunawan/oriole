import 'i18next';

import type en from './locales/en/translation.json';

declare module 'i18next' {
  interface CustomTypeOptions {
    /**
     * Kunci t() diketik ketat terhadap katalog `en` (source of truth).
     * Katalog `id` diverifikasi setara lewat scripts/check-locales.mjs.
     */
    defaultNS: 'translation';
    resources: {
      translation: typeof en;
    };
  }
}
