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
/** Verifikasi HMAC (hex) dengan perbandingan constant-time; panjang berbeda → false. */
function verifyHmacSignature(rawBody: string, secret: string, provided: string, algorithm: string): boolean {
  const expected = Buffer.from(createHmac(algorithm, secret).update(rawBody, 'utf8').digest('hex'), 'utf8');
  const actual = Buffer.from((provided ?? '').trim(), 'utf8');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export function verifyWebhookSignature(
  rawBody: string,
  secret: string,
  provided: string,
): boolean {
  return verifyHmacSignature(rawBody, secret, provided, 'sha256');
}

/**
 * Tanda tangan webhook WAHA — HMAC-SHA512 atas RAW body
 * (header `X-Webhook-Hmac`, algoritma `X-Webhook-Hmac-Algorithm: sha512`).
 * Beda dari Meta/360dialog (SHA-256 `X-Hub-Signature-256`) — jangan dicampur.
 */
export function signWahaWebhookBody(rawBody: string, secret: string): string {
  return createHmac('sha512', secret).update(rawBody, 'utf8').digest('hex');
}

/** Verifikasi X-Webhook-Hmac (constant-time, panjang berbeda → false). */
export function verifyWahaWebhookSignature(
  rawBody: string,
  secret: string,
  provided: string,
): boolean {
  return verifyHmacSignature(rawBody, secret, provided, 'sha512');
}

/**
 * Verifikasi token berbasis Bearer (Vapi webhook) dengan perbandingan
 * constant-time. Token = nilai mentah (mis. `Authorization: Bearer <x>`
 * dipotong prefix-nya oleh caller) atau header kustom (mis. `X-Vapi-Secret`).
 */
export function verifyBearerToken(provided: string, expected: string): boolean {
  const actual = Buffer.from((provided ?? '').trim(), 'utf8');
  const wanted = Buffer.from(expected.trim(), 'utf8');
  if (actual.length === 0 || actual.length !== wanted.length) return false;
  return timingSafeEqual(actual, wanted);
}
