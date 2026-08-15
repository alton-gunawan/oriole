import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  canonicalPhone,
  normalizePhone,
  parseSlotTime,
  renderAlreadyHandledReply,
  renderAskPhoneReply,
  renderBookingNotFoundReply,
  renderBookingReceivedReply,
  renderBookingReminder,
  renderCancelReply,
  renderConfirmReply,
  renderFormInvitation,
  renderGenericReply,
  renderLinkedReply,
  renderNoBookingReply,
  renderNoFormReply,
  renderOptOutReply,
  renderRescheduleCancelled,
  renderRescheduleInvalid,
  renderReschedulePrompt,
  renderRescheduleSuccess,
  renderReviewRequest,
  renderWaitlistBookedReply,
  renderWaitlistDeclinedReply,
  samePhone,
  type BotLanguage,
  type CanonicalInboundEvent,
  type ChannelType,
} from '@oriole/messaging';
import {
  bookings as bookingsTable,
  conversations,
  customerChannels,
  messages,
  workspaces,
} from '@oriole/database';

import { db } from '../db/index.ts';
import { tryAiChatReply } from './ai-chat.ts';
import { withBookingTitle } from './booking-title.ts';
import { formPublicUrlForCustomer } from './form-links.ts';
import { encryptMessageContent } from './message-encryption.ts';
import { emitBookingCancelled, emitBookingCreated } from './reminders.ts';
import {
  bookWaitlistOffer,
  emitWaitlistSlotFreed,
  findOfferedForChat,
  markWaitlistDeclined,
} from './waitlist.ts';
import { findActiveFormIntegration } from './whatsapp-handler.ts';

/**
 * Mesin percakapan lintas channel (Telegram, Line, WhatsApp, ...).
 *
 * Semua logika state machine + DB di sini agnostik terhadap provider — hanya
 * butuh (1) CanonicalInboundEvent dari parser per-channel, dan (2) sebuah
 * `send` callback yang mengirim balasan lewat API provider. Tujuannya: satu
 * implementasi alur booking, tidak ada drift antar channel.
 *
 * Bagian yang TETAP spesifik per channel (resolve kredensial, parsing,
 * ack callback, format tombol) hidup di adapter masing-masing
 * (telegram-handler.ts, line-handler.ts, ...).
 */

/** Balasan terstruktur — diterjemahkan ke format channel oleh adapter. */
export interface ChatEngineReply {
  text: string;
  buttons?: { id: string; label: string }[];
  /** Tombol "bagikan kontak/nomor" — hanya didukung channel yang punya (Telegram). */
  requestContact?: { label: string };
  /** Teks pendek pengganti template tombol bila `text` melebihi batas channel
   *  (mis. 160 karakter template Line) — opsional. */
  shortPrompt?: string;
  /** true = balasan hasil AI chat — dicatat dengan metadata `ai: true`. */
  ai?: boolean;
}

export interface ChatEngineSendInput {
  workspaceId: string;
  conversationId: string;
  recipient: string;
  reply: ChatEngineReply;
  metadata: Record<string, unknown>;
}

export type ChatEngineSender = (
  input: ChatEngineSendInput,
) => Promise<{ providerMessageId: string | null }>;

export interface ChatEngineDeps {
  channel: ChannelType;
  /** Nama kunci metadata outbound untuk dedup balasan (mis. 'replyToUpdateId'). */
  replyMetadataKey: string;
  /** Resolve channel workspace; null = belum dikonfigurasi. */
  resolveChannel(workspaceId: string): Promise<{ isActive: boolean } | null>;
  /** Kirim balasan outbound (record queued → provider send → update status). */
  send: ChatEngineSender;
  /** Efek samping spesifik channel setelah channel ter-resolve (mis. ack callback Telegram). */
  onChannelReady?(channel: { isActive: boolean }): void;
}

/** Error bisnis dispatch dengan pesan siap-tampil (dipetakan route → 400). */
export class ChatDispatchError extends Error {
  constructor(
    message: string,
    readonly channelLabel: string,
  ) {
    super(message);
    this.name = 'ChatDispatchError';
  }
}

/**
 * Proses satu event masuk (CanonicalInboundEvent) melalui state machine
 * percakapan. Alur:
 * resolve channel → (onChannelReady) → get/create percakapan + bahasa →
 * record inbound → intent (+ dedup balasan paralel) → kirim balasan.
 */
export async function processInboundEvent(
  workspaceId: string,
  parsed: CanonicalInboundEvent,
  providerEventId: string,
  deps: ChatEngineDeps,
): Promise<{ handled: boolean; reason?: string }> {
  const channel = await deps.resolveChannel(workspaceId);
  if (!channel) return { handled: false, reason: 'no-channel' };
  if (!channel.isActive) return { handled: false, reason: 'channel-disabled' };
  deps.onChannelReady?.(channel);

  // Bahasa balasan = preferensi workspace (callGoalLanguage, default 'en').
  // Di-resolve paralel dengan lookup percakapan agar tidak menambah latensi.
  const [conversation, language] = await Promise.all([
    getOrCreateConversation(workspaceId, parsed, deps.channel),
    findWorkspaceLanguage(workspaceId),
  ]);
  await recordInboundMessage(workspaceId, conversation.id, parsed, providerEventId, deps.channel);

  // Intent dijalankan dulu (balasan bisa membawa flag `ai` yang ikut menjadi
  // bagian metadata dedup) — pola sama dengan handler WhatsApp.
  const reply = await applyInboundIntent(
    workspaceId,
    conversation,
    parsed,
    language,
    deps.channel,
    providerEventId,
  );

  if (reply?.text) {
    // Balasan AI ditandai `ai: true` di metadata agar terlihat di inbox
    // sebagai pesan AI (audit jawaban otomatis).
    const metadata = reply.ai
      ? { [deps.replyMetadataKey]: providerEventId, ai: true }
      : { [deps.replyMetadataKey]: providerEventId };
    const alreadyReplied = await hasReplyForUpdate(conversation.id, metadata);
    if (!alreadyReplied) {
      await deps.send({
        workspaceId,
        conversationId: conversation.id,
        recipient: parsed.senderIdentifier,
        reply,
        metadata,
      });
    }
  }

  return { handled: true };
}

