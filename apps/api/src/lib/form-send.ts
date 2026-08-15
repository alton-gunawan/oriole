import { and, eq } from 'drizzle-orm';
import { brand } from '@oriole/config';
import {
  contacts,
  conversations,
  customerChannels,
  messages,
  workspaceChannels,
  workspaces,
} from '@oriole/database';
import {
  canonicalPhone,
  normalizePhone,
  renderFormInvitation,
  samePhone,
  type BotLanguage,
} from '@oriole/messaging';

import { db } from '../db/index.ts';
import { formPublicUrlForCustomer, type FormIntegrationType } from './form-links.ts';
import { encryptMessageContent } from './message-encryption.ts';
import { TelegramApiError, telegramSendMessage } from './telegram.ts';
import { LineApiError, lineBuildMessages, linePushMessage } from './line.ts';
import { resolveLineChannel } from './line-handler.ts';
import { resend } from '../services/email.ts';
import {
  resolveWhatsAppChannel,
  sendWhatsAppMessage,
  WhatsAppApiError,
  WhatsAppOutboundBlockedError,
} from '../services/whatsapp.ts';
import { WahaApiError } from '../services/waha.ts';

/* ────────────────────────────────────────────────────────────
 * Form send — kirim tautan form (Google Forms / Tally) ke
 * satu customer via channel yang dipilih (whatsapp / telegram /
 * email). Pesan dicatat ke unified inbox (conversations +
 * messages) agar auditable & dedup-able — pola sama dengan
 * dispatchEmailReminder / dispatchWhatsAppReminder.
 * ──────────────────────────────────────────────────────────── */

/** Error bisnis siap-tampil — status dipetakan route → HTTP. */
export class FormSendError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 500 | 502 = 400,
  ) {
    super(message);
    this.name = 'FormSendError';
  }
}

export type FormSendChannel = 'whatsapp' | 'telegram' | 'email' | 'line';

export interface FormSendResult {
  sent: true;
  channel: FormSendChannel;
  formUrl: string;
}

export interface FormSendInput {
  workspaceId: string;
  integrationType: FormIntegrationType;
  formId: string;
  formName: string | null;
  contactId: string;
  channel: FormSendChannel;
}

/** Resolve contact milik workspace (null bila tidak ada). */
async function findContact(workspaceId: string, contactId: string) {
  const [contact] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.workspaceId, workspaceId)))
    .limit(1);
  return contact;
}

/**
 * Nama bisnis + bahasa balasan workspace (`chatLanguage`, default 'en').
 * Nama null → renderer memakai sapaan generik.
 */
async function findBusinessName(workspaceId: string): Promise<{
  name: string | null;
  language: BotLanguage;
}> {
  const [workspace] = await db
    .select({ name: workspaces.name, chatLanguage: workspaces.chatLanguage })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return {
    name: workspace?.name ?? null,
    language: workspace?.chatLanguage === 'id' ? 'id' : 'en',
  };
}

/**
 * Cari chat customer yang sudah terhubung + opt-in di channel (WhatsApp /
 * Telegram) via nomor HP — konsisten dengan resolveBookingByPhone dll.
 * Mengembalikan identifier channel (wa_id / chat_id), atau null.
 *
 * contactPhone baru tersimpan kanonik → query pertama memakai index
 * (workspaceId, contactPhone); fallback scan menangani baris lama berformat
 * lokal (0xx) via samePhone.
 */
async function findOptedInChannel(
  workspaceId: string,
  channelType: FormSendChannel,
  phone: string,
): Promise<string | null> {
  const canonical = canonicalPhone(phone);
  if (canonical) {
    const [row] = await db
      .select({ identifier: customerChannels.identifier })
      .from(customerChannels)
      .where(
        and(
          eq(customerChannels.workspaceId, workspaceId),
          eq(customerChannels.channelType, channelType),
          eq(customerChannels.contactPhone, canonical),
          eq(customerChannels.isOptedIn, true),
        ),
      )
      .limit(1);
    if (row) return row.identifier ?? null;
  }

  const rows = await db
    .select({ identifier: customerChannels.identifier, contactPhone: customerChannels.contactPhone })
    .from(customerChannels)
    .where(
      and(
        eq(customerChannels.workspaceId, workspaceId),
        eq(customerChannels.channelType, channelType),
        eq(customerChannels.isOptedIn, true),
      ),
    )
    .limit(200);
  const match = rows.find((row) => row.contactPhone && samePhone(row.contactPhone, phone));
  return match?.identifier ?? null;
}

