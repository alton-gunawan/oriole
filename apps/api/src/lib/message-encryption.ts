import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Enkripsi at-rest pesan inbox (AES-256-GCM).
 *
 * Model kunci:
 * - Master key 32 byte dari env `MESSAGE_ENCRYPTION_KEY` (64 hex char).
 * - Kunci PER WORKSPACE diturunkan deterministik via HKDF-SHA256:
 *     key = HKDF(master, salt = workspaceId, info = 'oriole:message:v1')
 *   Workspace berbeda → kunci berbeda, tanpa menyimpan kunci di database.
 *   Kebocoran DB tidak bisa mendekripsi pesan (kunci ada di env server).
 *
 * Format nilai tersimpan: `enc:v1:` + base64url(iv || authTag || ciphertext).
 *
 * Kompatibilitas mundur (TIDAK memutus baris plaintext lama):
 * - `encryptMessageContent` tanpa master key → passthrough plaintext
 *   (dev / belum mengaktifkan enkripsi).
 * - `decryptMessageContent` melihat prefix: baris tanpa `enc:v1:` dianggap
 *   plaintext legacy dan dikembalikan apa adanya.
 * - Baris terenkripsi yang tidak bisa didekripsi (master key hilang/berubah,
 *   data rusak) → placeholder `UNREADABLE_PLACEHOLDER` — bukan ciphertext
 *   mentah yang bocor ke UI/LLM.
 */

/** Prefix payload terenkripsi. Baris plaintext (legacy) tidak berawalan ini. */
export const ENCRYPTED_PREFIX = 'enc:v1:';

/** Pengganti teks saat baris terenkripsi tidak bisa didekripsi. */
export const UNREADABLE_PLACEHOLDER = '[encrypted]';

const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const ALGORITHM = 'aes-256-gcm';
const HKDF_INFO = Buffer.from('oriole:message:v1', 'utf8');

/** Master key dari env — dibaca lazily agar mudah diuji. Null = enkripsi nonaktif. */
function masterKey(): Buffer | null {
  const raw = process.env.MESSAGE_ENCRYPTION_KEY;
  if (!raw) return null;
  // Format valid: 64 hex char (32 byte). Selain itu anggap nonaktif + warning.
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    console.warn('[message-encryption] MESSAGE_ENCRYPTION_KEY bukan 64 hex char — enkripsi pesan nonaktif.');
    return null;
  }
  return Buffer.from(raw, 'hex');
}

/**
 * Kunci AES-256-GCM per workspace, diturunkan deterministik dari master key.
 * Null bila enkripsi nonaktif (master key tidak ter-set).
 */
function workspaceKey(workspaceId: string): Buffer | null {
  const master = masterKey();
  if (!master) return null;
  return Buffer.from(
    hkdfSync(
      'sha256',
      master,
      Buffer.from(workspaceId, 'utf8'), // salt — workspace berbeda → kunci berbeda
      HKDF_INFO,
      KEY_LENGTH,
    ),
  );
}

/** Enkripsi konten pesan sebelum disimpan. Tanpa master key → plaintext apa adanya. */
export function encryptMessageContent(workspaceId: string, plaintext: string): string {
  const key = workspaceKey(workspaceId);
  if (!key) return plaintext;

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, tag, ciphertext]);
  return `${ENCRYPTED_PREFIX}${payload.toString('base64url')}`;
}

/**
 * Dekripsi konten pesan saat dibaca.
 * - Baris plaintext (legacy, tanpa prefix) → dikembalikan apa adanya.
 * - Baris terenkripsi + master key tersedia → didekripsi (GCM auth
 *   memverifikasi integritas; gagal = rusak/kunci beda → placeholder).
 * - Baris terenkripsi + master key hilang → placeholder (jangan bocorkan
 *   ciphertext mentah ke UI / konteks LLM).
 */
export function decryptMessageContent(workspaceId: string, value: string): string {
  if (!value.startsWith(ENCRYPTED_PREFIX)) return value;

  const key = workspaceKey(workspaceId);
  if (!key) return UNREADABLE_PLACEHOLDER;

  try {
    const raw = Buffer.from(value.slice(ENCRYPTED_PREFIX.length), 'base64url');
    if (raw.length < IV_LENGTH + TAG_LENGTH) return UNREADABLE_PLACEHOLDER;
    const iv = raw.subarray(0, IV_LENGTH);
    const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const data = raw.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return UNREADABLE_PLACEHOLDER;
  }
}
