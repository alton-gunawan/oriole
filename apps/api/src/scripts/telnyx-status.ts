import { VapiClient } from '@vapi-ai/server-sdk';
import { loadRootEnv } from '@oriole/config';

import { createTelnyxClient, TelnyxNotConfiguredError } from '../services/telnyx.ts';

/**
 * CLI: status integrasi Telnyx (BYO) + Vapi — untuk ops.
 *
 *   pnpm --filter @oriole/api telnyx:status
 *
 * Menampilkan: nomor Telnyx yang dimiliki, nomor Telnyx yang terdaftar di
 * Vapi, dan apakah VAPI_PHONE_NUMBER_ID saat ini cocok dengan salah satunya.
 */

async function main(): Promise<void> {
  loadRootEnv();

  const vapiPhoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
  console.log('── Telnyx (BYO) + Vapi — status ──────────────────────────');

  // 1) Nomor Telnyx yang dimiliki.
  const telnyxApiKey = process.env.TELNYX_API_KEY;
  if (!telnyxApiKey) {
    console.log('TELNYX_API_KEY     : (kosong — Telnyx tidak dikonfigurasi)');
  } else {
    try {
      const telnyx = createTelnyxClient(telnyxApiKey);
      const owned = await telnyx.listOwnedNumbers();
      console.log(`Nomor Telnyx dimiliki: ${owned.length}`);
      for (const n of owned) {
        console.log(`  - ${n.phoneNumber}${n.connectionId ? ` (connection ${n.connectionId})` : ' (belum di-assign ke koneksi)'}`);
      }
    } catch (err) {
      console.error(`✗ Gagal membaca nomor Telnyx: ${err instanceof Error ? err.message : err}`);
    }
  }

  // 2) Nomor Telnyx yang terdaftar di Vapi.
  const vapiApiKey = process.env.VAPI_API_KEY;
  if (!vapiApiKey) {
    console.log('VAPI_API_KEY       : (kosong — Vapi tidak dikonfigurasi)');
  } else {
    try {
      const vapi = new VapiClient({ token: vapiApiKey });
      const numbers = await vapi.phoneNumbers.list({ limit: 100 });
      const telnyxNumbers = numbers.filter((n) => n.provider === 'telnyx');
      console.log(`Nomor Telnyx di Vapi: ${telnyxNumbers.length}`);
      for (const n of telnyxNumbers) {
        const active = n.id === vapiPhoneNumberId ? '  ← VAPI_PHONE_NUMBER_ID aktif' : '';
        console.log(`  - ${n.number} (id ${n.id})${active}`);
      }
    } catch (err) {
      console.error(`✗ Gagal membaca nomor Vapi: ${err instanceof Error ? err.message : err}`);
    }
  }

  // 3) Kecocokan dengan VAPI_PHONE_NUMBER_ID.
  if (vapiPhoneNumberId) {
    console.log(`\nVAPI_PHONE_NUMBER_ID: ${vapiPhoneNumberId}`);
    if (!vapiApiKey) {
      console.log('  (VAPI_API_KEY kosong — tidak bisa diverifikasi)');
    }
  } else {
    console.log('\nVAPI_PHONE_NUMBER_ID: (kosong — panggilan keluar nonaktif)');
  }
}

main().catch((err) => {
  if (err instanceof TelnyxNotConfiguredError) {
    console.error('Telnyx belum dikonfigurasi (TELNYX_API_KEY kosong).');
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
