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
});
