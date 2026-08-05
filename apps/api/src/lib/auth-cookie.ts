/**
 * Nama cookie sesi aplikasi (HttpOnly) — dipakai untuk hand-off JWT dari
 * client setelah login (pola defense-in-depth). Dibuat di modul terpisah
 * agar `middleware/auth.ts` (yang membaca cookie sebagai fallback) dan
 * `routes/auth-session.ts` (yang menulisnya) tidak saling import.
 */
export const SESSION_COOKIE = 'oriole_session';
