import { and, eq } from 'drizzle-orm';
import { whatsappConnections, workspaceChannels } from '@oriole/database';

import { db } from '../db/index.ts';
import { decryptSecret } from '../lib/crypto.ts';
import { env } from '../lib/env.ts';
import { metaSendMessage } from './meta-whatsapp.ts';
import {
  countTodayNewContactWahaOutbound,
  countTodayWahaOutbound,
  hasWahaCustomerChannel,
  markWahaOutboundFailure,
  readWahaHealth,
  updateWahaHealth,
  WAHA_DAILY_NEW_CONTACT_CAP,
  WAHA_DAILY_TOTAL_CAP,
  type WahaHealth,
} from '../lib/waha-health.ts';
import { waIdToChatId, wahaSendText } from './waha.ts';

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

/** Konfigurasi channel 360dialog (BSP WhatsApp Cloud API — default). */
export interface WhatsApp360DialogChannelConfig {
  provider: '360dialog';
  apiKey: string;
  webhookSecret: string | null;
  phoneNumberId?: string | null;
  /** false = channel dijeda dari UI (inbound di-drop, outbound ditolak). */
  isActive: boolean;
}

/** Konfigurasi channel Meta (provider 'meta' — Embedded Signup, Tech Provider). */
export interface MetaWhatsAppChannelConfig {
  provider: 'meta';
  /** Business integration system user access token (per tenant). */
  businessToken: string;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  isActive: boolean;
}

/** Konfigurasi channel BYO (provider 'waha' — unofficial, WAHA gateway). */
export interface WahaOutboundChannelConfig {
  provider: 'waha';
  /** URL gateway WAHA milik workspace (dari providerConfig.baseUrl). */
  baseUrl: string;
  /** API key gateway WAHA (providerConfig.gatewayApiKey — bukan kolom apiKey). */
  gatewayApiKey: string;
  /** Nama session WAHA (providerConfig.sessionName, mis. ws_<workspaceId>). */
  sessionName: string;
  isActive: boolean;
  /** Workspace pemilik channel — dipakai guard outbound (kuota/blokir). */
  workspaceId: string;
  /** Health channel (providerConfig.health) — dipakai guard outbound. */
  health: WahaHealth;
}

/**
 * Outbound BYO diblokir oleh guard keamanan (banned / restricted untuk
 * kontak baru / kuota harian tercapai). Subclass WhatsAppApiError agar jalur
 * error yang ada (inbox → 400, form-send → 502) langsung menanganinya.
 */
export class WhatsAppOutboundBlockedError extends WhatsAppApiError {
  constructor(message: string) {
    super(message, 429);
    this.name = 'WhatsAppOutboundBlockedError';
  }
}

/** Channel WhatsApp ter-resolve — pemanggil memilah provider saat mengirim. */
export type WhatsAppChannelConfig =
  | WhatsApp360DialogChannelConfig
  | WahaOutboundChannelConfig
  | MetaWhatsAppChannelConfig;

