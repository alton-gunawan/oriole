import { and, eq } from 'drizzle-orm';
import { workspaceChannels } from '@oriole/database';

import { db } from '../db/index.ts';
import { env } from '../lib/env.ts';

/**
 * Client 360dialog (BSP WhatsApp Cloud API) — waba.360dialog.io.
 *
 * 360dialog meneruskan payload Meta apa adanya ke webhook kita dan
 * memakai X-Hub-Signature-256 bila app secret dikonfigurasi di dashboard.
 * Kredensial per-workspace disimpan di workspace_channels.providerConfig
 * (multi-tenant, keputusan (b)); env WHATSAPP_* hanya fallback dev.
 */

const WHATSAPP_API_BASE = 'https://waba.360dialog.io';

export class WhatsAppApiError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

export interface WhatsAppChannelConfig {
  apiKey: string;
  webhookSecret: string | null;
  phoneNumberId?: string | null;
  /** false = channel dijeda dari UI (inbound di-drop, outbound ditolak). */
  isActive: boolean;
}

/** Resolve kredensial WhatsApp untuk workspace: providerConfig → env fallback. */
export async function resolveWhatsAppChannel(
  workspaceId: string,
): Promise<WhatsAppChannelConfig | null> {
  const [channel] = await db
    .select()
    .from(workspaceChannels)
    .where(
      and(eq(workspaceChannels.workspaceId, workspaceId), eq(workspaceChannels.channelType, 'whatsapp')),
    )
    .limit(1);

  const providerKey = channel?.providerConfig?.apiKey;
  if (typeof providerKey === 'string' && providerKey.length > 0) {
    const secret = channel?.providerConfig?.webhookSecret;
    const phoneNumberId = channel?.providerConfig?.phoneNumberId;
    return {
      apiKey: providerKey,
      webhookSecret: typeof secret === 'string' && secret.length > 0 ? secret : null,
      phoneNumberId: typeof phoneNumberId === 'string' ? phoneNumberId : null,
      isActive: channel?.isActive ?? true,
    };
  }

  if (env.WHATSAPP_API_KEY) {
    return {
      apiKey: env.WHATSAPP_API_KEY,
      webhookSecret: env.WHATSAPP_WEBHOOK_SECRET ?? null,
      phoneNumberId: null,
      isActive: true,
    };
  }
  return null;
}

/**
 * Validasi API key + ambil identitas WABA (360dialog GET /v1/configs).
 * Endpoint ini juga dipakai setup channel dari UI.
 */
export async function whatsappGetConfig(
  token: string,
): Promise<{ phone: string | null; wabaId: string | null; phoneNumberId: string | null }> {
  const res = await fetch(`${WHATSAPP_API_BASE}/v1/configs`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new WhatsAppApiError(`360dialog config gagal: ${JSON.stringify(json)}`, res.status);
  }
  const data = ((json.data ?? json) as Record<string, unknown>) ?? {};
  return {
    phone: typeof data.phone === 'string' && data.phone.length > 0 ? data.phone : null,
    wabaId: typeof data.waba_id === 'string' && data.waba_id.length > 0 ? data.waba_id : null,
    phoneNumberId:
      typeof data.phone_number_id === 'string' && data.phone_number_id.length > 0
        ? data.phone_number_id
        : null,
  };
}

/** Result pengiriman — messageId = wamid pesan keluar (untuk tracking). */
export interface WhatsAppSendResult {
  messageId: string | null;
}

async function whatsappCall(
  token: string,
  body: Record<string, unknown>,
): Promise<{ json: Record<string, unknown>; messageId: string | null }> {
  const res = await fetch(`${WHATSAPP_API_BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new WhatsAppApiError(`360dialog gagal: ${JSON.stringify(json)}`, res.status);
  }

  const messages = (json.messages ?? []) as { id?: string }[];
  return { json, messageId: messages[0]?.id ?? null };
}

/** Pesan teks bebas — hanya sah di dalam 24h customer service window. */
export async function whatsappSendText(params: {
  token: string;
  to: string;
  text: string;
}): Promise<WhatsAppSendResult> {
  return whatsappCall(params.token, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: params.to,
    type: 'text',
    text: { body: params.text },
  });
}

/** Interactive reply buttons (maks 3, label ≤ 20 karakter) — balasan dalam window. */
export async function whatsappSendInteractive(params: {
  token: string;
  to: string;
  text: string;
  buttons: { id: string; label: string }[];
}): Promise<WhatsAppSendResult> {
  const buttons = params.buttons.slice(0, 3).map((button) => ({
    type: 'reply',
    reply: { id: button.id, title: button.label },
  }));

  return whatsappCall(params.token, {
    messaging_product: 'whatsapp',
    to: params.to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: params.text },
      action: { buttons },
    },
  });
}

/**
 * Message Template — satu-satunya cara memulai percakapan OUTSIDE 24h window.
 * Template harus sudah diapprove Meta; `components` berisi params posisional
 * (mis. [{ type: 'body', parameters: [{ type: 'text', text: 'Budi' }] }]).
 */
export async function whatsappSendTemplate(params: {
  token: string;
  to: string;
  templateName: string;
  language?: string;
  components?: Record<string, unknown>[];
}): Promise<WhatsAppSendResult> {
  return whatsappCall(params.token, {
    messaging_product: 'whatsapp',
    to: params.to,
    type: 'template',
    template: {
      name: params.templateName,
      language: { code: params.language ?? 'id' },
      components: params.components ?? [],
    },
  });
}