/** Apakah event ini sudah pernah dibalas (dedup retry Inngest)? */
async function hasReplyForUpdate(
  conversationId: string,
  metadata: Record<string, unknown>,
): Promise<boolean> {
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.direction, 'outbound'),
        eq(messages.metadata, metadata),
      ),
    )
    .limit(1);
  return Boolean(row);
}

interface ConversationRow {
  id: string;
  bookingId: string | null;
  state: Record<string, unknown> | null;
  status: string;
  customerName: string | null;
}

async function getOrCreateConversation(
  workspaceId: string,
  parsed: CanonicalInboundEvent,
  channel: ChannelType,
): Promise<ConversationRow> {
  const [existing] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.workspaceId, workspaceId),
        eq(conversations.channelType, channel),
        eq(conversations.externalId, parsed.senderIdentifier),
      ),
    )
    .limit(1);
  if (existing) return existing;

  const bookingId = parsed.bookingId ?? (await resolveBookingByChat(workspaceId, parsed.senderIdentifier, channel));
  const customerName = bookingId
    ? await bookingCustomerName(workspaceId, bookingId)
    : (parsed.senderName ?? null);
  const [created] = await db
    .insert(conversations)
    .values({
      workspaceId,
      bookingId,
      channelType: channel,
      externalId: parsed.senderIdentifier,
      customerName,
      status: 'active',
    })
    .returning();
  return created;
}

/** Cari booking terbaru untuk chat: via contactPhone yang sudah terhubung. */
async function resolveBookingByChat(
  workspaceId: string,
  chatId: string,
  channel: ChannelType,
): Promise<string | null> {
  const [channelRow] = await db
    .select({ contactPhone: customerChannels.contactPhone })
    .from(customerChannels)
    .where(
      and(
        eq(customerChannels.workspaceId, workspaceId),
        eq(customerChannels.channelType, channel),
        eq(customerChannels.identifier, chatId),
        eq(customerChannels.isOptedIn, true),
      ),
    )
    .limit(1);
  if (!channelRow?.contactPhone) return null;

  const rows = await db
    .select({ id: bookingsTable.id, phone: bookingsTable.phone })
    .from(bookingsTable)
    .where(and(eq(bookingsTable.workspaceId, workspaceId), isNotNull(bookingsTable.phone)))
    .limit(200);
  const match = rows.find((row) => row.phone && samePhone(row.phone, channelRow.contactPhone));
  return match?.id ?? null;
}

async function recordInboundMessage(
  workspaceId: string,
  conversationId: string,
  parsed: CanonicalInboundEvent,
  providerMessageId: string,
  channel: ChannelType,
): Promise<void> {
  // onConflictDoNothing: event id sama (retry) tidak boleh double-record.
  // Hanya bump unread/lastMessageAt bila baris BENAR-BENAR baru (bukan retry).
  const [inserted] = await db
    .insert(messages)
    .values({
      conversationId,
      channelType: channel,
      direction: 'inbound',
      providerMessageId,
      content: encryptMessageContent(workspaceId, parsed.content),
      status: 'sent',
    })
    .onConflictDoNothing()
    .returning({ id: messages.id });

  if (inserted) {
    await db
      .update(conversations)
      .set({ unreadCount: sql`${conversations.unreadCount} + 1`, lastMessageAt: new Date(), updatedAt: new Date() })
      .where(eq(conversations.id, conversationId));
  }
}

/** Catat pesan outbound — dipakai sendWithStatus (status 'queued' lalu 'sent'). */
export async function recordOutboundMessage(
  workspaceId: string,
  conversationId: string,
  content: string,
  providerMessageId: string,
  channel: ChannelType,
  metadata?: Record<string, unknown>,
  status: 'queued' | 'sent' | 'failed' = 'sent',
): Promise<void> {
  await db
    .insert(messages)
    .values({
      conversationId,
      channelType: channel,
      direction: 'outbound',
      providerMessageId,
      content: encryptMessageContent(workspaceId, content),
      status,
      metadata: metadata ?? null,
    })
    .onConflictDoNothing();

  await db
    .update(conversations)
    .set({ lastMessageAt: new Date(), updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));
}

/**
 * Pola kirim outbound yang aman terhadap retry Inngest: catat 'queued'
 * SEBELUM kirim (retry tidak mengirim ulang), lalu update status 'sent'
 * dengan providerMessageId setelah berhasil. Dipakai adapter di dalam
 * deps.send.
 */
export async function sendWithStatus(input: {
  workspaceId: string;
  conversationId: string;
  channel: ChannelType;
  recipient: string;
  reply: ChatEngineReply;
  metadata: Record<string, unknown>;
  providerSend(reply: ChatEngineReply): Promise<{ providerMessageId: string | null }>;
}): Promise<{ providerMessageId: string | null }> {
  await recordOutboundMessage(
    input.workspaceId,
    input.conversationId,
    input.reply.text,
    '',
    input.channel,
    input.metadata,
    'queued',
  );

  const sent = await input.providerSend(input.reply);

  await db
    .update(messages)
    .set({ status: 'sent', providerMessageId: String(sent.providerMessageId) })
    .where(
      and(
        eq(messages.conversationId, input.conversationId),
        eq(messages.direction, 'outbound'),
        eq(messages.metadata, input.metadata),
      ),
    );

  return sent;
}

