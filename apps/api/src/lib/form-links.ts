/* ────────────────────────────────────────────────────────────
 * Form links — URL publik (dapat dikirim ke customer) untuk
 * form yang sudah terhubung.
 *
 * Form diintegrasikan lewat API (formId internal), sedangkan
 * customer mengisi lewat URL publik. Helper ini membangun URL
 * publik deterministik dari formId — tidak perlu disimpan.
 * ──────────────────────────────────────────────────────────── */

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

/** URL publik untuk sebuah integrasi form (Google Forms / Tally). */
export function formPublicUrl(integrationType: FormIntegrationType, formId: string): string {
  return integrationType === 'google-forms' ? googleFormUrl(formId) : tallyFormUrl(formId);
}
