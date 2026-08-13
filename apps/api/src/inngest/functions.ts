import { and, eq, isNull, or } from 'drizzle-orm';
import { bookings, calleCalls, paymentLinks, subscriptions, workspaces } from '@oriole/database';
import { brand } from '@oriole/config';
import type { TelegramUpdate, WhatsAppWebhookPayload } from '@oriole/messaging';

import { db } from '../db/index.ts';
import { resend } from '../services/email.ts';
import { handleTelegramUpdate } from '../lib/telegram-handler.ts';
import { handleWhatsAppUpdate } from '../lib/whatsapp-handler.ts';
import { dispatchTelegramReminder, TelegramDispatchError } from '../lib/telegram-handler.ts';
import { dispatchWhatsAppReminder, WhatsAppDispatchError } from '../lib/whatsapp-handler.ts';
import { dispatchEmailReminder, EmailDispatchError } from '../lib/email-reminder.ts';
import {
  computeAutoCallAt,
  emitBookingCompleted,
  type BookingEventData,
  type AutoCallEventData,
} from '../lib/reminders.ts';
import { placeAutoCall } from '../lib/auto-call.ts';
import { withBookingTitle } from '../lib/booking-title.ts';
import { purgeExpiredWorkspaces } from '../lib/workspace-lifecycle.ts';
import { listActiveFormIntegrations, syncFormResponsesToContacts } from '../lib/google-forms.ts';
import {
  syncTallySubmissionToContacts,
  type TallyWebhookPayload,
} from '../lib/tally.ts';
import {
  deleteBookingCalendarEvent,
  upsertBookingCalendarEvent,
} from '../lib/google-calendar.ts';
import { dispatchOutgoingWebhook } from '../lib/outgoing-webhooks.ts';
import { dispatchSlackNotification } from '../lib/slack.ts';
import { emitOutgoingWebhookEvent, emitSlackBookingEvent } from '../lib/integration-events.ts';
import { createZoomLinkForBooking } from '../lib/video.ts';
import { handleMetaMessagingEvent } from '../lib/meta-handler.ts';
import type { MetaMessagingEvent } from '@oriole/messaging';
import { listWahaChannels, probeWahaChannelHealth } from '../lib/waha-health.ts';
import { mapEndedReason } from '../services/vapi.ts';
import {
  captureBookingEvent,
  captureCallEvent,
  capturePaymentEvent,
  getFeatureFlagValue,
} from '../lib/analytics.ts';
import type { VapiEventData } from '../lib/vapi-types.ts';
import { parseCallName } from '../lib/vapi-types.ts';
import { resolveInboundWorkspaceId } from '../lib/vapi-inbound.ts';
import { inngest } from './client.ts';

/**
 * Catatan API Inngest v4: `createFunction(options, handler)` — trigger
 * didefinisikan lewat `triggers: { event: '...' }` di dalam options
 * (bukan argumen terpisah seperti v3).
 */

/* ────────────────────────────────────────────────────────────
 * Vapi — event dari webhook /api/webhooks/vapi (end-of-call-report)
 * ──────────────────────────────────────────────────────────── */

/** Hasil step upsert — dibawa ke step berikutnya (primitif, aman serialisasi). */
interface VapiCallRef {
  callId: string;
  status: string | null;
  workspaceId?: string;
  bookingId?: string;
}

