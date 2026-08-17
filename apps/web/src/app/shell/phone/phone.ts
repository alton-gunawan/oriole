import type { TFunction } from 'i18next';

/**
 * Label provider yang ramah produk — user memilih produk, bukan primitive Vapi.
 * `mode` 'byoc' selalu Telnyx (satu-satunya BYO aktif saat ini); selain itu
 * label mengikuti provider yang dilaporkan Vapi untuk nomor tersebut.
 */
export function providerLabel(
  mode: string | null | undefined,
  provider: string | null | undefined,
  t: TFunction,
): string {
  if (mode === 'byoc') return t('phoneNumber.providerTelnyx');
  switch (provider) {
    case 'telnyx':
      return t('phoneNumber.providerTelnyx');
    case 'twilio':
      return t('phoneNumber.providerTwilio');
    case 'vonage':
      return t('phoneNumber.providerVonage');
    case 'byo-phone-number':
      return t('phoneNumber.providerByo');
    default:
      return t('phoneNumber.providerVapi');
  }
}

/** Format nomor tampilan — kosong/null → placeholder '—'. */
export function displayNumber(number: string | null | undefined): string {
  return number?.trim() || '—';
}
