import { env } from '../config/env';
import { clearAccessToken, getAccessToken } from './token';

/**
 * Hand-off JWT → cookie HttpOnly (pola defense-in-depth).
 *
 * Setelah login, token dikirim SEKALI lewat `Authorization: Bearer` ke
 * `POST /api/auth/session`; server memverifikasinya (requireAuth) lalu
 * menyimpannya sebagai cookie HttpOnly + Secure di domain API. Bila
 * berhasil, sessionStorage dibersihkan sehingga token tidak lagi terekspos
 * ke JavaScript (mitigasi XSS). Bila gagal, token tetap tersimpan — Bearer
 * token tetap dipakai (backward-compatible).
 */
export async function handoffSessionCookie(): Promise<boolean> {
  const token = getAccessToken();
  if (!token) return false;
  try {
    const res = await fetch(`${env.API_URL}/auth/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      credentials: 'include',
      body: '{}',
    });
    if (!res.ok) return false;
    clearAccessToken();
    return true;
  } catch {
    return false;
  }
}

/** Hapus cookie sesi di API saat sign-out (server membalas Max-Age=0). */
export async function clearSessionCookie(): Promise<void> {
  try {
    await fetch(`${env.API_URL}/auth/session`, { method: 'DELETE', credentials: 'include' });
  } catch {
    // Abaikan — bila request gagal, cookie tetap kedaluwarsa dengan sendirinya.
  }
}
