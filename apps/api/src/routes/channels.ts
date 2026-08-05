import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { workspaceChannels } from '@oriole/database';

import { db } from '../db/index.ts';
import { env } from '../lib/env.ts';
import {
  TelegramApiError,
  telegramDeleteWebhook,
  telegramGetMe,
  telegramSetWebhook,
} from '../lib/telegram.ts';
import { WhatsAppApiError, whatsappGetConfig } from '../services/whatsapp.ts';
import { requireAuth } from '../middleware/auth.ts';
import { requireWorkspace, type WorkspaceVariables } from '../middleware/workspace.ts';

/**
 * Manajemen channel komunikasi per workspace (Telegram, WhatsApp, ...).
 *
 * Keamanan: `providerConfig` (bot_token / api key / webhook secret)
 * TIDAK pernah di-expose — endpoint hanya menampilkan metadata publik
 * + URL webhook yang harus didaftarkan di sisi provider.
 *
 * Setup endpoint memvalidasi kredensial ke provider NYATA (getMe /
 * configs 360dialog) sebelum menyimpan — token typo langsung ditolak.
 */

function webhookUrlFor(workspaceId: string, channelType: string): string {
  return `${env.API_URL}/api/webhooks/${channelType}/${workspaceId}`;
}

function toPublicChannel(row: typeof workspaceChannels.$inferSelect, workspaceId: string) {
  return {
    id: row.id,
    channelType: row.channelType,
    identifier: row.identifier,
    isActive: row.isActive,
    webhookUrl: webhookUrlFor(workspaceId, row.channelType),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const telegramSetupSchema = z.object({
  token: z.string().trim().min(10, 'Bot token tidak valid').max(200),
});

const whatsappSetupSchema = z.object({
  apiKey: z.string().trim().min(10, 'API key tidak valid').max(300),
});

const patchChannelSchema = z.object({
  isActive: z.boolean(),
});

export const channelsRoutes = new Hono<{ Variables: WorkspaceVariables }>()
  /* ── Daftar channel workspace ────────────────────────────── */
  .get('/', requireAuth, requireWorkspace, async (c) => {
    const workspaceId = c.get('workspaceId');
    const rows = await db
      .select()
      .from(workspaceChannels)
      .where(eq(workspaceChannels.workspaceId, workspaceId));

    return c.json({ channels: rows.map((ch) => toPublicChannel(ch, workspaceId)) });
  })

  /* ── Setup Telegram: validasi token via getMe + daftarkan webhook ── */
  .post(
    '/telegram/setup',
    requireAuth,
    requireWorkspace,
    zValidator('json', telegramSetupSchema),
    async (c) => {
      const workspaceId = c.get('workspaceId');
      const { token } = c.req.valid('json');

      // Validasi token ke Telegram API sungguhan — token salah ditolak di sini.
      let botUsername: string | null;
      try {
        const me = await telegramGetMe(token);
        if (!me.isBot) {
          return c.json({ error: 'Token bukan milik sebuah bot Telegram.' }, 400);
        }
        botUsername = me.username;
      } catch (error) {
        if (error instanceof TelegramApiError) {
          return c.json({ error: `Token Telegram ditolak: ${error.message}` }, 400);
        }
        throw error;
      }

      // Secret baru hanya dibuat sekali; jangan reset saat re-setup (webhook
      // di provider masih memakai secret lama sampai user me-reset manual).
      const [existing] = await db
        .select()
        .from(workspaceChannels)
        .where(
          and(
            eq(workspaceChannels.workspaceId, workspaceId),
            eq(workspaceChannels.channelType, 'telegram'),
          ),
        )
        .limit(1);
      const webhookSecret =
        (existing?.providerConfig?.webhookSecret as string | undefined) ?? randomUUID();

      try {
        await telegramSetWebhook({
          token,
          url: webhookUrlFor(workspaceId, 'telegram'),
          secretToken: webhookSecret,
        });
      } catch (error) {
        if (error instanceof TelegramApiError) {
          return c.json({ error: `Gagal mendaftarkan webhook: ${error.message}` }, 400);
        }
        throw error;
      }

      const [channel] = await db
        .insert(workspaceChannels)
        .values({
          workspaceId,
          channelType: 'telegram',
          identifier: botUsername ? `@${botUsername}` : null,
          providerConfig: { botToken: token, webhookSecret },
          isActive: true,
        })
        .onConflictDoUpdate({
          target: [workspaceChannels.workspaceId, workspaceChannels.channelType],
          set: {
            identifier: botUsername ? `@${botUsername}` : null,
            providerConfig: { botToken: token, webhookSecret },
            isActive: true,
            updatedAt: new Date(),
          },
        })
        .returning();

      return c.json({ channel: toPublicChannel(channel, workspaceId) }, 201);
    },
  )

  /* ── Re-register webhook Telegram (mis. setelah deploy domain baru) ── */
  .post('/telegram/rewebhook', requireAuth, requireWorkspace, async (c) => {
    const workspaceId = c.get('workspaceId');
    const [channel] = await db
      .select()
      .from(workspaceChannels)
      .where(
        and(
          eq(workspaceChannels.workspaceId, workspaceId),
          eq(workspaceChannels.channelType, 'telegram'),
        ),
      )
      .limit(1);
    if (!channel) return c.json({ error: 'Channel Telegram belum dikonfigurasi.' }, 404);

    const token = channel.providerConfig?.botToken as string | undefined;
    const webhookSecret = channel.providerConfig?.webhookSecret as string | undefined;
    if (!token || !webhookSecret) {
      return c.json({ error: 'Konfigurasi channel Telegram tidak lengkap.' }, 400);
    }

    try {
      await telegramSetWebhook({
        token,
        url: webhookUrlFor(workspaceId, 'telegram'),
        secretToken: webhookSecret,
      });
    } catch (error) {
      if (error instanceof TelegramApiError) {
        return c.json({ error: `Gagal mendaftarkan webhook: ${error.message}` }, 400);
      }
      throw error;
    }
    return c.json({ ok: true, webhookUrl: webhookUrlFor(workspaceId, 'telegram') });
  })

  /* ── Setup WhatsApp: validasi API key 360dialog + simpan konfigurasi ── */
  .post(
    '/whatsapp/setup',
    requireAuth,
    requireWorkspace,
    zValidator('json', whatsappSetupSchema),
    async (c) => {
      const workspaceId = c.get('workspaceId');
      const { apiKey } = c.req.valid('json');

      let phone: string | null;
      let phoneNumberId: string | null;
      try {
        const config = await whatsappGetConfig(apiKey);
        phone = config.phone;
        phoneNumberId = config.phoneNumberId;
      } catch (error) {
        if (error instanceof WhatsAppApiError) {
          return c.json({ error: `API key 360dialog ditolak: ${error.message}` }, 400);
        }
        throw error;
      }

      const [existing] = await db
        .select()
        .from(workspaceChannels)
        .where(
          and(
            eq(workspaceChannels.workspaceId, workspaceId),
            eq(workspaceChannels.channelType, 'whatsapp'),
          ),
        )
        .limit(1);
      const webhookSecret =
        (existing?.providerConfig?.webhookSecret as string | undefined) ?? randomUUID();

      const [channel] = await db
        .insert(workspaceChannels)
        .values({
          workspaceId,
          channelType: 'whatsapp',
          identifier: phone,
          providerConfig: { apiKey, webhookSecret, phoneNumberId },
          isActive: true,
        })
        .onConflictDoUpdate({
          target: [workspaceChannels.workspaceId, workspaceChannels.channelType],
          set: {
            identifier: phone,
            providerConfig: { apiKey, webhookSecret, phoneNumberId },
            isActive: true,
            updatedAt: new Date(),
          },
        })
        .returning();

      return c.json(
        {
          channel: toPublicChannel(channel, workspaceId),
          // 360dialog tidak punya API set webhook — URL ini wajib ditempel
          // manual di dashboard 360dialog > Settings > Webhooks.
          note: 'Tempel webhookUrl ini di dashboard 360dialog (Settings → Webhooks) bersama secret token.',
        },
        201,
      );
    },
  )

  /* ── Aktif / nonaktifkan channel tanpa menghapus konfigurasi ── */
  .patch(
    '/:channelType',
    requireAuth,
    requireWorkspace,
    zValidator('param', z.object({ channelType: z.string().min(1).max(30) })),
    zValidator('json', patchChannelSchema),
    async (c) => {
      const channelType = c.req.param('channelType');
      const { isActive } = c.req.valid('json');

      const [existing] = await db
        .select()
        .from(workspaceChannels)
        .where(
          and(
            eq(workspaceChannels.workspaceId, c.get('workspaceId')),
            eq(workspaceChannels.channelType, channelType),
          ),
        )
        .limit(1);
      if (!existing) return c.json({ error: 'Channel tidak ditemukan' }, 404);
      if (existing.isActive === isActive) {
        return c.json({ channel: toPublicChannel(existing, c.get('workspaceId')) });
      }

      // Telegram: cabut/daftarkan ulang webhook sesuai status (best-effort).
      if (channelType === 'telegram') {
        const token = existing.providerConfig?.botToken as string | undefined;
        const secret = existing.providerConfig?.webhookSecret as string | undefined;
        if (token) {
          try {
            if (isActive) {
              if (secret) {
                await telegramSetWebhook({
                  token,
                  url: webhookUrlFor(c.get('workspaceId'), 'telegram'),
                  secretToken: secret,
                });
              }
            } else {
              await telegramDeleteWebhook(token);
            }
          } catch (error) {
            if (error instanceof TelegramApiError) {
              return c.json(
                { error: `Gagal sinkron webhook Telegram: ${error.message}` },
                400,
              );
            }
            throw error;
          }
        }
      }

      const [updated] = await db
        .update(workspaceChannels)
        .set({ isActive, updatedAt: new Date() })
        .where(
          and(
            eq(workspaceChannels.workspaceId, c.get('workspaceId')),
            eq(workspaceChannels.channelType, channelType),
          ),
        )
        .returning();

      return c.json({ channel: toPublicChannel(updated, c.get('workspaceId')) });
    },
  )

  .delete('/:channelType', requireAuth, requireWorkspace, async (c) => {
    const channelType = c.req.param('channelType');

    // Cabut webhook Telegram (best-effort) sebelum baris dihapus.
    if (channelType === 'telegram') {
      const [channel] = await db
        .select({ providerConfig: workspaceChannels.providerConfig })
        .from(workspaceChannels)
        .where(
          and(
            eq(workspaceChannels.workspaceId, c.get('workspaceId')),
            eq(workspaceChannels.channelType, 'telegram'),
          ),
        )
        .limit(1);
      const token = channel?.providerConfig?.botToken as string | undefined;
      if (token) {
        try {
          await telegramDeleteWebhook(token);
        } catch (error) {
          // Gagal cabut webhook bukan alasan gagal hapus channel — log saja.
          console.warn('[channels] gagal cabut webhook Telegram:', error);
        }
      }
    }

    const [deleted] = await db
      .delete(workspaceChannels)
      .where(
        and(
          eq(workspaceChannels.workspaceId, c.get('workspaceId')),
          eq(workspaceChannels.channelType, channelType),
        ),
      )
      .returning({ id: workspaceChannels.id });

    if (!deleted) return c.json({ error: 'Channel tidak ditemukan' }, 404);
    return c.json({ ok: true, id: deleted.id });
  });