export const onVapiEvent = inngest.createFunction(
  { id: 'vapi-event-received', triggers: { event: 'vapi/event.received' } },
  async ({ event, step }) => {
    const { payload } = event.data as VapiEventData;
    const message = payload.message;
    const call = message?.call;
    const callId = call?.id;
    if (!callId) return { skipped: 'no-call-id' };

    // Map endedReason → status aplikasi (completed/failed/canceled).
    const status = mapEndedReason(message?.endedReason) ?? call?.status ?? null;

    // Durasi (detik) dihitung dari startedAt/endedAt call — Vapi tidak
    // selalu menyertakan duration di artifact pada SDK ini.
    let durationSeconds: number | null = null;
    if (call?.startedAt && call?.endedAt) {
      const seconds = Math.round(
        (new Date(call.endedAt).getTime() - new Date(call.startedAt).getTime()) / 1000,
      );
      if (Number.isFinite(seconds) && seconds >= 0) durationSeconds = seconds;
    }

    const callRef = await step.run('upsert-vapi-call', async (): Promise<VapiCallRef> => {
      // Cari record yang dibuat saat call ditempatkan (calleCallId = Vapi id).
      const [row] = await db
        .select({ bookingId: calleCalls.bookingId, workspaceId: calleCalls.workspaceId, userId: calleCalls.userId })
        .from(calleCalls)
        .where(eq(calleCalls.calleCallId, callId))
        .limit(1);

      // Fallback: call dibuat di luar alur commit (mis. create sukses tapi
      // commit DB gagal, atau call ter-orphan dari reservasi yang dibersihkan)
      // — rekonstruksi dari nama panggilan (`booking:<id>:...`).
      // Panggilan MASUK (inbound) punya workspace tapi TANPA booking —
      // di-resolve dari nomor Vapi (vapi_inbound_numbers) agar terekam di
      // riwayat panggilan & analytics (bookingId null).
      let bookingId = row?.bookingId ?? null;
      let workspaceId = row?.workspaceId ?? null;
      let userId = row?.userId ?? null;
      if (!row) {
        const { bookingId: parsedBookingId } = parseCallName(call?.name);
        if (parsedBookingId) {
          const [booking] = await db
            .select({ workspaceId: bookings.workspaceId, userId: bookings.userId, phone: bookings.phone })
            .from(bookings)
            .where(eq(bookings.id, parsedBookingId))
            .limit(1);
          if (booking) {
            bookingId = parsedBookingId;
            workspaceId = booking.workspaceId;
            userId = booking.userId;
          }
        } else if (call?.phoneNumberId) {
          const inboundWorkspaceId = await resolveInboundWorkspaceId(call.phoneNumberId);
          if (inboundWorkspaceId) {
            workspaceId = inboundWorkspaceId;
            const [workspace] = await db
              .select({ userId: workspaces.userId })
              .from(workspaces)
              .where(eq(workspaces.id, inboundWorkspaceId))
              .limit(1);
            userId = workspace?.userId ?? null;
          }
        }
      }
      if (!workspaceId) {
        console.warn(`[vapi] call ${callId} bukan milik aplikasi, skip upsert`);
        return { callId, status };
      }

      const result = {
        endedReason: message?.endedReason ?? null,
        status,
        durationSeconds,
        transcript: message?.artifact?.transcript ?? null,
        recordingUrl: message?.artifact?.recordingUrl ?? null,
        call: {
          id: callId,
          startedAt: call?.startedAt ?? null,
          endedAt: call?.endedAt ?? null,
        },
      };
      // Upsert: baris yang ada di-update (goalType/task dipertahankan — hanya
      // `set` yang diterapkan), baris yang hilang (fallback) dibuat ulang agar
      // outcome panggilan tidak pernah lenyap.
      await db
        .insert(calleCalls)
        .values({
          calleCallId: callId,
          userId,
          workspaceId,
          bookingId,
          phone: call?.customer?.number ?? '',
          status,
          result,
        })
        .onConflictDoUpdate({
          target: calleCalls.calleCallId,
          set: { status, result, updatedAt: new Date() },
        });

      return {
        callId,
        status,
        workspaceId: workspaceId ?? undefined,
        bookingId: bookingId ?? undefined,
      };
    });

    const bookingCompleted = await step.run('complete-linked-booking', async () => {
      // Hanya tandai booking 'completed' jika panggilan berakhir sukses
      // (endedReason dipetakan ke completed). Status lain dibiarkan agar
      // goal engine tetap bisa menyarankan follow-up (mis. final-follow-up).
      if (callRef.status !== 'completed' || !callRef.bookingId || !callRef.workspaceId) {
        return false;
      }
      // Update by bookingId, bukan calleCallId: menangani kasus parsial
      // (insert calle_calls gagal tapi booking update sukses di alur commit).
      // Guard tambahan: hanya complete bila booking belum punya panggilan lain
      // (bookings.calleCallId null = belum tercatat) ATAU panggilan ini masih
      // yang terakhir — eocr panggilan lama yang datang terlambat tidak
      // menimpa panggilan baru yang sedang berjalan.
      const [updated] = await db
        .update(bookings)
        .set({ status: 'completed', updatedAt: new Date() })
        .where(
          and(
            eq(bookings.id, callRef.bookingId),
            or(isNull(bookings.calleCallId), eq(bookings.calleCallId, callRef.callId)),
          ),
        )
        .returning({ id: bookings.id });
      if (!updated) return false;

      await emitBookingCompleted(callRef.workspaceId, callRef.bookingId);
      // Webhook keluar: booking selesai (dipicu dari Vapi, bukan route).
      await emitOutgoingWebhookEvent(callRef.workspaceId, 'booking.completed', {
        bookingId: callRef.bookingId,
        calleCallId: callRef.callId,
        status: 'completed',
      });
      await emitSlackBookingEvent(callRef.workspaceId, 'booking.completed', {
        bookingId: callRef.bookingId,
        calleCallId: callRef.callId,
        status: 'completed',
      });
      return true;
    });

    // Analitik (di body handler, bukan di dalam step — step bisa re-run saat
    // retry; event di sini dikirim tepat satu kali per eksekusi).
    if (callRef.workspaceId) {
      captureCallEvent(
        callRef.status === 'completed' ? 'call.completed' : 'call.failed',
        {
          workspaceId: callRef.workspaceId,
          bookingId: callRef.bookingId,
          callId: callRef.callId,
          status: callRef.status,
          durationSeconds,
          // Alasan berakhir (enum non-PII) — analitik AI call: kenapa
          // panggilan berakhir (customer-tidak-menjawab, selesai, dst).
          endedReason: message?.endedReason ?? null,
        },
      );
      // bookingCompleted hanya true bila bookingId ada (guard di step
      // 'complete-linked-booking'); guard ulang di sini agar TS narrowing
      // non-null bertahan.
      if (bookingCompleted && callRef.bookingId) {
        captureBookingEvent('booking.completed', {
          workspaceId: callRef.workspaceId,
          bookingId: callRef.bookingId,
          status: 'completed',
        });
      }
    }
  },
);

