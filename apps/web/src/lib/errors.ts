import type { TFunction } from 'i18next';

import { AuthActionError } from './auth';
import { ApiError } from './api';
import type { TranslationKey } from '../i18n';

/**
 * Ubah error menjadi pesan yang aman dan terlokalisasi:
 * - AuthActionError dengan messageKey → diterjemahkan lewat t().
 * - Fetch abort/timeout → diterjemahkan via common.requestTimedOut.
 * - ApiError 500 / pesan internal generik → fallback key yang diterjemahkan.
 * - Error lain yang punya pesan spesifik dari server/validasi → pesan asli.
 * - Selain itu → fallback key yang diterjemahkan.
 */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

const INTERNAL_ERROR_STRINGS = new Set([
  'Terjadi kesalahan internal. Coba lagi.',
  'Internal server error. Please try again.',
  'Internal server error',
]);

export function errorMessage(err: unknown, t: TFunction, fallbackKey: TranslationKey): string {
  if (err instanceof AuthActionError && err.messageKey) return t(err.messageKey);
  if (isAbortError(err)) return t('common.requestTimedOut');
  if (err instanceof ApiError) {
    if (err.status >= 500 || INTERNAL_ERROR_STRINGS.has(err.message)) {
      return t(fallbackKey);
    }
  }
  if (err instanceof Error) {
    if (INTERNAL_ERROR_STRINGS.has(err.message)) {
      return t(fallbackKey);
    }
    return err.message;
  }
  return t(fallbackKey);
}
