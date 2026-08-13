import { sql } from 'drizzle-orm';
import { Hono } from 'hono';

import { db } from '../db/index.ts';
import { checkInngestPipeline } from '../lib/inngest-health.ts';

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
  })
  // Health pipeline Inngest — UI menampilkan peringatan saat `down` (webhook
  // pesan membalas 503 diam-diam tanpa Dev Server/cloud). SELALU 200 agar
  // frontend bisa membaca `status` tanpa error-handling khusus; `down` = 503
  // internal dijalankan webhook, bukan endpoint ini.
  .get('/inngest', async (c) => c.json(await checkInngestPipeline()));
