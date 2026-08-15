import { and, eq, gte, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  canonicalPhone,
  normalizePhone,
  parseSlotTime,
  parseWhatsAppWebhook,
  renderAlreadyHandledReply,
  renderBookingNotFoundReply,
  renderBookingReminder,
  renderBusinessInfoReply,
  renderCancelReply,
  renderConfirmReply,
  renderFormInvitation,
  renderGenericReply,
  renderNoFormReply,
  renderOptOutReply,
  renderRescheduleCancelled,
  renderRescheduleInvalid,
  renderReschedulePrompt,
  renderRescheduleSuccess,
  samePhone,
  type BotLanguage,
  type CanonicalInboundEvent,
  type WhatsAppWebhookPayload,
} from '@oriole/messaging';
import {
  bookings as bookingsTable,
  conversations,
  customerChannels,
  messages,
  workspaceIntegrations,
  workspaces,
} from '@oriole/database';

import {
  formPublicUrl,
  formPublicUrlForCustomer,
  FORM_INTEGRATION_TYPES,
  type FormIntegrationType,
} from './form-links.ts';
import { tryAiChatReply } from './ai-chat.ts';
import { encryptMessageContent } from './message-encryption.ts';

import { db } from '../db/index.ts';
import { withBookingTitle } from './booking-title.ts';
import { env } from './env.ts';
import { emitBookingCancelled, emitBookingCreated } from './reminders.ts';
import {
  resolveWhatsAppChannel,
  sendWhatsAppMessage,
  type WhatsAppChannelConfig,
  WhatsAppOutboundBlockedError,
} from '../services/whatsapp.ts';

const CHANNEL = 'whatsapp';

/** Error bisnis dengan pesan siap-tampil (dipetakan route → 400). */
export class WhatsAppDispatchError extends Error {}

/**
 * Proses satu payload webhook WhatsApp (Meta/360dialog).
 * Berbeda dari Telegram: `wa_id` = nomor HP customer, jadi identitas
 * langsung diketahui — chat auto-terhubung ke booking via nomor.
 */
export async function handleWhatsAppUpdate(
  workspaceId: string,
  payload: WhatsAppWebhookPayload,
): Promise<{ handled: boolean; events: number }> {
  const events = parseWhatsAppWebhook(payload);
  if (events.length === 0) return { handled: false, events: 0 };

  // Bahasa balasan = preferensi workspace (callGoalLanguage, default 'en')
  // — di-resolve paralel dengan channel agar tidak menambah latensi.
  const [channel, language] = await Promise.all([
    resolveWhatsAppChannel(workspaceId),
    findWorkspaceLanguage(workspaceId),
  ]);
  if (!channel) return { handled: false, events: events.length };

  for (const event of events) {
    const conversation = await getOrCreateConversation(workspaceId, event);
    await recordInboundMessage(workspaceId, conversation.id, event);

    const reply = await applyInboundIntent(workspaceId, conversation, event, channel.provider, language);
    if (reply?.text) {
      // Idempotensi balasan: skip bila wamid yang sama sudah pernah dibalas.
      // Dibandingkan via path jsonb (->>'replyToWamid') agar metadata tambahan
      // (mis. `ai: true` untuk balasan AI chat) tidak mematahkan dedup.
      const [alreadyReplied] = await db
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversation.id),
            eq(messages.direction, 'outbound'),
            eq(sql`${messages.metadata}->>'replyToWamid'`, event.providerEventId),
          ),
        )
        .limit(1);

      if (!alreadyReplied) {
        // Balasan AI chat ditandai `ai: true` di metadata agar terlihat di
        // inbox sebagai pesan AI (audit jawaban otomatis).
        const metadata = reply.ai
          ? { replyToWamid: event.providerEventId, ai: true }
          : { replyToWamid: event.providerEventId };
        // Catat 'queued' SEBELUM kirim agar retry Inngest tidak mengirim ulang
        // (dedup membaca baris ini meski send belum selesai).
        await recordOutboundMessage(workspaceId, conversation.id, reply.text, '', metadata, 'queued');

        // Dispatch provider-aware: 360dialog → interactive/text; BYO (waha)
        // → sendText polos (tombol reply engine-dependent, fallback teks).
        //
        // Intent booking BYO kini berfungsi penuh: WAHA mengirim tekan tombol
        // sebagai teks polos (label-nya) — parseWhatsAppWebhook memetakan
        // keyword label itu ('ya hadir'/'batal'/'ubah jadwal' dll) ke intent,
        // dan handler me-resolve booking dari percakapan. Hanya outbound
        // interaktif yang tetap text-only untuk BYO.
        try {
          const sent = await sendWhatsAppMessage({
            channel,
            to: event.senderIdentifier,
            text: reply.text,
            buttons: reply.buttons,
            replyTo: event.providerEventId,
          });

          await db
            .update(messages)
            .set({ status: 'sent', providerMessageId: sent.messageId ?? event.providerEventId })
            .where(
              and(
                eq(messages.conversationId, conversation.id),
                eq(messages.direction, 'outbound'),
                eq(messages.metadata, metadata),
              ),
            );
        } catch (error) {
          if (error instanceof WhatsAppOutboundBlockedError) {
            // Guard BYO menolak (banned / restricted kontak baru / kuota) —
            // tandai gagal dan jangan retry (bukan error provider sementara).
            console.warn(`[whatsapp] outbound diblokir: ${error.message}`);
            await db
              .update(messages)
              .set({ status: 'failed' })
              .where(
                and(
                  eq(messages.conversationId, conversation.id),
                  eq(messages.direction, 'outbound'),
                  eq(messages.metadata, metadata),
                ),
              );
          } else {
            throw error;
          }
        }
      }
    }
  }

  return { handled: true, events: events.length };
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
  event: CanonicalInboundEvent,
): Promise<ConversationRow> {
  const [existing] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.workspaceId, workspaceId),
        eq(conversations.channelType, CHANNEL),
        eq(conversations.externalId, event.senderIdentifier),
      ),
    )
    .limit(1);
  if (existing) return existing;

  const bookingId = event.bookingId ?? (await resolveBookingByPhone(workspaceId, event.senderIdentifier));
  const customerName = bookingId
    ? await bookingCustomerName(workspaceId, bookingId)
    : (event.senderName ?? null);
  const [created] = await db
    .insert(conversations)
    .values({
      workspaceId,
      bookingId,
      channelType: CHANNEL,
      externalId: event.senderIdentifier,
      customerName,
      status: 'active',
    })
    .returning();
  return created;
}

