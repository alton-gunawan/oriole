const TELEGRAM_API_BASE = 'https://api.telegram.org';

/** Error dari Telegram API — `code` = HTTP / error_code provider. */
export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

interface TelegramInlineButton {
  id: string;
  label: string;
}

async function telegramCall(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const json = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: unknown;
    description?: string;
    error_code?: number;
  };

  if (!res.ok || json.ok === false) {
    throw new TelegramApiError(
      `Telegram ${method} gagal: ${json.description ?? res.statusText}`,
      json.error_code ?? res.status,
    );
  }
  return (json.result ?? {}) as Record<string, unknown>;
}

/**
 * Kirim pesan teks + tombol inline ke sebuah chat.
 * Setiap tombol inline ditaruh di baris sendiri agar rapi di layar sempit.
 *
 * `requestContact` menampilkan reply keyboard SEKALI PAKAI dengan tombol
 * "Bagikan Nomor" (request_contact) — dipakai alur linking chat → booking.
 * Hanya berlaku di private chat (ditolak Telegram di group).
 */
export async function telegramSendMessage(params: {
  token: string;
  chatId: string;
  text: string;
  buttons?: TelegramInlineButton[];
  requestContact?: { label: string };
}): Promise<{ messageId: number }> {
  let replyMarkup: Record<string, unknown> | undefined;
  if (params.buttons?.length) {
    replyMarkup = { inline_keyboard: params.buttons.map((button) => [{ text: button.label, callback_data: button.id }]) };
  } else if (params.requestContact) {
    replyMarkup = {
      keyboard: [[{ text: params.requestContact.label, request_contact: true }]],
      one_time_keyboard: true,
      resize_keyboard: true,
    };
  }

  const result = await telegramCall(params.token, 'sendMessage', {
    chat_id: params.chatId,
    text: params.text,
    reply_markup: replyMarkup,
  });
  return { messageId: Number(result.message_id) };
}

/** Akui callback query agar spinner tombol hilang. */
export async function telegramAnswerCallbackQuery(
  token: string,
  callbackQueryId: string,
): Promise<void> {
  await telegramCall(token, 'answerCallbackQuery', { callback_query_id: callbackQueryId });
}

/** Hapus keyboard inline dari pesan yang tombolnya sudah dipakai. */
export async function telegramEditMessageReplyMarkup(
  token: string,
  chatId: string,
  messageId: number,
): Promise<void> {
  await telegramCall(token, 'editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: [] },
  });
}

/** Identitas bot (getMe) — dipakai validasi token saat setup channel. */
export async function telegramGetMe(token: string): Promise<{
  id: number;
  username: string | null;
  isBot: boolean;
}> {
  const result = await telegramCall(token, 'getMe', {});
  return {
    id: Number(result.id),
    username: typeof result.username === 'string' && result.username.length > 0 ? result.username : null,
    isBot: Boolean(result.is_bot),
  };
}

/** Daftarkan webhook Telegram (dipakai manual saat setup channel). */
export async function telegramSetWebhook(params: {
  token: string;
  url: string;
  secretToken: string;
}): Promise<void> {
  await telegramCall(params.token, 'setWebhook', {
    url: params.url,
    secret_token: params.secretToken,
  });
}

/** Cabut webhook Telegram (dipakai saat channel dilepas / dijeda). */
export async function telegramDeleteWebhook(token: string): Promise<void> {
  await telegramCall(token, 'deleteWebhook', { drop_pending_updates: false });
}

/**
 * Info webhook Telegram saat ini (getWebhookInfo) — dipakai rekonsiliasi saat
 * boot untuk memutuskan apakah webhook perlu didaftarkan ulang (URL berganti /
 * terhapus) tanpa memanggil setWebhook secara membabi buta tiap restart.
 */
export async function telegramGetWebhookInfo(token: string): Promise<{
  url: string | null;
  pendingUpdateCount: number;
  lastError: string | null;
}> {
  const result = await telegramCall(token, 'getWebhookInfo', {});
  return {
    url: typeof result.url === 'string' && result.url.length > 0 ? result.url : null,
    pendingUpdateCount: Number(result.pending_update_count ?? 0),
    lastError: typeof result.last_error_message === 'string' ? result.last_error_message : null,
  };
}