/* ────────────────────────────────────────────────────────────
 * Paddle — event dari webhook /api/webhooks/paddle
 * ──────────────────────────────────────────────────────────── */

type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid' | 'paused';

interface PaddleEventPayload {
  id: string;
  customer_id?: string;
  status?: string;
  current_period_end?: string;
  scheduled_change?: { action?: string };
  items?: { price?: { id?: string } }[];
  custom_data?: {
    user_id?: string;
    payment_link_id?: string;
    workspace_id?: string;
  };
  // Transaction (one-time payment link) fields
  customer?: { email?: string; name?: string };
  billed_at?: string;
}

interface PaddleEventData {
  eventId: string;
  eventType: string;
  payload: PaddleEventPayload;
}

function toSubscriptionStatus(raw?: string): SubscriptionStatus {
  switch (raw) {
    case 'canceled':
    case 'past_due':
    case 'paused':
    case 'unpaid':
    case 'trialing':
      return raw;
    default:
      return 'active';
  }
}

export const onPaddleEvent = inngest.createFunction(
  { id: 'paddle-event-received', triggers: { event: 'paddle/event.received' } },
  async ({ event, step }) => {
    const { eventType, payload } = event.data as PaddleEventData;

    // Payment link (one-time customer payment) — sync status link dari event
    // transaction.*. Idempotent: hanya pending → paid/canceled; link yang
    // sudah paid tidak pernah diubah oleh event lain.
    await step.run('sync-payment-link', async () => {
      const paymentLinkId = payload.custom_data?.payment_link_id;
      if (!paymentLinkId) return;

      const [link] = await db
        .select()
        .from(paymentLinks)
        .where(eq(paymentLinks.id, paymentLinkId))
        .limit(1);
      if (!link) {
        console.warn(`[paddle] payment link tidak ditemukan, skip sync: ${paymentLinkId}`);
        return;
      }
      // Workspace gate: jangan pernah ubah link di luar workspace event ini
      // (custom_data.workspace_id dikirim saat checkout dibuat).
      const workspaceId = payload.custom_data?.workspace_id;
      if (workspaceId && link.workspaceId !== workspaceId) {
        console.warn(`[paddle] payment link ${paymentLinkId} bukan milik workspace ${workspaceId}, skip sync`);
        return;
      }

      if (eventType === 'transaction.completed' && link.status === 'pending') {
        await db
          .update(paymentLinks)
          .set({
            status: 'paid',
            paddleTransactionId: payload.id,
            customerName: link.customerName ?? payload.customer?.name ?? null,
            customerEmail: link.customerEmail ?? payload.customer?.email ?? null,
            paidAt: payload.billed_at ? new Date(payload.billed_at) : new Date(),
            updatedAt: new Date(),
          })
          .where(eq(paymentLinks.id, link.id));
        console.log(`[paddle] payment link ${link.id} lunas (txn ${payload.id})`);
      } else if (eventType === 'transaction.canceled' && link.status === 'pending') {
        await db
          .update(paymentLinks)
          .set({ status: 'canceled', updatedAt: new Date() })
          .where(eq(paymentLinks.id, link.id));
      }
    });

    // Analitik pembayaran — di body handler agar tepat satu kali per event
    // Inngest (step bisa di-replay saat retry). `transaction.completed` dari
    // Paddle = customer sudah membayar; dipakai untuk metrik revenue.
    if (eventType === 'transaction.completed') {
      capturePaymentEvent('payment.completed', {
        workspaceId: payload.custom_data?.workspace_id,
        paymentLinkId: payload.custom_data?.payment_link_id,
        status: 'paid',
      });
    } else if (eventType === 'transaction.canceled') {
      capturePaymentEvent('payment.canceled', {
        workspaceId: payload.custom_data?.workspace_id,
        paymentLinkId: payload.custom_data?.payment_link_id,
        status: 'canceled',
      });
    } else if (eventType === 'subscription.active' && payload.custom_data?.user_id) {
      capturePaymentEvent('subscription.activated', {
        userId: payload.custom_data.user_id,
        status: payload.status,
      });
    } else if (eventType === 'subscription.canceled' && payload.custom_data?.user_id) {
      capturePaymentEvent('subscription.canceled', {
        userId: payload.custom_data.user_id,
        status: payload.status,
      });
    }

    await step.run('sync-subscription', async () => {
      // Hanya event subscription yang menyentuh tabel subscriptions — event
      // transaction.* (payment link) tidak punya custom_data.user_id.
      if (!eventType.startsWith('subscription.')) return;
      // user_id dikirim lewat `custom_data` saat checkout dibuat dari app kita.
      const userId = payload.custom_data?.user_id;
      if (!userId) {
        console.warn(`[paddle] event tanpa custom_data.user_id, skip sync: ${payload.id}`);
        return;
      }

      const status = toSubscriptionStatus(payload.status);
      const currentPeriodEnd = payload.current_period_end
        ? new Date(payload.current_period_end)
        : null;
      const cancelAtPeriodEnd = payload.scheduled_change?.action === 'cancel';

      await db
        .insert(subscriptions)
        .values({
          userId,
          paddleSubscriptionId: payload.id,
          paddleCustomerId: payload.customer_id,
          planId: payload.items?.[0]?.price?.id,
          priceId: payload.items?.[0]?.price?.id,
          status,
          currentPeriodEnd,
          cancelAtPeriodEnd,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: subscriptions.paddleSubscriptionId,
          set: {
            paddleCustomerId: payload.customer_id,
            planId: payload.items?.[0]?.price?.id,
            priceId: payload.items?.[0]?.price?.id,
            status,
            currentPeriodEnd,
            cancelAtPeriodEnd,
            updatedAt: new Date(),
          },
        });

      // Status 'canceled' sudah tertangani oleh upsert di atas
      // (toSubscriptionStatus memetakan payload.status).
      if (eventType === 'subscription.canceled') {
        console.warn(`[paddle] subscription dibatalkan: ${payload.id}`);
      }
    });
  },
);

