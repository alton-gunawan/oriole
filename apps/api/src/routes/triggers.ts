import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';

import { inngest } from '../inngest/client.ts';
import { requireAuth, type AuthVariables } from '../middleware/auth.ts';

const welcomeEmailSchema = z.object({
  name: z.string().min(1).max(120).optional(),
});

/**
 * Endpoint untuk meng-queue event Inngest dari API (dipakai misalnya
 * oleh alur sign-up nyata). Wajib auth — email penerima diambil dari JWT
 * (bukan dari body) agar pengguna terautentikasi tidak bisa memakai
 * endpoint ini untuk mengirim email ke alamat sebarang.
 */
export const triggerRoutes = new Hono<{ Variables: AuthVariables }>().post(
  '/welcome-email',
  requireAuth,
  zValidator('json', welcomeEmailSchema),
  async (c) => {
    const email = c.get('userEmail');
    if (!email) {
      return c.json({ error: 'Email tidak tersedia pada sesi' }, 400);
    }
    const body = c.req.valid('json');
    await inngest.send({
      name: 'user/signed-up',
      data: { email, name: body.name },
    });
    return c.json({ queued: true, event: 'user/signed-up', email });
  },
);
