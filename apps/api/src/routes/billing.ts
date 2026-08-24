import { zValidator } from '@hono/zod-validator';
import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { calleCalls, subscriptions } from '@oriole/database';

import { db } from '../db/index.ts';
import { extractCallSeconds } from '../lib/calls.ts';
import { env } from '../lib/env.ts';
import { PLAN_ORDER, PLANS, priceIdForPlan, type PlanId } from '../lib/plans.ts';
import { planFromSubscription } from '../lib/quota.ts';
import { requireAuth, type AuthVariables } from '../middleware/auth.ts';
import { paddle } from '../services/paddle.ts';

/**
 * Deteksi apakah Paddle benar-benar dikonfigurasi (bukan placeholder).
 * `PADDLE_CLIENT_TOKEN` wajib ada — dipakai frontend untuk checkout/3DS.
 */
function isPlaceholder(value: string | undefined | null): boolean {
  if (!value) return true;
  return /\.\.\.|xxxx|placeholder/i.test(value);
}

const paddleConfigured =
  !isPlaceholder(env.PADDLE_API_KEY) && !isPlaceholder(env.PADDLE_CLIENT_TOKEN);

/**
 * Ekstrak pesan kesalahan asli dari error SDK Paddle (mis. detail kaya
 * "Transaction balance is less than what we can charge. ...") supaya
 * kegagalan checkout tidak berubah menjadi pesan generik yang membingungkan.
 */
function paddleErrorDetail(err: unknown): string | null {
  if (err && typeof err === 'object') {
    // SDK Paddle: ApiError mengekspos `detail` langsung (dan sebagai message).
    const direct = (err as { detail?: unknown }).detail;
    if (typeof direct === 'string' && direct) return direct;
    const apiError = (err as { error?: { detail?: string } }).error;
    if (apiError?.detail) return apiError.detail;
  }
  return err instanceof Error ? err.message : null;
}

const topupSchema = z.object({
  amount: z
    .number({ message: 'Jumlah top-up harus berupa angka' })
    .int('Jumlah top-up harus bilangan bulat')
    .min(5, 'Minimal top-up kredit adalah $5')
    .refine((val) => val % 5 === 0, {
      message: 'Jumlah kredit harus kelipatan $5 (misal: $5, $10, $15, $20, ...)',
    }),
});

/**
 * Billing — status langganan & kuota (GET), serta aksi Paddle
 * (POST /checkout → URL checkout paket Pro, POST /topup → URL checkout top-up kredit, POST /portal → portal billing).
 */
export const billingRoutes = new Hono<{ Variables: AuthVariables }>()
  .get('/', requireAuth, async (c) => {
    const userId = c.get('userId');

    const [latestSubscription] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .orderBy(desc(subscriptions.createdAt))
      .limit(1);

    const plan: PlanId = planFromSubscription(
      latestSubscription?.status,
      latestSubscription?.planId ?? latestSubscription?.priceId,
    );

    const calls = await db
      .select({
        status: calleCalls.status,
        createdAt: calleCalls.createdAt,
        result: calleCalls.result,
      })
      .from(calleCalls)
      .where(eq(calleCalls.userId, userId));

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const usage = {
      totalCalls: calls.length,
      monthCalls: calls.filter((call) => call.createdAt >= monthStart).length,
      totalSeconds: calls.reduce((acc, call) => acc + extractCallSeconds(call.result), 0),
    };

    return c.json({
      paddleConfigured,
      plan,
      planInfo: PLANS[plan],
      plans: PLAN_ORDER.map((id) => PLANS[id]),
      topupOptions: [5, 10, 15, 20, 25, 50],
      usage,
      subscription: latestSubscription
        ? {
            status: latestSubscription.status,
            paddleSubscriptionId: latestSubscription.paddleSubscriptionId,
            priceId: latestSubscription.priceId,
            currentPeriodEnd: latestSubscription.currentPeriodEnd,
            cancelAtPeriodEnd: latestSubscription.cancelAtPeriodEnd,
          }
        : null,
    });
  })

  .post('/checkout', requireAuth, async (c) => {
    if (!paddleConfigured) {
      return c.json({ error: 'Paddle belum dikonfigurasi', configured: false }, 503);
    }

    // Single subscription plan ('pro' - $19/month).
    const priceId = priceIdForPlan('pro');
    if (!priceId) {
      return c.json(
        {
          error: 'PADDLE_PRO_PRICE_ID belum diatur di environment',
          plan: 'pro',
        },
        400,
      );
    }

    try {
      // `custom_data.user_id` dipakai webhook Paddle → Inngest untuk
      // menghubungkan subscription ke user (lihat inngest/functions.ts).
      const transaction = await paddle.transactions.create({
        items: [{ priceId, quantity: 1 }],
        customData: { user_id: c.get('userId') },
      });
      if (!transaction.checkout?.url) {
        return c.json({ error: 'Paddle tidak mengembalikan URL checkout' }, 502);
      }
      return c.json({ url: transaction.checkout.url });
    } catch (err) {
      const detail = paddleErrorDetail(err);
      console.error('[billing] checkout gagal:', detail ?? err);
      // Sertakan detail asli (jika ada) agar user & log bisa melihat penyebab
      // sebenarnya (mis. harga di bawah batas minimum charge Paddle).
      return c.json(
        { error: 'Gagal membuat checkout di Paddle', detail: detail ?? undefined },
        502,
      );
    }
  })

  .post('/topup', requireAuth, zValidator('json', topupSchema), async (c) => {
    if (!paddleConfigured) {
      return c.json({ error: 'Paddle belum dikonfigurasi', configured: false }, 503);
    }

    const { amount } = c.req.valid('json');

    try {
      const transaction = await paddle.transactions.create({
        items: [
          {
            quantity: 1,
            price: {
              description: `Oriole AI Voice Credits - $${amount}`,
              unitPrice: {
                amount: String(amount * 100),
                currencyCode: 'USD',
              },
              product: {
                name: `Oriole Call Credits ($${amount})`,
                taxCategory: 'standard',
              },
            },
          },
        ],
        customData: {
          user_id: c.get('userId'),
          type: 'credit_topup',
          amount_usd: amount,
        },
      });

      if (!transaction.checkout?.url) {
        return c.json({ error: 'Paddle tidak mengembalikan URL checkout' }, 502);
      }
      return c.json({ url: transaction.checkout.url, amount });
    } catch (err) {
      const detail = paddleErrorDetail(err);
      console.error('[billing] topup checkout gagal:', detail ?? err);
      return c.json(
        { error: 'Gagal membuat checkout top-up di Paddle', detail: detail ?? undefined },
        502,
      );
    }
  })

  .post('/portal', requireAuth, async (c) => {
    if (!paddleConfigured) {
      return c.json({ error: 'Paddle belum dikonfigurasi', configured: false }, 503);
    }

    const [latestSubscription] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, c.get('userId')))
      .orderBy(desc(subscriptions.createdAt))
      .limit(1);

    if (!latestSubscription?.paddleCustomerId) {
      return c.json({ error: 'Belum ada langganan aktif untuk akun ini' }, 400);
    }

    try {
      const session = await paddle.customerPortalSessions.create(
        latestSubscription.paddleCustomerId,
        [latestSubscription.paddleSubscriptionId],
      );
      return c.json({ url: session.urls.general.overview });
    } catch (err) {
      const detail = paddleErrorDetail(err);
      console.error('[billing] portal gagal:', detail ?? err);
      return c.json(
        { error: 'Gagal membuka portal billing', detail: detail ?? undefined },
        502,
      );
    }
  });
