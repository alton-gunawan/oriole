import { eq } from 'drizzle-orm';
import { bookings, calleCalls, subscriptions, workspaces } from '@oriole/database';
import { brand } from '@oriole/config';
import type { TelegramUpdate, WhatsAppWebhookPayload } from '@oriole/messaging';

import { db } from '../db/index.ts';
import { resend } from '../services/email.ts';
import { handleTelegramUpdate } from '../lib/telegram-handler.ts';
import { handleWhatsAppUpdate } from '../lib/whatsapp-handler.ts';
import { dispatchTelegramReminder, TelegramDispatchError } from '../lib/telegram-handler.ts';
import { dispatchWhatsAppReminder, WhatsAppDispatchError } from '../lib/whatsapp-handler.ts';
import { dispatchEmailReminder, EmailDispatchError } from '../lib/email-reminder.ts';
import { emitBookingCompleted, type BookingEventData } from '../lib/reminders.ts';
import type { CalleEventData } from '../lib/calle-types.ts';
import { inngest } from './client.ts';

/**
 * Catatan API Inngest v4: `createFunction(options, handler)` — trigger
 * didefinisikan lewat `triggers: { event: '...' }` di dalam options
 * (bukan argumen terpisah seperti v3).
 */

/* ────────────────────────────────────────────────────────────
 * CALL-E — event dari webhook /api/webhooks/calle
 * ──────────────────────────────────────────────────────────── */

export const onCalleEvent = inngest.createFunction(
  { id: 'calle-event-received', triggers: { event: 'calle/event.received' } },
  async ({ event, step }) => {
    const { payload } = event.data as CalleEventData;
    const call = payload.data;
    const workspaceId = call?.workspaceId;

    await step.run('upsert-calle-call', async () => {
      if (!call?.callId) return;
      // userId diambil dari payload webhook (harus dikirim via custom data
      // saat panggilan dibuat) — tanpa ini riwayat per-user tetap kosong.
      const userId = call.userId ?? undefined;
      await db
        .insert(calleCalls)
        .values({
          calleCallId: call.callId,
          userId,
          workspaceId,
          bookingId: call.bookingId ?? undefined,
          phone: call.phone ?? 'unknown',
          status: call.status,
          result: call.result ?? null,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: calleCalls.calleCallId,
          set: {
            status: call.status,
            result: call.result ?? null,
            updatedAt: new Date(),
          },
        });
    });

    await step.run('complete-linked-booking', async () => {
      if (!call?.callId) return;
      // Hanya tandai booking 'completed' jika panggilan berakhir sukses.
      // Webhook hanya dikirim saat panggilan mencapai status terminal
      // (completed/failed/canceled); status lain dibiarkan agar goal engine
      // tetap bisa menyarankan follow-up (mis. final-follow-up).
      if (call.status !== 'completed') return;
      await db
        .update(bookings)
        .set({ status: 'completed', updatedAt: new Date() })
        .where(eq(bookings.calleCallId, call.callId));
      if (workspaceId && call.bookingId) {
        await emitBookingCompleted(workspaceId, call.bookingId);
      }
    });
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
  custom_data?: { user_id?: string };
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

    await step.run('sync-subscription', async () => {
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
      return row ?? null;
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

    const workspace = await step.run('load-business-name', async () => {
      const [ws] = await db
        .select({ name: workspaces.name })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);
      return ws ?? null;
    });

    // Catatan: step.run mengubah output lewat middleware serialisasi —
    // timestamp keluar sebagai string ISO, konversi kembali ke Date di sini.
    const bookingInput = {
      id: booking.id,
      title: booking.title,
      customerName: booking.customerName,
      phone: booking.phone,
      scheduledAt: new Date(booking.scheduledAt),
      timezone: booking.timezone,
    };
    const businessName = workspace?.name ?? null;


    // Tiap channel independen: error bisnis (channel belum dikonfigurasi /
    // customer belum terhubung) hanya dicatat, tidak menggagalkan channel lain.
    // Error provider (network / API) tetap dilempar agar Inngest me-retry.
    await step.run('dispatch-telegram-reminder', async () => {
      try {
        await dispatchTelegramReminder({ workspaceId, booking: bookingInput, businessName });
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
        await dispatchWhatsAppReminder({ workspaceId, booking: bookingInput, businessName });
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
        await dispatchEmailReminder({ workspaceId, booking: bookingInput, businessName });
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

export const inngestFunctions = [
  onCalleEvent,
  onPaddleEvent,
  onTelegramEvent,
  onWhatsAppEvent,
  remindBooking,
  sendWelcomeEmail,
];
