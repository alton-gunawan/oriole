import { loadRootEnv } from '@oriole/config';

import {
  maskMetaWhatsappSecret,
  validateMetaWhatsappEnv,
  type MetaWhatsAppValidation,
} from '../lib/meta-whatsapp-config.ts';

/**
 * CLI: validasi konfigurasi Meta WhatsApp Business (Embedded Signup — Tech
 * Provider) dan cetak langkah dashboard Meta + URL callback/webhook yang
 * PERSIS untuk ditempel.
 *
 *   pnpm --filter @oriole/api setup:whatsapp [--check]
 *
 * Tanpa --check: hanya memvalidasi env + mencetak panduan (offline, no network).
 * Dengan --check : verifikasi live ke Graph API (debug_token sistem user +
 *                  app_id) untuk memastikan token & app benar sebelum tenant
 *                  mulai connect.
 *
 * Idempotent & read-only — aman dijalankan ulang kapan saja.
 */

const GRAPH_BASE = 'https://graph.facebook.com';

/* ── Live check (--check) ─────────────────────────────────────────── */
async function checkToken(graphVersion: string, token: string): Promise<void> {
  const url = `${GRAPH_BASE}/${graphVersion}/debug_token?input_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const json = (await res.json().catch(() => ({}))) as {
    data?: {
      app_id?: string;
      type?: string;
      expires_at?: number;
      scopes?: string[];
      granular_scopes?: { scope?: string }[];
      error?: { message?: string };
    };
    error?: { message?: string };
  };
  if (!res.ok) {
    console.log(
      `   ✗ debug_token gagal (${res.status}): ${json.error?.message ?? json.data?.error?.message ?? 'lihat body'}`,
    );
    return;
  }
  const data = json.data;
  if (!data) {
    console.log('   ✗ debug_token tidak mengembalikan data.');
    return;
  }
  console.log(`   ✅ Token sistem user valid → app_id=${data.app_id ?? '?'}, tipe=${data.type ?? '?'}`);
  const scopes = data.granular_scopes?.map((s) => s.scope) ?? data.scopes ?? [];
  if (scopes.length) console.log(`      scope: ${scopes.join(', ')}`);
  const expires = Number(data.expires_at ?? 0);
  console.log(
    `      kedaluwarsa: ${expires === 0 ? 'tidak pernah (long-lived) ✓' : new Date(expires * 1000).toISOString()}`,
  );
}

async function checkApp(graphVersion: string, token: string, appId: string): Promise<void> {
  const url = `${GRAPH_BASE}/${graphVersion}/${encodeURIComponent(appId)}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const json = (await res.json().catch(() => ({}))) as { name?: string; error?: { message?: string } };
  if (res.ok && json.name) {
    console.log(`   ✅ Meta App dapat diakses → "${json.name}"`);
  } else {
    console.log(`   ✗ Meta App tidak dapat diakses (${res.status}): ${json.error?.message ?? 'periksa APP_ID & token'}`);
  }
}

/* ── Panduan dashboard ────────────────────────────────────────────── */
function printGuide(v: MetaWhatsAppValidation): void {
  console.log('\n📌 NILAI PENTING (tempel ke dashboard Meta):');
  console.log(`   App ID              : ${v.values.appId}`);
  console.log(`   Config ID           : ${v.values.configId}`);
  console.log(`   Verify token        : ${v.values.verifyToken}`);
  console.log(`   Graph API version   : ${v.values.graphVersion}`);
  console.log(`   Callback (redirect) : ${v.callbackUrl}`);
  console.log(`   Webhook URL         : ${v.webhookUrl}`);
  console.log(`   Return ke UI        : ${v.frontendReturnUrl}`);

  console.log('\n🛠️  LANGKAH DI DASHBOARD META (developers.facebook.com):');
  console.log('   1. App Dashboard → pilih Meta App platform → WhatsApp → Embedded Signup.');
  console.log('      • Buat/konfigurasi Configuration dengan Redirect URI:');
  console.log(`        ${v.callbackUrl}`);
  console.log('      • Permissions/scopes yang diminta:');
  console.log('          - whatsapp_business_management');
  console.log('          - whatsapp_business_messaging');
  console.log('          - business_management');
  console.log('      • Simpan, lalu salin Config ID → setel ke META_WHATSAPP_CONFIG_ID.');
  console.log('   2. App Dashboard → WhatsApp → Configuration → Webhook:');
  console.log(`      • Callback URL : ${v.webhookUrl}`);
  console.log(`      • Verify token : ${v.values.verifyToken}`);
  console.log('      • Subscribe field: `messages` (status/read dikirim otomatis).');
  console.log('   3. Business Settings → System Users → buat system user role Admin untuk');
  console.log('      app platform ini → Generate token (long-lived, tanpa kedaluwarsa) →');
  console.log('      setel ke META_WHATSAPP_SYSTEM_USER_TOKEN (dipakai resolve WABA ID).');
  console.log('   4. Pastikan App berada dalam mode Live (bukan Development) dan scope');
  console.log('      whatsapp_business_management lolos App Review / Advanced Access,');
  console.log('      agar tenant bisa menambahkan & memverifikasi nomor mereka.');

  console.log('\n🔁 ALUR TENANT (setelah env di atas valid):');
  console.log('   Integrations → kartu WhatsApp Business → Connect WhatsApp → dialog Meta');
  console.log('   (login, pilih/buat Business Portfolio & WABA, tambah + verifikasi nomor,');
  console.log('   izin) → Meta redirect ke callback → backend simpan WABA/nomor & subscribe');
  console.log('   webhook → kembali ke /integrations?whatsapp=connected.');
}

