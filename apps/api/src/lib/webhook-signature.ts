import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Tanda tangan webhook berbasis HMAC-SHA256 atas RAW body.
 *
 * Format: `x-calle-signature: <hex hmac sha256(rawBody, secret)>`.
 * Verifikasi harus memakai body mentah (byte asli), bukan hasil
 * re-serialisasi JSON, agar HMAC selalu cocok.
 */

export function signWebhookBody(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

/**
 * Verifikasi signature dengan perbandingan constant-time
 * (`crypto.timingSafeEqual`) untuk mencegah serangan timing.
 * Panjang berbeda → langsung false (timingSafeEqual melempar bila
 * panjang buffer tidak sama).
 */
export function verifyWebhookSignature(
  rawBody: string,
  secret: string,
  provided: string,
): boolean {
  const expected = Buffer.from(signWebhookBody(rawBody, secret), 'utf8');
  const actual = Buffer.from((provided ?? '').trim(), 'utf8');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
