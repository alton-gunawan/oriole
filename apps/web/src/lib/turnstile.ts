import { apiFetch } from './api';

/**
 * Memverifikasi token Cloudflare Turnstile ke endpoint backend /api/auth/turnstile/verify.
 * Melempar ApiError jika token ditolak atau terjadi kendala jaringan.
 */
export async function verifyTurnstileToken(token: string): Promise<void> {
  await apiFetch('/auth/turnstile/verify', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
}
