import { and, eq } from 'drizzle-orm';
import { workspaceChannels } from '@oriole/database';

import { db } from '../db/index.ts';
import { env } from './env.ts';
import { telegramGetWebhookInfo } from './telegram.ts';
import { webhookUrlFor } from './webhook-url.ts';

/**
 * Health webhook Telegram per channel — dipakai GET
 * /api/channels/telegram/webhook-health agar UI bisa menampilkan apakah
 * webhook yang terdaftar di Telegram masih menunjuk URL yang benar + jumlah
 * update tertunda (indikator pipeline inbound macet).
 *
 * Sumber kredensial sama dengan resolver inbound: providerConfig di
 * workspace_channels dulu, fallback env TELEGRAM_BOT_TOKEN (dev single-tenant).
 * Tidak melempar — kegagalan provider (token mati / jaringan) dikembalikan
 * sebagai `providerError` agar endpoint tetap 200 dan UI bisa merender status.
 */

export interface TelegramWebhookHealth {
  /** Channel (row) atau fallback env token tersedia. */
  configured: boolean;
  isActive: boolean;
  /** URL yang SEHARUSNYA dipakai (dari WEBHOOK_BASE_URL / API_URL). */
  expectedUrl: string | null;
  /** URL yang benar-benar terdaftar di Telegram (getWebhookInfo). */
  actualUrl: string | null;
  /** null = belum bisa dibandingkan (belum setup / provider error). */
  urlMatches: boolean | null;
  /** Update antrean yang belum diproses di sisi Telegram (indikator macet). */
  pendingUpdateCount: number | null;
  /** last_error_message dari Telegram (mis. webhook gagal delivery). */
  lastError: string | null;
  /** Error saat memanggil getWebhookInfo (token mati / jaringan) — non-fatal. */
  providerError: string | null;
  checkedAt: string;
}

export async function checkTelegramWebhookHealth(
  workspaceId: string,
): Promise<TelegramWebhookHealth> {
  const [channel] = await db
    .select({
      providerConfig: workspaceChannels.providerConfig,
      isActive: workspaceChannels.isActive,
    })
    .from(workspaceChannels)
    .where(
      and(
        eq(workspaceChannels.workspaceId, workspaceId),
        eq(workspaceChannels.channelType, 'telegram'),
      ),
    )
    .limit(1);

  const config = (channel?.providerConfig ?? {}) as Record<string, unknown>;
  const providerToken = config.botToken;
  const token =
    typeof providerToken === 'string' && providerToken.length > 0
      ? providerToken
      : env.TELEGRAM_BOT_TOKEN;

  const health: TelegramWebhookHealth = {
    configured: Boolean(token),
    isActive: channel?.isActive ?? true,
    expectedUrl: null,
    actualUrl: null,
    urlMatches: null,
    pendingUpdateCount: null,
    lastError: null,
    providerError: null,
    checkedAt: new Date().toISOString(),
  };

  if (!token) return health;

  health.expectedUrl = webhookUrlFor(workspaceId, 'telegram');
  try {
    const info = await telegramGetWebhookInfo(token);
    health.actualUrl = info.url;
    health.pendingUpdateCount = info.pendingUpdateCount;
    health.lastError = info.lastError;
    health.urlMatches = info.url === health.expectedUrl;
  } catch (error) {
    health.providerError = (error as Error).message;
  }
  return health;
}
