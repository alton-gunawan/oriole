import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import { createRateLimiter, resetRateLimiterStoreForTests } from './rate-limit';

describe('createRateLimiter', () => {
  beforeEach(() => {
    resetRateLimiterStoreForTests();
  });

  it('memblokir setelah limit terlampaui dalam satu jendela', async () => {
    const app = new Hono();
    app.use('*', createRateLimiter({ windowMs: 60_000, limit: 2 }));
    app.get('/', (c) => c.text('ok'));

    expect((await app.request('/')).status).toBe(200);
    expect((await app.request('/')).status).toBe(200);
    expect((await app.request('/')).status).toBe(429);
  });

  it('key yang berbeda tidak saling memblokir', async () => {
    const app = new Hono();
    app.use(
      '*',
      createRateLimiter({ windowMs: 60_000, limit: 1, keyOf: (c) => c.req.header('x-test-key') ?? 'k' }),
    );
    app.get('/', (c) => c.text('ok'));

    const a = await app.request('/', { headers: { 'x-test-key': 'a' } });
    const b = await app.request('/', { headers: { 'x-test-key': 'b' } });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });

  it('mengirim pesan error JSON saat diblokir', async () => {
    const app = new Hono();
    app.use('*', createRateLimiter({ windowMs: 60_000, limit: 1 }));
    app.get('/', (c) => c.text('ok'));

    await app.request('/');
    const blocked = await app.request('/');
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({ error: expect.any(String) });
  });

  it('trafik API biasa tidak ikut menghitung limiter khusus (regresi bucket bersama)', async () => {
    const app = new Hono();
    // Limiter global di semua path + limiter khusus /setup/* dengan limit kecil.
    app.use('*', createRateLimiter({ windowMs: 60_000, limit: 300 }));
    app.use('/setup/*', createRateLimiter({ windowMs: 60_000, limit: 5, message: 'setup blocked' }));
    app.get('/', (c) => c.text('ok'));
    app.post('/setup/x', (c) => c.text('setup ok'));

    // 5 request API biasa — hanya limiter global yang berjalan.
    for (let i = 0; i < 5; i++) {
      expect((await app.request('/')).status).toBe(200);
    }

    // Request setup PERTAMA harus lolos (1/5). Sebelum perbaikan, bucket
    // bersama berisi 6 (5 global + 1 setup) → 429 palsu "setup blocked".
    const setup = await app.request('/setup/x', { method: 'POST' });
    expect(setup.status).toBe(200);
  });

  it('dua limiter dengan nama berbeda di path sama punya counter sendiri', async () => {
    const app = new Hono();
    app.use('*', createRateLimiter({ name: 'a', windowMs: 60_000, limit: 2 }));
    app.use('*', createRateLimiter({ name: 'b', windowMs: 60_000, limit: 4 }));
    app.get('/', (c) => c.text('ok'));

    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await app.request('/')).status);
    // Limiter 'a' (limit 2) memblokir request ke-3; limiter 'b' (limit 4) tidak.
    expect(statuses).toEqual([200, 200, 429]);
  });
});
