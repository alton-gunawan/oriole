import { env } from '../lib/env.ts';

/**
 * Meta WhatsApp Business Platform client (Graph API) — Tech Provider.
 *
 * Alur resmi Embedded Signup:
 *   1. `buildMetaWhatsappSignupUrl` → dialog URL yang dibuka di UI Meta.
 *   2. Meta redirect → `exchangeWhatsappCode` (GET /oauth/access_token)
 *      → business integration system user access token ("business token").
 *   3. `resolveWabaIdByToken` (GET /debug_token, auth = SYSTEM USER token)
 *      → WABA ID dari granular_scopes.whatsapp_business_management.
 *   4. `getWabaPhoneNumbers` → Phone Number ID + display number + verified name.
 *   5. `subscribeAppToWaba` (POST /{waba}/subscribed_apps) + `registerPhoneNumber`.
 *   6. Outbound: `metaSendMessage` (POST /{phone_number_id}/messages).
 *
 * Semua panggilan server-to-server — token tenant TIDAK pernah ke frontend.
 */

const GRAPH_BASE = `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}`;

export class MetaWhatsAppApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'MetaWhatsAppApiError';
  }
}

/** Bangun URL dialog Embedded Signup (pure — diuji unit). */
export function buildMetaWhatsappSignupUrl(input: {
  version: string;
  appId: string;
  configId: string;
  state: string;
  redirectUri: string;
}): string {
  const params = new URLSearchParams({
    app_id: input.appId,
    config_id: input.configId,
    state: input.state,
    redirect_uri: input.redirectUri,
  });
  return `https://www.facebook.com/${input.version}/dialog/whatsapp_business_signup?${params.toString()}`;
}

async function graphJson(
  path: string,
  init: RequestInit & { token?: string },
): Promise<Record<string, unknown>> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('authorization', `Bearer ${init.token}`);
  const res = await fetch(`${GRAPH_BASE}${path}`, { ...init, headers });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Beberapa endpoint (oauth/access_token) membalas token polos — caller khusus.
  }
  if (!res.ok) {
    const error = json.error as { message?: string; code?: number } | undefined;
    throw new MetaWhatsAppApiError(
      error?.message ?? `Meta Graph API ${res.status}: ${text.slice(0, 200)}`,
      res.status,
      error?.code,
    );
  }
  return json;
}

/** Tukar `code` hasil Embedded Signup → business token (respons teks polos). */
export async function exchangeWhatsappCode(input: {
  appId: string;
  appSecret: string;
  code: string;
}): Promise<string> {
  const params = new URLSearchParams({
    client_id: input.appId,
    client_secret: input.appSecret,
    code: input.code,
  });
  const res = await fetch(`${GRAPH_BASE}/oauth/access_token?${params.toString()}`);
  const text = await res.text();
  if (!res.ok) {
    let message = `Meta oauth gagal (${res.status})`;
    try {
      const json = JSON.parse(text) as { error?: { message?: string; code?: number } };
      if (json.error?.message) message = json.error.message;
    } catch {
      // respons non-JSON — pakai pesan generik.
    }
    throw new MetaWhatsAppApiError(message, res.status);
  }
  // Meta membalas access token sebagai teks polos, bukan JSON.
  const token = text.trim();
  if (!token) throw new MetaWhatsAppApiError('Meta tidak mengembalikan access token.');
  return token;
}

/**
 * Resolve WABA ID terbaru yang dishare ke app dari business token.
 * Memakai GET /debug_token (auth = SYSTEM USER token platform) dan membaca
 * `granular_scopes` scope `whatsapp_business_management` → `target_ids[0]`.
 */
export async function resolveWabaIdByToken(input: {
  systemUserToken: string;
  businessToken: string;
}): Promise<string | null> {
  const json = await graphJson(`/debug_token?input_token=${encodeURIComponent(input.businessToken)}`, {
    token: input.systemUserToken,
  });
  const data = json.data as
    | { granular_scopes?: { scope?: string; target_ids?: string[] }[] }
    | undefined;
  const management = data?.granular_scopes?.find((s) => s.scope === 'whatsapp_business_management');
  const first = management?.target_ids?.[0];
  return typeof first === 'string' && first.length > 0 ? first : null;
}

export interface MetaWhatsAppPhoneNumber {
  id: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  qualityRating: string | null;
  codeVerificationStatus: string | null;
  nameStatus: string | null;
}

/** Daftar nomor pada sebuah WABA (GET /{waba}/phone_numbers). */
export async function getWabaPhoneNumbers(input: {
  businessToken: string;
  wabaId: string;
}): Promise<MetaWhatsAppPhoneNumber[]> {
  const json = await graphJson(
    `/${encodeURIComponent(input.wabaId)}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status,name_status`,
    { token: input.businessToken },
  );
  const rows = (json.data ?? []) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: typeof row.id === 'string' ? row.id : '',
    displayPhoneNumber:
      typeof row.display_phone_number === 'string' ? row.display_phone_number : null,
    verifiedName: typeof row.verified_name === 'string' ? row.verified_name : null,
    qualityRating: typeof row.quality_rating === 'string' ? row.quality_rating : null,
    codeVerificationStatus:
      typeof row.code_verification_status === 'string' ? row.code_verification_status : null,
    nameStatus: typeof row.name_status === 'string' ? row.name_status : null,
  }));
}

/** Info WABA (nama bisnis) — GET /{waba}?fields=name. */
export async function getWabaInfo(input: {
  businessToken: string;
  wabaId: string;
}): Promise<{ name: string | null }> {
  const json = await graphJson(`/${encodeURIComponent(input.wabaId)}?fields=name`, {
    token: input.businessToken,
  });
  return { name: typeof json.name === 'string' ? json.name : null };
}

/** Subscribe app platform ke webhook WABA tenant (POST /{waba}/subscribed_apps). */
export async function subscribeAppToWaba(input: {
  businessToken: string;
  wabaId: string;
}): Promise<void> {
  await graphJson(`/${encodeURIComponent(input.wabaId)}/subscribed_apps`, {
    method: 'POST',
    token: input.businessToken,
  });
}

/** Register nomor untuk Cloud API (POST /{phone_number_id}/register). */
export async function registerPhoneNumber(input: {
  businessToken: string;
  phoneNumberId: string;
  pin: string;
}): Promise<void> {
  await graphJson(`/${encodeURIComponent(input.phoneNumberId)}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    token: input.businessToken,
    body: JSON.stringify({ messaging_product: 'whatsapp', pin: input.pin }),
  });
}

/** Kirim pesan via Messages API (POST /{phone_number_id}/messages) → wamid. */
export async function metaSendMessage(input: {
  businessToken: string;
  phoneNumberId: string;
  body: Record<string, unknown>;
}): Promise<{ messageId: string | null }> {
  const json = await graphJson(`/${encodeURIComponent(input.phoneNumberId)}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    token: input.businessToken,
    body: JSON.stringify(input.body),
  });
  const messages = (json.messages ?? []) as { id?: string }[];
  return { messageId: messages[0]?.id ?? null };
}