/**
 * State machine percakapan:
 * - intent tombol (confirm/cancel/reschedule) → aksi booking langsung.
 * - `awaiting-phone` → user mengirim nomor → link chat ke customer.
 * - `awaiting-time`  → user mengirim waktu baru → reschedule booking.
 * - `opt-out`        → matikan channel, tutup percakapan.
 */
async function applyInboundIntent(
  workspaceId: string,
  conversation: ConversationRow,
  parsed: CanonicalInboundEvent,
  language: BotLanguage,
  channel: ChannelType,
  providerEventId: string,
): Promise<ChatEngineReply | null> {
  const state = (conversation.state ?? {}) as { step?: string };

  // 1. Opt-out selalu menang.
  if (parsed.intent === 'opt-out') {
    // Dua update independen — jalan paralel (hemat 1 round trip DB).
    await Promise.all([
      db
        .update(customerChannels)
        .set({ isOptedIn: false, optedOutAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(customerChannels.workspaceId, workspaceId),
            eq(customerChannels.channelType, channel),
            eq(customerChannels.identifier, parsed.senderIdentifier),
          ),
        ),
      db
        .update(conversations)
        .set({ status: 'closed', state: null, updatedAt: new Date() })
        .where(eq(conversations.id, conversation.id)),
    ]);
    return { text: renderOptOutReply(language) };
  }

  // 2. Kontak (request_contact Telegram) — nomor VERIFIED dari provider. Selalu
  //    coba link (di luar state machine): berbagi kontak adalah tindakan
  //    eksplisit user, valid walau tidak sedang di alur awaiting-phone.
  if (parsed.intent === 'contact') {
    return handlePhoneLink(workspaceId, conversation, parsed, language, channel);
  }

  // 2b. Balasan tawaran slot waitlist ("Ya"/"Tidak") — diperiksa SEBELUM
  //     state machine agar jawaban atas tawaran selalu diproses, tidak kalah
  //     oleh alur lain.
  if (parsed.intent === 'text') {
    const waitlistReply = await handleWaitlistOfferReply(workspaceId, conversation, parsed, language, channel);
    if (waitlistReply) return waitlistReply;
  }

  // 3. State machine dulu: input yang sedang ditunggu menang atas fallback
  //    "belum terhubung" (user yang sudah di tengah alur tidak boleh
  //    dilempar balik ke minta-nomor oleh branch di bawah).
  if (state.step === 'awaiting-phone' && parsed.intent === 'text') {
    return handlePhoneLink(workspaceId, conversation, parsed, language, channel);
  }
  if (state.step === 'awaiting-time' && parsed.intent === 'text') {
    return handleRescheduleTimeInput(workspaceId, conversation, parsed, language);
  }

  // 4. Intent tombol booking.
  if (parsed.bookingId) {
    return handleBookingAction(workspaceId, conversation, parsed, language);
  }

  // 4b. Permintaan booking baru ("mau booking") — arahkan ke form booking
  //     terintegrasi; tanpa form → handoff admin (needsAttention).
  if (parsed.intent === 'booking-request') {
    return handleBookingRequest(workspaceId, conversation, parsed, language);
  }

  // 5. Belum terhubung → minta nomor telepon.
  const linked = await isChatLinked(workspaceId, parsed.senderIdentifier, channel);
  if (parsed.intent === 'text' && !linked) {
    await db
      .update(conversations)
      .set({ state: { step: 'awaiting-phone' }, status: 'waiting_input', updatedAt: new Date() })
      .where(eq(conversations.id, conversation.id));
    // Balasan membawa request_contact (tombol "Bagikan Nomor") — dipakai
    // adapter channel yang mendukung (Telegram) untuk reply keyboard sekali pakai.
    return renderAskPhoneReply(language);
  }

  // 7. Teks biasa dengan konteks booking → kirim ulang reminder.
  //    Tetap tandai needsAttention agar staf/AI (inbox) bisa menindaklanjuti
  //    permintaan yang tidak tercakup tombol.
  if (parsed.intent === 'text' && conversation.bookingId) {
    const booking = await findBooking(workspaceId, conversation.bookingId);
    if (booking && (booking.status === 'pending' || booking.status === 'confirmed')) {
      const businessName = await findBusinessName(workspaceId);
      await markNeedsAttention(conversation.id);
      return renderBookingReminder(
        {
          businessName: businessName ?? 'kami',
          customerName: booking.customerName,
          title: booking.title,
          scheduledAt: booking.scheduledAt.toISOString(),
          timezone: booking.timezone,
          videoLink: booking.videoLink,
        },
        booking.id,
        language,
      );
    }
  }

  // 8. Pesan bebas → AI Booking Agent (RAG + tools) bila aktif. Customer yang
  //    sudah ter-link (punya nomor) mendapat alur booking penuh; tanpa nomor,
  //    AI tetap menjawab FAQ/layanan dari knowledge base (tool booking akan
  //    meminta nomor). null = AI mati/gagal → lanjut handoff lama.
  if (parsed.intent === 'text') {
    const customerPhone = await resolveChatPhone(workspaceId, parsed.senderIdentifier, channel);
    const aiReply = await tryAiChatReply(workspaceId, conversation.id, language, {
      customerPhone,
      customerName: conversation.customerName ?? parsed.senderName ?? null,
      state: conversation.state,
      providerEventId,
    });
    if (aiReply) return { text: aiReply.text, ai: true };
    await markNeedsAttention(conversation.id);
  }

  return { text: renderGenericReply(language) };
}

/** Nama customer dari booking (denormalized ke conversations untuk inbox). */
async function bookingCustomerName(workspaceId: string, bookingId: string): Promise<string | null> {
  const [booking] = await db
    .select({ customerName: bookingsTable.customerName })
    .from(bookingsTable)
    .where(and(eq(bookingsTable.id, bookingId), eq(bookingsTable.workspaceId, workspaceId)))
    .limit(1);
  return booking?.customerName ?? null;
}