/** Cari booking aktif terbaru untuk nomor (wa_id) ini. */
async function resolveBookingByPhone(workspaceId: string, waId: string): Promise<string | null> {
  const phone = normalizePhone(waId);
  if (!phone) return null;
  const rows = await db
    .select({ id: bookingsTable.id, phone: bookingsTable.phone })
    .from(bookingsTable)
    .where(
      and(
        eq(bookingsTable.workspaceId, workspaceId),
        isNotNull(bookingsTable.phone),
        inArray(bookingsTable.status, ['pending', 'confirmed']),
      ),
    )
    .limit(200);
  return rows.find((row) => row.phone && samePhone(row.phone, phone))?.id ?? null;
}

/**
 * Cari booking AKAN DATANG (status aktif, jadwal masa depan) untuk nomor
 * (wa_id) ini — dipakai auto-reply proaktif saat customer mengirim pesan
 * bebas. Diprioritaskan ke jadwal terdekat; lewati yang sudah lewat.
 */
async function findUpcomingBookingByPhone(workspaceId: string, waId: string) {
  const phone = normalizePhone(waId);
  if (!phone) return null;
  const now = new Date();
  const rows = await db
    .select()
    .from(bookingsTable)
    .where(
      and(
        eq(bookingsTable.workspaceId, workspaceId),
        isNotNull(bookingsTable.phone),
        inArray(bookingsTable.status, ['pending', 'confirmed']),
        gte(bookingsTable.scheduledAt, now),
      ),
    )
    .orderBy(bookingsTable.scheduledAt)
    .limit(200);
  const match = rows.find((row) => row.phone && samePhone(row.phone, phone));
  // Title booking = nama layanan katalog (kolom title sudah dihapus).
  return match ? withBookingTitle(workspaceId, match) : null;
}

