import type { VapiClient } from '@vapi-ai/server-sdk';

/**
 * Registrasi nomor Telnyx (BYO) ke Vapi — idempotent.
 *
 * Vapi mengimpor nomor Telnyx dengan `provider: 'telnyx'` + `credentialId`
 * (kredensial Telnyx yang dibuat di dashboard Vapi — lihat env
 * VAPI_TELNYX_CREDENTIAL_ID). Panggilan keluar kemudian memakai
 * `phoneNumberId` (VAPI_PHONE_NUMBER_ID) seperti nomor Vapi biasa — runtime
 * API tidak perlu tahu carrier-nya.
 *
 * `vapi.phoneNumbers.create` TIDAK idempoten, jadi registrasi memakai pola
 * list-then-create: cari nomor yang sudah terdaftar (provider telnyx +
 * nomor cocok) → reuse id-nya; kalau belum ada → buat. Aman dijalankan ulang.
 */

export interface RegisterTelnyxNumberInVapiInput {
  /** Klien Vapi (harus dibuat dengan VAPI_API_KEY — BUKAN singleton `vapi`). */
  vapi: VapiClient;
  /** Nomor Telnyx E.164, contoh `+6281234567890`. */
  telnyxNumber: string;
  /** ID kredensial Telnyx di sisi Vapi (dashboard.vapi.ai → Keys). */
  credentialId: string;
  /** Label internal Vapi untuk nomor ini (opsional). */
  name?: string;
}

export interface RegisterTelnyxNumberInVapiResult {
  /** ID nomor di Vapi — pakai sebagai VAPI_PHONE_NUMBER_ID. */
  vapiPhoneNumberId: string;
  /** false bila nomor sudah terdaftar (re-run); true bila baru dibuat. */
  created: boolean;
}

/** Cari ID nomor Vapi yang sudah meregistrasikan nomor Telnyx tertentu. */
export async function findVapiPhoneNumberByTelnyx(
  vapi: VapiClient,
  telnyxNumber: string,
): Promise<string | null> {
  const numbers = await vapi.phoneNumbers.list({ limit: 100 });
  const match = numbers.find((n) => n.provider === 'telnyx' && n.number === telnyxNumber);
  return match?.id ?? null;
}

export async function registerTelnyxNumberInVapi(
  input: RegisterTelnyxNumberInVapiInput,
): Promise<RegisterTelnyxNumberInVapiResult> {
  const existing = await findVapiPhoneNumberByTelnyx(input.vapi, input.telnyxNumber);
  if (existing) {
    return { vapiPhoneNumberId: existing, created: false };
  }

  const created = await input.vapi.phoneNumbers.create({
    provider: 'telnyx',
    number: input.telnyxNumber,
    credentialId: input.credentialId,
    name: input.name,
  });
  if (created.provider !== 'telnyx') {
    throw new Error(`Vapi mengembalikan phone number provider '${created.provider}' untuk nomor Telnyx.`);
  }
  return { vapiPhoneNumberId: created.id, created: true };
}