/** Nomor HP customer dari channel yang sudah ter-link (untuk tool booking AI). */
async function resolveChatPhone(
  workspaceId: string,
  chatId: string,
  channel: ChannelType,
): Promise<string | null> {
  const [row] = await db
    .select({ contactPhone: customerChannels.contactPhone })
    .from(customerChannels)
    .where(
      and(
        eq(customerChannels.workspaceId, workspaceId),
        eq(customerChannels.channelType, channel),
        eq(customerChannels.identifier, chatId),
        eq(customerChannels.isOptedIn, true),
      ),
    )
    .limit(1);
  return row?.contactPhone ?? null;
}

async function isChatLinked(workspaceId: string, chatId: string, channel: ChannelType): Promise<boolean> {
  const [row] = await db
    .select({ id: customerChannels.id })
    .from(customerChannels)
    .where(
      and(
        eq(customerChannels.workspaceId, workspaceId),
        eq(customerChannels.channelType, channel),
        eq(customerChannels.identifier, chatId),
        eq(customerChannels.isOptedIn, true),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * User mengirim nomor HP (ketikan ATAU kontak request_contact) → cocokkan
 * dengan booking aktif di workspace.
 *
 * Tiga hasil:
 * - Bukan nomor valid       → minta ulang (tombol request_contact tetap ada).
 * - Cocok dengan booking    → link chat + upsert customerChannel (opt-in).
 * - Nomor valid, TANPA
 *   booking aktif            → tandai needsAttention + arahkan ke form booking
 *                             (bila ada) — customer yang mau booking dari awal
 *                             tidak boleh terjebak di loop "nomor tidak cocok".
 */
async function handlePhoneLink(
  workspaceId: string,
  conversation: ConversationRow,
  parsed: CanonicalInboundEvent,
  language: BotLanguage,
  channel: ChannelType,
): Promise<ChatEngineReply> {
  const phone = normalizePhone(parsed.content);
  if (!phone) {
    // Bukan nomor (kurang dari 6 digit) — tampilkan ulang keyboard + contoh
    // format, jangan balas "tidak cocok" yang menyesatkan.
    return renderAskPhoneReply(language);
  }

  // Satu query untuk cek keberadaan + ambil nama customer — hanya izinkan
  // link ke nomor yang punya booking aktif (mencegah klaim nomor
  // lama/customer lain lalu mengontrol booking-nya).
  const booking = await findActiveBookingByPhone(workspaceId, phone);
  if (!booking) {
    // Nomor valid tapi belum ada booking aktif → arahkan ke booking baru
    // (form terintegrasi bila ada) atau admin langsung (bila tidak ada form),
    // bukan penolakan mentah. Staf tetap melihat percakapan di inbox
    // (needsAttention).
    await markNeedsAttention(conversation.id);
    // Link chat ↔ nomor SEKARANG (opt-in): customer baru saja mengidentifikasi
    // dirinya dengan nomor ini. Konfirmasi "booking diterima" dari submission
    // form bisa menjangkaunya lewat nomor (fallback) walau form belum memuat
    // token chat — alih-alih diam tanpa kabar.
    await upsertCustomerChannel(workspaceId, parsed.senderIdentifier, phone, channel);
    const form = await findActiveFormIntegration(workspaceId);
    if (form?.integrationType === 'tally') {
      // Self-heal: form Tally yang belum punya hidden field token chat
      // diperbarui otomatis saat tautan dikirim (fire-and-forget, tidak
      // memblokir balasan).
      void import('./tally.ts')
        .then((m) => m.ensureTallyFormEnhanced(workspaceId))
        .catch(() => {});
    }
    return {
      text: renderNoBookingReply(
        // Tally: prefill nomor yang baru saja diketik customer (+ nama bila
        // dikenal) + token chat asal → konfirmasi otomatis setelah submission.
        form
          ? formPublicUrlForCustomer(
              form.integrationType,
              form.formId,
              phone,
              conversation.customerName ?? parsed.senderName ?? null,
              parsed.senderIdentifier,
            )
          : null,
        language,
      ),
    };
  }

  // Link chat + update percakapan independen — jalan paralel (hemat 1 round trip DB).
  await Promise.all([
    upsertCustomerChannel(workspaceId, parsed.senderIdentifier, phone, channel),
    db
      .update(conversations)
      .set({
        status: 'active',
        state: null,
        customerName: booking.customerName,
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conversation.id)),
  ]);
  return { text: renderLinkedReply(language) };
}

const WAITLIST_YES_RE = /^(ya|yes|oke|ok|okay|sure|yep|yeah|siap|boleh|mau)$/i;
const WAITLIST_NO_RE = /^(tidak|no|nope|skip|engga|nggak|gak|batal)$/i;

/**
 * Customer membalas tawaran slot waitlist ("Ya" → booking; "Tidak" → tolak).
 * Return null bila pesan bukan jawaban atas tawaran (lanjut alur normal).
 */
async function handleWaitlistOfferReply(
  workspaceId: string,
  conversation: ConversationRow,
  parsed: CanonicalInboundEvent,
  language: BotLanguage,
  channel: ChannelType,
): Promise<ChatEngineReply | null> {
  const content = parsed.content.trim();
  const yes = WAITLIST_YES_RE.test(content);
  const no = WAITLIST_NO_RE.test(content);
  if (!yes && !no) return null;

  const entry = await findOfferedForChat(workspaceId, channel, parsed.senderIdentifier);
  if (!entry) return null;

  if (no) {
    await markWaitlistDeclined(entry.id);
    return { text: renderWaitlistDeclinedReply(language) };
  }

  const phone = await resolveChatPhone(workspaceId, parsed.senderIdentifier, channel);
  const result = await bookWaitlistOffer({
    workspaceId,
    entry,
    customerName: conversation.customerName ?? entry.customerName,
    phone,
  });
  if (!result.ok) {
    // Slot sudah terisi / data tak lengkap → handoff agar staf menindaklanjuti.
    await markNeedsAttention(conversation.id);
    return { text: result.error };
  }

  return {
    text: renderWaitlistBookedReply(
      {
        customerName: result.customerName,
        serviceName: result.serviceName,
        scheduledAt: result.scheduledAt.toISOString(),
        timezone: result.timezone,
      },
      language,
    ),
  };
}

/**
 * Customer minta booking baru → balas dengan tautan form terintegrasi
 * (Google Forms / Tally) via renderFormInvitation. Tanpa form aktif → tandai
 * percakapan needsAttention (terlihat staf di inbox) + pesan handoff yang
 * jelas bahwa booking online belum diaktifkan.
 */
async function handleBookingRequest(
  workspaceId: string,
  conversation: ConversationRow,
  parsed: CanonicalInboundEvent,
  language: BotLanguage,
): Promise<ChatEngineReply> {
  const form = await findActiveFormIntegration(workspaceId);
  if (!form) {
    await markNeedsAttention(conversation.id);
    return { text: renderNoFormReply(language) };
  }
  const businessName = await findBusinessName(workspaceId);
  // Nomor HP customer untuk prefill: dari booking percakapan atau link chat.
  const phone = await resolveChatCustomerPhone(
    workspaceId,
    parsed.channel,
    parsed.senderIdentifier,
    conversation.bookingId,
  );
  if (form.integrationType === 'tally') {
    // Self-heal: form Tally yang belum punya hidden field token chat
    // diperbarui otomatis saat tautan dikirim (fire-and-forget).
    void import('./tally.ts')
      .then((m) => m.ensureTallyFormEnhanced(workspaceId))
      .catch(() => {});
  }
  return {
    text: renderFormInvitation(
      {
        businessName,
        customerName: conversation.customerName ?? parsed.senderName ?? null,
        formName: form.formName?.trim() || 'formulir',
        // Tally: prefill nomor + nama customer (bila dikenal) + token chat
        // asal → konfirmasi otomatis setelah submission.
        formUrl: formPublicUrlForCustomer(
          form.integrationType,
          form.formId,
          phone,
          conversation.customerName ?? parsed.senderName ?? null,
          parsed.senderIdentifier,
        ),
      },
      language,
    ),
  };
}

/**
 * Nomor HP customer untuk prefill form Tally — dari booking terakhir
 * percakapan, atau link chat (customerChannels) yang sudah terhubung.
 * Null bila tidak dikenal (URL polos tetap aman — parameter diabaikan Tally).
 */
async function resolveChatCustomerPhone(
  workspaceId: string,
  channel: ChannelType,
  chatId: string,
  bookingId: string | null,
): Promise<string | null> {
  if (bookingId) {
    const [booking] = await db
      .select({ phone: bookingsTable.phone })
      .from(bookingsTable)
      .where(eq(bookingsTable.id, bookingId))
      .limit(1);
    if (booking?.phone) return booking.phone;
  }
  const [linked] = await db
    .select({ contactPhone: customerChannels.contactPhone })
    .from(customerChannels)
    .where(
      and(
        eq(customerChannels.workspaceId, workspaceId),
        eq(customerChannels.channelType, channel),
        eq(customerChannels.identifier, chatId),
        eq(customerChannels.isOptedIn, true),
      ),
    )
    .limit(1);
  return linked?.contactPhone ?? null;
}

/** User mengirim waktu baru (state awaiting-time) → update booking. */
async function handleRescheduleTimeInput(
  workspaceId: string,
  conversation: ConversationRow,
  parsed: CanonicalInboundEvent,
  language: BotLanguage,
): Promise<ChatEngineReply> {
  if (/^batal$/i.test(parsed.content.trim())) {
    await db
      .update(conversations)
      .set({ status: 'active', state: null, updatedAt: new Date() })
      .where(eq(conversations.id, conversation.id));
    return { text: renderRescheduleCancelled(language) };
  }

  if (!conversation.bookingId) {
    await db
      .update(conversations)
      .set({ status: 'active', state: null, updatedAt: new Date() })
      .where(eq(conversations.id, conversation.id));
    return { text: renderBookingNotFoundReply(language) };
  }

  const booking = await findBooking(workspaceId, conversation.bookingId);
  if (!booking) return { text: renderBookingNotFoundReply(language) };

  const newTime = parseSlotTime(parsed.content, booking.timezone);
  if (!newTime) return { text: renderRescheduleInvalid(language) };

  // Permintaan ubah jadwal sudah dipenuhi → reset flag agar goal engine
  // tidak terus menyarankan reschedule-assistance.
  // Update booking + percakapan independen — jalan paralel (hemat 1 round trip DB).
  await Promise.all([
    db
      .update(bookingsTable)
      .set({ scheduledAt: newTime, changeRequested: false, updatedAt: new Date() })
      .where(eq(bookingsTable.id, booking.id)),
    db
      .update(conversations)
      .set({ status: 'active', state: null, updatedAt: new Date() })
      .where(eq(conversations.id, conversation.id)),
  ]);
  // Reminder terjadwal lama dibatalkan, yang baru dijadwalkan ulang.
  await emitBookingCancelled(workspaceId, booking.id);
  await emitBookingCreated({
    workspaceId,
    bookingId: booking.id,
    scheduledAt: newTime,
    timezone: booking.timezone,
  });
  return { text: renderRescheduleSuccess(newTime.toISOString(), booking.timezone, language) };
}

/** Intent dari tombol: confirm / cancel / reschedule. */
async function handleBookingAction(
  workspaceId: string,
  conversation: ConversationRow,
  parsed: CanonicalInboundEvent,
  language: BotLanguage,
): Promise<ChatEngineReply> {
  const booking = await findBooking(workspaceId, parsed.bookingId!);
  if (!booking) return { text: renderBookingNotFoundReply(language) };

  if (parsed.intent === 'confirm') {
    if (booking.status === 'cancelled' || booking.status === 'completed' || booking.status === 'confirmed') {
      return { text: renderAlreadyHandledReply(language) };
    }
    await db
      .update(bookingsTable)
      .set({ status: 'confirmed', updatedAt: new Date() })
      .where(eq(bookingsTable.id, booking.id));
    // Backfill link chat → customer (phone dari booking) + update percakapan
    // independen — jalan paralel (hemat 1 round trip DB).
    const phone = normalizePhone(booking.phone);
    await Promise.all([
      phone ? upsertCustomerChannel(workspaceId, parsed.senderIdentifier, phone, parsed.channel) : Promise.resolve(),
      db
        .update(conversations)
        .set({
          bookingId: booking.id,
          customerName: booking.customerName ?? conversation.customerName,
          status: 'active',
          state: null,
          updatedAt: new Date(),
        })
        .where(eq(conversations.id, conversation.id)),
    ]);
    return { text: renderConfirmReply(booking.scheduledAt.toISOString(), booking.timezone, language) };
  }

  if (parsed.intent === 'cancel') {
    if (booking.status === 'cancelled') return { text: renderAlreadyHandledReply(language) };
    // Update booking + percakapan independen — jalan paralel (hemat 1 round trip DB).
    await Promise.all([
      db
        .update(bookingsTable)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(eq(bookingsTable.id, booking.id)),
      db
        .update(conversations)
        .set({ status: 'active', state: null, updatedAt: new Date() })
        .where(eq(conversations.id, conversation.id)),
    ]);
    // Batalkan reminder terjadwal untuk booking ini, lalu tawarkan slot yang
    // dilepas ke customer daftar tunggu berikutnya (best-effort).
    await emitBookingCancelled(workspaceId, booking.id);
    await emitWaitlistSlotFreed({
      workspaceId,
      bookingId: booking.id,
      serviceId: booking.serviceId,
      staffId: booking.staffId,
      scheduledAt: booking.scheduledAt,
      durationMinutes: booking.durationMinutes ?? 60,
      timezone: booking.timezone,
    });
    return { text: renderCancelReply(booking.title, language) };
  }

  if (parsed.intent === 'reschedule') {
    if (booking.status === 'cancelled' || booking.status === 'completed') {
      return { text: renderAlreadyHandledReply(language) };
    }
    await db
      .update(conversations)
      .set({
        bookingId: booking.id,
        customerName: booking.customerName ?? conversation.customerName,
        status: 'waiting_input',
        state: { step: 'awaiting-time' },
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conversation.id));
    return { text: renderReschedulePrompt(language) };
  }

  return { text: renderGenericReply(language) };
}

/* ────────────────────────────────────────────────────────────
 * Outbound — kirim reminder / konfirmasi booking ke chat customer
 * ──────────────────────────────────────────────────────────── */

export interface BookingOutboundInput {
  workspaceId: string;
  channel: ChannelType;
  channelLabel: string;
  booking: {
    id: string;
    title: string;
    customerName: string | null;
    phone: string | null;
    scheduledAt: Date;
    timezone: string;
    videoLink: string | null;
  };
  businessName: string | null;
  /** Bahasa balasan — default mengikuti preferensi workspace (callGoalLanguage). */
  language?: BotLanguage;
  /**
   * Chat tujuan yang sudah diketahui (mis. token `orioleChatId` dari form
   * Tally) — konfirmasi dikirim langsung ke chat ini tanpa lookup nomor HP.
   * Caller bertanggung jawab memverifikasi chat milik workspace ini.
   */
  chatOverride?: { identifier: string } | null;
  deps: ChatEngineDeps;
}

/**
 * Kirim reminder booking ke chat customer yang sudah terhubung.
 * Dedup per booking (`reminderBookingId`) — retry Inngest tidak mengirim ulang.
 * Business error (channel belum dikonfigurasi / customer belum terhubung)
 * dilempar sebagai ChatDispatchError; error provider dibiarkan bubble
 * agar Inngest me-retry.
 */
export async function dispatchChannelReminder(input: BookingOutboundInput): Promise<{ messageId: string | null }> {
  const phone = normalizePhone(input.booking.phone);
  if (!phone) {
    throw new ChatDispatchError('Booking belum memiliki nomor telepon customer.', input.channelLabel);
  }
  const language = input.language ?? (await findWorkspaceLanguage(input.workspaceId));

  const chat = await findChatByPhone(input.workspaceId, phone, input.channel);
  if (!chat) {
    throw new ChatDispatchError('Customer belum terhubung ke bot.', input.channelLabel);
  }

  const channel = await input.deps.resolveChannel(input.workspaceId);
  if (!channel) {
    throw new ChatDispatchError(`Channel ${input.channelLabel} belum dikonfigurasi untuk workspace ini.`, input.channelLabel);
  }
  if (!channel.isActive) {
    throw new ChatDispatchError(`Channel ${input.channelLabel} sedang dijeda (nonaktif).`, input.channelLabel);
  }

  const conversationId = await ensureConversationForBooking(
    input.workspaceId,
    input.channel,
    chat.identifier,
    input.booking,
  );
  if (!conversationId) return { messageId: null };

  // Dedup: reminder untuk booking yang sama sudah pernah dikirim ke chat ini.
  const reminderMetadata = { reminderBookingId: input.booking.id };
  const [alreadySent] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.direction, 'outbound'),
        eq(messages.metadata, reminderMetadata),
      ),
    )
    .limit(1);
  if (alreadySent) return { messageId: null };

  const rendered = renderBookingReminder(
    {
      businessName: input.businessName ?? 'kami',
      customerName: input.booking.customerName,
      title: input.booking.title,
      scheduledAt: input.booking.scheduledAt.toISOString(),
      timezone: input.booking.timezone,
      videoLink: input.booking.videoLink,
    },
    input.booking.id,
    language,
  );

  const { providerMessageId } = await input.deps.send({
    workspaceId: input.workspaceId,
    conversationId,
    recipient: chat.identifier,
    reply: {
      text: rendered.text,
      buttons: rendered.buttons,
      // Teks reminder panjang (detail booking) — channel dengan batas template
      // (Line 160 karakter) memakai prompt pendek ini untuk tombol aksi.
      shortPrompt: language === 'id' ? 'Pilih aksi:' : 'Choose an action:',
    },
    metadata: reminderMetadata,
  });

  return { messageId: providerMessageId };
}

