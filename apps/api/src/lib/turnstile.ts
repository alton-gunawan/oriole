import { env } from './env.ts';

export interface TurnstileVerifyResult {
  success: boolean;
  error?: string;
  challengeTs?: string;
  hostname?: string;
}

/**
 * Verifikasi token Cloudflare Turnstile dari client.
 * Endpoint Cloudflare: https://challenges.cloudflare.com/turnstile/v0/siteverify
 *
 * Bila TURNSTILE_SECRET_KEY belum disetel (misal: development lokal),
 * verifikasi dianggap lolos (graceful fallback).
 */
export async function verifyTurnstileToken(
  token: string,
  remoteIp?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TurnstileVerifyResult> {
  const secretKey = env.TURNSTILE_SECRET_KEY;
  if (!secretKey) {
    return { success: true };
  }

  if (!token || typeof token !== 'string' || token.trim() === '') {
    return { success: false, error: 'Token Turnstile tidak valid atau kosong' };
  }

  try {
    const formData = new URLSearchParams();
    formData.append('secret', secretKey);
    formData.append('response', token);
    if (remoteIp) {
      formData.append('remoteip', remoteIp);
    }

    const res = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: formData,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    if (!res.ok) {
      return { success: false, error: `Cloudflare Turnstile HTTP ${res.status}` };
    }

    const outcome = (await res.json()) as {
      success: boolean;
      challenge_ts?: string;
      hostname?: string;
      'error-codes'?: string[];
    };

    if (!outcome.success) {
      const errorMsg = outcome['error-codes']?.join(', ') || 'Verifikasi Turnstile gagal';
      return { success: false, error: errorMsg };
    }

    return {
      success: true,
      challengeTs: outcome.challenge_ts,
      hostname: outcome.hostname,
    };
  } catch (err) {
    console.error('[turnstile] verification error:', err);
    return { success: false, error: 'Terjadi kesalahan jaringan saat verifikasi Turnstile' };
  }
}