async function recordInboundMessage(
  workspaceId: string,
  conversationId: string,
  event: CanonicalInboundEvent,
): Promise<void> {
  // Hanya bump unread/lastMessageAt bila baris BENAR-BENAR baru (bukan retry).
  const [inserted] = await db
    .insert(messages)
    .values({
      conversationId,
      channelType: CHANNEL,
      direction: 'inbound',
      providerMessageId: event.providerEventId,
      content: encryptMessageContent(workspaceId, event.content),
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

async function recordOutboundMessage(
  workspaceId: string,
  conversationId: string,
  content: string,
  providerMessageId: string,
  metadata?: Record<string, unknown>,
  status: 'queued' | 'sent' | 'failed' = 'sent',
): Promise<void> {
  await db
    .insert(messages)
    .values({
      conversationId,
      channelType: CHANNEL,
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

interface Reply {
  text: string;
  buttons?: { id: string; label: string }[];
  /** true = balasan hasil AI chat — dicatat dengan metadata `ai: true`. */
  ai?: boolean;
}

/**
 * State machine — sama dengan Telegram:
 * opt-out > tombol booking (confirm/cancel/reschedule) > keyword teks BYO
 * (intent booking tanpa callback-data — booking di-resolve dari percakapan)
 * > text (awaiting-time).
 * Tidak ada alur "ketik nomor": identitas sudah diketahui dari wa_id.
 */
async function applyInboundIntent(
  workspaceId: string,
  conversation: ConversationRow,
  event: CanonicalInboundEvent,
  provider: WhatsAppChannelConfig['provider'],
  language: BotLanguage,
): Promise<Reply | null> {
  const state = (conversation.state ?? {}) as { step?: string };

  if (event.intent === 'opt-out') {
    await db
      .update(customerChannels)
      .set({ isOptedIn: false, optedOutAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(customerChannels.workspaceId, workspaceId),
          eq(customerChannels.channelType, CHANNEL),
          eq(customerChannels.identifier, event.senderIdentifier),
        ),
      );
    await db
      .update(conversations)
      .set({ status: 'closed', state: null, updatedAt: new Date() })
      .where(eq(conversations.id, conversation.id));
    return { text: renderOptOutReply(language) };
  }

  // Auto-link: nomor WhatsApp = identitas customer. HORMATI opt-out yang
  // sudah ada — user yang pernah STOP tidak boleh di-re-opt-in hanya karena
  // mengirim pesan apa pun (baru link pertama / status opt-in tetap).
  const phone = normalizePhone(event.senderIdentifier);
  if (phone) {
    const [existing] = await db
      .select({ id: customerChannels.id, isOptedIn: customerChannels.isOptedIn })
      .from(customerChannels)
      .where(
        and(
          eq(customerChannels.workspaceId, workspaceId),
          eq(customerChannels.channelType, CHANNEL),
          eq(customerChannels.identifier, event.senderIdentifier),
        ),
      )
      .limit(1);

    // Simpan KANONIK (kode negara, tanpa 0 depan) agar pencocokan SQL by
    // contactPhone konsisten dengan format booking/kontak mana pun.
    const canonical = canonicalPhone(phone) ?? phone;
    if (!existing) {
      await db
        .insert(customerChannels)
        .values({
          workspaceId,
          channelType: CHANNEL,
          identifier: event.senderIdentifier,
          contactPhone: canonical,
          source: CHANNEL,
        })
        .onConflictDoNothing();
    } else if (existing.isOptedIn) {
      await db
        .update(customerChannels)
        .set({ contactPhone: canonical, updatedAt: new Date() })
        .where(eq(customerChannels.id, existing.id));
    }
    // else: sudah opt-out — biarkan, jangan re-enable.
  }

  if (state.step === 'awaiting-time') {
    // Keyword 'batal' (WhatsApp BYO) selama menunggu waktu baru = membatalkan
    // PERUBAHAN jadwal, bukan booking — sama dengan ketik "Batal" di alur lama
    // (renderReschedulePrompt). Tombol booking (confirm/reschedule) tetap
    // diproses handleBookingAction di bawah (callback-data maupun keyword).
    if (event.intent === 'cancel') {
      await db
        .update(conversations)
        .set({ status: 'active', state: null, updatedAt: new Date() })
        .where(eq(conversations.id, conversation.id));
      return { text: renderRescheduleCancelled(language) };
    }
    if (event.intent === 'text') {
      return handleRescheduleTimeInput(workspaceId, conversation, event, language);
    }
  }

  // Intent booking dari tombol (callback-data membawa bookingId) ATAU keyword
  // teks BYO (tanpa bookingId — di-resolve dari percakapan yang ter-link ke
  // booking via nomor saat getOrCreateConversation).
  const bookingId = event.bookingId ?? conversation.bookingId;
  if (
    bookingId &&
    (event.intent === 'confirm' || event.intent === 'cancel' || event.intent === 'reschedule')
  ) {
    return handleBookingAction(workspaceId, conversation, event, bookingId, language);
  }

  // Minta booking baru → kirim tautan form terintegrasi (Google Forms /
  // Tally). Tanpa form aktif → handoff staf (needsAttention) + balasan.
  if (event.intent === 'booking-request') {
    return handleBookingRequest(workspaceId, conversation, event, language);
  }

  // Teks bebas: cari booking AKAN DATANG untuk nomor ini. Utamakan
  // conversation.bookingId, TAPI fallback ke pencarian by nomor bila booking
  // itu sudah selesai/dibatalkan (status non-aktif) — jangan biarkan booking
  // lama menghalangi tawaran booking baru yang akan datang.
  if (event.intent === 'text') {
    let booking = conversation.bookingId
      ? await findBooking(workspaceId, conversation.bookingId)
      : null;
    if (!booking || (booking.status !== 'pending' && booking.status !== 'confirmed')) {
      booking = await findUpcomingBookingByPhone(workspaceId, event.senderIdentifier);
    }

    if (booking && (booking.status === 'pending' || booking.status === 'confirmed')) {
      const businessName = await findBusinessName(workspaceId);
      const reminder = renderBookingReminder(
        {
          businessName: businessName ?? 'kami',
          customerName: booking.customerName,
          title: booking.title,
          scheduledAt: booking.scheduledAt.toISOString(),
          timezone: booking.timezone,
          videoLink: booking.videoLink,
        },
        booking.id,
      );
      // BYO (waha) tidak mengirim tombol → buang baris ajakan tombol yang
      // tidak akan muncul, lalu sematkan keyword aksi di teks agar customer
      // tahu cara membalas (label tombol dipetakan ke intent oleh
      // parseWhatsAppWebhook — lihat keyword BYO di parse.ts). Pola sama
      // dengan dispatchWhatsAppReminder.
      if (provider === 'waha') {
        reminder.text =
          reminder.text.replace(/\n+(Silakan konfirmasi kehadiran Anda:|Please confirm your attendance:)\s*$/, '') +
          (language === 'id'
            ? '\n\nBalas: *Ya hadir* / *Ubah jadwal* / *Batalkan*'
            : '\n\nReply: *Yes, I will attend* / *Reschedule* / *Cancel*');
      }
      return reminder;
    }

    // AI Booking Agent: jawab layanan/harga/jam/lokasi dari retrieval
    // tenant-scoped + gunakan booking tools (slot/booking live) bila diminta.
    // null = AI mati / gagal → lanjut handoff lama. Identitas (wa_id) & state
    // disuntikkan server-side agar tool booking tidak bergantung tebakan LLM.
    const aiReply = await tryAiChatReply(workspaceId, conversation.id, language, {
      customerPhone: event.senderIdentifier,
      customerName: conversation.customerName ?? event.senderName,
      state: conversation.state,
      providerEventId: event.providerEventId,
    });
    if (aiReply) return aiReply;

    // Tanpa booking aktif → handoff staf/AI + info bisnis workspace.
    await markNeedsAttention(conversation.id);
    return { text: await renderBusinessInfoForWorkspace(workspaceId, language) };
  }

  return { text: renderGenericReply(language) };
}

/**
 * Minta booking → balas dengan tautan form terintegrasi (Google Forms /
 * Tally) via renderFormInvitation. Tanpa form aktif → tandai percakapan
 * needsAttention (terlihat staf di inbox) dan balas dengan pesan handoff.
 * Idempotensi balasan otomatis lewat metadata replyToWamid (pola sama).
 */
async function handleBookingRequest(
  workspaceId: string,
  conversation: ConversationRow,
  event: CanonicalInboundEvent,
  language: BotLanguage,
): Promise<Reply> {
  const form = await findActiveFormIntegration(workspaceId);
  if (!form) {
    await markNeedsAttention(conversation.id);
    return { text: renderNoFormReply(language) };
  }
  const businessName = await findBusinessName(workspaceId);
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
        customerName: conversation.customerName ?? event.senderName ?? null,
        formName: form.formName?.trim() || 'formulir',
        // Tally: prefill nomor dari wa_id pengirim (WhatsApp = nomor HP) +
        // nama customer (bila dikenal) + token chat asal → konfirmasi
        // otomatis setelah submission (kanal Telegram dikirim via webhook).
        formUrl: formPublicUrlForCustomer(
          form.integrationType,
          form.formId,
          event.senderIdentifier,
          conversation.customerName ?? event.senderName ?? null,
          event.senderIdentifier,
        ),
      },
      language,
    ),
  };
}

/**
 * Integrasi form aktif pertama (prioritas Google Forms, lalu Tally) yang
 * punya formId — dipakai bot untuk mengirim tautan saat customer minta booking.
 * Diekspor agar handler Telegram (dan channel lain) memakai alur yang sama.
 */
export async function findActiveFormIntegration(workspaceId: string): Promise<{
  integrationType: FormIntegrationType;
  formId: string;
  formName: string | null;
} | null> {
  const rows = await db
    .select({
      integrationType: workspaceIntegrations.integrationType,
      providerConfig: workspaceIntegrations.providerConfig,
    })
    .from(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, workspaceId),
        inArray(workspaceIntegrations.integrationType, [...FORM_INTEGRATION_TYPES]),
        eq(workspaceIntegrations.isActive, true),
      ),
    )
    // 'google-forms' < 'tally' abjad → prioritas Google Forms dulu.
    .orderBy(workspaceIntegrations.integrationType)
    .limit(10);
  for (const row of rows) {
    const config = (row.providerConfig ?? {}) as { formId?: unknown; formName?: unknown };
    if (typeof config.formId === 'string' && config.formId.trim().length > 0) {
      return {
        integrationType: row.integrationType as FormIntegrationType,
        formId: config.formId,
        formName: typeof config.formName === 'string' ? config.formName : null,
      };
    }
  }
  return null;
}

async function handleRescheduleTimeInput(
  workspaceId: string,
  conversation: ConversationRow,
  event: CanonicalInboundEvent,
  language: BotLanguage,
): Promise<Reply> {
  // Catatan: teks "batal" TIDAK tiba di sini untuk WhatsApp — parser
  // memetakannya ke intent 'cancel' yang ditangani applyInboundIntent
  // (membatalkan PERUBAHAN jadwal). Telegram punya jalur sendiri.
  if (!conversation.bookingId) {
    await db
      .update(conversations)
      .set({ status: 'active', state: null, updatedAt: new Date() })
      .where(eq(conversations.id, conversation.id));
    return { text: renderBookingNotFoundReply(language) };
  }

  const booking = await findBooking(workspaceId, conversation.bookingId);
  if (!booking) return { text: renderBookingNotFoundReply(language) };

  const newTime = parseSlotTime(event.content, booking.timezone);
  if (!newTime) return { text: renderRescheduleInvalid(language) };

  await db
    .update(bookingsTable)
    .set({ scheduledAt: newTime, changeRequested: false, updatedAt: new Date() })
    .where(eq(bookingsTable.id, booking.id));
  await db
    .update(conversations)
    .set({ status: 'active', state: null, updatedAt: new Date() })
    .where(eq(conversations.id, conversation.id));
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

async function handleBookingAction(
  workspaceId: string,
  conversation: ConversationRow,
  event: CanonicalInboundEvent,
  bookingId: string,
  language: BotLanguage,
): Promise<Reply> {
  const booking = await findBooking(workspaceId, bookingId);
  if (!booking) return { text: renderBookingNotFoundReply(language) };

  if (event.intent === 'confirm') {
    if (booking.status === 'cancelled' || booking.status === 'completed' || booking.status === 'confirmed') {
      return { text: renderAlreadyHandledReply(language) };
    }
    await db
      .update(bookingsTable)
      .set({ status: 'confirmed', updatedAt: new Date() })
      .where(eq(bookingsTable.id, booking.id));
    await db
      .update(conversations)
      .set({
        bookingId: booking.id,
        customerName: booking.customerName ?? conversation.customerName,
        status: 'active',
        state: null,
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conversation.id));
    return { text: renderConfirmReply(booking.scheduledAt.toISOString(), booking.timezone, language) };
  }

  if (event.intent === 'cancel') {
    if (booking.status === 'cancelled') return { text: renderAlreadyHandledReply(language) };
    await db
      .update(bookingsTable)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(eq(bookingsTable.id, booking.id));
    await db
      .update(conversations)
      .set({ status: 'active', state: null, updatedAt: new Date() })
      .where(eq(conversations.id, conversation.id));
    // Batalkan reminder terjadwal untuk booking ini.
    await emitBookingCancelled(workspaceId, booking.id);
    return { text: renderCancelReply(booking.title, language) };
  }

  if (event.intent === 'reschedule') {
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
 * Outbound — reminder via Message Template (wajib di luar 24h window)
 * ──────────────────────────────────────────────────────────── */

export async function dispatchWhatsAppReminder(input: {
  workspaceId: string;
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
  templateName?: string;
  /** Bahasa balasan — default mengikuti preferensi workspace (callGoalLanguage). */
  language?: BotLanguage;
}): Promise<void> {
  const phone = normalizePhone(input.booking.phone);
  if (!phone) {
    throw new WhatsAppDispatchError('Booking belum memiliki nomor telepon customer.');
  }
  const language = input.language ?? (await findWorkspaceLanguage(input.workspaceId));

  // Cari chat WhatsApp customer: identifier = wa_id = nomor HP. contactPhone
  // baru tersimpan kanonik → query pertama memakai index; fallback scan
  // menangani baris lama berformat lokal (0xx).
  const canonical = canonicalPhone(phone);
  let chat: { identifier: string } | undefined;
  if (canonical) {
    const [row] = await db
      .select({ identifier: customerChannels.identifier })
      .from(customerChannels)
      .where(
        and(
          eq(customerChannels.workspaceId, input.workspaceId),
          eq(customerChannels.channelType, CHANNEL),
          eq(customerChannels.contactPhone, canonical),
          eq(customerChannels.isOptedIn, true),
        ),
      )
      .limit(1);
    chat = row;
  }
  if (!chat) {
    const rows = await db
      .select({ identifier: customerChannels.identifier, contactPhone: customerChannels.contactPhone })
      .from(customerChannels)
      .where(
        and(
          eq(customerChannels.workspaceId, input.workspaceId),
          eq(customerChannels.channelType, CHANNEL),
          eq(customerChannels.isOptedIn, true),
        ),
      )
      .limit(200);
    chat = rows.find((row) => row.contactPhone && samePhone(row.contactPhone, phone));
  }
  if (!chat) {
    throw new WhatsAppDispatchError('Customer belum terhubung ke WhatsApp (belum pernah membalas).');
  }

  const channel = await resolveWhatsAppChannel(input.workspaceId);
  if (!channel) {
    throw new WhatsAppDispatchError('Channel WhatsApp belum dikonfigurasi untuk workspace ini.');
  }
  if (!channel.isActive) {
    throw new WhatsAppDispatchError('Channel WhatsApp sedang dijeda (nonaktif).');
  }

  // Siapkan percakapan DULU agar dedup bisa dicek sebelum kirim template
  // (cegah duplikat saat retry Inngest setelah send-without-response).
  const [existing] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.workspaceId, input.workspaceId),
        eq(conversations.channelType, CHANNEL),
        eq(conversations.externalId, chat.identifier),
      ),
    )
    .limit(1);

  let conversationId = existing?.id;
  if (!conversationId) {
    const [created] = await db
      .insert(conversations)
      .values({
        workspaceId: input.workspaceId,
        bookingId: input.booking.id,
        channelType: CHANNEL,
        externalId: chat.identifier,
        customerName: input.booking.customerName,
        status: 'active',
      })
      .returning({ id: conversations.id });
    conversationId = created?.id;
  } else {
    await db
      .update(conversations)
      .set({
        bookingId: input.booking.id,
        customerName: input.booking.customerName,
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conversationId));
  }

  if (!conversationId) return;

  // Dedup: template reminder untuk booking ini sudah pernah dikirim.
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
  if (alreadySent) return;

  // Provider-aware: 360dialog memakai Message Template (satu-satunya cara di
  // luar 24h window); BYO (waha) mengirim teks polos — unofficial client tidak
  // punya template/24h window (spikes/waha/README.md §mapping), dan teks
  // dicatat apa adanya ke inbox (bukan placeholder template).
  let sent: Awaited<ReturnType<typeof sendWhatsAppMessage>>;
  let outboundContent: string;
  if (channel.provider === 'waha') {
    const reminder = renderBookingReminder(
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
    // BYO tidak punya tombol — buang paragraf ajakan konfirmasi yang
    // merujuk tombol yang tidak akan muncul (renderBookingReminder menambahkan
    // baris itu khusus untuk interactive buttons).
    const reminderText = reminder.text.replace(
      /\n+(Silakan konfirmasi kehadiran Anda:|Please confirm your attendance:)\s*$/,
      '',
    );
    try {
      sent = await sendWhatsAppMessage({ channel, to: chat.identifier, text: reminderText });
    } catch (error) {
      if (error instanceof WhatsAppOutboundBlockedError) {
        // Guard BYO menolak — skip reminder tanpa retry Inngest (bukan error
        // provider sementara; retry hanya akan memblokir lagi).
        throw new WhatsAppDispatchError(`Outbound WhatsApp (BYO) diblokir: ${error.message}`);
      }
      throw error;
    }
    outboundContent = reminderText;
  } else {
    const templateName =
      input.templateName ?? env.WHATSAPP_TEMPLATE_REMINDER ?? 'booking_reminder';

    // Template harus punya body dengan params posisional:
    // {{1}} nama customer, {{2}} judul, {{3}} waktu terformat.
    const when = new Intl.DateTimeFormat('id-ID', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: input.booking.timezone,
    }).format(input.booking.scheduledAt);

    sent = await sendWhatsAppMessage({
      channel,
      to: chat.identifier,
      text: '',
      template: {
        name: templateName,
        language: 'id',
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: input.booking.customerName ?? 'Anda' },
              { type: 'text', text: input.booking.title },
              { type: 'text', text: when },
            ],
          },
        ],
      },
    });
    outboundContent = `[template:${templateName}] reminder dikirim`;
  }

  // Catat pengiriman ke percakapan (unified inbox) + dedup.
  await db
    .insert(messages)
    .values({
      conversationId,
      channelType: CHANNEL,
      direction: 'outbound',
      providerMessageId: sent.messageId ?? '',
      content: encryptMessageContent(input.workspaceId, outboundContent),
      status: 'sent',
      metadata: reminderMetadata,
    })
    .onConflictDoNothing();
  await db
    .update(conversations)
    .set({ lastMessageAt: new Date(), updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));
}

