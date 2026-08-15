import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const LINE_API_BASE = 'https://api.line.me';

/** Error dari Line Messaging API — `status` = HTTP status provider. */
export class LineApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

interface LineInlineButton {
  id: string;
  label: string;
}

/** Pesan Line siap kirim (text / template tombol). */
export interface LineOutboundMessage {
  type: string;
  text?: string;
  altText?: string;
  template?: unknown;
}

/** Fetch ke Line API dengan Bearer token; non-2xx → LineApiError. */
async function lineCall(
  accessToken: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${LINE_API_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = (await res.json().catch(() => ({}))) as { message?: string; details?: unknown };

  if (!res.ok) {
    const description = json.message ?? res.statusText;
    throw new LineApiError(`Line ${method} ${path} gagal: ${description}`, res.status);
  }
  return json;
}

/**
 * Verifikasi header `X-Line-Signature`: base64(HMAC-SHA256(channelSecret,
 * rawBody)). WAJIB dijalankan di route webhook — Line menolak permintaan
 * tanpa signature dan ini mencegah request palsu memproses pesan.
 */
export function verifyLineSignature(
  channelSecret: string,
  rawBody: string,
  signature: string | null | undefined,
): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', channelSecret).update(rawBody, 'utf8').digest('base64');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Bersihkan markdown Telegram (`**tebal**`, `__` , backtick) → teks polos Line. */
export function lineCleanText(text: string): string {
  return text.replace(/\*\*/g, '').replace(/__/g, '').replace(/`/g, '');
}

/**
 * Bangun array pesan Line dari teks + tombol.
 * - Tanpa tombol → satu pesan teks (markdown Telegram dibersihkan).
 * - Dengan tombol → pesan teks (teks penuh) + satu template `buttons`
 *   (maks 4 aksi postback) memakai format callback data yang sama dengan
 *   Telegram (`bk:<id>:<action>`) agar state machine identik.
 * - Template `text` dibatasi 160 karakter (batas Line): teks pendek dipakai
 *   apa adanya, teks panjang memakai `shortPrompt` (fallback: potongan teks).
 */
export function lineBuildMessages(
  text: string,
  buttons?: LineInlineButton[],
  shortPrompt?: string,
): LineOutboundMessage[] {
  const cleaned = lineCleanText(text);
  const messages: LineOutboundMessage[] = [{ type: 'text', text: cleaned }];

  if (buttons && buttons.length > 0) {
    messages.push({
      type: 'template',
      altText: cleaned.slice(0, 200),
      template: {
        type: 'buttons',
        text: (text.length <= 160 ? cleaned : shortPrompt ?? cleaned.slice(0, 160)).slice(0, 160),
        actions: buttons.slice(0, 4).map((button) => ({
          type: 'postback',
          label: button.label.slice(0, 20),
          data: button.id,
        })),
      },
    });
  }

  return messages;
}

/** Kirim balasan via replyToken (satu kali pakai, dalam 1 menit). */
export async function lineSendReply(params: {
  accessToken: string;
  replyToken: string;
  messages: LineOutboundMessage[];
}): Promise<{ sentMessages: unknown[] }> {
  const result = await lineCall(params.accessToken, 'POST', '/v2/bot/message/reply', {
    replyToken: params.replyToken,
    messages: params.messages,
  });
  return { sentMessages: (result.sentMessages as unknown[]) ?? [] };
}

/**
 * Push message ke user (reminder / konfirmasi booking).
 * `X-Line-Retry-Key` (UUID) memberi idempotency sisi Line: bila request
 * timeout tapi diterima Line, retry dengan key sama tidak double-send.
 */
export async function linePushMessage(params: {
  accessToken: string;
  to: string;
  messages: LineOutboundMessage[];
}): Promise<void> {
  await lineCall(
    params.accessToken,
    'POST',
    '/v2/bot/message/push',
    { to: params.to, messages: params.messages },
    { 'x-line-retry-key': randomUUID() },
  );
}

/** Profil pengguna Line (displayName) — dipakai nama pengirim di inbox. */
export async function lineGetProfile(
  accessToken: string,
  userId: string,
): Promise<{ displayName: string | null }> {
  const result = await lineCall(accessToken, 'GET', `/v2/bot/profile/${encodeURIComponent(userId)}`);
  return { displayName: typeof result.displayName === 'string' ? result.displayName : null };
}

/**
 * Info bot (GET /v2/bot/info) — validasi channel access token saat setup:
 * token salah / tidak punya scope Messaging API → 401 dari Line.
 */
export async function lineGetBotInfo(accessToken: string): Promise<{
  userId: string;
  displayName: string | null;
}> {
  const result = await lineCall(accessToken, 'GET', '/v2/bot/info');
  return {
    userId: typeof result.userId === 'string' ? result.userId : '',
    displayName: typeof result.displayName === 'string' ? result.displayName : null,
  };
}

/** Daftarkan webhook endpoint ke Line (dipakai manual saat setup channel). */
export async function lineSetWebhookEndpoint(
  accessToken: string,
  endpoint: string,
): Promise<void> {
  await lineCall(accessToken, 'PUT', '/v2/bot/channel/webhook/endpoint', { endpoint });
}
