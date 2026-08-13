/**
 * Setup global Vitest — menjalankan dummy env SEBELUM modul apa pun di-import.
 *
 * Masalah yang diselesaikan: beberapa test file mengimpor modul yang membaca
 * env saat load (`env.ts` → parseEnv melempar bila key wajib kosong). Bila
 * file itu menjadi file PERTAMA di worker yang mengimpor env.ts (sebelum
 * beforeAll file lain sempat men-set env), test gagal dengan
 * "Konfigurasi environment tidak valid" — flaky, tergantung penjadwalan worker.
 *
 * Nilai dummy di sini hanya DEFAULT — test file tetap boleh menimpa di
 * beforeAll masing-masing (nilai spesifik yang dibutuhkan skenario mereka).
 */
process.env.NODE_ENV = 'test';
// PORT=0 / kosong ditolak schema env (harus > 0) — default 3000 agar test
// tidak bergantung nilai PORT di shell environment.
if (!process.env.PORT || Number(process.env.PORT) <= 0) process.env.PORT = '3000';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/oriole_test';
process.env.NEON_AUTH_URL ??= 'https://test.neon.tech/neondb/auth';
process.env.PADDLE_API_KEY ??= 'pdl_test';
process.env.PADDLE_WEBHOOK_SECRET ??= 'pdl_ntfset_test';
process.env.RESEND_API_KEY ??= 're_test';
process.env.VAPI_API_KEY ??= 'vapi_test';
process.env.VAPI_PHONE_NUMBER_ID ??= 'phone-test';
