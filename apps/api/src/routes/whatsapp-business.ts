import { Hono } from 'hono';

import { requireAuth } from '../middleware/auth.ts';
import { requireWorkspace } from '../middleware/workspace.ts';
import {
  checkWhatsAppBusinessStatus,
  completeWhatsAppBusinessConnect,
  disconnectWhatsAppBusiness,
  frontendReturnUrl,
  getWhatsAppBusinessConnection,
  refreshWhatsAppBusiness,
  startWhatsAppBusinessConnect,
  WhatsAppBusinessError,
} from '../lib/whatsapp-business.ts';

/**
 * Koneksi WhatsApp Business per tenant (Meta Embedded Signup — Tech Provider).
 *
 * Frontend TIDAK pernah menerima token/ID Meta — endpoint status hanya
 * mengembalikan metadata publik (status, nomor, nama bisnis, timestamp).
 * Alur: POST /connect → signupUrl → user selesai di Meta → Meta redirect ke
 * GET /connect/callback → backend selesaikan onboarding → redirect ke UI.
 */
export const whatsappBusinessRoutes = new Hono()
  .get('/', requireAuth, requireWorkspace, async (c) => {
    const connection = await getWhatsAppBusinessConnection(c.get('workspaceId'));
    return c.json({ connection });
  })
  .post('/connect', requireAuth, requireWorkspace, async (c) => {
    try {
      const { signupUrl } = await startWhatsAppBusinessConnect(c.get('workspaceId'));
      return c.json({ signupUrl });
    } catch (err) {
      if (err instanceof WhatsAppBusinessError) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }
  })
  // Public: Meta (browser) redirect ke sini dengan ?code=&state= — lalu
  // kembali ke frontend dengan hasil. Tidak butuh auth session (window Meta).
  .get('/connect/callback', async (c) => {
    const code = c.req.query('code') ?? '';
    const state = c.req.query('state') ?? '';
    if (!code || !state) {
      return c.redirect(frontendReturnUrl('error', 'missing-params'));
    }
    try {
      const result = await completeWhatsAppBusinessConnect({ code, state });
      return c.redirect(
        result.alreadyConnected ? frontendReturnUrl('already') : frontendReturnUrl('connected'),
      );
    } catch (err) {
      const message =
        err instanceof WhatsAppBusinessError ? err.message : 'whatsapp-connect-failed';
      return c.redirect(frontendReturnUrl('error', message));
    }
  })
  .post('/disconnect', requireAuth, requireWorkspace, async (c) => {
    await disconnectWhatsAppBusiness(c.get('workspaceId'));
    return c.json({ ok: true });
  })
  .post(
    '/refresh',
    requireAuth,
    requireWorkspace,
    async (c) => {
      try {
        const connection = await refreshWhatsAppBusiness(c.get('workspaceId'));
        return c.json({ connection });
      } catch (err) {
        if (err instanceof WhatsAppBusinessError) {
          return c.json({ error: err.message }, 400);
        }
        throw err;
      }
    },
  )
  .post('/check', requireAuth, requireWorkspace, async (c) => {
    const connection = await checkWhatsAppBusinessStatus(c.get('workspaceId'));
    return c.json({ connection });
  });