/** Bot token Telegram channel (providerConfig.botToken) — null bila belum setup. */
async function findTelegramBotToken(workspaceId: string): Promise<string | null> {
  const [channel] = await db
    .select({ providerConfig: workspaceChannels.providerConfig })
    .from(workspaceChannels)
    .where(
      and(
        eq(workspaceChannels.workspaceId, workspaceId),
        eq(workspaceChannels.channelType, 'telegram'),
      ),
    )
    .limit(1);
  const token = channel?.providerConfig?.botToken;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/** Siapkan percakapan unified inbox (find-or-create per channel+externalId). */
async function upsertConversation(input: {
  workspaceId: string;
  channelType: FormSendChannel;
  externalId: string;
  customerName: string | null;
}): Promise<string | null> {
  const [existing] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.workspaceId, input.workspaceId),
        eq(conversations.channelType, input.channelType),
        eq(conversations.externalId, input.externalId),
      ),
    )
    .limit(1);
  if (existing) return existing.id;

  const [created] = await db
    .insert(conversations)
    .values({
      workspaceId: input.workspaceId,
      channelType: input.channelType,
      externalId: input.externalId,
      customerName: input.customerName,
      status: 'active',
      lastMessageAt: new Date(),
    })
    .returning({ id: conversations.id });
  return created?.id ?? null;
}

/**
 * Kirim undangan form ke satu customer. Idempotent per
 * (integrationType + formId + contactId + channel): panggilan ulang tidak
 * mengirim dua kali (metadata dedup di tabel messages).
 */