/**
 * Kirim permintaan ulasan ke chat customer setelah booking selesai.
 * Dedup terpisah (`reviewBookingId`) agar tidak tertukar dengan reminder /
 * konfirmasi. Pola resolve chat/channel/percakapan sama dengan reminder.
 */
export async function dispatchChannelReview(input: BookingOutboundInput): Promise<{ messageId: string | null }> {
  const phone = normalizePhone(input.booking.phone);
  if (!phone) {
    throw new ChatDispatchError('Booking belum memiliki nomor telepon customer.', input.channelLabel);
  }
  const language = input.language ?? (await findWorkspaceLanguage(input.workspaceId));

  const chat = await findChatByPhone(input.workspaceId, phone, input.channel);
  if (!chat) {
    throw new ChatDispatchError('Customer belum terhubung ke bot.', input.channelLabel);
  }

  const channel = await input.deps.resolveChannel(input.workspaceId);
  if (!channel) {
    throw new ChatDispatchError(`Channel ${input.channelLabel} belum dikonfigurasi untuk workspace ini.`, input.channelLabel);
  }
  if (!channel.isActive) {
    throw new ChatDispatchError(`Channel ${input.channelLabel} sedang dijeda (nonaktif).`, input.channelLabel);
  }

  const conversationId = await ensureConversationForBooking(
    input.workspaceId,
    input.channel,
    chat.identifier,
    input.booking,
  );
  if (!conversationId) return { messageId: null };

  // Dedup: ulasan untuk booking ini sudah pernah diminta ke chat ini.
  const reviewMetadata = { reviewBookingId: input.booking.id };
  const [alreadySent] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.direction, 'outbound'),
        eq(messages.metadata, reviewMetadata),
      ),
    )
    .limit(1);
  if (alreadySent) return { messageId: null };

  const text = renderReviewRequest(
    {
      businessName: input.businessName ?? 'kami',
      customerName: input.booking.customerName,
    },
    language,
  );

  const { providerMessageId } = await input.deps.send({
    workspaceId: input.workspaceId,
    conversationId,
    recipient: chat.identifier,
    reply: { text },
    metadata: reviewMetadata,
  });

  return { messageId: providerMessageId };
}

