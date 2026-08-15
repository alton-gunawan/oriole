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
import {
  isWahaSessionAlreadyExistsError,
  WahaApiError,
  wahaCreateSession,
  wahaGetMe,
  wahaGetQr,
  wahaGetSession,
  wahaListSessions,
  wahaStartSession,
  wahaUpdateSession,
} from '../services/waha.ts';
import { chatIdToWaId } from '../lib/waha-mapping.ts';
import {
  isWahaConsentChecklistValid,
  isWahaConsentVersionKnown,
  wahaConsentCopyHash,
  type WahaConsentRecord,
} from '../lib/waha-consent.ts';
import { requireAuth } from '../middleware/auth.ts';
import { requireWorkspace, type WorkspaceVariables } from '../middleware/workspace.ts';
import {
  assertPublicHttpsWebhookUrl,
  WebhookUrlError,
  webhookUrlFor,
} from '../lib/webhook-url.ts';
import { MetaApiError, metaGetPageIdentity, META_WEBHOOK_PATH } from '../lib/meta.ts';
import { LineApiError, lineGetBotInfo, lineSetWebhookEndpoint } from '../lib/line.ts';
import { encryptSecret } from '../lib/crypto.ts';
import { resolveLineChannel } from '../lib/line-handler.ts';
import { checkTelegramWebhookHealth } from '../lib/telegram-health.ts';

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

/** Bentuk channel publik (tanpa kredensial privat); isEnvShared hanya untuk virtual channel bot bersama. */
type PublicChannel = {
  id: string;
  channelType: string;
  identifier: string | null;
  isActive: boolean;
  webhookUrl: string;
  createdAt: string;
  updatedAt: string;
  isEnvShared?: boolean;
  /** Provider channel WhatsApp: '360dialog' (default) | 'waha' (BYO unofficial). */
  provider?: string;
  /** Health state BYO (connecting/connected/…) — hanya untuk provider waha. */
  healthState?: string;
  /** Status session mentah terakhir dari gateway (WORKING/FAILED/…) — UI
   *  memakainya untuk hint re-pairing LID saat FAILED tapi masih ter-pair. */
  healthStatus?: string;
};

/**
 * URL webhook Meta — SATU per app (bukan per-workspace seperti Telegram).
 * Meta mengirim event semua page ke satu callback URL; routing ke workspace
 * terjadi di route webhook via page id. Ditampilkan di UI sebagai URL yang
 * harus ditempel di dashboard Meta Developers.
 */
function metaWebhookUrl(): string {
  return `${env.API_URL}${META_WEBHOOK_PATH}`;
}

function toPublicChannel(row: typeof workspaceChannels.$inferSelect, workspaceId: string): PublicChannel {
  const config = (row.providerConfig ?? {}) as Record<string, unknown>;
  const isMetaChannel = row.channelType === 'instagram' || row.channelType === 'facebook';
  return {
    id: row.id,
    channelType: row.channelType,
    identifier: row.identifier,
    isActive: row.isActive,
    // Meta: webhook di level app (satu URL untuk semua page) — bukan
    // per-workspace.
    webhookUrl: isMetaChannel ? metaWebhookUrl() : webhookUrlFor(workspaceId, row.channelType),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    provider: typeof config.provider === 'string' ? config.provider : undefined,
    healthState:
      config.health && typeof config.health === 'object'
        ? ((config.health as { state?: unknown }).state as string | undefined)
        : undefined,
    healthStatus:
      config.health && typeof config.health === 'object'
        ? ((config.health as { lastStatus?: unknown }).lastStatus as string | undefined)
        : undefined,
  };
}

/**
 * Identitas bot bersama dari env (getMe) dengan cache pendek — dipakai untuk
 * menampilkan @username pada channel virtual tanpa network call tiap request.
 */
let envBotIdentityCache: { username: string | null; fetchedAt: number } | null = null;
const ENV_BOT_IDENTITY_TTL_MS = 10 * 60_000;

async function resolveEnvBotIdentity(): Promise<{ username: string | null } | null> {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  if (envBotIdentityCache && Date.now() - envBotIdentityCache.fetchedAt < ENV_BOT_IDENTITY_TTL_MS) {
    return envBotIdentityCache;
  }
  try {
    const me = await telegramGetMe(token);
    envBotIdentityCache = { username: me.username, fetchedAt: Date.now() };
  } catch {
    // Token mati / Telegram down — tampilkan channel tanpa username.
    envBotIdentityCache = { username: null, fetchedAt: Date.now() };
  }
  return envBotIdentityCache;
}

/**
 * Validasi token ke Telegram API sungguhan → daftarkan webhook → simpan/upsert
 * channel. Dipakai bersama oleh /telegram/setup (token dari user) dan
 * /telegram/connect (token env bot bersama). Error dikembalikan HTTP-ready
 * agar pemanggil langsung merespons.
 */
async function registerTelegramChannel(input: {
  workspaceId: string;
  token: string;
  tokenLabel?: string;
}): Promise<
  | { ok: true; channel: typeof workspaceChannels.$inferSelect }
  | { ok: false; status: 400 | 500; error: string }