/* ────────────────────────────────────────────────────────────
 * Email — dipicu event user/signed-up (lihat /api/triggers)
 * ──────────────────────────────────────────────────────────── */

/* ────────────────────────────────────────────────────────────
 * Telegram — event dari webhook /api/webhooks/telegram/:workspaceId
 * ──────────────────────────────────────────────────────────── */

interface TelegramEventData {
  workspaceId: string;
  update: TelegramUpdate;
}

/* ────────────────────────────────────────────────────────────
 * WhatsApp — event dari webhook /api/webhooks/whatsapp/:workspaceId
 * ──────────────────────────────────────────────────────────── */

interface WhatsAppEventData {
  workspaceId: string;
  payload: WhatsAppWebhookPayload;
}

export const onWhatsAppEvent = inngest.createFunction(
  { id: 'whatsapp-message-received', triggers: { event: 'whatsapp/message.received' } },
  async ({ event, step }) => {
    const { workspaceId, payload } = event.data as WhatsAppEventData;

    await step.run('handle-whatsapp-update', async () => {
      await handleWhatsAppUpdate(workspaceId, payload);
    });
  },
);

export const onTelegramEvent = inngest.createFunction(
  { id: 'telegram-message-received', triggers: { event: 'telegram/message.received' } },
  async ({ event, step }) => {
    const { workspaceId, update } = event.data as TelegramEventData;

    await step.run('handle-telegram-update', async () => {
      await handleTelegramUpdate(workspaceId, update);
    });
  },
);

/* ────────────────────────────────────────────────────────────
 * Tally — submission webhook → kontak (real-time)
 * Dipicu `tally/form.response` (route /api/webhooks/tally
 * sudah memverifikasi signature + dedup idempotency). Handler
 * idempotent (find-or-create by nomor) — retry aman.
 * ──────────────────────────────────────────────────────────── */

interface TallyEventData {
  workspaceId: string;
  payload: TallyWebhookPayload;
}

export const onTallySubmission = inngest.createFunction(
  { id: 'tally-form-response', triggers: { event: 'tally/form.response' } },
  async ({ event, step }) => {
    const { workspaceId, payload } = event.data as TallyEventData;
    const submissionId = payload?.data?.submissionId ?? payload?.data?.responseId;
    if (!workspaceId || !submissionId) {
      return { skipped: 'invalid-event' };
    }
    const result = await step.run('sync-tally-contact', () =>
      syncTallySubmissionToContacts(workspaceId, payload),
    );
    return result;
  },
);

/* ────────────────────────────────────────────────────────────
 * Automatic booking reminders (P1)
 * Dipicu `booking/created` (dikirim route bookings saat create /
 * reschedule), tidur sampai `reminderAt`, lalu kirim ke semua channel.
 * Dibatalkan oleh `booking/cancelled` / `booking/completed` (cancelOn).
 * ──────────────────────────────────────────────────────────── */