/* ────────────────────────────────────────────────────────────
 * Helpers DB
 * ──────────────────────────────────────────────────────────── */

/** Nama customer dari booking (denormalized ke conversations untuk inbox). */
async function bookingCustomerName(workspaceId: string, bookingId: string): Promise<string | null> {
  const [booking] = await db
    .select({ customerName: bookingsTable.customerName })
    .from(bookingsTable)
    .where(and(eq(bookingsTable.id, bookingId), eq(bookingsTable.workspaceId, workspaceId)))
    .limit(1);
  return booking?.customerName ?? null;
}

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

async function findBooking(workspaceId: string, bookingId: string) {
  const [row] = await db
    .select()
    .from(bookingsTable)
    .where(and(eq(bookingsTable.id, bookingId), eq(bookingsTable.workspaceId, workspaceId)))
    .limit(1);
  // Title booking = nama layanan katalog (kolom title sudah dihapus).
  return row ? withBookingTitle(workspaceId, row) : null;
}

async function findBusinessName(workspaceId: string): Promise<string | null> {
  // Workspace soft-deleted → null (caller fallback ke "kami").
  const [workspace] = await db
    .select({ name: workspaces.name })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)))
    .limit(1);
  return workspace?.name ?? null;
}

/** Bahasa balasan bot — setting `chatLanguage` workspace (default 'en'). */
async function findWorkspaceLanguage(workspaceId: string): Promise<BotLanguage> {
  const [workspace] = await db
    .select({ chatLanguage: workspaces.chatLanguage })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return workspace?.chatLanguage === 'id' ? 'id' : 'en';
}

/**
 * Balasan info bisnis untuk pesan bebas TANPA booking aktif: nama bisnis +
 * industri workspace, plus tautan form booking bila ada integrasi form aktif
 * (Google Forms/Tally). Ini pengganti balasan generik — customer langsung
 * tahu siapa yang diajak bicara dan cara membuat booking.
 */
async function renderBusinessInfoForWorkspace(
  workspaceId: string,
  language: BotLanguage,
): Promise<string> {
  const [workspace] = await db
    .select({ name: workspaces.name, industry: workspaces.industry })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)))
    .limit(1);

  const form = await findActiveFormIntegration(workspaceId);
  return renderBusinessInfoReply(
    {
      businessName: workspace?.name ?? 'kami',
      industry: workspace?.industry ?? null,
      bookingUrl: form ? formPublicUrl(form.integrationType, form.formId) : null,
    },
    language,
  );
}