/**
 * Kirim konfirmasi "booking diterima" SEGERA ke chat customer yang sudah
 * terhubung (auto-respond saat booking dibuat dari submission form).
 * Dedup terpisah dari reminder (`confirmationBookingId`) supaya reminder
 * terjadwal tetap terkirim nanti. Pola resolve chat/channel/percakapan sama
 * dengan dispatchChannelReminder.
 */
export async function dispatchChannelConfirmation(
  input: BookingOutboundInput,
): Promise<{ messageId: string | null }> {
  const phone = normalizePhone(input.booking.phone);
  if (!phone) {
    throw new ChatDispatchError('Booking belum memiliki nomor telepon customer.', input.channelLabel);
  }
  const language = input.language ?? (await findWorkspaceLanguage(input.workspaceId));

  // Chat tujuan: override (token chat asal form — tanpa menunggu customer
  // kirim pesan lagi) atau lookup nomor HP yang sudah terhubung (lama).
  const chat = input.chatOverride ?? (await findChatByPhone(input.workspaceId, phone, input.channel));
  if (!chat) {
    throw new ChatDispatchError('Customer belum terhubung ke bot.', input.channelLabel);
  }

  // Kuatkan tautan chat ↔ nomor (opt-in): begitu konfirmasi terkirim ke chat
  // ini, reminder/review/reengagement berikutnya bisa menjangkaunya lewat
  // nomor — tidak perlu token URL lagi.
  if (input.booking.phone) {
    await upsertCustomerChannel(input.workspaceId, chat.identifier, input.booking.phone, input.channel);
  }

  const channel = await input.deps.resolveChannel(input.workspaceId);
  if (!channel) {
    throw new ChatDispatchError(`Channel ${input.channelLabel} belum dikonfigurasi untuk workspace ini.`, input.channelLabel);
  }
  if (!channel.isActive) {
    throw new ChatDispatchError(`Channel ${input.channelLabel} sedang dijeda (nonaktif).`, input.channelLabel);
  }

  const conversationId = await ensureConversationForBooking(
    input.workspaceId,
    input.channel,
    chat.identifier,
    input.booking,
  );
  if (!conversationId) return { messageId: null };

  // Dedup: konfirmasi untuk booking ini sudah pernah dikirim ke chat ini.
  const confirmationMetadata = { confirmationBookingId: input.booking.id };
  const [alreadySent] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.direction, 'outbound'),
        eq(messages.metadata, confirmationMetadata),
      ),
    )
    .limit(1);
  if (alreadySent) return { messageId: null };

  const rendered = renderBookingReceivedReply(
    {
      businessName: input.businessName ?? 'kami',
      customerName: input.booking.customerName,
      title: input.booking.title,
      scheduledAt: input.booking.scheduledAt.toISOString(),
      timezone: input.booking.timezone,
      videoLink: input.booking.videoLink,
    },
    language,
  );

  const { providerMessageId } = await input.deps.send({
    workspaceId: input.workspaceId,
    conversationId,
    recipient: chat.identifier,
    reply: { text: rendered },
    metadata: confirmationMetadata,
  });

  return { messageId: providerMessageId };
}