async function main(): Promise<void> {
  loadRootEnv();

  const check = process.argv.includes('--check');
  const v = validateMetaWhatsappEnv({
    appId: process.env.META_WHATSAPP_APP_ID,
    appSecret: process.env.META_WHATSAPP_APP_SECRET,
    configId: process.env.META_WHATSAPP_CONFIG_ID,
    verifyToken: process.env.META_WHATSAPP_VERIFY_TOKEN,
    systemUserToken: process.env.META_WHATSAPP_SYSTEM_USER_TOKEN,
    graphVersion: process.env.META_GRAPH_API_VERSION,
    apiUrl: process.env.API_URL,
    appUrl: process.env.APP_URL,
    webhookBaseUrl: process.env.WEBHOOK_BASE_URL,
  });

  console.log('→ Meta WhatsApp Business — validasi & panduan Embedded Signup (Tech Provider)');
  console.log('──────────────────────────────────────────────────────────────');
  console.log('  Env saat ini:');
  console.log(`   META_WHATSAPP_APP_ID           : ${maskMetaWhatsappSecret(v.values.appId)}`);
  console.log(`   META_WHATSAPP_APP_SECRET       : ${maskMetaWhatsappSecret(v.values.appSecret)}`);
  console.log(`   META_WHATSAPP_CONFIG_ID        : ${maskMetaWhatsappSecret(v.values.configId)}`);
  console.log(`   META_WHATSAPP_VERIFY_TOKEN     : ${maskMetaWhatsappSecret(v.values.verifyToken)}`);
  console.log(`   META_WHATSAPP_SYSTEM_USER_TOKEN: ${maskMetaWhatsappSecret(v.values.systemUserToken)}`);
  console.log(`   META_GRAPH_API_VERSION         : ${v.values.graphVersion}`);
  console.log(`   API_URL                        : ${v.values.apiUrl || '(kosong)'}`);
  console.log(`   WEBHOOK_BASE_URL               : ${process.env.WEBHOOK_BASE_URL || '(kosong → fallback API_URL)'}`);
  console.log(`   APP_URL                        : ${v.values.appUrl || '(kosong)'}`);

  if (!v.ok) {
    console.log('\n✗ VALIDASI GAGAL — perbaiki dulu di .env:');
    for (const problem of v.problems) console.log(`   - ${problem}`);
    process.exit(1);
  }

  console.log('\n✅ Env valid.');

  if (check) {
    console.log('\n🔎 Live check ke Graph API…');
    await checkToken(v.values.graphVersion, v.values.systemUserToken);
    await checkApp(v.values.graphVersion, v.values.systemUserToken, v.values.appId);
  } else {
    console.log('\n(Tanpa --check — jalankan `pnpm --filter @oriole/api setup:whatsapp --check`');
    console.log(' untuk verifikasi live token & app ke Graph API.)');
  }

  printGuide(v);

  console.log('\n✅ Selesai. Setelah langkah di atas, tenant bisa Connect dari halaman Integrations.\n');
}

main().catch((err) => {
  console.error(`\n✗ Setup Meta WhatsApp gagal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
