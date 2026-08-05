import { eq } from 'drizzle-orm';
import { loadRootEnv } from '@oriole/config';
import { createDb, workspaces, workspaceChannels } from '@oriole/database';

import { telegramSetWebhook } from '../lib/telegram.ts';

/**
 * CLI: daftarkan bot Telegram untuk sebuah workspace (multi-tenant).
 *
 *   pnpm --filter @oriole/api setup:telegram \
 *     --workspace <workspaceId> \
 *     --token <botToken> \
 *     [--secret <webhookSecret>] \
 *     [--url <webhookUrl>]
 *
 * - Upsert kredensial di tabel workspace_channels (token + secret TIDAK
 *   pernah di-expose lewat API).
 * - Mendaftarkan webhook ke api.telegram.org dengan secret_token.
 * - Bila secret tidak diberikan, dibuatkan random UUID (webhook fail-closed
 *   tanpa secret di produksi).
 *
 * Catatan: script ini sengaja TIDAK memuat validasi env API lengkap
 * (PADDLE/RESEND/CALLE tidak relevan di sini) — hanya butuh DATABASE_URL
 * dari root .env (atau env platform).
 */

function readArg(flag: string): string | undefined {
  const prefix = `--${flag}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
}

async function main(): Promise<void> {
  loadRootEnv();

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL wajib diisi (root .env atau env platform).');
    process.exit(1);
  }
  const db = createDb(databaseUrl);
  const apiUrl = process.env.API_URL ?? 'http://localhost:3000';

  const workspaceId = readArg('workspace');
  const botToken = readArg('token');
  const webhookSecret = readArg('secret');

  if (!workspaceId || !botToken) {
    console.error(
      'Pemakaian: setup:telegram --workspace <workspaceId> --token <botToken> [--secret <secret>] [--url <webhookUrl>]',
    );
    process.exit(1);
  }

  const [workspace] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!workspace) {
    console.error(`Workspace tidak ditemukan: ${workspaceId}`);
    process.exit(1);
  }

  const secret = webhookSecret ?? crypto.randomUUID();
  const webhookUrl = readArg('url') ?? `${apiUrl}/api/webhooks/telegram/${workspaceId}`;

  await db
    .insert(workspaceChannels)
    .values({
      workspaceId,
      channelType: 'telegram',
      providerConfig: { botToken, webhookSecret: secret },
      isActive: true,
    })
    .onConflictDoUpdate({
      target: [workspaceChannels.workspaceId, workspaceChannels.channelType],
      set: {
        providerConfig: { botToken, webhookSecret: secret },
        isActive: true,
        updatedAt: new Date(),
      },
    });

  await telegramSetWebhook({ token: botToken, url: webhookUrl, secretToken: secret });

  console.log(`✅ Channel Telegram workspace ${workspaceId} terkonfigurasi.`);
  console.log(`   Webhook URL : ${webhookUrl}`);
  console.log(`   Secret      : ${secret}  (dikirim Telegram via X-Telegram-Bot-Api-Secret-Token)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