export const remindBooking = inngest.createFunction(
  {
    id: 'booking-reminder',
    triggers: { event: 'booking/created' },
    cancelOn: [
      { event: 'booking/cancelled', match: 'data.bookingId' },
      { event: 'booking/completed', match: 'data.bookingId' },
    ],
  },
  async ({ event, step }) => {
    const { bookingId, workspaceId, reminderAt, scheduledAt } = event.data as BookingEventData;

    if (!bookingId || !workspaceId || !reminderAt) return { skipped: 'invalid-event' };

    // Tidur sampai waktu reminder (langsung return bila sudah lewat).
    await step.sleepUntil('wait-for-reminder', new Date(reminderAt));

    // Guard ulang: booking mungkin dibatalkan / dijadwal ulang / dihapus
    // setelah event dibuat (jaring pengaman bila event cancel hilang).
    const booking = await step.run('load-booking', async () => {
      const [row] = await db
        .select()
        .from(bookings)
        .where(eq(bookings.id, bookingId))
        .limit(1);
      // Title diturunkan dari layanan katalog (kolom title sudah tidak ada).
      return row ? await withBookingTitle(workspaceId, row) : null;
    });

    if (!booking || booking.workspaceId !== workspaceId) {
      return { skipped: 'booking-not-found' };
    }
    if (booking.status !== 'pending' && booking.status !== 'confirmed') {
      return { skipped: `status-${booking.status}` };
    }
    // Guard jadwal: bila booking sudah di-reschedule sejak event dibuat, run
    // ini basi — run baru (dari emitBookingCreated saat reschedule) yang
    // bertanggung jawab mengirim. Cegah reminder waktu lama terkirim.
    if (new Date(booking.scheduledAt).getTime() !== new Date(scheduledAt).getTime()) {
      return { skipped: 'rescheduled' };
    }

    // Workspace soft-deleted (project dihapus user) → jangan kirim reminder
    // dari run lama; project sedang menunggu penghapusan permanen.
    const workspace = await step.run('load-business-name', async () => {
      const [ws] = await db
        .select({ name: workspaces.name, chatLanguage: workspaces.chatLanguage })
        .from(workspaces)
        .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)))
        .limit(1);
      return ws ?? null;
    });
    if (!workspace) {
      return { skipped: 'workspace-deleted' };
    }
    // Bahasa balasan reminder = setting chatLanguage workspace (default 'en').
    const reminderLanguage = workspace.chatLanguage === 'id' ? 'id' : 'en';

    // Feature flag kill-switch `reminders-enabled` (per-workspace) — matikan
    // semua reminder dari dashboard PostHog tanpa deploy. Fallback TRUE:
    // flag yang belum dibuat / PostHog down / tanpa key TIDAK boleh diam-diam
    // mematikan reminder (lihat getFeatureFlagValue — hanya nilai boolean
    // yang defined yang menimpa fallback).
    const remindersEnabled = await step.run('check-reminders-flag', () =>
      getFeatureFlagValue('reminders-enabled', `workspace:${workspaceId}`, {
        groups: { workspace: workspaceId },
        fallback: true,
      }),
    );
    if (!remindersEnabled) {
      return { skipped: 'flag-reminders-disabled' };
    }

    // Catatan: step.run mengubah output lewat middleware serialisasi —
    // timestamp keluar sebagai string ISO, konversi kembali ke Date di sini.
    const bookingInput = {
      id: booking.id,
      title: booking.title,
      customerName: booking.customerName,
      phone: booking.phone,
      scheduledAt: new Date(booking.scheduledAt),
      timezone: booking.timezone,
      videoLink: booking.videoLink,
    };
    const businessName = workspace?.name ?? null;


    // Tiap channel independen: error bisnis (channel belum dikonfigurasi /
    // customer belum terhubung) hanya dicatat, tidak menggagalkan channel lain.
    // Error provider (network / API) tetap dilempar agar Inngest me-retry.
    await step.run('dispatch-telegram-reminder', async () => {
      try {
        await dispatchTelegramReminder({
          workspaceId,
          booking: bookingInput,
          businessName,
          language: reminderLanguage,
        });
      } catch (error) {
        if (error instanceof TelegramDispatchError) {
          console.warn(`[reminder] telegram skip: ${error.message}`);
          return;
        }
        throw error;
      }
    });

    await step.run('dispatch-whatsapp-reminder', async () => {
      try {
        await dispatchWhatsAppReminder({
          workspaceId,
          booking: bookingInput,
          businessName,
          language: reminderLanguage,
        });
      } catch (error) {
        if (error instanceof WhatsAppDispatchError) {
          console.warn(`[reminder] whatsapp skip: ${error.message}`);
          return;
        }
        throw error;
      }
    });

    await step.run('dispatch-email-reminder', async () => {
      try {
        await dispatchEmailReminder({
          workspaceId,
          booking: bookingInput,
          businessName,
          language: reminderLanguage,
        });
      } catch (error) {
        if (error instanceof EmailDispatchError) {
          console.warn(`[reminder] email skip: ${error.message}`);
          return;
        }
        throw error;
      }
    });

    return { sent: true, bookingId };
  },
);

