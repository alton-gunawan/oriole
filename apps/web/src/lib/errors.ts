import type { TFunction } from 'i18next';

import { AuthActionError } from './auth';
import type { TranslationKey } from '../i18n';

/**
 * Ubah error menjadi pesan yang aman ditampilkan:
 * - AuthActionError dengan messageKey → diterjemahkan lewat t().
 * - Error lain → pesan asli (biasanya dari server, sudah final).
 * - Selain itu → fallback key yang diterjemahkan.
 */
export function errorMessage(err: unknown, t: TFunction, fallbackKey: TranslationKey): string {
  if (err instanceof AuthActionError && err.messageKey) return t(err.messageKey);
  if (err instanceof Error) return err.message;
  return t(fallbackKey);
}
