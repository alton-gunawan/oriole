/**
 * Telnyx (BYO phone number untuk Vapi) — klien REST v2 minimal.
 *
 * Kenapa REST langsung, bukan paket `telnyx` npm: ekosistem paket Telnyx
 * (npm & PyPI) kena insiden supply-chain Maret 2026 (TeamPCP / CanisterWorm).
 * Operasi yang kita butuhkan hanya 3 endpoint v2 yang stabil dan terdokumentasi:
 *   - GET  /v2/available_phone_numbers  (cari nomor tersedia)
 *   - POST /v2/number_orders            (beli nomor)
 *   - GET  /v2/phone_numbers            (daftar nomor yang dimiliki)
 * Klien ini TIDAK dipakai runtime API — hanya script provisioning/ops
 * (scripts/setup-telnyx.ts, scripts/telnyx-status.ts). Panggilan keluar tetap
 * lewat Vapi (`VAPI_PHONE_NUMBER_ID`); Telnyx hanya penyedia nomor di balik
 * layar (diimpor ke Vapi dengan kredensial Telnyx).
 */
export const TELNYX_BASE_URL = 'https://api.telnyx.com/v2';

/** Error bisnis — TELNYX_API_KEY tidak dikonfigurasi (bukan kegagalan jaringan). */
export class TelnyxNotConfiguredError extends Error {
  constructor() {
    super('Telnyx belum dikonfigurasi (TELNYX_API_KEY kosong).');
    this.name = 'TelnyxNotConfiguredError';
  }
}

/** Error dari API Telnyx — menyimpan status HTTP + pesan dari body. */
export class TelnyxApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(`Telnyx API ${status}: ${message}`);
    this.name = 'TelnyxApiError';
    this.status = status;
  }
}

/** Normalisasi ke E.164: bersihkan spasi/dash, pastikan diawali `+`. */
export function toE164(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '');
  if (!digits) throw new Error('Nomor telepon kosong setelah dibersihkan.');
  return digits.startsWith('+') ? digits : `+${digits}`;
}

export interface TelnyxNumberResult {
  /** E.164 (dengan `+`). */
  phoneNumber: string;
  /** ID internal Telnyx (ada pada nomor yang sudah dimiliki). */
  id?: string;
  /** Connection ID (bila nomor sudah di-assign ke koneksi Telnyx). */
  connectionId?: string | null;
  locality?: string | null;
}

export interface TelnyxClient {
  /**
   * Cari nomor tersedia di inventory Telnyx.
   * https://developers.telnyx.com/api-reference/phone-number-search/list-available-phone-numbers
   */
  searchAvailableNumbers(options: {
    countryCode: string;
    areaCode?: string;
    limit?: number;
  }): Promise<TelnyxNumberResult[]>;
  /** Daftar SEMUA nomor yang dimiliki akun (paginated sampai habis). */
  listOwnedNumbers(): Promise<TelnyxNumberResult[]>;
  /**
   * Beli satu nomor (number order). Gagal bila nomor sudah dimiliki.
   * https://developers.telnyx.com/api-reference/phone-number-orders/create-a-number-order
   */
  orderNumber(phoneNumber: string): Promise<{ id: string; status: string; phoneNumber: string }>;
}

type FetchLike = typeof fetch;

/**
 * Bangun klien Telnyx. `fetchImpl` bisa di-inject untuk testing.
 * Tanpa `apiKey` → semua operasi melempar TelnyxNotConfiguredError.
 */
export function createTelnyxClient(apiKey: string | undefined, fetchImpl: FetchLike = fetch): TelnyxClient {
  if (!apiKey) {
    // async → selalu mengembalikan promise yang reject (bukan throw sinkron).
    const notConfigured = async () => {
      throw new TelnyxNotConfiguredError();
    };
    return {
      searchAvailableNumbers: notConfigured,
      listOwnedNumbers: notConfigured,
      orderNumber: notConfigured,
    };
  }

  async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const url = `${TELNYX_BASE_URL}${path}`;
    const res = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      let detail = '';
      try {
        const parsed = (await res.json()) as { message?: string; errors?: Array<{ title?: string; detail?: string }> };
        detail = parsed.message ?? parsed.errors?.map((e) => e.title ?? e.detail ?? '').filter(Boolean).join('; ') ?? '';
      } catch {
        // body bukan JSON — biarkan detail kosong
      }
      throw new TelnyxApiError(res.status, detail || res.statusText);
    }
    return (await res.json()) as T;
  }

  async function searchAvailableNumbers(options: {
    countryCode: string;
    areaCode?: string;
    limit?: number;
  }): Promise<TelnyxNumberResult[]> {
    const params = new URLSearchParams({
      'filter[country_code]': options.countryCode.toUpperCase(),
      'page[size]': String(options.limit ?? 10),
    });
    if (options.areaCode) params.set('filter[area_code]', options.areaCode);
    // Hanya nomor voice-capable — panggilan keluar kita butuh voice.
    params.append('filter[features][]', 'voice');

    const data = await request<{ data: Array<{ phone_number: string; region_information?: Array<{ region_type: string; region_name: string }> }> }>(
      'GET',
      `/available_phone_numbers?${params.toString()}`,
    );
    return (data.data ?? []).map((n) => ({
      phoneNumber: n.phone_number,
      locality: n.region_information?.find((r) => r.region_type === 'locality')?.region_name ?? null,
    }));
  }

  async function listOwnedNumbers(): Promise<TelnyxNumberResult[]> {
    const all: TelnyxNumberResult[] = [];
    let pageNumber = 1;
    let totalPages = 1;
    do {
      const params = new URLSearchParams({ 'page[size]': '250', 'page[number]': String(pageNumber) });
      const data = await request<{
        data: Array<{ id: string; phone_number: string; connection_id: string | null }>;
        meta?: { total_pages?: number; page_number?: number };
      }>(`GET`, `/phone_numbers?${params.toString()}`);
      for (const n of data.data ?? []) {
        all.push({ id: n.id, phoneNumber: n.phone_number, connectionId: n.connection_id ?? null });
      }
      totalPages = data.meta?.total_pages ?? 1;
      pageNumber += 1;
    } while (pageNumber <= totalPages);
    return all;
  }

  async function orderNumber(phoneNumber: string): Promise<{ id: string; status: string; phoneNumber: string }> {
    const e164 = toE164(phoneNumber);
    const data = await request<{
      data: { id: string; status: string; phone_numbers: Array<{ phone_number: string }> };
    }>('POST', '/number_orders', { phone_numbers: [{ phone_number: e164 }] });
    return {
      id: data.data.id,
      status: data.data.status,
      phoneNumber: data.data.phone_numbers?.[0]?.phone_number ?? e164,
    };
  }

  return { searchAvailableNumbers, listOwnedNumbers, orderNumber };
}