/**
 * Resolve channel WhatsApp untuk workspace: providerConfig → env fallback.
 * Provider-aware: channel BYO (provider 'waha') mengembalikan konfigurasi
 * WAHA (bukan kredensial 360dialog), jadi outbound/inbound mengarah ke
 * gateway yang benar dan TIDAK pernah jatuh ke fallback env WHATSAPP_API_KEY.
 */
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

  const providerConfig = (channel?.providerConfig ?? {}) as Record<string, unknown>;

  if (providerConfig.provider === 'waha') {
    const baseUrl = providerConfig.baseUrl;
    const gatewayApiKey = providerConfig.gatewayApiKey;
    const sessionName = providerConfig.sessionName;
    // Channel BYO tidak lengkap (setup gagal separuh) → anggap belum
    // dikonfigurasi daripada salah kirim lewat provider lain.
    if (
      typeof baseUrl !== 'string' ||
      baseUrl.length === 0 ||
      typeof gatewayApiKey !== 'string' ||
      gatewayApiKey.length === 0 ||
      typeof sessionName !== 'string' ||
      sessionName.length === 0
    ) {
      return null;
    }
    return {
      provider: 'waha',
      baseUrl,
      gatewayApiKey,
      sessionName,
      isActive: channel?.isActive ?? true,
      workspaceId,
      health: readWahaHealth(providerConfig),
    };
  }

  const providerKey = channel?.providerConfig?.apiKey;
  if (typeof providerKey === 'string' && providerKey.length > 0) {
    const secret = channel?.providerConfig?.webhookSecret;
    const phoneNumberId = channel?.providerConfig?.phoneNumberId;
    return {
      provider: '360dialog',
      apiKey: providerKey,
      webhookSecret: typeof secret === 'string' && secret.length > 0 ? secret : null,
      phoneNumberId: typeof phoneNumberId === 'string' ? phoneNumberId : null,
      isActive: channel?.isActive ?? true,
    };
  }

  // Meta Embedded Signup (Tech Provider) — koneksi per tenant di tabel
  // whatsapp_connections. Token didekripsi server-side, tidak pernah keluar.
  const [meta] = await db
    .select()
    .from(whatsappConnections)
    .where(
      and(
        eq(whatsappConnections.workspaceId, workspaceId),
        eq(whatsappConnections.status, 'connected'),
      ),
    )
    .limit(1);
  if (meta?.accessTokenEncrypted && meta.phoneNumberId) {
    const businessToken = decryptSecret(meta.accessTokenEncrypted);
    if (businessToken.length > 0) {
      return {
        provider: 'meta',
        businessToken,
        phoneNumberId: meta.phoneNumberId,
        displayPhoneNumber: meta.displayPhoneNumber,
        isActive: true,
      };
    }
  }

  if (env.WHATSAPP_API_KEY) {
    return {
      provider: '360dialog',
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

export interface WhatsAppMessageOptions {
  /** Channel ter-resolve (provider-aware) — dari resolveWhatsAppChannel. */
  channel: WhatsAppChannelConfig;
  /** wa_id penerima (tanpa @c.us; WAHA dikonversi ke chatId internal). */
  to: string;
  text: string;
  /** Interactive reply buttons — hanya 360dialog (WAHA: fallback teks polos). */
  buttons?: { id: string; label: string }[];
  /** Message Template — hanya 360dialog (WAHA: fallback teks polos). */
  template?: {
    name: string;
    language?: string;
    components?: Record<string, unknown>[];
  };
  /** Id pesan yang dibalas — diteruskan ke WAHA reply_to, diabaikan 360dialog. */
  replyTo?: string;
}

/** wa_id penerima (tanpa suffix @c.us) — identitas untuk cek kontak lama. */
function waIdOf(to: string): string {
  return to.replace(/@c\.us$/, '').replace(/@s\.whatsapp\.net$/, '');
}

/**
 * Guard outbound BYO (spec §6–7):
 *  - banned → semua kiriman diblokir (auto-pause oleh sistem).
 *  - restricted (reachout timelock) → pesan ke kontak BARU diblokir; timelock
 *    yang sudah lewat otomatis kembali connected.
 *  - Kuota harian: ≤ 200 total, ≤ 20 ke kontak baru.
 * Melempar WhatsAppOutboundBlockedError (ditangani sebagai error bisnis).
 */
async function assertWahaOutboundAllowed(
  channel: WahaOutboundChannelConfig,
  to: string,
): Promise<void> {
  const health = channel.health;
  const waId = waIdOf(to);
  const recipientIsNew = !(await hasWahaCustomerChannel(channel.workspaceId, waId));

  if (health.state === 'banned') {
    throw new WhatsAppOutboundBlockedError(
      'Nomor WhatsApp (BYO) dibanned — semua kiriman otomatis dijeda.',
    );
  }

  if (health.state === 'restricted') {
    const until = health.reachoutTimelockUntil ? new Date(health.reachoutTimelockUntil).getTime() : 0;
    if (until > 0 && until < Date.now()) {
      // Jendela timelock 463 sudah lewat → kembali normal (self-heal).
      await updateWahaHealth(channel.workspaceId, {
        state: 'connected',
        reachoutTimelockUntil: null,
      });
    } else if (recipientIsNew) {
      throw new WhatsAppOutboundBlockedError(
        'Reachout timelock aktif — pesan ke kontak baru dijeda sementara oleh WhatsApp.',
      );
    }
  }

  const [total, newContact] = await Promise.all([
    countTodayWahaOutbound(channel.workspaceId),
    countTodayNewContactWahaOutbound(channel.workspaceId),
  ]);
  if (total >= WAHA_DAILY_TOTAL_CAP) {
    throw new WhatsAppOutboundBlockedError(
      `Kuota kiriman harian WhatsApp (BYO) tercapai (${WAHA_DAILY_TOTAL_CAP}/hari) — coba lagi besok.`,
    );
  }
  if (recipientIsNew && newContact >= WAHA_DAILY_NEW_CONTACT_CAP) {
    throw new WhatsAppOutboundBlockedError(
      `Kuota pesan ke kontak baru harian tercapai (${WAHA_DAILY_NEW_CONTACT_CAP}/hari) — coba lagi besok.`,
    );
  }
}

/**
 * Catat kegagalan kirim gateway BYO ke health (463 → restricted/banned, dll).
 * Error asli TETAP dilempar walau pencatatan health gagal (DB hiccup tidak
 * boleh menutupi error gateway yang sebenarnya).
 */
async function recordWahaSendFailure(channel: WahaOutboundChannelConfig, error: unknown): Promise<void> {
  const status = (error as { status?: number } | null)?.status;
  const message = error instanceof Error ? error.message : String(error);
  try {
    await markWahaOutboundFailure(channel.workspaceId, { status, message });
  } catch (healthError) {
    console.warn('[whatsapp] gagal mencatat kegagalan BYO ke health:', healthError);
  }
}

/** Body Messages API Meta (Cloud API) — shape sama dengan 360dialog (BSP). */
function metaOutboundBody(params: {
  to: string;
  text: string;
  buttons?: { id: string; label: string }[];
  template?: { name: string; language?: string; components?: Record<string, unknown>[] };
}): Record<string, unknown> {
  if (params.template) {
    return {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: params.to,
      type: 'template',
      template: {
        name: params.template.name,
        language: { code: params.template.language ?? 'id' },
        components: params.template.components ?? [],
      },
    };
  }
  if (params.buttons && params.buttons.length > 0) {
    return {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: params.to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: params.text },
        action: {
          buttons: params.buttons.slice(0, 3).map((button) => ({
            type: 'reply',
            reply: { id: button.id, title: button.label },
          })),
        },
      },
    };
  }
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: params.to,
    type: 'text',
    text: { body: params.text },
  };
}