> {
  const label = input.tokenLabel ?? 'Token';

  // Webhook Telegram harus HTTPS publik — gagal cepat dengan pesan jelas
  // SEBELUM memanggil API Telegram (error asli Telegram "bad webhook: An
  // HTTPS URL must be provided" membingungkan pengguna).
  try {
    assertPublicHttpsWebhookUrl(webhookUrlFor(input.workspaceId, 'telegram'));
  } catch (error) {
    if (error instanceof WebhookUrlError) {
      return { ok: false, status: 400, error: error.message };
    }
    throw error;
  }

  // Validasi token ke Telegram API sungguhan — token salah ditolak di sini.
  let botUsername: string | null;
  try {
    const me = await telegramGetMe(input.token);
    if (!me.isBot) {
      return { ok: false, status: 400, error: `${label} bukan milik sebuah bot Telegram.` };
    }
    botUsername = me.username;
  } catch (error) {
    if (error instanceof TelegramApiError) {
      return { ok: false, status: 400, error: `${label} ditolak: ${error.message}` };
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
        eq(workspaceChannels.workspaceId, input.workspaceId),
        eq(workspaceChannels.channelType, 'telegram'),
      ),
    )
    .limit(1);
  const webhookSecret =
    (existing?.providerConfig?.webhookSecret as string | undefined) ?? randomUUID();

  try {
    await telegramSetWebhook({
      token: input.token,
      url: webhookUrlFor(input.workspaceId, 'telegram'),
      secretToken: webhookSecret,
    });
  } catch (error) {
    if (error instanceof TelegramApiError) {
      return { ok: false, status: 400, error: `Gagal mendaftarkan webhook: ${error.message}` };
    }
    throw error;
  }

  const [channel] = await db
    .insert(workspaceChannels)
    .values({
      workspaceId: input.workspaceId,
      channelType: 'telegram',
      identifier: botUsername ? `@${botUsername}` : null,
      providerConfig: { botToken: input.token, webhookSecret },
      isActive: true,
    })
    .onConflictDoUpdate({
      target: [workspaceChannels.workspaceId, workspaceChannels.channelType],
      set: {
        identifier: botUsername ? `@${botUsername}` : null,
        providerConfig: { botToken: input.token, webhookSecret },
        isActive: true,
        updatedAt: new Date(),
      },
    })
    .returning();

  if (!channel) {
    // Defensive: pada Postgres `returning()` selalu mengembalikan row, tapi
    // guard ini mencegah 500 bila driver mengembalikan array kosong.
    return { ok: false, status: 500, error: 'Gagal menyimpan channel Telegram.' };
  }
  return { ok: true, channel };
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

const metaSetupSchema = z.object({
  channelType: z.enum(['instagram', 'facebook']),
  accessToken: z.string().trim().min(20, 'Access token Meta tidak valid').max(600),
});

/** Setup Line Messaging API: channel access token + channel secret (Console →
 *  https://developers.line.biz — provider Messaging API, bukan LINE Login). */
const lineSetupSchema = z.object({
  channelAccessToken: z.string().trim().min(10, 'Channel access token tidak valid').max(500),
  channelSecret: z.string().trim().min(8, 'Channel secret tidak valid').max(300),
});

const whatsappWahaSetupSchema = z.object({
  // Kredensial gateway TIDAK lagi diterima dari klien — gateway selalu
  // ter-managed server (env WAHA_GATEWAY_URL + WAHA_GATEWAY_API_KEY).
  // Field baseUrl/apiKey yang dikirim klien di-strip oleh zod (unknown keys).
  consentVersion: z.number().int().min(1),
  // Kunci checklist risiko yang dicentang user — backend memverifikasi bahwa
  // SEMUA kunci WAHA_CONSENT_RISK_ITEMS ada (set, bukan teks literal).
  // Tanpa .min(1): array kosong dibiarkan lolos zod agar ditolak oleh
  // isWahaConsentChecklistValid dengan pesan konsisten (bukan pesan generik).
  checked: z.array(z.string().trim().min(1)),
});

/**
 * Mode gateway ter-managed server: bila env WAHA_GATEWAY_URL + API key
 * diisi, user TIDAK perlu memasukkan kredensial gateway (dialog BYO hanya
 * consent + QR). Kredensial env dipakai untuk semua workspace.
 */
function isWahaGatewayManaged(): boolean {
  return Boolean(env.WAHA_GATEWAY_URL && env.WAHA_GATEWAY_API_KEY);
}

/**
 * API key default dari docker-compose spike WAHA — ditolak di setup
 * (spec §9: "Default credentials are rejected at setup").
 */
const WAHA_FORBIDDEN_API_KEYS = ['spike-waha-change-me-00000000000000000000000000000000'];

/** Nama session WAHA per workspace — unik per workspace, aman untuk nama session. */
function wahaSessionName(workspaceId: string): string {
  return `ws_${workspaceId}`;
}

/**
 * Pesan untuk kegagalan KONEKTIVITAS gateway (bukan respons WAHA): DNS tak
 * terjangkau, koneksi ditolak, atau timeout fetch — fetch melempar TypeError/
 * DOMException, BUKAN WahaApiError. Diubah jadi 400 dengan pesan jelas (bukan
 * rethrow → 500 generik "kesalahan internal").
 */
function gatewayUnreachableMessage(baseUrl: string): string {
  return `Gateway WAHA tidak dapat dijangkau (${baseUrl}). Pastikan gateway berjalan dan URL/API key benar.`;
}

/**
 * Riwayat provider channel whatsapp (spec §3 — rollback mudah saat ganti
 * provider 360dialog ⇄ waha). Mengembalikan array baru: bila provider lama
 * berbeda dari yang baru, konfigurasi lama masuk riwayat; re-setup sesama
 * provider tidak menambah entri.
 */
/**
 * Validasi kredensial Line ke API sungguhan (GET /v2/bot/info) → daftarkan
 * webhook endpoint → simpan/upsert channel. Access token & channel secret
 * dienkripsi at-rest (AES-256-GCM) sebelum masuk providerConfig.
 */
async function registerLineChannel(input: {
  workspaceId: string;
  channelAccessToken: string;
  channelSecret: string;
}): Promise<
  | { ok: true; channel: typeof workspaceChannels.$inferSelect }
  | { ok: false; status: 400 | 500; error: string }
> {
  // Webhook Line harus HTTPS publik — gagal cepat dengan pesan jelas.
  try {
    assertPublicHttpsWebhookUrl(webhookUrlFor(input.workspaceId, 'line'));
  } catch (error) {
    if (error instanceof WebhookUrlError) {
      return { ok: false, status: 400, error: error.message };
    }
    throw error;
  }

  // Validasi token ke Line API sungguhan — token salah / tidak punya scope
  // Messaging API ditolak di sini (401 dari Line).
  let botInfo: { userId: string; displayName: string | null };
  try {
    botInfo = await lineGetBotInfo(input.channelAccessToken);
  } catch (error) {
    if (error instanceof LineApiError) {
      return { ok: false, status: 400, error: `Channel access token ditolak: ${error.message}` };
    }
    throw error;
  }
  if (!botInfo.userId) {
    return { ok: false, status: 400, error: 'Token bukan milik bot Line Messaging API (periksa provider di Line Developers Console).' };
  }

  try {
    await lineSetWebhookEndpoint(input.channelAccessToken, webhookUrlFor(input.workspaceId, 'line'));
  } catch (error) {
    if (error instanceof LineApiError) {
      return { ok: false, status: 400, error: `Gagal mendaftarkan webhook: ${error.message}` };
    }
    throw error;
  }

  const [channel] = await db
    .insert(workspaceChannels)
    .values({
      workspaceId: input.workspaceId,
      channelType: 'line',
      identifier: botInfo.displayName ?? botInfo.userId,
      providerConfig: {
        // Kredensial dienkripsi at-rest (AES-256-GCM).
        channelAccessToken: encryptSecret(input.channelAccessToken),
        channelSecret: encryptSecret(input.channelSecret),
        lineUserId: botInfo.userId,
      },
      isActive: true,
    })
    .onConflictDoUpdate({
      target: [workspaceChannels.workspaceId, workspaceChannels.channelType],
      set: {
        identifier: botInfo.displayName ?? botInfo.userId,
        providerConfig: {
          channelAccessToken: encryptSecret(input.channelAccessToken),
          channelSecret: encryptSecret(input.channelSecret),
          lineUserId: botInfo.userId,
        },
        isActive: true,
        updatedAt: new Date(),
      },
    })
    .returning();

  if (!channel) {
    return { ok: false, status: 500, error: 'Gagal menyimpan channel Line.' };
  }
  return { ok: true, channel };
}

function pushProviderHistory(
  prevConfig: Record<string, unknown>,
  newProvider: string,
): { provider: string; config: Record<string, unknown>; replacedAt: string }[] {
  const history = (prevConfig.providerHistory ?? []) as {
    provider: string;
    config: Record<string, unknown>;
    replacedAt: string;
  }[];
  // Row lama tanpa field provider = 360dialog (default sebelum BYO ada).
  const prevProvider = typeof prevConfig.provider === 'string' ? prevConfig.provider : '360dialog';
  if (prevProvider !== newProvider) {
    return [
      ...history,
      { provider: prevProvider, config: prevConfig, replacedAt: new Date().toISOString() },
    ];
  }
  return history;
}

export const channelsRoutes = new Hono<{ Variables: WorkspaceVariables }>()
  /* ── Daftar channel workspace ────────────────────────────── */
  .get('/', requireAuth, requireWorkspace, async (c) => {
    const workspaceId = c.get('workspaceId');
    const rows = await db
      .select()
      .from(workspaceChannels)
      .where(eq(workspaceChannels.workspaceId, workspaceId));

    const channels: PublicChannel[] = rows.map((ch) => toPublicChannel(ch, workspaceId));

    // One-click mode (single-tenant / development): bila server menyediakan bot
    // bersama via env TELEGRAM_BOT_TOKEN dan bisnis ini belum punya channel
    // Telegram sendiri, tampilkan virtual channel agar UI bisa menghubungkannya
    // sekali klik tanpa input token BotFather. isActive=false karena webhook
    // untuk bisnis ini belum didaftarkan sampai connect ditekan.
    if (!rows.some((r) => r.channelType === 'telegram') && env.TELEGRAM_BOT_TOKEN) {
      const identity = await resolveEnvBotIdentity();
      const now = new Date();
      channels.push({
        id: 'env-shared-telegram',
        channelType: 'telegram',
        identifier: identity?.username ? `@${identity.username}` : null,
        isActive: false,
        webhookUrl: webhookUrlFor(workspaceId, 'telegram'),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        isEnvShared: true,
      });
    }

    return c.json({ channels });
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

      const result = await registerTelegramChannel({ workspaceId, token });
      if (!result.ok) return c.json({ error: result.error }, result.status);

      return c.json({ channel: toPublicChannel(result.channel, workspaceId) }, 201);
    },
  )

  /* ── One-click connect: hubungkan bot bersama dari env (tanpa token) ──
   * Dipakai mode single-tenant/development (TELEGRAM_BOT_TOKEN di env).
   * CATATAN: setWebhook Telegram hanya 1 URL per bot — jika beberapa workspace
   * memakai bot bersama yang sama, workspace yang terakhir connect yang
   * menerima update webhook. Mode ini memang ditujukan untuk deployment
   * satu workspace. */
  .post('/telegram/connect', requireAuth, requireWorkspace, async (c) => {
    const workspaceId = c.get('workspaceId');
    if (!env.TELEGRAM_BOT_TOKEN) {
      return c.json({ error: 'Bot Telegram bersama belum dikonfigurasi di server (TELEGRAM_BOT_TOKEN).' }, 400);
    }

    // Guard: jangan menimpa bot custom milik workspace (mis. user sudah setup
    // bot sendiri lewat /telegram/setup) dengan bot bersama dari server.
    const [existing] = await db
      .select({ providerConfig: workspaceChannels.providerConfig })
      .from(workspaceChannels)
      .where(
        and(
          eq(workspaceChannels.workspaceId, workspaceId),
          eq(workspaceChannels.channelType, 'telegram'),
        ),
      )
      .limit(1);
    const existingToken = existing?.providerConfig?.botToken as string | undefined;
    if (existing && existingToken !== env.TELEGRAM_BOT_TOKEN) {
      return c.json(
        { error: 'Workspace sudah punya bot Telegram sendiri — lepas dulu sebelum memakai bot bersama.' },
        409,
      );
    }

    const result = await registerTelegramChannel({
      workspaceId,
      token: env.TELEGRAM_BOT_TOKEN,
      tokenLabel: 'Bot bersama server',
    });
    if (!result.ok) return c.json({ error: result.error }, result.status);

    // Segarkan cache username bot env agar tampilan GET tidak basi.
    const username = result.channel.identifier?.replace(/^@/, '') ?? null;
    envBotIdentityCache = { username, fetchedAt: Date.now() };

    return c.json({ channel: toPublicChannel(result.channel, workspaceId) }, 201);
  })

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
      // HTTPS publik wajib — gagal cepat sebelum memanggil Telegram.
      assertPublicHttpsWebhookUrl(webhookUrlFor(workspaceId, 'telegram'));
      await telegramSetWebhook({
        token,
        url: webhookUrlFor(workspaceId, 'telegram'),
        secretToken: webhookSecret,
      });
    } catch (error) {
      if (error instanceof WebhookUrlError) {
        return c.json({ error: error.message }, 400);
      }
      if (error instanceof TelegramApiError) {
        return c.json({ error: `Gagal mendaftarkan webhook: ${error.message}` }, 400);
      }
      throw error;
    }
    return c.json({ ok: true, webhookUrl: webhookUrlFor(workspaceId, 'telegram') });
  })

  /* ── Health webhook Telegram: URL terdaftar + update tertunda ──
   * UI memakainya untuk menampilkan apakah webhook masih menunjuk URL yang
   * benar (mis. setelah restart/tunnel berganti) tanpa harus cek dashboard
   * Telegram manual. Selalu 200 — status dibaca dari body, bukan kode HTTP.
   */
  .get('/telegram/webhook-health', requireAuth, requireWorkspace, async (c) => {
    const health = await checkTelegramWebhookHealth(c.get('workspaceId'));
    return c.json(health);
  })

  /* ── Setup Line: validasi channel access token (GET /v2/bot/info) + daftarkan webhook ── */
  .post(
    '/line/setup',
    requireAuth,
    requireWorkspace,
    zValidator('json', lineSetupSchema),
    async (c) => {
      const workspaceId = c.get('workspaceId');
      const { channelAccessToken, channelSecret } = c.req.valid('json');

      const result = await registerLineChannel({ workspaceId, channelAccessToken, channelSecret });
      if (!result.ok) return c.json({ error: result.error }, result.status);

      return c.json({ channel: toPublicChannel(result.channel, workspaceId) }, 201);
    },
  )

  /* ── Re-register webhook Line (mis. setelah deploy domain baru) ── */
  .post('/line/rewebhook', requireAuth, requireWorkspace, async (c) => {
    const workspaceId = c.get('workspaceId');
    const channel = await resolveLineChannel(workspaceId);
    if (!channel) return c.json({ error: 'Channel Line belum dikonfigurasi.' }, 404);

    try {
      // HTTPS publik wajib — gagal cepat sebelum memanggil Line.
      assertPublicHttpsWebhookUrl(webhookUrlFor(workspaceId, 'line'));
      await lineSetWebhookEndpoint(channel.accessToken, webhookUrlFor(workspaceId, 'line'));
    } catch (error) {
      if (error instanceof WebhookUrlError) {
        return c.json({ error: error.message }, 400);
      }
      if (error instanceof LineApiError) {
        return c.json({ error: `Gagal mendaftarkan webhook: ${error.message}` }, 400);
      }
      throw error;
    }
    return c.json({ ok: true, webhookUrl: webhookUrlFor(workspaceId, 'line') });
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

      // Replace dari BYO (waha) → simpan konfigurasi lama di providerHistory
      // agar rollback mudah (spec §3). Riwayat tidak bertambah saat re-setup
      // sesama 360dialog.
      const prevConfig = (existing?.providerConfig ?? {}) as Record<string, unknown>;
      const providerHistory = pushProviderHistory(prevConfig, '360dialog');

      const providerConfig = {
        provider: '360dialog',
        apiKey,
        webhookSecret,
        phoneNumberId,
        providerHistory,
      };

      const [channel] = await db
        .insert(workspaceChannels)
        .values({
          workspaceId,
          channelType: 'whatsapp',
          identifier: phone,
          providerConfig,
          isActive: true,
        })
        .onConflictDoUpdate({
          target: [workspaceChannels.workspaceId, workspaceChannels.channelType],
          set: {
            identifier: phone,
            providerConfig,
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

  /* ── Pratinjau identitas Meta (token → page + IG business account) ──
   * Token TIDAK disimpan di endpoint ini — hanya validasi + info tampilan.
   */
  .post(
    '/meta/preview',
    requireAuth,
    requireWorkspace,
    zValidator('json', z.object({ accessToken: z.string().trim().min(20).max(600) })),
    async (c) => {
      const { accessToken } = c.req.valid('json');
      try {
        const identity = await metaGetPageIdentity(accessToken);
        return c.json({ identity });
      } catch (err) {
        if (err instanceof MetaApiError) {
          return c.json({ error: `Meta menolak: ${err.message}` }, err.status && err.status >= 400 && err.status < 500 ? 400 : 502);
        }
        console.error('[channels] preview meta gagal:', err);
        return c.json({ error: 'Gagal menghubungi Meta. Coba lagi.' }, 502);
      }
    },
  )

  /* ── Setup Meta (Instagram / Facebook DMs): validasi token + simpan ──
   * Alur: user membuat Page access token di Meta Developer dashboard
   * (izinkan pages_messaging untuk Messenger; instagram_manage_messages +
   * instagram_business_messages untuk Instagram), lalu menempelnya di sini.
   * Validasi ke Graph API NYATA (getMe) — token typo langsung ditolak.
   * Webhook di daftarkan di dashboard Meta (satu callback URL per app) —
   * route /api/webhooks/meta yang routing ke workspace via page id.
   */
  .post(
    '/meta/setup',
    requireAuth,
    requireWorkspace,
    zValidator('json', metaSetupSchema),
    async (c) => {
      const workspaceId = c.get('workspaceId');
      const { channelType, accessToken } = c.req.valid('json');

      let identity: Awaited<ReturnType<typeof metaGetPageIdentity>>;
      try {
        identity = await metaGetPageIdentity(accessToken);
      } catch (err) {
        if (err instanceof MetaApiError) {
          const status = err.status && err.status >= 400 && err.status < 500 ? 400 : 502;
          return c.json({ error: `Access token ditolak Meta: ${err.message}` }, status);
        }
        throw err;
      }

      // Instagram WAJIB punya instagram_business_account terhubung ke page —
      // tanpa itu token tidak bisa menerima/mengirim DM Instagram.
      if (channelType === 'instagram' && !identity.instagramBusinessAccount) {
        return c.json(
          {
            error: 'Token ini tidak terhubung ke Instagram Business Account. Hubungkan IG ke page di Meta Business Suite, lalu buat token baru dengan izin instagram_manage_messages + instagram_business_messages.',
          },
          400,
        );
      }

      const identifier =
        channelType === 'instagram'
          ? identity.instagramBusinessAccount?.username ?? identity.name
          : identity.name;
      const providerConfig = {
        accessToken,
        pageId: identity.id,
        pageName: identity.name,
        igBusinessId: identity.instagramBusinessAccount?.id ?? null,
      };

      const [channel] = await db
        .insert(workspaceChannels)
        .values({
          workspaceId,
          channelType,
          identifier,
          providerConfig,
          isActive: true,
        })
        .onConflictDoUpdate({
          target: [workspaceChannels.workspaceId, workspaceChannels.channelType],
          set: {
            identifier,
            providerConfig,
            isActive: true,
            updatedAt: new Date(),
          },
        })
        .returning();

      if (!channel) {
        return c.json({ error: 'Gagal menyimpan channel Meta.' }, 500);
      }
      return c.json(
        {
          channel: toPublicChannel(channel, workspaceId),
          note: 'Tempel webhookUrl ini di dashboard Meta Developers (App → Webhooks → subscribe ke pesan page).',
        },
        201,
      );
    },
  )

  /* ── Info gateway BYO — apakah server menyediakan gateway ter-managed? ──
   * Gateway BYO selalu ter-managed server (env WAHA_GATEWAY_*); endpoint ini
   * informatif (frontend tidak lagi menampilkan field kredensial). Hanya
   * boolean + baseUrl publik yang dikembalikan — API key TIDAK pernah diekspos.
   */
  .get(
    '/whatsapp/waha/gateway-info',
    requireAuth,
    requireWorkspace,
    async (c) => {
      const managed = isWahaGatewayManaged();
      return c.json({
        managed,
        baseUrl: managed ? (env.WAHA_GATEWAY_URL as string) : undefined,
      });
    },
  )

  /* ── Setup WhatsApp BYO (unofficial, WAHA): consent + create session ──
   *
   * Alur (spec docs/bring-your-own-whatsapp.md §4–5):
   *   1. Validasi consent ter-version: versi copy dikenal + checklist risiko
   *      (SEMUA kotak dicentang) — tanpa ini 409/400.
   *   2. Probe gateway NYATA (GET /api/sessions) sebelum menyimpan apa pun.
   *   3. Buat session WAHA (name = ws_<workspaceId>) dengan webhook ke
   *      adapter (POST /api/webhooks/waha/:workspaceId, HMAC-SHA512) +
   *      metadata workspace.id; 409 = session sudah ada → reuse.
   *   4. Simpan providerConfig: provider 'waha' + consent audit + health
   *      awal 'connecting'. gatewayApiKey sengaja TIDAK disimpan di kolom
   *      `apiKey` agar resolver tidak keliru menganggapnya kredensial WABA —
   *      resolveWhatsAppChannel memilah provider 'waha' → sendWhatsAppMessage
   *      mengirim via WAHA sendText.
   */
  .post(
    '/whatsapp/waha/setup',
    requireAuth,
    requireWorkspace,
    zValidator('json', whatsappWahaSetupSchema),
    async (c) => {
      const workspaceId = c.get('workspaceId');
      const userId = c.get('userId');
      const body = c.req.valid('json');

      // 1) Consent — gagal di sini sebelum ada efek samping apa pun.
      if (!isWahaConsentVersionKnown(body.consentVersion)) {
        return c.json(
          { error: 'Teks persetujuan telah diperbarui — baca ulang dan setujui kembali.' },
          409,
        );
      }
      if (!isWahaConsentChecklistValid(body.checked)) {
        return c.json({ error: 'Tandai semua kotak risiko untuk melanjutkan.' }, 400);
      }

      // 2) Kredensial gateway SELALU dari server (env WAHA_GATEWAY_URL +
      //    WAHA_GATEWAY_API_KEY) — klien tidak lagi mengirim URL/key sendiri.
      const baseUrl = env.WAHA_GATEWAY_URL;
      const apiKey = env.WAHA_GATEWAY_API_KEY;
      if (!baseUrl || !apiKey) {
        return c.json(
          { error: 'Gateway WhatsApp belum dikonfigurasi di server (WAHA_GATEWAY_URL / WAHA_GATEWAY_API_KEY).' },
          400,
        );
      }
      if (WAHA_FORBIDDEN_API_KEYS.includes(apiKey)) {
        return c.json({ error: 'Ganti API key default gateway sebelum menghubungkan.' }, 400);
      }

      // 3) Probe gateway sungguhan — URL/key salah ditolak di sini.
      //    Kegagalan NON-WahaApiError (DNS tak terjangkau, koneksi ditolak,
      //    timeout fetch) diubah menjadi 400 dengan pesan jelas — bukan
      //    rethrow yang berakhir sebagai 500 generik "kesalahan internal".
      try {
        await wahaListSessions(baseUrl, apiKey);
      } catch (error) {
        if (error instanceof WahaApiError) {
          return c.json({ error: error.message }, 400);
        }
        return c.json({ error: gatewayUnreachableMessage(baseUrl) }, 400);
      }

      // 4) Session WAHA (webhook secret dipertahankan saat re-setup agar
      //    HMAC adapter tidak berubah).
      const sessionName = wahaSessionName(workspaceId);
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

      let sessionStatus: string;
      const sessionInput = {
        baseUrl,
        apiKey,
        name: sessionName,
        workspaceId,
        webhookUrl: `${env.API_URL}/api/webhooks/waha/${workspaceId}`,
        webhookSecret,
      };
      try {
        const created = await wahaCreateSession(sessionInput);
        sessionStatus = created.status;
      } catch (error) {
        // Session sudah ada (re-setup): WAHA lama → 409; WAHA 2026.x → 422
        // "already exists. Use PUT to update it". Perbarui config session lama
        // (webhook URL/secret terkini) lewat PUT — WAHA sendiri menyarankannya
        // — agar adapter webhook tidak memakai config basi setelah re-setup.
        // CATATAN: PUT dapat me-restart engine sesaat (re-setup adalah aksi
        // eksplisit user); session ter-pair (WORKING) sembuh sendiri dari creds
        // tersimpan di store NOWEB.
        if (error instanceof WahaApiError && isWahaSessionAlreadyExistsError(error)) {
          try {
            const updated = await wahaUpdateSession(sessionInput);
            sessionStatus = updated.status;
          } catch (updateError) {
            // PUT gagal (mis. gateway sedang sibuk) — session tetap ADA;
            // lanjut saja, refresh-qr yang menetapkan state nyata.
            console.warn('[channels] gagal memperbarui session eksisting:', updateError);
            sessionStatus = 'EXISTS';
          }
        } else if (error instanceof WahaApiError) {
          return c.json({ error: error.message }, 400);
        } else {
          // Kegagalan non-WahaApiError (jaringan/DNS/timeout) — pesan jelas,
          // bukan 500 generik (lihat probe di atas).
          return c.json({ error: gatewayUnreachableMessage(baseUrl) }, 400);
        }
      }

      // 5) Simpan channel + consent audit (append-only) + health awal.
      //    consent = catatan TERBARU; consentHistory = riwayat sebelumnya
      //    (spec §4: jejak audit tidak boleh ditimpa saat re-setup).
      const prevConfig = (existing?.providerConfig ?? {}) as Record<string, unknown>;
      const prevConsent = prevConfig.consent as WahaConsentRecord | undefined;
      const prevHistory = (prevConfig.consentHistory as WahaConsentRecord[] | undefined) ?? [];
      const consentHistory = prevConsent ? [...prevHistory, prevConsent] : prevHistory;

      // Ganti provider (360dialog → waha) → konfigurasi lama masuk
      // providerHistory untuk rollback (spec §3). Re-setup sesama waha tidak
      // menambah riwayat baru.
      const providerHistory = pushProviderHistory(prevConfig, 'waha');

      const consentRecord: WahaConsentRecord = {
        version: body.consentVersion,
        copyHash: wahaConsentCopyHash(body.consentVersion),
        acceptedAt: new Date().toISOString(),
        acceptedByUserId: userId,
      };

      const providerConfig = {
        provider: 'waha',
        baseUrl,
        gatewayApiKey: apiKey,
        sessionName,
        webhookSecret,
        consent: consentRecord,
        consentHistory,
        providerHistory,
        health: {
          state: 'connecting',
          lastSeenAt: null,
          lastStatusAt: new Date().toISOString(),
          reachoutTimelockUntil: null,
          lastError: null,
          lastStatus: null,
        },
      };

      const [channel] = await db
        .insert(workspaceChannels)
        .values({
          workspaceId,
          channelType: 'whatsapp',
          identifier: null,
          providerConfig,
          isActive: true,
        })
        .onConflictDoUpdate({
          target: [workspaceChannels.workspaceId, workspaceChannels.channelType],
          set: {
            identifier: null,
            providerConfig,
            isActive: true,
            updatedAt: new Date(),
          },
        })
        .returning();

      if (!channel) {
        return c.json({ error: 'Gagal menyimpan channel WhatsApp.' }, 500);
      }

      return c.json(
        {
          channel: toPublicChannel(channel, workspaceId),
          session: { name: sessionName, status: sessionStatus },
          note: 'Scan QR / pairing code di gateway WAHA (WhatsApp → Linked devices) untuk menyelesaikan pairing.',
        },
        201,
      );
    },
  )

  /* ── Refresh QR pairing WhatsApp BYO ───────────────────────
   *
   * Alur (spec docs/bring-your-own-whatsapp.md §5): setup membuat session
   * (health 'connecting') — QR diambil di sini dan ditampilkan UI dengan
   * countdown. Health transition:
   *   connecting ──refresh (SCAN_QR_CODE)──▶ connecting + QR segar
   *   connecting ──countdown habis──▶ qr-expired (body { expired: true })
   *   qr-expired ──refresh──▶ connecting + QR segar
   *   (kapan saja) ──gateway WORKING──▶ connected (pairing selesai)
   * Body opsional { expired: true } = UI melaporkan QR lama kadaluarsa —
   * hanya persist transisi, tanpa probe gateway.
   *
   * Auto-recovery: session yang BERHENTI (STOPPED/FAILED — QR kadaluarsa
   * tanpa scan, atau setelah gateway restart) menolak auth/qr (422/404).
   * Refresh memulai ulang session (POST /api/sessions/{session}/start,
   * path WAHA 2026.x) lalu mengambil QR — pairing lanjut tanpa re-setup.
   * Session yang hilang total dari gateway (start 404) → 400 dengan ajakan
   * hubungkan ulang.
   */
  .post(
    '/whatsapp/waha/refresh-qr',
    requireAuth,
    requireWorkspace,
    zValidator('json', z.object({ expired: z.boolean().optional() })),
    async (c) => {
      const workspaceId = c.get('workspaceId');
      const { expired } = c.req.valid('json');

      const [channel] = await db
        .select()
        .from(workspaceChannels)
        .where(
          and(
            eq(workspaceChannels.workspaceId, workspaceId),
            eq(workspaceChannels.channelType, 'whatsapp'),
          ),
        )
        .limit(1);
      const config = (channel?.providerConfig ?? {}) as Record<string, unknown>;
      if (!channel || config.provider !== 'waha') {
        return c.json({ error: 'Channel WhatsApp BYO belum dikonfigurasi.' }, 404);
      }
      if (!channel.isActive) {
        return c.json({ error: 'Channel WhatsApp sedang dijeda — aktifkan dulu untuk pairing.' }, 400);
      }
      const baseUrl = config.baseUrl;
      const gatewayApiKey = config.gatewayApiKey;
      const sessionName = config.sessionName;
      if (
        typeof baseUrl !== 'string' ||
        baseUrl.length === 0 ||
        typeof gatewayApiKey !== 'string' ||
        gatewayApiKey.length === 0 ||
        typeof sessionName !== 'string' ||
        sessionName.length === 0
      ) {
        return c.json({ error: 'Konfigurasi channel WhatsApp BYO tidak lengkap.' }, 400);
      }

      const persistHealth = async (
        state: 'connecting' | 'qr-expired' | 'connected',
        identifier: string | null = channel.identifier,
      ) => {
        const prev = (config.health ?? {}) as Record<string, unknown>;
        const providerConfig = {
          ...config,
          health: {
            ...prev,
            state,
            lastStatusAt: new Date().toISOString(),
            lastSeenAt:
              state === 'connected' ? new Date().toISOString() : (prev.lastSeenAt ?? null),
          },
        };
        await db
          .insert(workspaceChannels)
          .values({
            workspaceId,
            channelType: 'whatsapp',
            identifier,
            providerConfig,
            isActive: channel.isActive,
          })
          .onConflictDoUpdate({
            target: [workspaceChannels.workspaceId, workspaceChannels.channelType],
            set: {
              identifier,
              providerConfig,
              updatedAt: new Date(),
            },
          })
          .returning({ id: workspaceChannels.id });
      };

      if (expired) {
        await persistHealth('qr-expired');
        return c.json({ qr: null, healthState: 'qr-expired', sessionName });
      }

      // Ambil QR pairing. Bila session TIDAK berjalan (STOPPED setelah QR
      // kadaluarsa tanpa scan / setelah gateway restart), WAHA menolak
      // auth/qr (422/404). Mulai session dulu (POST start), tunggu transisi,
      // lalu ambil QR — pairing lanjut tanpa re-setup.
      let qr: Awaited<ReturnType<typeof wahaGetQr>> | null = null;
      let qrError: WahaApiError | null = null;
      try {
        qr = await wahaGetQr({ baseUrl, apiKey: gatewayApiKey, session: sessionName });
      } catch (error) {
        if (error instanceof WahaApiError) {
          qrError = error;
        } else {
          throw error;
        }
      }

      // WAHA baru mengembalikan QR sebagai PNG mentah TANPA status session
      // (wahaGetQr → status null). Probe wahaGetSession untuk membedakan
      // WORKING (pairing selesai) dari SCAN_QR_CODE (masih menunggu scan).
      let sessionStatus = qr?.status ?? null;
      if (!sessionStatus) {
        try {
          const session = await wahaGetSession(baseUrl, gatewayApiKey, sessionName);
          sessionStatus = session?.status ?? sessionStatus;
        } catch (error) {
          // Gagal probe bukan bencana — QR tetap bisa ditampilkan;
          // watchdog/webhook yang menetapkan connected. Error tak dikenal
          // tetap di-rethrow (konvensi file); WahaApiError hanya dicatat.
          if (error instanceof WahaApiError) {
            console.warn('[channels] gagal probe session status:', error.message);
          } else {
            throw error;
          }
        }
      }

      // Session berhenti → hidupkan dulu agar QR tersedia lagi. FAILED sengaja
      // TIDAK dipicu: bisa menandakan pemblokiran, dan docs melarang restart/
      // re-pair untuk "memperbaiki" ban — UI sudah menyembunyikan Show QR saat
      // health banned; guard di bawah memperkuatnya di level API.
      const storedHealthState = (config.health as { state?: string } | undefined)?.state;
      if (
        !qr &&
        (sessionStatus === 'STOPPED' || sessionStatus === 'DISCONNECTED') &&
        storedHealthState !== 'banned'
      ) {
        try {
          const started = await wahaStartSession(baseUrl, gatewayApiKey, sessionName);
          sessionStatus = started.status;
          // Poll status sesaat sampai SCAN_QR_CODE (start bisa transit STARTING
          // dulu) — paling lama ~5 detik, bukan sleep buta, agar recovery satu
          // kali langsung jadi.
          const deadline = Date.now() + 5000;
          while (sessionStatus !== 'SCAN_QR_CODE' && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            try {
              const s = await wahaGetSession(baseUrl, gatewayApiKey, sessionName);
              sessionStatus = s?.status ?? sessionStatus;
            } catch {
              break; // probe gagal → coba ambil QR langsung
            }
          }
          qr = await wahaGetQr({ baseUrl, apiKey: gatewayApiKey, session: sessionName });
        } catch (error) {
          if (error instanceof WahaApiError) {
            // Session benar-benar hilang dari gateway (mis. dihapus manual di
            // dashboard) → arahkan user untuk re-connect, bukan error mentah.
            if (error.status === 404) {
              return c.json(
                { error: 'Sesi gateway tidak ditemukan — putuskan lalu hubungkan ulang nomor Anda.' },
                400,
              );
            }
            return c.json({ error: error.message }, 400);
          }
          throw error;
        }
      }

      // QR tetap gagal walau session sudah di-start — tampilkan error asli
      // (atau pesan generik bila tidak ada detail).
      if (!qr) {
        return c.json({ error: qrError?.message ?? 'Gagal mengambil QR pairing.' }, 400);
      }

      // Session sudah WORKING → pairing selesai; QR tidak relevan lagi.
      // Identifier (nomor sendiri) diambil dari gateway untuk badge kartu.
      if (sessionStatus === 'WORKING') {
        const me = await wahaGetMe(baseUrl, gatewayApiKey, sessionName).catch(() => null);
        const identifier = me?.id ? chatIdToWaId(me.id) : channel.identifier;
        await persistHealth('connected', identifier);
        return c.json({ qr: null, healthState: 'connected', sessionName });
      }

      // SCAN_QR_CODE (atau status lain dengan QR tersedia) → QR segar.
      await persistHealth('connecting');
      return c.json({
        qr: { url: qr.url, expected: qr.expected, ttl: qr.ttl },
        healthState: 'connecting',
        sessionName,
      });
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
                // HTTPS publik wajib — gagal cepat sebelum memanggil Telegram.
                assertPublicHttpsWebhookUrl(webhookUrlFor(c.get('workspaceId'), 'telegram'));
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
            if (error instanceof WebhookUrlError) {
              return c.json({ error: error.message }, 400);
            }
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
