import { and, eq, isNull } from 'drizzle-orm';
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
import {
  computeAutoCallAt,
  emitBookingCompleted,
  type BookingEventData,
  type AutoCallEventData,
} from '../lib/reminders.ts';
import { placeAutoCall } from '../lib/auto-call.ts';
import { purgeExpiredWorkspaces } from '../lib/workspace-lifecycle.ts';
import { listActiveFormIntegrations, syncFormResponsesToContacts } from '../lib/google-forms.ts';
import {
  deleteBookingCalendarEvent,
  upsertBookingCalendarEvent,
} from '../lib/google-calendar.ts';
import { dispatchOutgoingWebhook } from '../lib/outgoing-webhooks.ts';
import { emitOutgoingWebhookEvent } from '../lib/integration-events.ts';
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
        // Webhook keluar: booking selesai (dipicu dari CALL-E, bukan route).
        await emitOutgoingWebhookEvent(workspaceId, 'booking.completed', {
          bookingId: call.bookingId,
          calleCallId: call.callId,
          status: 'completed',
        });
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

    // Workspace soft-deleted (project dihapus user) → jangan kirim reminder
    // dari run lama; project sedang menunggu penghapusan permanen.
    const workspace = await step.run('load-business-name', async () => {
      const [ws] = await db
        .select({ name: workspaces.name })
        .from(workspaces)
        .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)))
        .limit(1);
      return ws ?? null;
    });
    if (!workspace) {
      return { skipped: 'workspace-deleted' };
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
  onCalleEvent,
  onPaddleEvent,
  onTelegramEvent,
  onWhatsAppEvent,
  remindBooking,
  autoCallBooking,
  syncGoogleForms,
  syncCalendarBooking,
  deliverOutgoingWebhook,
  sendWelcomeEmail,
  purgeDeletedWorkspaces,
];
