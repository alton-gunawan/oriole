/* ────────────────────────────────────────────────────────────
 * Form links — URL publik (dapat dikirim ke customer) untuk
 * form yang sudah terhubung.
 *
 * Form diintegrasikan lewat API (formId internal), sedangkan
 * customer mengisi lewat URL publik. Helper ini membangun URL
 * publik deterministik dari formId — tidak perlu disimpan.
 * ──────────────────────────────────────────────────────────── */

import { canonicalPhone } from '@oriole/messaging';

/** Jenis integrasi form yang mendukung pengiriman tautan ke customer. */
export const FORM_INTEGRATION_TYPES = ['google-forms', 'tally'] as const;
export type FormIntegrationType = (typeof FORM_INTEGRATION_TYPES)[number];

/** URL publik Google Forms: /forms/d/e/{id}/viewform. */
export function googleFormUrl(formId: string): string {
  return `https://docs.google.com/forms/d/e/${encodeURIComponent(formId)}/viewform`;
}

/** URL publik Tally: https://tally.so/r/{id}. */
export function tallyFormUrl(formId: string): string {
  return `https://tally.so/r/${encodeURIComponent(formId)}`;
}

/**
 * URL publik Tally dengan nomor HP (dan nama) sudah terisi otomatis (prefill),
 * plus token chat asal form (`orioleChatId`) bila bot mengirim tautan dari
 * sebuah chat — submission membawa token itu kembali sehingga webhook bisa
 * mengirim konfirmasi langsung ke chat yang sama.
 *
 * Mekanisme Tally: parameter URL hanya mengisi **hidden field**; input yang
 * terlihat terisi lewat "Default answer" yang menunjuk hidden field `phone` /
 * `name` (dibuat otomatis saat generate, atau manual di editor Tally — ketik
 * `/hidden` → field `phone`/`name` → aktifkan Default answer pada pertanyaan
 * dan pilih hidden field-nya).
 *
 * Parameter diabaikan Tally bila form belum punya hidden field yang sama
 * (aman dikirim kapan pun — tidak pernah merusak form).
 */
export function tallyPrefillUrl(
  formId: string,
  phone: string,
  name?: string | null,
  chatRef?: string | null,
): string {
  const url = new URL(tallyFormUrl(formId));
  url.searchParams.set('phone', phone);
  if (name && name.trim()) url.searchParams.set('name', name.trim());
  if (chatRef && chatRef.trim()) url.searchParams.set('orioleChatId', chatRef.trim());
  return url.toString();
}

/** URL publik untuk sebuah integrasi form (Google Forms / Tally). */
export function formPublicUrl(integrationType: FormIntegrationType, formId: string): string {
  return integrationType === 'google-forms' ? googleFormUrl(formId) : tallyFormUrl(formId);
}

/**
 * URL form untuk satu customer: Tally + data dikenal → prefill `phone`
 * dan/atau `name` agar customer tidak perlu mengetiknya. Nomor
 * dikanonikalisasi (0812… → 62812…) agar konsisten dengan penyimpanan
 * internal. `chatRef` = chat asal form (token `orioleChatId`) — dipakai bot
 * supaya konfirmasi setelah submission bisa dikirim otomatis ke chat yang
 * sama. Google Forms → URL polos (prefill Google Forms butuh entry ID per
 * pertanyaan — di luar scope).
 */
export function formPublicUrlForCustomer(
  integrationType: FormIntegrationType,
  formId: string,
  phone?: string | null,
  customerName?: string | null,
  chatRef?: string | null,
): string {
  if (integrationType !== 'tally') return formPublicUrl(integrationType, formId);
  const canonical = phone && phone.trim() ? canonicalPhone(phone) : null;
  const name = customerName?.trim() || null;
  const ref = chatRef?.trim() || null;
  if (!canonical && !name && !ref) return formPublicUrl(integrationType, formId);
  const url = new URL(tallyFormUrl(formId));
  if (canonical) url.searchParams.set('phone', canonical);
  if (name) url.searchParams.set('name', name);
  if (ref) url.searchParams.set('orioleChatId', ref);
  return url.toString();
}