/**
 * Siapkan percakapan DULU agar dedup bisa dicek sebelum mengirim
 * (cegah duplikat saat Inngest me-retry step after send-without-response).
 */
async function ensureConversationForBooking(
  workspaceId: string,
  channel: ChannelType,
  chatIdentifier: string,
  booking: BookingOutboundInput['booking'],
): Promise<string | undefined> {
  const [existing] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.workspaceId, workspaceId),
        eq(conversations.channelType, channel),
        eq(conversations.externalId, chatIdentifier),
      ),
    )
    .limit(1);

  let conversationId: string | undefined = existing?.id;
  if (conversationId) {
    await db
      .update(conversations)
      .set({
        bookingId: booking.id,
        customerName: booking.customerName,
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conversationId));
  } else {
    const [created] = await db
      .insert(conversations)
      .values({
        workspaceId,
        bookingId: booking.id,
        channelType: channel,
        externalId: chatIdentifier,
        customerName: booking.customerName,
        status: 'active',
      })
      .returning({ id: conversations.id });
    if (created) conversationId = created.id;
  }

  return conversationId;
}

/* ────────────────────────────────────────────────────────────
 * Helpers DB
 * ──────────────────────────────────────────────────────────── */

/** Tandai percakapan butuh perhatian staf/AI (state.needsAttention). */
async function markNeedsAttention(conversationId: string): Promise<void> {
  const [row] = await db
    .select({ state: conversations.state })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  const state = { ...(row?.state ?? {}), needsAttention: true };
  await db
    .update(conversations)
    .set({ state, updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));
}

