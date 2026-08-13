import type { VapiClient } from '@vapi-ai/server-sdk';

import { TelnyxApiError, toE164, type TelnyxClient, type TelnyxNumberResult } from '../services/telnyx.ts';
import { createTelnyxCredential, findTelnyxCredentialByName } from '../services/vapi-credential.ts';
import { registerTelnyxNumberInVapi } from '../services/telnyx-vapi.ts';

/**
 * Mode "Bring your own carrier" (BYOC) — fase-2 di balik kartu Voice AI.
 *
 * Workspace menempel API key Telnyx milik MEREKA SENDIRI, lalu:
 *   1. SEARCH  — lihat nomor yang sudah mereka miliki + nomor tersedia
 *                untuk dibeli (read-only, tidak ada pembelian).
 *   2. CONNECT — buat kredensial Telnyx DI SISI VAPI (atas nama akun Vapi
 *                operator) dengan API key workspace → beli nomor pilihan
 *                bila belum dimiliki → daftarkan nomor ke Vapi dengan
 *                kredensial itu → simpan pilihan per-workspace.
 *
 * Keamanan: API key Telnyx hanya dipakai SELAMA request (membuat credential
 * di Vapi + memvalidasi kepemilikan nomor) — TIDAK pernah disimpan di DB.
 * Vapi memegangnya (dibutuhkan untuk dial keluar); database kita hanya
 * menyimpan referensi non-secret: vapiPhoneNumberId, vapiCredentialId,
 * nomor, dan mode.
 *
 * Idempotensi: credential diadopsi dari baris integrasi yang sudah ada atau
 * dicari berdasarkan nama deterministik (`oriole-byoc-<workspaceId>`) — retry
 * / crash di tengah jalan tidak menggandakan credential. Nomor didaftarkan
 * list-then-create oleh registerTelnyxNumberInVapi. Pembelian tidak pernah
 * dua kali: cek kepemilikan dulu, dan 422 dari Telnyx (sudah dimiliki /
 * tidak tersedia) diverifikasi ulang sebelum melanjutkan.
 */

export interface TelnyxByocSearchInput {
  /** Klien Telnyx yang dibangun dengan API key workspace. */
  telnyx: TelnyxClient;
  /** Negara pencarian (ISO 3166-1 alpha-2). */
  countryCode: string;
  /** Kode area opsional untuk mempersempit pencarian. */
  areaCode?: string;
}

export interface TelnyxByocSearchResult {
  /** Nomor yang SUDAH dimiliki akun Telnyx ini (connect tanpa membeli). */
  owned: TelnyxNumberResult[];
  /** Nomor tersedia untuk dibeli (connect akan membeli). */
  available: TelnyxNumberResult[];
}

/** Cari nomor BYO: daftar kepemilikan (validasi key) + inventory tersedia. */
export async function searchTelnyxByoc(input: TelnyxByocSearchInput): Promise<TelnyxByocSearchResult> {
  const [owned, available] = await Promise.all([
    input.telnyx.listOwnedNumbers(),
    input.telnyx.searchAvailableNumbers({ countryCode: input.countryCode, areaCode: input.areaCode, limit: 20 }),
  ]);
  const ownedSet = new Set(owned.map((n) => n.phoneNumber));
  return {
    owned,
    available: available.filter((n) => !ownedSet.has(n.phoneNumber)),
  };
}

/** Nomor tidak tersedia untuk dibeli di akun Telnyx ini (bukan milik sendiri). */
export class TelnyxByocNumberUnavailableError extends Error {
  constructor(number: string) {
    super(
      `Nomor ${number} tidak tersedia untuk dibeli di akun Telnyx ini. Pilih nomor dari daftar milik Anda atau daftar tersedia.`,
    );
    this.name = 'TelnyxByocNumberUnavailableError';
  }
}

export interface ConnectTelnyxByocInput {
  /** Klien Telnyx yang dibangun dengan API key workspace. */
  telnyx: TelnyxClient;
  /** Klien Vapi operator (VAPI_API_KEY). */
  vapi: VapiClient;
  /** API key Telnyx workspace — dipakai membuat credential di Vapi, tidak disimpan. */
  apiKey: string;
  /** Id credential dari baris integrasi yang sudah ada (idempotensi retry). */
  existingCredentialId?: string | null;
  /** Nama deterministik credential per workspace: `oriole-byoc-<workspaceId>`. */
  credentialName: string;
  /** Nomor pilihan (E.164) — boleh sudah dimiliki atau dari daftar tersedia. */
  phoneNumber: string;
}

export interface ConnectTelnyxByocResult {
  /** Id kredensial Telnyx di sisi Vapi (referensi internal, bukan secret). */
  vapiCredentialId: string;
  /** Id nomor di Vapi — dipakai pemanggilan keluar (VAPI_PHONE_NUMBER_ID setara). */
  vapiPhoneNumberId: string;
  /** Nomor E.164 yang dipakai. */
  telnyxNumber: string;
  /** true bila nomor baru DIBELI pada run ini. */
  purchased: boolean;
  /** true bila nomor baru DIDAFTARKAN ke Vapi pada run ini. */
  registered: boolean;
}

export async function connectTelnyxByoc(input: ConnectTelnyxByocInput): Promise<ConnectTelnyxByocResult> {
  const telnyxNumber = toE164(input.phoneNumber);

  // 1. OWNERSHIP dulu — memvalidasi API key Telnyx (list kepemilikan menolak
  //    key tidak valid) dan menentukan apakah perlu beli. Key yang salah
  //    gagal cepat SEBELUM membuat kredensial di Vapi (tidak ada orphan).
  //    Telnyx menolak membeli nomor yang sudah dimiliki (422) — diverifikasi
  //    ulang dengan list kepemilikan supaya nomor milik ORANG LAIN (tidak
  //    tersedia untuk dibeli) tidak lolos sebagai "sudah milik sendiri".
  let purchased = false;
  const owned = await input.telnyx.listOwnedNumbers();
  if (!owned.some((n) => n.phoneNumber === telnyxNumber)) {
    try {
      await input.telnyx.orderNumber(telnyxNumber);
      purchased = true;
    } catch (err) {
      if (err instanceof TelnyxApiError && err.status === 422) {
        const after = await input.telnyx.listOwnedNumbers();
        if (!after.some((n) => n.phoneNumber === telnyxNumber)) {
          throw new TelnyxByocNumberUnavailableError(telnyxNumber);
        }
        // Sudah jadi milik akun ini (race antar attempt) — lanjut tanpa beli.
      } else {
        throw err;
      }
    }
  }

  // 2. CREDENTIAL — reuse dari baris / adopsi orphan by name / buat baru.
  let credentialId = input.existingCredentialId ?? null;
  if (!credentialId) {
    const existing = await findTelnyxCredentialByName(input.vapi, input.credentialName);
    credentialId = existing?.id ?? null;
  }
  if (!credentialId) {
    const created = await createTelnyxCredential({
      vapi: input.vapi,
      apiKey: input.apiKey,
      name: input.credentialName,
    });
    credentialId = created.id;
  }

  // 3. REGISTER di Vapi (list-then-create, idempotent).
  const registered = await registerTelnyxNumberInVapi({
    vapi: input.vapi,
    telnyxNumber,
    credentialId,
    name: `oriole-byoc-${telnyxNumber}`,
  });

  return {
    vapiCredentialId: credentialId,
    vapiPhoneNumberId: registered.vapiPhoneNumberId,
    telnyxNumber,
    purchased,
    registered: registered.created,
  };
}