/* ────────────────────────────────────────────────────────────
 * Auto-call CALL-E otomatis (P1)
 * Dipicu `booking/auto-call/created` (dikirim route bookings saat create /
 * reschedule, dan saat setting auto-call workspace diubah), tidur sampai
 * `autoCallAt`, lalu menyusun goal & menempatkan panggilan. Dibatalkan oleh
 * `booking/auto-call/cancelled`, `booking/cancelled`, `booking/completed`.
 * ──────────────────────────────────────────────────────────── */

export const autoCallBooking = inngest.createFunction(
  {
    id: 'booking-auto-call',
    triggers: { event: 'booking/auto-call/created' },
    cancelOn: [
      { event: 'booking/auto-call/cancelled', match: 'data.bookingId' },
      { event: 'booking/cancelled', match: 'data.bookingId' },
      { event: 'booking/completed', match: 'data.bookingId' },
    ],
  },
  async ({ event, step }) => {
    const { bookingId, workspaceId, autoCallAt, scheduledAt } = event.data as AutoCallEventData;

    if (!bookingId || !workspaceId || !autoCallAt) return { skipped: 'invalid-event' };

    // Tidur sampai waktu auto-call (langsung return bila sudah lewat).
    await step.sleepUntil('wait-for-auto-call', new Date(autoCallAt));

    // Guard ulang: booking mungkin dibatalkan / dijadwal ulang / dihapus
    // sejak event dibuat (jaring pengaman bila event cancel hilang).
    const booking = await step.run('load-booking', async () => {
      const [row] = await db
        .select()
        .from(bookings)
        .where(eq(bookings.id, bookingId))
        .limit(1);
      return row ?? null;
    });

    if (!booking || booking.workspaceId !== workspaceId) {
      return { skipped: 'booking-not-found' };
    }
    if (booking.status !== 'pending' && booking.status !== 'confirmed') {
      return { skipped: `status-${booking.status}` };
    }
    if (new Date(booking.scheduledAt).getTime() !== new Date(scheduledAt).getTime()) {
      return { skipped: 'rescheduled' };
    }

    // Auto-call bisa saja dimatikan / lead hours diubah setelah event
    // dijadwalkan. Freshness guard: bila lead hours terkini menghasilkan waktu
    // panggil yang berbeda, run ini basi — run baru (dari re-schedule setting)
    // yang bertanggung jawab. Ini menggantikan race cancel/create.
    // Workspace soft-deleted → dianggap tidak ada (auto-call dibatalkan).
    const workspace = await step.run('load-auto-call-settings', async () => {
      const [ws] = await db
        .select({ autoCallEnabled: workspaces.autoCallEnabled, autoCallLeadHours: workspaces.autoCallLeadHours })
        .from(workspaces)
        .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)))
        .limit(1);
      return ws ?? null;
    });
    if (!workspace) return { skipped: 'workspace-not-found' };
    if (!workspace.autoCallEnabled) return { skipped: 'auto-call-disabled' };
    if (
      computeAutoCallAt(new Date(booking.scheduledAt), workspace.autoCallLeadHours).getTime() !==
      new Date(autoCallAt).getTime()
    ) {
      return { skipped: 'lead-changed' };
    }

    const result = await step.run('place-auto-call', async () =>
      placeAutoCall({
        workspaceId,
        bookingId,
        userId: booking.userId,
        reminderWindowHours: workspace.autoCallLeadHours,
        autoCallAt,
      }),
    );

    if (result.status === 'skipped') {
      console.warn(`[auto-call] skip ${bookingId}: ${result.reason}`);
      return { skipped: result.reason };
    }

    return { called: true, bookingId, callId: result.callId, goalType: result.goalType };
  },
);

/* ────────────────────────────────────────────────────────────
 * Google Forms — polling submission → kontak (P2)
 * Cron 5 menit: scan integrasi google-forms aktif, lalu sinkronkan
 * response baru (kursor lastSubmittedAt) menjadi kontak.
 * Kegagalan per-workspace dicatat & dilanjutkan (poller); tick
 * berikutnya mencoba lagi.
 * ──────────────────────────────────────────────────────────── */