export async function dispatchFormInvitation(input: FormSendInput): Promise<FormSendResult> {
  const contact = await findContact(input.workspaceId, input.contactId);
  if (!contact) {
    throw new FormSendError('Kontak tidak ditemukan.', 404);
  }

  // Tally: nomor HP + nama customer disuntikkan ke URL → field phone/nama
  // terisi otomatis (hidden field `phone`/`name`; diabaikan Tally bila form
  // belum punya field itu). Kanonikalisasi (0812… → 62812…) dilakukan di
  // formPublicUrlForCustomer.
  if (input.integrationType === 'tally') {
    // Self-heal: form Tally yang belum punya hidden field prefill/token chat
    // diperbarui otomatis saat tautan dikirim (fire-and-forget — tidak
    // memperlambat atau menggagalkan pengiriman undangan).
    void import('./tally.ts')
      .then((m) => m.ensureTallyFormEnhanced(input.workspaceId))
      .catch(() => {});
  }
  const formUrl = formPublicUrlForCustomer(
    input.integrationType,
    input.formId,
    contact.phone,
    contact.name,
  );
  const business = await findBusinessName(input.workspaceId);
  const text = renderFormInvitation(
    {
      businessName: business.name,
      customerName: contact.name,
      formName: input.formName?.trim() || 'formulir',
      formUrl,
    },
    business.language,
  );

  // Metadata stabil → dedup retry (baris dicek sebelum kirim).
  const invitationMetadata = {
    formInvitation: {
      integrationType: input.integrationType,
      formId: input.formId,
      contactId: input.contactId,
    },
  };

  // Resolve kredensial + identitas penerima per channel.
  let externalId: string;
  let send: () => Promise<{ providerMessageId: string | null }>;

  if (input.channel === 'whatsapp') {
    if (!contact.phone) {
      throw new FormSendError('Kontak belum memiliki nomor telepon untuk WhatsApp.', 400);
    }
    const phone = normalizePhone(contact.phone);
    const channel = await resolveWhatsAppChannel(input.workspaceId);
    if (!channel) {
      throw new FormSendError('Channel WhatsApp belum dikonfigurasi untuk workspace ini.', 409);
    }
    if (!channel.isActive) {
      throw new FormSendError('Channel WhatsApp sedang dijeda (nonaktif).', 409);
    }
    const identifier = phone ? await findOptedInChannel(input.workspaceId, 'whatsapp', phone) : null;
    if (!identifier) {
      throw new FormSendError('Customer belum terhubung ke WhatsApp atau sudah berhenti berlangganan.', 409);
    }
    externalId = identifier;
    send = async () => {
      // Dispatch provider-aware: 360dialog → text; BYO (waha) → sendText.
      const result = await sendWhatsAppMessage({ channel, to: identifier, text });
      return { providerMessageId: result.messageId };
    };
  } else if (input.channel === 'telegram') {
    if (!contact.phone) {
      throw new FormSendError('Kontak belum memiliki nomor telepon untuk Telegram.', 400);
    }
    const phone = normalizePhone(contact.phone);
    const token = await findTelegramBotToken(input.workspaceId);
    if (!token) {
      throw new FormSendError('Channel Telegram belum dikonfigurasi untuk workspace ini.', 409);
    }
    const identifier = phone ? await findOptedInChannel(input.workspaceId, 'telegram', phone) : null;
    if (!identifier) {
      throw new FormSendError('Customer belum terhubung ke Telegram atau sudah berhenti berlangganan.', 409);
    }
    externalId = identifier;
    send = async () => {
      const result = await telegramSendMessage({ token, chatId: identifier, text });
      return { providerMessageId: String(result.messageId) };
    };
  } else if (input.channel === 'line') {
    if (!contact.phone) {
      throw new FormSendError('Kontak belum memiliki nomor telepon untuk Line.', 400);
    }
    const phone = normalizePhone(contact.phone);
    const channel = await resolveLineChannel(input.workspaceId);
    if (!channel) {
      throw new FormSendError('Channel Line belum dikonfigurasi untuk workspace ini.', 409);
    }
    if (!channel.isActive) {
      throw new FormSendError('Channel Line sedang dijeda (nonaktif).', 409);
    }
    const identifier = phone ? await findOptedInChannel(input.workspaceId, 'line', phone) : null;
    if (!identifier) {
      throw new FormSendError('Customer belum terhubung ke Line atau sudah berhenti berlangganan.', 409);
    }
    externalId = identifier;
    send = async () => {
      // Push message ke userId Line — teks undangan form (tanpa tombol).
      await linePushMessage({
        accessToken: channel.accessToken,
        to: identifier,
        messages: lineBuildMessages(text),
      });
      return { providerMessageId: null };
    };
  } else {
    if (!contact.email) {
      throw new FormSendError('Kontak belum memiliki alamat email.', 400);
    }
    externalId = contact.email;
    send = async () => {
      const html = [
        `<p>${text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br/>')}</p>`,
        '<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0"/>',
        '<p style="color:#6b7280;font-size:12px">Butuh bantuan? Balas email ini atau hubungi kami langsung.</p>',
      ].join('');
      const { data, error } = await resend.emails.send({
        from: brand.emailFrom,
        to: [contact.email!],
        subject: `Formulir: ${input.formName?.trim() || 'undangan form'}`,
        html,
      });
      if (error) {
        throw new FormSendError(`Resend gagal mengirim email: ${error.message}`, 502);
      }
      return { providerMessageId: data?.id ?? null };
    };
  }

  const conversationId = await upsertConversation({
    workspaceId: input.workspaceId,
    channelType: input.channel,
    externalId,
    customerName: contact.name,
  });
  if (!conversationId) {
    throw new FormSendError('Gagal menyiapkan percakapan.', 500);
  }

  // Dedup: undangan yang sama sudah pernah terkirim → tidak kirim ulang.
  // Cek SEBELUM mencatat pesan/percakapan agar retry tidak menimpa timestamp.
  const [alreadySent] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.direction, 'outbound'),
        eq(messages.metadata, invitationMetadata),
      ),
    )
    .limit(1);
  if (alreadySent) return { sent: true, channel: input.channel, formUrl };

  // Catat 'queued' SEBELUM kirim — baris ini jadi jaring pengaman dedup retry.
  await db
    .insert(messages)
    .values({
      conversationId,
      channelType: input.channel,
      direction: 'outbound',
      providerMessageId: '',
      content: encryptMessageContent(input.workspaceId, text),
      status: 'queued',
      metadata: invitationMetadata,
    })
    .onConflictDoNothing();
  await db
    .update(conversations)
    .set({ lastMessageAt: new Date(), updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));

  let providerMessageId: string | null = null;
  try {
    const result = await send();
    providerMessageId = result.providerMessageId;
  } catch (error) {
    // Tandai gagal + map error provider ke pesan siap-tampil.
    await db
      .update(messages)
      .set({ status: 'failed' })
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.direction, 'outbound'),
          eq(messages.metadata, invitationMetadata),
        ),
      );
    if (error instanceof WhatsAppOutboundBlockedError) {
      // Guard BYO (banned / restricted kontak baru / kuota harian).
      throw new FormSendError(`WhatsApp (BYO) outbound dijeda: ${error.message}`, 409);
    }
    if (error instanceof WhatsAppApiError) {
      // Meta menolak pesan teks bebas di luar 24h customer service window —
      // kasus paling umum saat MEMULAI percakapan. Beri tahu user dengan jelas.
      throw new FormSendError(
        `WhatsApp menolak pesan: ${error.message} (pesan bebas hanya terkirim dalam 24 jam sejak customer terakhir menghubungi Anda).`,
        502,
      );
    }
    if (error instanceof WahaApiError) {
      // Gateway BYO menolak (mis. 463 reachout timelock / session mati).
      throw new FormSendError(`WhatsApp (BYO) gagal mengirim: ${error.message}`, 502);
    }
    if (error instanceof TelegramApiError) {
      throw new FormSendError(`Telegram menolak pesan: ${error.message}`, 502);
    }
    if (error instanceof LineApiError) {
      throw new FormSendError(`Line menolak pesan: ${error.message}`, 502);
    }
    throw error;
  }

  await db
    .update(messages)
    .set({ status: 'sent', providerMessageId: providerMessageId ?? '' })
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.direction, 'outbound'),
        eq(messages.metadata, invitationMetadata),
      ),
    );

  return { sent: true, channel: input.channel, formUrl };
}