/** Booking aktif yang nomornya cocok (via nomor HP ternormalisasi). */
async function findActiveBookingByPhone(
  workspaceId: string,
  phone: string,
): Promise<{ customerName: string | null } | null> {
  const rows = await db
    .select({ phone: bookingsTable.phone, customerName: bookingsTable.customerName })
    .from(bookingsTable)
    .where(
      and(
        eq(bookingsTable.workspaceId, workspaceId),
        isNotNull(bookingsTable.phone),
        inArray(bookingsTable.status, ['pending', 'confirmed']),
      ),
    )
    .limit(200);
  const match = rows.find((row) => row.phone && samePhone(row.phone, phone));
  return match ? { customerName: match.customerName } : null;
}

/**
 * Cari chat identifier dari contactPhone yang sudah terhubung & opted-in.
 * contactPhone baru tersimpan kanonik (kode negara, tanpa 0 depan) → query
 * pertama memakai index (workspaceId, contactPhone). Fallback scan (bounded)
 * menangani baris lama yang tersimpan format lokal (0xx) sebelum normalisasi
 * kanonik — dibandingkan via samePhone agar format berbeda tetap cocok.
 */
export async function findChatByPhone(
  workspaceId: string,
  phone: string,
  channel: ChannelType,
): Promise<{ identifier: string } | null> {
  const canonical = canonicalPhone(phone);
  if (canonical) {
    const [row] = await db
      .select({ identifier: customerChannels.identifier })
      .from(customerChannels)
      .where(
        and(
          eq(customerChannels.workspaceId, workspaceId),
          eq(customerChannels.channelType, channel),
          eq(customerChannels.isOptedIn, true),
          eq(customerChannels.contactPhone, canonical),
        ),
      )
      .limit(1);
    if (row) return { identifier: row.identifier };
  }

  const rows = await db
    .select({ identifier: customerChannels.identifier, contactPhone: customerChannels.contactPhone })
    .from(customerChannels)
    .where(
      and(
        eq(customerChannels.workspaceId, workspaceId),
        eq(customerChannels.channelType, channel),
        eq(customerChannels.isOptedIn, true),
      ),
    )
    .limit(200);
  const match = rows.find((row) => row.contactPhone && samePhone(row.contactPhone, phone));
  return match ? { identifier: match.identifier } : null;
}

/** Simpan kanonik (kode negara, tanpa 0 depan) agar pencocokan SQL by
 *  contactPhone konsisten dengan format booking/kontak mana pun. */
export async function upsertCustomerChannel(
  workspaceId: string,
  chatId: string,
  contactPhone: string,
  channel: ChannelType,
): Promise<void> {
  const canonical = canonicalPhone(contactPhone) ?? contactPhone;
  await db
    .insert(customerChannels)
    .values({
      workspaceId,
      channelType: channel,
      identifier: chatId,
      contactPhone: canonical,
      source: channel,
    })
    .onConflictDoUpdate({
      target: [customerChannels.workspaceId, customerChannels.channelType, customerChannels.identifier],
      set: {
        contactPhone: canonical,
        isOptedIn: true,
        optedOutAt: null,
        updatedAt: new Date(),
      },
    });
}

/** Booking dengan title dari katalog layanan (via withBookingTitle). */
export async function findBooking(workspaceId: string, bookingId: string) {
  const [row] = await db
    .select()
    .from(bookingsTable)
    .where(and(eq(bookingsTable.id, bookingId), eq(bookingsTable.workspaceId, workspaceId)))
    .limit(1);
  return row ? withBookingTitle(workspaceId, row) : null;
}

/** Nama bisnis workspace — null bila workspace soft-deleted. */
export async function findBusinessName(workspaceId: string): Promise<string | null> {
  const [workspace] = await db
    .select({ name: workspaces.name })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)))
    .limit(1);
  return workspace?.name ?? null;
}

/** Bahasa balasan bot — setting `chatLanguage` workspace (default 'en'). */
export async function findWorkspaceLanguage(workspaceId: string): Promise<BotLanguage> {
  const [workspace] = await db
    .select({ chatLanguage: workspaces.chatLanguage })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return workspace?.chatLanguage === 'id' ? 'id' : 'en';
}
