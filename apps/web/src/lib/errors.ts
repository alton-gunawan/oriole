import type { TFunction } from 'i18next';

import { AuthActionError } from './auth';
import type { TranslationKey } from '../i18n';

/**
 * Ubah error menjadi pesan yang aman ditampilkan:
 * - AuthActionError dengan messageKey → diterjemahkan lewat t().
 * - Error lain → pesan asli (biasanya dari server, sudah final).
 * - Selain itu → fallback key yang diterjemahkan.
 */
/** Deteksi pembatalan fetch (timeout internal / user leave) — DOMException
 * AbortError di browser & Node sama-sama Error dengan name 'AbortError'. */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

export function errorMessage(err: unknown, t: TFunction, fallbackKey: TranslationKey): string {
  if (err instanceof AuthActionError && err.messageKey) return t(err.messageKey);
  // Jangan tampilkan teks mentah browser seperti "Fetch is aborted" —
  // ini hampir selalu timeout request; tampilkan pesan ramah + ajakan retry.
  if (isAbortError(err)) return t('common.requestTimedOut');
  if (err instanceof Error) return err.message;
  return t(fallbackKey);
}
