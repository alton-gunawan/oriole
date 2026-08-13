import { and, desc, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type { CurrencyCode } from '@paddle/paddle-node-sdk';
import { bookings, paymentLinks, workspaceIntegrations } from '@oriole/database';

import { db } from '../db/index.ts';
import { capturePaymentEvent } from '../lib/analytics.ts';
import { DEFAULT_BOOKING_TITLE, loadServiceNames } from '../lib/booking-title.ts';
import { requireAuth } from '../middleware/auth.ts';
import { requireWorkspace, type WorkspaceVariables } from '../middleware/workspace.ts';
import {
  cancelPaddleTransaction,
  createPaddleCheckout,
  DEFAULT_PAYMENT_CURRENCY,
  isValidCurrency,
  isPaddlePaymentsConfigured,
  paddleErrorDetail,
  toMinorUnits,
} from '../lib/paddle-payments.ts';

/**
 * Global Payments — payment link satu kali (Paddle Merchant of Record).
 *
 * Workspace membuat tautan pembayaran (deposit / biaya layanan) dengan jumlah
 * bebas; customer membayar via hosted checkout Paddle; webhook terverifikasi
 * menandai link lunas (lihat onPaddleEvent di inngest/functions.ts).
 *
 * Persyaratan: integrasi `payments` terhubung & aktif di workspace, dan
 * PADDLE_API_KEY terisi di server. Kredensial TIDAK pernah datang dari client.
 */

type PaymentLinkRow = typeof paymentLinks.$inferSelect;

/** Serialisasi publik — tanpa field internal. bookingTitle dari lookup terpisah. */
function serializePaymentLink(row: PaymentLinkRow, bookingTitle: string | null) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    amountMinor: row.amountMinor,
    currency: row.currency,
    status: row.status,
    checkoutUrl: row.checkoutUrl,
    customerName: row.customerName,
    customerEmail: row.customerEmail,
    bookingId: row.bookingId ?? null,
    bookingTitle,
    paidAt: row.paidAt ? row.paidAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Judul booking untuk daftar link (batch lookup — hindari N+1). */
async function loadBookingTitles(
  workspaceId: string,
  rows: PaymentLinkRow[],
): Promise<Map<string, string>> {
  const ids = rows
    .map((row) => row.bookingId)
    .filter((id): id is string => Boolean(id));
  if (ids.length === 0) return new Map();
  // Title booking = nama layanan katalog (kolom title sudah dihapus).
  const bookingRows = await db
    .select({ id: bookings.id, serviceId: bookings.serviceId })
    .from(bookings)
    .where(inArray(bookings.id, ids));
  const serviceNames = await loadServiceNames(
    workspaceId,
    bookingRows.map((booking) => booking.serviceId),
  );
  return new Map(
    bookingRows.map((booking) => [
      booking.id,
      booking.serviceId
        ? (serviceNames.get(booking.serviceId) ?? DEFAULT_BOOKING_TITLE)
        : DEFAULT_BOOKING_TITLE,
    ]),
  );
}

const createPaymentLinkSchema = z.object({
  bookingId: z.string().uuid().optional().nullable(),
  title: z.string().trim().min(1, 'Judul wajib diisi').max(200),
  description: z.string().trim().max(2_000).optional().nullable(),
  /** Nominal major units (mis. 29.99) — dikonversi ke minor units di server. */
  amount: z.number().positive('Jumlah harus lebih besar dari 0').max(1_000_000),
  currency: z.string().trim().max(8).optional().nullable(),
  customerName: z.string().trim().max(200).optional().nullable(),
  customerEmail: z.string().trim().email('Email tidak valid').max(320).optional().nullable(),
});

const paymentIdParamSchema = z.object({ id: z.string().uuid() });

const listQuerySchema = z.object({
  bookingId: z.string().uuid().optional(),
});

export const paymentsRoutes = new Hono<{ Variables: WorkspaceVariables }>()
  /* ── Daftar payment link workspace (opsional filter per booking) ── */
  .get('/', requireAuth, requireWorkspace, zValidator('query', listQuerySchema), async (c) => {
    const workspaceId = c.get('workspaceId');
    const { bookingId } = c.req.valid('query');

    const conditions = [eq(paymentLinks.workspaceId, workspaceId)];
    if (bookingId) conditions.push(eq(paymentLinks.bookingId, bookingId));

    const rows = await db
      .select()
      .from(paymentLinks)
      .where(and(...conditions))
      .orderBy(desc(paymentLinks.createdAt));

    const titles = await loadBookingTitles(c.get('workspaceId'), rows);
    return c.json({
      payments: rows.map((row) =>
        serializePaymentLink(row, row.bookingId ? (titles.get(row.bookingId) ?? null) : null),
      ),
    });
  })

  /* ── Buat payment link: validasi → insert → checkout Paddle → URL ── */
  .post('/', requireAuth, requireWorkspace, zValidator('json', createPaymentLinkSchema), async (c) => {
    const workspaceId = c.get('workspaceId');
    const body = c.req.valid('json');

    // Gate: integrasi Payments harus terhubung & aktif di workspace ini.
    const [integration] = await db
      .select({ isActive: workspaceIntegrations.isActive })
      .from(workspaceIntegrations)
      .where(
        and(
          eq(workspaceIntegrations.workspaceId, workspaceId),
          eq(workspaceIntegrations.integrationType, 'payments'),
        ),
      )
      .limit(1);
    if (!integration) {
      return c.json({ error: 'Integrasi Payments belum dihubungkan di halaman Integrations.' }, 409);
    }
    if (!integration.isActive) {
      return c.json({ error: 'Integrasi Payments sedang dijeda (nonaktif).' }, 409);
    }
    if (!isPaddlePaymentsConfigured()) {
      return c.json(
        { error: 'PADDLE_API_KEY belum dikonfigurasi di server. Hubungi administrator project.' },
        503,
      );
    }

    const rawCurrency = body.currency?.trim().toUpperCase() || DEFAULT_PAYMENT_CURRENCY;
    if (!isValidCurrency(rawCurrency)) {
      return c.json({ error: 'Kode mata uang tidak didukung Paddle.' }, 400);
    }
    const currency = rawCurrency;
    const amountMinor = toMinorUnits(body.amount);
    if (amountMinor === null) {
      return c.json({ error: 'Jumlah tidak valid (maksimal 2 desimal).' }, 400);
    }

    // bookingId (bila ada) harus milik workspace ini — jangan biarkan link
    // menaut ke booking project lain.
    if (body.bookingId) {
      const [booking] = await db
        .select({ id: bookings.id })
        .from(bookings)
        .where(and(eq(bookings.id, body.bookingId), eq(bookings.workspaceId, workspaceId)))
        .limit(1);
      if (!booking) {
        return c.json({ error: 'Booking tidak ditemukan di project ini.' }, 400);
      }
    }

    const [row] = await db
      .insert(paymentLinks)
      .values({
        workspaceId,
        bookingId: body.bookingId ?? null,
        title: body.title,
        description: body.description ?? null,
        amountMinor,
        currency,
        customerName: body.customerName ?? null,
        customerEmail: body.customerEmail ?? null,
      })
      .returning();

    // Checkout Paddle: gagal → rollback lokal (link tanpa URL tidak berguna).
    try {
      const checkout = await createPaddleCheckout({
        title: row.title,
        description: row.description,
        amountMinor: row.amountMinor,
        // Divalidasi via isValidCurrency sebelum insert — aman untuk di-cast.
        currency: row.currency as CurrencyCode,
        paymentLinkId: row.id,
        workspaceId,
      });
      const [updated] = await db
        .update(paymentLinks)
        .set({
          paddleTransactionId: checkout.transactionId,
          checkoutUrl: checkout.checkoutUrl,
          updatedAt: new Date(),
        })
        .where(eq(paymentLinks.id, row.id))
        .returning();
      capturePaymentEvent('payment.checkout_created', {
        workspaceId,
        paymentLinkId: row.id,
        bookingId: row.bookingId,
        status: 'pending',
        amountMinor: row.amountMinor,
        currency: row.currency,
      });
      return c.json({ payment: serializePaymentLink(updated, null) }, 201);
    } catch (err) {
      await db.delete(paymentLinks).where(eq(paymentLinks.id, row.id));
      const detail = paddleErrorDetail(err);
      console.error('[payments] create checkout gagal:', detail ?? err);
      return c.json(
        { error: 'Gagal membuat checkout pembayaran di Paddle.', detail: detail ?? undefined },
        502,
      );
    }
  })

  /* ── Batalkan payment link pending (checkout URL langsung mati) ── */
  .post(
    '/:id/cancel',
    requireAuth,
    requireWorkspace,
    zValidator('param', paymentIdParamSchema),
    async (c) => {
      const { id } = c.req.valid('param');
      const [row] = await db
        .select()
        .from(paymentLinks)
        .where(and(eq(paymentLinks.id, id), eq(paymentLinks.workspaceId, c.get('workspaceId'))))
        .limit(1);
      if (!row) return c.json({ error: 'Payment link tidak ditemukan.' }, 404);
      if (row.status !== 'pending') {
        return c.json({ error: 'Payment link tidak bisa dibatalkan (status bukan pending).' }, 409);
      }

      // Di produksi (Paddle terkonfigurasi) batalkan dulu di Paddle — jika
      // gagal, URL checkout MASIH hidup dan link tidak boleh tampak batal.
      if (row.paddleTransactionId && isPaddlePaymentsConfigured()) {
        try {
          await cancelPaddleTransaction(row.paddleTransactionId);
        } catch (err) {
          const detail = paddleErrorDetail(err);
          console.error('[payments] cancel di Paddle gagal:', detail ?? err);
          return c.json(
            { error: 'Gagal membatalkan checkout di Paddle.', detail: detail ?? undefined },
            502,
          );
        }
      }

      const [updated] = await db
        .update(paymentLinks)
        .set({ status: 'canceled', updatedAt: new Date() })
        .where(eq(paymentLinks.id, row.id))
        .returning();
      return c.json({ payment: serializePaymentLink(updated, null) });
    },
  );
