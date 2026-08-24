import { describe, expect, it, vi } from 'vitest';
import { verifyTurnstileToken } from './turnstile.ts';
import { env } from './env.ts';

describe('verifyTurnstileToken', () => {
  it('lolos verifikasi jika TURNSTILE_SECRET_KEY belum disetel (fallback dev)', async () => {
    const original = env.TURNSTILE_SECRET_KEY;
    (env as unknown as { TURNSTILE_SECRET_KEY: string | undefined }).TURNSTILE_SECRET_KEY = undefined;

    const res = await verifyTurnstileToken('any-token');
    expect(res.success).toBe(true);

    (env as unknown as { TURNSTILE_SECRET_KEY: string | undefined }).TURNSTILE_SECRET_KEY = original;
  });

  it('gagal jika token kosong saat TURNSTILE_SECRET_KEY disetel', async () => {
    const original = env.TURNSTILE_SECRET_KEY;
    (env as unknown as { TURNSTILE_SECRET_KEY: string | undefined }).TURNSTILE_SECRET_KEY = 'secret-123';

    const res = await verifyTurnstileToken('');
    expect(res.success).toBe(false);
    expect(res.error).toContain('Token Turnstile tidak valid');

    (env as unknown as { TURNSTILE_SECRET_KEY: string | undefined }).TURNSTILE_SECRET_KEY = original;
  });

  it('berhasil verifikasi saat Cloudflare mengembalikan success: true', async () => {
    const original = env.TURNSTILE_SECRET_KEY;
    (env as unknown as { TURNSTILE_SECRET_KEY: string | undefined }).TURNSTILE_SECRET_KEY = 'secret-123';

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        challenge_ts: '2026-08-24T18:00:00.000Z',
        hostname: 'example.com',
      }),
    });

    const res = await verifyTurnstileToken('valid-token', '127.0.0.1', mockFetch as unknown as typeof fetch);
    expect(res.success).toBe(true);
    expect(res.hostname).toBe('example.com');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      expect.objectContaining({ method: 'POST' }),
    );

    (env as unknown as { TURNSTILE_SECRET_KEY: string | undefined }).TURNSTILE_SECRET_KEY = original;
  });

  it('gagal verifikasi saat Cloudflare mengembalikan success: false', async () => {
    const original = env.TURNSTILE_SECRET_KEY;
    (env as unknown as { TURNSTILE_SECRET_KEY: string | undefined }).TURNSTILE_SECRET_KEY = 'secret-123';

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: false,
        'error-codes': ['invalid-input-response'],
      }),
    });

    const res = await verifyTurnstileToken('invalid-token', undefined, mockFetch as unknown as typeof fetch);
    expect(res.success).toBe(false);
    expect(res.error).toBe('invalid-input-response');

    (env as unknown as { TURNSTILE_SECRET_KEY: string | undefined }).TURNSTILE_SECRET_KEY = original;
  });

  it('menangani error jaringan fetch secara aman', async () => {
    const original = env.TURNSTILE_SECRET_KEY;
    (env as unknown as { TURNSTILE_SECRET_KEY: string | undefined }).TURNSTILE_SECRET_KEY = 'secret-123';

    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const res = await verifyTurnstileToken('token', undefined, mockFetch as unknown as typeof fetch);
    expect(res.success).toBe(false);
    expect(res.error).toContain('kesalahan jaringan');

    (env as unknown as { TURNSTILE_SECRET_KEY: string | undefined }).TURNSTILE_SECRET_KEY = original;
  });
});
