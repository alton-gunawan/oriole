import { createHmac, timingSafeEqual } from 'node:crypto';

/* ────────────────────────────────────────────────────────────
 * Meta (Instagram + Facebook DMs) — Graph API.
 *
 * Per-workspace: Page access token (dengan izin pages_messaging untuk
 * Messenger, atau instagram_manage_messages + instagram_business_messages
 * untuk Instagram) + page/IG business id — disimpan di providerConfig
 * channel. Global (env): META_APP_SECRET untuk verifikasi webhook
 * (X-Hub-Signature-256) + META_VERIFY_TOKEN untuk handshake GET.
 * ──────────────────────────────────────────────────────────── */

export const META_GRAPH_BASE = 'https://graph.facebook.com/v21.0';
export const META_WEBHOOK_PATH = '/api/webhooks/meta';

export class MetaApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'MetaApiError';
  }
}

/** Identitas page dari token (Graph GET /me). */
export interface MetaPageIdentity {
  id: string;
  name: string;
  /** Instagram business account terhubung ke page (bila ada izin). */
  instagramBusinessAccount: { id: string; username: string | null } | null;
}

/**
 * Validasi token + ambil identitas page (GET /me). Untuk channel
 * Instagram, klien WAJIB menyertakan instagram_business_account — tanpa
 * itu token tidak punya izin Instagram messaging.
 */
export async function metaGetPageIdentity(accessToken: string): Promise<MetaPageIdentity> {
  const params = new URLSearchParams({
    fields: 'id,name,instagram_business_account{id,username}',
    access_token: accessToken,
  });
  const res = await metaFetchJson<{
    id?: string;
    name?: string;
    instagram_business_account?: { id?: string; username?: string } | null;
  }>(`${META_GRAPH_BASE}/me?${params.toString()}`);
  if (!res.id) {
    throw new MetaApiError('Meta tidak mengembalikan identitas page.', 502);
  }
  return {
    id: res.id,
    name: res.name ?? 'Untitled page',
    instagramBusinessAccount: res.instagram_business_account?.id
      ? {
          id: res.instagram_business_account.id,
          username: res.instagram_business_account.username ?? null,
        }
      : null,
  };
}

/**
 * Kirim pesan teks ke pengguna via Graph API
 * (POST /{page-id}/messages dengan recipient + message).
 */
export async function metaSendTextMessage(input: {
  accessToken: string;
  pageId: string;
  recipientId: string;
  text: string;
}): Promise<{ messageId: string | null }> {
  const params = new URLSearchParams({ access_token: input.accessToken });
  const res = await metaFetchJson<{ message_id?: string }>(
    `${META_GRAPH_BASE}/${encodeURIComponent(input.pageId)}/messages?${params.toString()}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: input.recipientId },
        message: { text: input.text },
        // Messenger/Instagram: pesan otomatis wajib dalam 24h messaging window
        // dari pesan terakhir user (tag policy) — tidak ada tag tambahan.
        messaging_type: 'RESPONSE',
      }),
    },
  );
  return { messageId: res.message_id ?? null };
}

/** Fetch + parsing JSON dengan penanganan error Meta (error.message). */
async function metaFetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (error) {
    throw new MetaApiError(
      `Meta tidak dapat dijangkau (${error instanceof Error ? error.message : 'network error'}).`,
      0,
    );
  }
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      detail = body.error?.message ? `: ${body.error.message}` : '';
    } catch {
      // body bukan JSON — abaikan detail.
    }
    throw new MetaApiError(`Meta menjawab ${res.status}${detail}.`, res.status);
  }
  return (await res.json()) as T;
}

/**
 * Verifikasi signature webhook Meta (X-Hub-Signature-256 = sha256=hmac
 * app secret atas RAW body). timingSafeEqual mencegah timing attack.
 */
export function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader) return false;
  const expected = `sha256=${createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex')}`;
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
