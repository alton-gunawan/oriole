import { VapiClient } from '@vapi-ai/server-sdk';
import { loadRootEnv } from '@oriole/config';

import { runTelnyxSetup } from '../lib/telnyx-setup.ts';
import { createTelnyxClient } from '../services/telnyx.ts';

/**
 * CLI: provision nomor Telnyx (BYO) dan daftarkan ke Vapi.
 *
 *   pnpm --filter @oriole/api setup:telnyx \
 *     [--number +6281234567890] \   # nomor pilihan (E.164); kosong = cari & beli
 *     [--country ID] \              # negara pencarian (default TELNYX_COUNTRY_CODE / US)
 *     [--area-code 21] \            # kode area opsional
 *     [--dry-run]                   # hanya rencana — tidak membeli/mendaftarkan
 *
 * Butuh env: TELNYX_API_KEY, VAPI_API_KEY, VAPI_TELNYX_CREDENTIAL_ID.
 * Idempotent — aman dijalankan ulang (tidak membeli nomor dua kali).
 *
 * SETELAH script sukses, konfigurasi manual SATU KALI di portal Telnyx:
 * Outbound Voice Profiles → buat/edit profil → enable destinasi (mis. ID) →
 * attach koneksi yang dipakai Vapi. Tanpa ini panggilan keluar gagal.
 */

function readArg(flag: string): string | undefined {
  const prefix = `--${flag}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
}

async function main(): Promise<void> {
  loadRootEnv();

  const telnyxApiKey = process.env.TELNYX_API_KEY;
  const vapiApiKey = process.env.VAPI_API_KEY;
  const credentialId = process.env.VAPI_TELNYX_CREDENTIAL_ID;

  if (!telnyxApiKey) {
    console.error('TELNYX_API_KEY wajib diisi di .env (API key v2 dari portal.telnyx.com).');
    process.exit(1);
  }
  if (!vapiApiKey) {
    console.error('VAPI_API_KEY wajib diisi di .env (dashboard.vapi.ai → API Keys).');
    process.exit(1);
  }
  if (!credentialId) {
    console.error(
      'VAPI_TELNYX_CREDENTIAL_ID wajib diisi di .env — buat kredensial Telnyx SEKALI di ' +
        'dashboard.vapi.ai (Keys → buat credential Telnyx, tempel TELNYX_API_KEY), lalu setel id-nya.',
    );
    process.exit(1);
  }

  const preferredNumber = readArg('number') ?? process.env.TELNYX_PHONE_NUMBER;
  const countryCode = (readArg('country') ?? process.env.TELNYX_COUNTRY_CODE ?? 'US').toUpperCase();
  const areaCode = readArg('area-code');
  const dryRun = process.argv.includes('--dry-run');

  console.log(`→ Telnyx setup ${dryRun ? '(DRY-RUN — tidak ada pembelian/registrasi)' : ''}`);
  if (preferredNumber) console.log(`  Nomor pilihan : ${preferredNumber}`);
  else console.log(`  Pencarian     : negara ${countryCode}${areaCode ? `, area code ${areaCode}` : ''}`);

  const result = await runTelnyxSetup({
    telnyx: createTelnyxClient(telnyxApiKey),
    vapi: new VapiClient({ token: vapiApiKey }),
    credentialId,
    preferredNumber,
    countryCode,
    areaCode,
    dryRun,
  });

  if (result.status === 'dry-run') {
    console.log('\n📋 Rencana (dry-run, belum dieksekusi):');
    console.log(`   Beli nomor Telnyx   : ${result.telnyxNumber}`);
    console.log(`   Daftarkan ke Vapi   : ya (VAPI_TELNYX_CREDENTIAL_ID=${credentialId})`);
    console.log('\nJalankan tanpa --dry-run untuk mengeksekusi.');
    return;
  }

  if (result.status === 'already-configured') {
    console.log(`\n✅ Sudah terkonfigurasi: nomor ${result.telnyxNumber} sudah dimiliki & terdaftar di Vapi.`);
    console.log(`   VAPI_PHONE_NUMBER_ID=${result.vapiPhoneNumberId}`);
    return;
  }

  console.log(`\n✅ Nomor Telnyx siap dipakai Vapi: ${result.telnyxNumber}`);
  if (result.orderStatus) console.log(`   Order Telnyx status: ${result.orderStatus} (nomor internasional bisa butuh beberapa saat untuk aktif)`);
  console.log(`   Registrasi Vapi     : ${result.registered ? 'baru' : 'sudah ada'}`);
  console.log('\nTambahkan ke .env:');
  console.log(`   VAPI_PHONE_NUMBER_ID=${result.vapiPhoneNumberId}`);
  console.log(`   TELNYX_PHONE_NUMBER=${result.telnyxNumber}`);
  console.log(
    '\n⚠️  Langkah manual terakhir (sekali saja) di portal.telnyx.com:\n' +
      '   Voice → Outbound Voice Profiles → enable destinasi yang dituju (mis. ID) →\n' +
      '   tambahkan koneksi yang dipakai Vapi ke profil. Tanpa ini panggilan keluar gagal.\n',
  );
}

main().catch((err) => {
  console.error(`\n✗ Setup Telnyx gagal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