export const syncGoogleForms = inngest.createFunction(
  { id: 'sync-google-forms', triggers: { cron: '*/5 * * * *' } },
  async ({ step }) => {
    const integrations = await step.run('list-active-form-integrations', () =>
      listActiveFormIntegrations(),
    );

    for (const integration of integrations) {
      await step.run(`sync-form-${integration.workspaceId}`, async () => {
        try {
          const result = await syncFormResponsesToContacts(
            integration.workspaceId,
            integration.config,
          );
          if (result.imported > 0 || result.skipped > 0) {
            console.warn(
              `[google-forms] ws ${integration.workspaceId}: ${result.imported} kontak baru, ${result.skipped} dilewati`,
            );
          }
        } catch (error) {
          // Kredensial dicabut / form dihapus — jangan gagalkan run; log saja.
          console.error(`[google-forms] sync gagal ws ${integration.workspaceId}:`, error);
        }
      });
    }
    return { workspaces: integrations.length };
  },
);

/* ────────────────────────────────────────────────────────────
 * Google Calendar — mirror booking → event (P2)
 * Dipicu `google-calendar/booking.changed` (route bookings saat create /
 * update / hapus). Inngest me-retry otomatis bila Google menolak.
 * ──────────────────────────────────────────────────────────── */

interface CalendarBookingEventData {
  workspaceId: string;
  bookingId: string;
  action: 'upsert' | 'delete';
}

export const syncCalendarBooking = inngest.createFunction(
  {
    id: 'google-calendar-booking-sync',
    triggers: { event: 'google-calendar/booking.changed' },
    // Serialisasi per booking: event create + update untuk booking yang sama
    // tidak boleh berjalan bersamaan (race baca eventIds map → duplikat event).
    concurrency: [{ key: 'event.data.bookingId', limit: 1 }],
  },
  async ({ event, step }) => {
    const { workspaceId, bookingId, action } = event.data as CalendarBookingEventData;
    if (!workspaceId || !bookingId) return { skipped: 'invalid-event' };

    if (action === 'delete') {
      const result = await step.run('delete-calendar-event', () =>
        deleteBookingCalendarEvent(workspaceId, bookingId),
      );
      return result;
    }
    const result = await step.run('upsert-calendar-event', () =>
      upsertBookingCalendarEvent(workspaceId, bookingId),
    );
    return result;
  },
);

/* ────────────────────────────────────────────────────────────
 * Outgoing webhook — kirim notifikasi event (P2)
 * Dipicu `outgoing-webhook/deliver` (route bookings). Kegagalan
 * pengiriman dilempar → retry built-in Inngest (backoff).
 * ──────────────────────────────────────────────────────────── */

interface OutgoingWebhookEventData {
  workspaceId: string;
  event: string;
  data: Record<string, unknown>;
  webhookId?: string;
}

export const deliverOutgoingWebhook = inngest.createFunction(
  { id: 'deliver-outgoing-webhook', triggers: { event: 'outgoing-webhook/deliver' } },
  async ({ event, step }) => {
    const { workspaceId, event: webhookEvent, data, webhookId } = event.data as OutgoingWebhookEventData;
    if (!workspaceId || !webhookEvent) return { skipped: 'invalid-event' };
    const result = await step.run('dispatch-webhook', () =>
      dispatchOutgoingWebhook(workspaceId, webhookEvent, data, webhookId),
    );
    return result;
  },
);

/* ────────────────────────────────────────────────────────────
 * Slack — notifikasi booking ke channel tim (Incoming Webhook)
 * Dipicu `slack/booking.event` (route bookings / form-booking /
 * CALL-E). Kegagalan pengiriman dilempar → retry built-in Inngest.
 * ──────────────────────────────────────────────────────────── */

interface SlackBookingEventData {
  workspaceId: string;
  event: string;
  data: Record<string, unknown>;
}

export const deliverSlackNotification = inngest.createFunction(
  { id: 'deliver-slack-notification', triggers: { event: 'slack/booking.event' } },
  async ({ event, step }) => {
    const { workspaceId, event: slackEvent, data } = event.data as SlackBookingEventData;
    if (!workspaceId || !slackEvent) return { skipped: 'invalid-event' };
    const result = await step.run('dispatch-slack', () =>
      dispatchSlackNotification(workspaceId, slackEvent, data),
    );
    return result;
  },
);

/* ────────────────────────────────────────────────────────────
 * Video calls — buat link Zoom untuk booking (provider zoom)
 * Dipicu `video/link.required` (route bookings / form-booking).
 * Provider meet ditangani sync Google Calendar (hangoutLink).
 * ──────────────────────────────────────────────────────────── */

interface VideoLinkEventData {
  workspaceId: string;
  bookingId: string;
}

export const createBookingVideoLink = inngest.createFunction(
  { id: 'create-booking-video-link', triggers: { event: 'video/link.required' } },
  async ({ event, step }) => {
    const { workspaceId, bookingId } = event.data as VideoLinkEventData;
    if (!workspaceId || !bookingId) return { skipped: 'invalid-event' };
    return step.run('create-zoom-link', () => createZoomLinkForBooking(workspaceId, bookingId));
  },
);