/**
 * Dispatch outbound WhatsApp provider-aware: channel BYO (waha) → WAHA
 * sendText; channel 360dialog → text / interactive / template (sesuai opsi);
 * channel meta (Embedded Signup) → Messages API langsung.
 *
 * WAHA tidak punya Message Template atau interactive buttons yang 1:1 dengan
 * Meta (spikes/waha/README.md §mapping): tombol/tipe lain di-fallback ke
 * teks polos — balasan tombol tiba sebagai teks biasa dari sisi customer.
 *
 * Outbound BYO melalui guard keamanan (banned/restricted/kuota) — lihat
 * assertWahaOutboundAllowed. Kegagalan gateway 463/402/403 dicatat ke health.
 */
export async function sendWhatsAppMessage(params: WhatsAppMessageOptions): Promise<WhatsAppSendResult> {
  if (params.channel.provider === 'waha') {
    await assertWahaOutboundAllowed(params.channel, params.to);
    try {
      return await wahaSendText({
        baseUrl: params.channel.baseUrl,
        apiKey: params.channel.gatewayApiKey,
        session: params.channel.sessionName,
        chatId: waIdToChatId(params.to),
        text: params.text,
        replyTo: params.replyTo,
      });
    } catch (error) {
      await recordWahaSendFailure(params.channel, error);
      throw error;
    }
  }

  if (params.channel.provider === 'meta') {
    return metaSendMessage({
      businessToken: params.channel.businessToken,
      phoneNumberId: params.channel.phoneNumberId,
      body: metaOutboundBody({
        to: params.to,
        text: params.text,
        buttons: params.buttons,
        template: params.template,
      }),
    });
  }

  if (params.template) {
    return whatsappSendTemplate({
      token: params.channel.apiKey,
      to: params.to,
      templateName: params.template.name,
      language: params.template.language,
      components: params.template.components,
    });
  }
  if (params.buttons && params.buttons.length > 0) {
    return whatsappSendInteractive({
      token: params.channel.apiKey,
      to: params.to,
      text: params.text,
      buttons: params.buttons,
    });
  }
  return whatsappSendText({ token: params.channel.apiKey, to: params.to, text: params.text });
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
