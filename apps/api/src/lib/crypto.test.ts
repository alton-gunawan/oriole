import { afterEach, describe, expect, it, vi } from 'vitest';

// Env wajib (dibaca env.ts saat modul di-import) — pola sama dengan
// analytics.test.ts. Import modul dilakukan dinamis SETELAH env disetel.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/oriole_test';
process.env.NEON_AUTH_URL = 'https://ep-test.neon.tech/neondb/auth';
process.env.PADDLE_API_KEY = 'pdl_sdbx_test';
process.env.PADDLE_WEBHOOK_SECRET = 'pdl_ntfset_test';
process.env.RESEND_API_KEY = 're_test';
process.env.VAPI_API_KEY = 'vapi_test';
process.env.VAPI_PHONE_NUMBER_ID = 'phone-number-test';
process.env.APP_ENCRYPTION_KEY = 'a'.repeat(64); // hex 32 byte

const { decryptSecret, encryptSecret, isEncrypted } = await import('./crypto.ts');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('crypto (AES-256-GCM, APP_ENCRYPTION_KEY terisi)', () => {
  it('enkripsi menghasilkan ciphertext ber-prefix, bukan plaintext', () => {
    const stored = encryptSecret('secret_abc123');
    expect(isEncrypted(stored)).toBe(true);
    expect(stored.startsWith('enc:v1:')).toBe(true);
    expect(stored).not.toContain('secret_abc123');
  });

  it('roundtrip mengembalikan nilai asli', () => {
    const value = 'secret_abc123';
    expect(decryptSecret(encryptSecret(value))).toBe(value);
  });

  it('dua ciphertext untuk nilai yang sama berbeda (IV acak)', () => {
    const a = encryptSecret('secret_abc123');
    const b = encryptSecret('secret_abc123');
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(decryptSecret(b));
  });

  it('nilai plaintext lama dikembalikan apa adanya (kompatibilitas)', () => {
    expect(isEncrypted('secret_abc123')).toBe(false);
    expect(decryptSecret('secret_abc123')).toBe('secret_abc123');
  });

  it('nilai korup / format salah → string kosong (tidak pernah melempar)', () => {
    expect(decryptSecret('enc:v1:bad')).toBe('');
    expect(decryptSecret('enc:v1::::')).toBe('');
  });

  it('nilai kosong tetap kosong', () => {
    expect(encryptSecret('')).toBe('');
    expect(decryptSecret('')).toBe('');
  });
});

describe('crypto tanpa APP_ENCRYPTION_KEY (mode kompatibilitas)', () => {
  it('encryptSecret mengembalikan plaintext; decrypt mengembalikan apa adanya', async () => {
    delete process.env.APP_ENCRYPTION_KEY;
    vi.resetModules();
    const mod = await import('./crypto.ts');
    expect(mod.encryptSecret('secret_abc')).toBe('secret_abc');
    expect(mod.decryptSecret('secret_abc')).toBe('secret_abc');
    expect(mod.isEncrypted('secret_abc')).toBe(false);
    // Nilai dengan prefix tetap dianggap terenkripsi → dekripsi gagal aman
    // (kunci hilang) → '' tanpa crash.
    expect(mod.decryptSecret('enc:v1:abc:def:ghi')).toBe('');
  });
});
