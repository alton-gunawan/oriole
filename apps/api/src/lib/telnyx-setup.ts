import type { VapiClient } from '@vapi-ai/server-sdk';

import { toE164, type TelnyxClient } from '../services/telnyx.ts';
import { registerTelnyxNumberInVapi } from '../services/telnyx-vapi.ts';

/**
 * Orkestrator setup nomor Telnyx (BYO) untuk Vapi — idempotent & aman
 * dijalankan ulang (skrip `pnpm setup:telnyx`):
 *
 *   1. RESOLVE — tentukan nomor: pakai `preferredNumber` (bila diisi) atau
 *      cari di inventory Telnyx (`countryCode` / `areaCode`).
 *   2. PURCHASE — kalau nomor belum dimiliki akun, beli lewat number order.
 *      Tidak pernah membeli dua kali: cek kepemilikan dulu.
 *   3. REGISTER — daftarkan nomor ke Vapi (list-then-create, idempotent)
 *      supaya bisa dipakai sebagai VAPI_PHONE_NUMBER_ID.
 *
 * Dry-run (`dryRun: true`) hanya membaca (search/list) dan mengembalikan
 * rencana — TIDAK ada pembelian/registrasi. Ini pengaman penting karena
 * membeli nomor = biaya riil.
 *
 * Langkah manual yang TIDAK bisa diautomasi (sesuai dokumentasi resmi Vapi +
 * Telnyx): buat kredensial Telnyx di dashboard Vapi sekali (VAPI_TELNYX_CREDENTIAL_ID),
 * dan konfigurasi Outbound Voice Profile Telnyx (destinasi + attach koneksi
 * Vapi) untuk panggilan keluar. Lihat docs/deployment.md.
 */

export interface TelnyxSetupInput {
  /** Klien Telnyx (lihat services/telnyx.ts). */
  telnyx: TelnyxClient;
  /** Klien Vapi dengan VAPI_API_KEY. */
  vapi: VapiClient;
  /** ID kredensial Telnyx di sisi Vapi (wajib — dibikin manual di dashboard). */
  credentialId: string;
  /** Nomor pilihan E.164. Kosong → cari & beli dari inventory. */
  preferredNumber?: string;
  /** Negara pencarian (ISO 3166-1 alpha-2). Dipakai hanya bila tanpa preferredNumber. */
  countryCode: string;
  /** Kode area opsional untuk pencarian. */
  areaCode?: string;
  /** Jangan beli/daftarkan — hanya bacakan rencana. */
  dryRun?: boolean;
}

export type TelnyxSetupResult =
  | {
      status: 'registered';
      telnyxNumber: string;
      vapiPhoneNumberId: string;
      /** true bila nomor baru dibeli pada run ini. */
      purchased: boolean;
      /** true bila nomor baru didaftarkan ke Vapi pada run ini. */
      registered: boolean;
      orderStatus?: string;
    }
  | {
      status: 'already-configured';
      telnyxNumber: string;
      vapiPhoneNumberId: string;
      purchased: false;
      registered: false;
    }
  | {
      status: 'dry-run';
      telnyxNumber: string;
      vapiPhoneNumberId: null;
      purchased: boolean;
      registered: boolean;
    };

export async function runTelnyxSetup(input: TelnyxSetupInput): Promise<TelnyxSetupResult> {
  if (!input.credentialId) {
    throw new Error(
      'VAPI_TELNYX_CREDENTIAL_ID wajib diisi — buat kredensial Telnyx di dashboard.vapi.ai (Keys) dengan menempel TELNYX_API_KEY, lalu setel id-nya di .env.',
    );
  }

  // RESOLVE + PURCHASE
  const owned = await input.telnyx.listOwnedNumbers();
  const ownedSet = new Set(owned.map((n) => n.phoneNumber));

  let telnyxNumber: string;
  let purchased = false;
  let orderStatus: string | undefined;

  if (input.preferredNumber) {
    telnyxNumber = toE164(input.preferredNumber);
    if (ownedSet.has(telnyxNumber)) {
      // Sudah dimiliki — tidak perlu beli.
    } else {
      if (input.dryRun) {
        return { status: 'dry-run', telnyxNumber, vapiPhoneNumberId: null, purchased: true, registered: true };
      }
      const order = await input.telnyx.orderNumber(telnyxNumber);
      purchased = true;
      orderStatus = order.status;
    }
  } else {
    const candidates = await input.telnyx.searchAvailableNumbers({
      countryCode: input.countryCode,
      areaCode: input.areaCode,
      limit: 10,
    });
    if (candidates.length === 0) {
      throw new Error(
        `Tidak ada nomor Telnyx voice-capable tersedia untuk negara ${input.countryCode.toUpperCase()}${input.areaCode ? ` / area code ${input.areaCode}` : ''}.`,
      );
    }
    telnyxNumber = candidates[0].phoneNumber;
    if (input.dryRun) {
      return { status: 'dry-run', telnyxNumber, vapiPhoneNumberId: null, purchased: true, registered: true };
    }
    const order = await input.telnyx.orderNumber(telnyxNumber);
    purchased = true;
    orderStatus = order.status;
  }

  // REGISTER (idempotent) — dry-run sudah return di atas.
  const registered = await registerTelnyxNumberInVapi({
    vapi: input.vapi,
    telnyxNumber,
    credentialId: input.credentialId,
    name: `oriole-telnyx-${telnyxNumber}`,
  });

  if (!purchased && !registered.created) {
    return {
      status: 'already-configured',
      telnyxNumber,
      vapiPhoneNumberId: registered.vapiPhoneNumberId,
      purchased: false,
      registered: false,
    };
  }

  return {
    status: 'registered',
    telnyxNumber,
    vapiPhoneNumberId: registered.vapiPhoneNumberId,
    purchased,
    registered: registered.created,
    ...(orderStatus ? { orderStatus } : {}),
  };
}