/* ────────────────────────────────────────────────────────────
 * Meta (Instagram + Facebook DMs) — pesan masuk dari webhook
 * Dipicu `meta/message.received` (route webhooks/meta.ts).
 * ──────────────────────────────────────────────────────────── */

interface MetaMessageEventData {
  workspaceId: string;
  channelType: 'instagram' | 'facebook';
  pageId: string;
  event: MetaMessagingEvent;
}

export const onMetaMessage = inngest.createFunction(
  { id: 'handle-meta-message', triggers: { event: 'meta/message.received' } },
  async ({ event, step }) => {
    const { workspaceId, channelType, pageId, event: metaEvent } = event.data as MetaMessageEventData;
    if (!workspaceId || !channelType || !pageId) return { skipped: 'invalid-event' };
    return step.run('handle-meta-message', () =>
      handleMetaMessagingEvent({ workspaceId, channelType, pageId, event: metaEvent }),
    );
  },
);

export const sendWelcomeEmail = inngest.createFunction(
  { id: 'send-welcome-email', triggers: { event: 'user/signed-up' } },
  async ({ event, step }) => {
    const { email, name } = event.data as { email: string; name?: string };

    await step.run('send-email', async () => {
      const { error } = await resend.emails.send({
        from: brand.emailFrom,
        to: [email],
        subject: `Welcome to ${brand.name}`,
        html: `<h1>Welcome to ${brand.name}!</h1><p>Hi ${name ?? 'there'}, we're glad you joined.</p>`,
      });
      if (error) {
        throw new Error(`Resend gagal mengirim email: ${error.message}`);
      }
    });
  },
);

/* ────────────────────────────────────────────────────────────
 * WAHA health watchdog (BYO WhatsApp — spec §7)
 * Cron 5 menit: probe session setiap workspace dengan channel waha
 * (GET /api/sessions/{name} + me). Menggerakkan state machine health:
 *   WORKING → connected (identifier dari me.id)
 *   FAILED/STOPPED → disconnected
 *   gateway tak terjangkau → disconnected (fail-safe)
 * Outbound tetap dijaga di jalur kirim (guard banned/restricted/kuota di
 * services/whatsapp.ts) — watchdog hanya memastikan state UI/API segar.
 * Kegagalan per-workspace dicatat & dilanjutkan (poller).
 * ──────────────────────────────────────────────────────────── */

export const wahaHealthWatchdog = inngest.createFunction(
  { id: 'waha-health-watchdog', triggers: { cron: '*/5 * * * *' } },
  async ({ step }) => {
    const channels = await step.run('list-waha-channels', () => listWahaChannels());

    const states: string[] = [];
    for (const channel of channels) {
      await step.run(`probe-waha-${channel.workspaceId}`, async () => {
        try {
          const result = await probeWahaChannelHealth(channel);
          if (result.state) states.push(`${channel.workspaceId}:${result.state}`);
        } catch (error) {
          // Probe gagal di luar kontrol gateway (mis. DB) — jangan matikan run.
          console.error(`[waha] watchdog gagal probe ${channel.workspaceId}:`, error);
        }
      });
    }
    return { channels: channels.length, states };
  },
);

/* ────────────────────────────────────────────────────────────
 * Purge project soft-deleted (P1)
 * Cron harian: hapus permanen workspace yang sudah melewati masa tenggang
 * (WORKSPACE_DELETE_GRACE_DAYS) sejak soft-delete. Menghapus baris workspace
 * → FK cascade membersihkan booking, kontak, chat, channel, integrasi, dll.
 * Batch terbatas per run; cron berikutnya melanjutkan sisa.
 * ──────────────────────────────────────────────────────────── */

export const purgeDeletedWorkspaces = inngest.createFunction(
  { id: 'purge-deleted-workspaces', triggers: { cron: '0 4 * * *' } },
  async ({ step }) => {
    const purged = await step.run('purge-expired-workspaces', () => purgeExpiredWorkspaces());
    if (purged > 0) {
      console.warn(`[workspace-lifecycle] ${purged} project dihapus permanen (masa tenggang lewat)`);
    }
    return { purged };
  },
);

export const inngestFunctions = [
  onVapiEvent,
  onPaddleEvent,
  onTelegramEvent,
  onTallySubmission,
  onWhatsAppEvent,
  remindBooking,
  autoCallBooking,
  syncGoogleForms,
  syncCalendarBooking,
  wahaHealthWatchdog,
  deliverOutgoingWebhook,
  deliverSlackNotification,
  createBookingVideoLink,
  onMetaMessage,
  sendWelcomeEmail,
  purgeDeletedWorkspaces,
];
