import { zValidator } from '@hono/zod-validator';
import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { calleCalls, subscriptions } from '@oriole/database';

import { db } from '../db/index.ts';
import { extractCallSeconds } from '../lib/calls.ts';
import { env } from '../lib/env.ts';
import { PLANS, priceIdForPlan, type PlanId } from '../lib/plans.ts';
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

    const totalSeconds = calls.reduce((acc, call) => acc + extractCallSeconds(call.result), 0);
    const monthCalls = calls.filter((call) => call.createdAt >= monthStart);
    const monthSeconds = monthCalls.reduce((acc, call) => acc + extractCallSeconds(call.result), 0);

    const totalMinutes = Math.ceil(totalSeconds / 60);
    const monthMinutes = Math.ceil(monthSeconds / 60);

    const trialCreditTotalUsd = 5.0;
    // Standar estimasi voice cost: $0.15/menit
    const voiceUsageCostUsd = Number(((monthSeconds / 60) * 0.15).toFixed(2));
    const trialCreditUsedUsd = Number(Math.min(trialCreditTotalUsd, (monthSeconds / 60) * 0.15).toFixed(2));
    const trialCreditRemainingUsd = Number(Math.max(0, trialCreditTotalUsd - trialCreditUsedUsd).toFixed(2));

    const daysRemaining = latestSubscription?.currentPeriodEnd
      ? Math.max(0, Math.ceil((new Date(latestSubscription.currentPeriodEnd).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
      : 14;

    return c.json({
      paddleConfigured,
      currency: 'USD',
      plan,
      planInfo: PLANS[plan] ?? PLANS.pro,
      usage: {
        totalCalls: calls.length,
        monthCalls: monthCalls.length,
        totalSeconds,
        totalMinutes,
        monthSeconds,
        monthMinutes,
        voiceUsageCostUsd,
        trialCreditTotalUsd,
        trialCreditUsedUsd,
        trialCreditRemainingUsd,
      },
      subscription: latestSubscription
        ? {
            status: latestSubscription.status,
            paddleSubscriptionId: latestSubscription.paddleSubscriptionId,
            paddleCustomerId: latestSubscription.paddleCustomerId,
            priceId: latestSubscription.priceId,
            currentPeriodEnd: latestSubscription.currentPeriodEnd,
            cancelAtPeriodEnd: latestSubscription.cancelAtPeriodEnd,
            daysRemaining,
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
      console.error('[billing] checkout error from Paddle:', detail ?? err);
      // Sanitized user error message (technical details tetap masuk di server log)
      return c.json(
        { error: "We couldn't start your subscription. Please try again or use another payment method." },
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
        { error: "We couldn't process the top-up. Please try again or use another payment method." },
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
      console.error('[billing] customer portal error from Paddle:', detail ?? err);
      // Sanitized user error message
      return c.json(
        { error: "We couldn't open your customer billing portal. Please try again later." },
        502,
      );
    }
  });
