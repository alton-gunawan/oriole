import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { env } from './env.ts';

/**
 * Enkripsi kredensial privat at-rest (providerConfig integrasi) — AES-256-GCM.
 *
 * Format tersimpan: `enc:v1:<iv(base64url)>:<authTag(base64url)>:<ciphertext(base64url)>`
 * Nilai lama (plaintext) TETAP terbaca via `decryptSecret` (fallback) sehingga
 * integrasi yang sudah ada tidak rusak; saat ditulis ulang, di-enkripsi.
 *
 * Tanpa `APP_ENCRYPTION_KEY` → `encryptSecret` mengembalikan plaintext apa
 * adanya (mode kompatibilitas, tidak crash). Aman: ciphertext hanya dibuat
 * bila kunci tersedia.
 */
const PREFIX = 'enc:v1:';

/** Kunci dari env — hex 64 karakter (32 byte). Null bila tidak dikonfigurasi. */
function keyBuffer(): Buffer | null {
  const key = env.APP_ENCRYPTION_KEY;
  if (!key) return null;
  return Buffer.from(key, 'hex');
}

/** True bila nilai tersimpan dalam format terenkripsi kita. */
export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

/** Enkripsi nilai. Tanpa kunci → plaintext (kompatibilitas). */
export function encryptSecret(value: string): string {
  if (!value) return value;
  const key = keyBuffer();
  if (!key) return value;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`;
}

/** Dekripsi nilai terenkripsi; nilai plaintext lama dikembalikan apa adanya. */
export function decryptSecret(value: string): string {
  if (!value || !isEncrypted(value)) return value;
  const key = keyBuffer();
  // Kunci hilang / berubah → jangan crash; kembalikan placeholder non-secret
  // (kredensial tidak bisa dipakai, sync akan gagal graceful di hulu).
  if (!key) return '';
  try {
    const [, , ivB64, tagB64, dataB64] = value.split(':');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64url')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch {
    // Data korup / kunci salah → tidak pernah melempar ke atas (graceful).
    return '';
  }
}
