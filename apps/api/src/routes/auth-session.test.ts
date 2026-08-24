import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { authSessionRoutes } from './auth-session.ts';
import * as turnstileLib from '../lib/turnstile.ts';

describe('authSessionRoutes - POST /turnstile/verify', () => {
  const app = new Hono().route('/api/auth', authSessionRoutes);

  it('mengembalikan 400 jika body tidak menyertakan token', async () => {
    const res = await app.request('/api/auth/turnstile/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('mengembalikan 200 ok bila verifikasi turnstile sukses', async () => {
    const spy = vi.spyOn(turnstileLib, 'verifyTurnstileToken').mockResolvedValueOnce({
      success: true,
    });

    const res = await app.request('/api/auth/turnstile/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '1.2.3.4' },
      body: JSON.stringify({ token: 'test-turnstile-token' }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true, success: true });
    expect(spy).toHaveBeenCalledWith('test-turnstile-token', '1.2.3.4');

    spy.mockRestore();
  });

  it('mengembalikan 400 bila verifikasi turnstile ditolak', async () => {
    const spy = vi.spyOn(turnstileLib, 'verifyTurnstileToken').mockResolvedValueOnce({
      success: false,
      error: 'Turnstile verification failed',
    });

    const res = await app.request('/api/auth/turnstile/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'invalid-token' }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: 'Turnstile verification failed' });

    spy.mockRestore();
  });
});
