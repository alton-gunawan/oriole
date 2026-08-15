import { and, eq, isNull } from 'drizzle-orm';
import { workspaceChannels, workspaces } from '@oriole/database';

import { db } from '../db/index.ts';
import { env } from './env.ts';
import { telegramGetWebhookInfo, telegramSetWebhook } from './telegram.ts';
import { assertPublicHttpsWebhookUrl, WebhookUrlError, webhookUrlFor } from './webhook-url.ts';

/**
 * Rekonsiliasi webhook Telegram saat API boot — self-healing setelah restart /
 * deploy. Tanpa ini, webhook di sisi Telegram bisa tetap menunjuk URL lama
 * (tunnel dev yang sudah mati, atau domain yang baru diganti) sehingga bot
 * berhenti merespons walau server sudah hidup lagi.
 *
 * Alasan tidak hanya mengandalkan `dev-services.ts` / setup UI: keduanya
 * berjalan pada momen tertentu (`pnpm dev` / klik connect). Kalau server
 * di-restart lewat jalur lain (`pnpm dev:api`, `pnpm start`, deploy produksi),
 * webhook tidak pernah didaftarkan ulang. Rekonsiliasi boot menutup gap itu.
 *
 * Idempotent & murah: baca `getWebhookInfo` dulu, hanya panggil `setWebhook`
 * bila URL berbeda / webhook hilang. Non-blocking dan tidak pernah melempar ke
 * pemanggil — kegagalan dicatat sebagai warning agar boot API tidak gagal.
 */

/** Jeda antar-retry setWebhook (detik), naik bertahap. */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function setWebhookWithRetry(
  token: string,
  url: string,
  secret: string,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 1; attempt++) {
    try {
      await telegramSetWebhook({ token, url, secretToken: secret });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
  }
  throw lastError;
}

export async function reconcileTelegramWebhooks(): Promise<void> {
  // Tidak pernah berjalan di test — index.ts juga men-skip di NODE_ENV=test.
  if (env.NODE_ENV === 'test') return;

  try {
    const rows = await db
      .select({
        workspaceId: workspaceChannels.workspaceId,
        providerConfig: workspaceChannels.providerConfig,
      })
      .from(workspaceChannels)
      .innerJoin(workspaces, eq(workspaceChannels.workspaceId, workspaces.id))
      .where(
        and(
          eq(workspaceChannels.channelType, 'telegram'),
          eq(workspaceChannels.isActive, true),
          isNull(workspaces.deletedAt),
        ),
      );

    for (const row of rows) {
      const config = (row.providerConfig ?? {}) as Record<string, unknown>;
      const token = config.botToken;
      const secret = config.webhookSecret;
      if (typeof token !== 'string' || token.length === 0) continue;
      if (typeof secret !== 'string' || secret.length === 0) continue;

      const url = webhookUrlFor(row.workspaceId, 'telegram');
      try {
        // URL belum HTTPS publik (mis. dev tanpa tunnel) → dev-services yang
        // menyediakan tunnel; jangan panggil Telegram dengan URL yang pasti
        // ditolak ("An HTTPS URL must be provided").
        try {
          assertPublicHttpsWebhookUrl(url);
        } catch (error) {
          if (error instanceof WebhookUrlError) {
            console.warn(`[telegram-boot] webhook ${row.workspaceId} dilewati: ${error.message}`);
            continue;
          }
          throw error;
        }

        const info = await telegramGetWebhookInfo(token);
        if (info.url === url) {
          // Sudah benar — no-op (pending updates dibiarkan diproses normal).
          continue;
        }

        await setWebhookWithRetry(token, url, secret);
        console.log(`[telegram-boot] webhook didaftarkan ulang ${row.workspaceId} → ${url}`);
      } catch (error) {
        console.warn(
          `[telegram-boot] gagal sinkron webhook ${row.workspaceId}: ${(error as Error).message}. ` +
            `Jalankan \`pnpm dev:services\` (dev) atau periksa WEBHOOK_BASE_URL.`,
        );
      }
    }
  } catch (error) {
    console.warn('[telegram-boot] gagal membaca channel Telegram:', (error as Error).message);
  }
}
