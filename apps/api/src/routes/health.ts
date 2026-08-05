import { sql } from 'drizzle-orm';
import { Hono } from 'hono';

import { db } from '../db/index.ts';

export const healthRoutes = new Hono()
  .get('/', (c) =>
    c.json({
      status: 'ok',
      service: 'oriole-api',
      version: '0.1.0',
      time: new Date().toISOString(),
    }),
  )
  .get('/ready', async (c) => {
    try {
      await db.execute(sql`select 1`);
      return c.json({ status: 'ready', db: 'connected' });
    } catch {
      return c.json({ status: 'unavailable', db: 'unreachable' }, 503);
    }
  });
