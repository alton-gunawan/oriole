import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Badge,
  Button,
  IconButton,
  Skeleton,
  Spinner,
  type BadgeVariant,
} from '@astryxdesign/core';
import type { TFunction } from 'i18next';
import { Trans, useTranslation } from 'react-i18next';

import { ApiError, apiFetch } from '../../lib/api';
import { Card, SessionExpiredCard } from './ui';
import { useWorkspaceStore } from '../../stores/workspace';
import { activeLocale, formatDate, formatNumber } from '../../i18n/format';
import type { TranslationKey } from '../../i18n';
import {
  IconAlertTriangle,
  IconExternalLink,
  IconPhone,
  IconRefreshCw,
} from './icons';

/* ── Types (mirror dari GET /api/billing) ──────────────────── */

export type PlanId = 'free' | 'pro';

export interface PlanInfo {
  id: PlanId;
  name: string;
  pricePerMonth: number;
  trialDays: number;
  usagePricing: string;
  cancelAnytime: boolean;
  features: string[];
}

export interface BillingResponse {
  paddleConfigured: boolean;
  currency: string;
  plan: PlanId;
  planInfo: PlanInfo;
  usage: {
    totalCalls: number;
    monthCalls: number;
    totalSeconds: number;
    totalMinutes: number;
    monthSeconds: number;
    monthMinutes: number;
    voiceUsageCostUsd: number;
    trialCreditTotalUsd: number;
    trialCreditUsedUsd: number;
    trialCreditRemainingUsd: number;
  };
  subscription: {
    status: string;
    paddleSubscriptionId: string;
    paddleCustomerId?: string | null;
    priceId: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    daysRemaining: number;
  } | null;
}

/* ── Helpers ───────────────────────────────────────────────── */

const SUBSCRIPTION_BADGES: Record<string, { labelKey: TranslationKey; variant: BadgeVariant }> = {
  trialing: { labelKey: 'billing.subTrial', variant: 'info' },
  active: { labelKey: 'billing.active', variant: 'success' },
  past_due: { labelKey: 'billing.subPastDue', variant: 'error' },
  paused: { labelKey: 'billing.subPaused', variant: 'warning' },
  unpaid: { labelKey: 'billing.subUnpaid', variant: 'error' },
  canceled: { labelKey: 'billing.subCanceled', variant: 'neutral' },
};

function badgeFor(status: string, t: TFunction): { label: string; variant: BadgeVariant } {
  const badge = SUBSCRIPTION_BADGES[status];
  return badge ? { label: t(badge.labelKey), variant: badge.variant } : { label: status, variant: 'neutral' };
}

/** Format harga dengan currency dinamis dari backend/locale */
function formatCurrency(amount: number, currency = 'USD'): string {
  return new Intl.NumberFormat(activeLocale(), {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/**
 * Panel Billing & Subscription — untuk digunakan di dalam SettingsDialog (tab Billing).
 */
export function BillingPanel() {
  const { t } = useTranslation();
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const [actionBusy, setActionBusy] = useState<'checkout' | 'portal' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, isPending, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['billing', activeWorkspaceId],
    queryFn: () => apiFetch<BillingResponse>('/billing'),
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 1,
  });

  const isAuthExpiry = error instanceof ApiError && error.status === 401;
  const showError = isError && !isAuthExpiry;

  const failAction = (err: unknown) => {
    const message = err instanceof Error ? err.message : t('errors.billingAction');
    setActionError(message);
    setActionBusy(null);
  };

  /** Checkout langganan Pro → redirect ke Paddle. */
  const runCheckout = async () => {
    setActionError(null);
    setActionBusy('checkout');
    try {
      const { url } = await apiFetch<{ url: string }>('/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({ plan: 'pro' }),
      });
      window.location.assign(url);
    } catch (err) {
      failAction(err);
    }
  };

  /** Portal billing Paddle (kelola langganan / pembayaran). */
  const runPortal = async () => {
    setActionError(null);
    setActionBusy('portal');
    try {
      const { url } = await apiFetch<{ url: string }>('/billing/portal', { method: 'POST' });
      window.location.assign(url);
    } catch (err) {
      failAction(err);
    }
  };

  const plan = data?.planInfo;
  const usage = data?.usage;
  const sub = data?.subscription;
  const isSubscribed = !!sub && (sub.status === 'active' || sub.status === 'trialing');
  const currency = data?.currency || 'USD';
  const isTrial = sub?.status === 'trialing' || (!isSubscribed && data?.plan === 'free');

  return (
    <div className="space-y-5">
      {/* Header section dengan tombol reload */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-base font-medium text-zinc-700 dark:text-zinc-300">
            {t('billing.title')}
          </p>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {t('billing.description')}
          </p>
        </div>
        <IconButton
          icon={isFetching ? <Spinner size="sm" /> : <IconRefreshCw className="size-4" />}
          label={t('common.reload')}
          variant="ghost"
          size="sm"
          isDisabled={isFetching}
          onClick={() => void refetch()}
        />
      </div>

      {/* Action error jika terjadi kegagalan checkout / portal */}
      {actionError && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
          {actionError}
        </div>
      )}

      {/* Not configured banner */}
      {!isPending && data && !data.paddleConfigured && (
        <div className="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-900/60 dark:bg-amber-950/40">
          <IconAlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="text-xs leading-relaxed text-amber-800 dark:text-amber-300">
            <p className="font-semibold">{t('billing.notConfiguredTitle')}</p>
            <p className="mt-0.5 [&_code]:rounded [&_code]:bg-amber-100 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-xs">
              <Trans i18nKey="billing.notConfiguredBody">
                Fill in <code>PADDLE_API_KEY</code>, <code>PADDLE_CLIENT_TOKEN</code>, and{' '}
                <code>PADDLE_PRO_PRICE_ID</code> in <code>.env</code> to enable checkout & portal. Info below shows default status.
              </Trans>
            </p>
          </div>
        </div>
      )}

      {/* Error state */}
      {showError && (
        <Card className="flex flex-col items-center gap-4 p-8 text-center">
          <span className="flex size-10 items-center justify-center rounded-md bg-red-50 text-red-500 dark:bg-red-950/50 dark:text-red-400">
            <IconAlertTriangle className="size-5" />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t('errors.billingLoadTitle')}</h3>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{t('errors.apiConnection')}</p>
          </div>
          <Button label={t('common.retry')} variant="primary" onClick={() => void refetch()} />
        </Card>
      )}

      {/* Sesi habis */}
      {isAuthExpiry && <SessionExpiredCard />}

      {/* Loading skeleton */}
      {isPending && (
        <div className="space-y-4">
          <Card className="p-5">
            <Skeleton width="40%" height={20} />
            <Skeleton className="mt-3" width="70%" height={16} />
          </Card>
          <Card className="p-5">
            <Skeleton width="30%" height={20} />
            <Skeleton className="mt-3" width="100%" height={40} />
          </Card>
        </div>
      )}

      {/* Konten Billing */}
      {!isPending && !isError && data && plan && usage && (
        <div className="space-y-4">
          {/* ── 1. Your Plan Card ──────────────────────────────── */}
          <Card className="rounded-md border border-zinc-200 bg-white p-5 shadow-xs dark:border-zinc-700/80 dark:bg-zinc-900">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-bold text-zinc-900 dark:text-zinc-100">
                    {t('billing.proPlanTitle')} — {formatCurrency(plan.pricePerMonth || 19, currency)}{t('common.perMonth')}
                  </h3>
                  {sub ? (
                    <Badge variant={badgeFor(sub.status, t).variant} label={badgeFor(sub.status, t).label} />
                  ) : (
                    <Badge variant="neutral" label={t('billing.trialNotStarted')} />
                  )}
                </div>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  {t('billing.yourPlanSubtitle')}
                </p>
              </div>

              <div className="shrink-0">
                {isSubscribed ? (
                  <Button
                    label={actionBusy === 'portal' ? t('billing.openingPortal') : t('billing.manageBilling')}
                    variant="secondary"
                    isLoading={actionBusy === 'portal'}
                    isDisabled={!data.paddleConfigured || !data.subscription || actionBusy !== null}
                    onClick={() => void runPortal()}
                  />
                ) : (
                  <Button
                    label={
                      actionBusy === 'checkout'
                        ? t('billing.preparing')
                        : t('billing.startTrialWithCredit')
                    }
                    variant="primary"
                    isLoading={actionBusy === 'checkout'}
                    isDisabled={!data.paddleConfigured || actionBusy !== null}
                    onClick={() => void runCheckout()}
                  />
                )}
              </div>
            </div>

            <div className="mt-4 border-t border-zinc-100 pt-3 text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
              {sub?.status === 'trialing' && (
                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <span className="font-medium text-amber-700 dark:text-amber-400">
                    {t('billing.trialStatusActive', { days: sub.daysRemaining ?? 14 })}
                  </span>
                  <span>
                    {t('billing.trialEndsDate', { date: formatDate(sub.currentPeriodEnd) })}
                  </span>
                </div>
              )}

              {sub?.status === 'active' && (
                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <span className="font-medium text-zinc-800 dark:text-zinc-200">
                    {t('billing.nextBillingDate', { date: formatDate(sub.currentPeriodEnd) })}
                  </span>
                  <span className="text-zinc-500">
                    {t('billing.nextChargeAmount', { amount: formatCurrency(plan.pricePerMonth || 19, currency) })}
                  </span>
                </div>
              )}

              {!isSubscribed && (
                <p className="text-zinc-500 dark:text-zinc-400">
                  {t('billing.cardRequiredNotice')}
                </p>
              )}

              {sub?.cancelAtPeriodEnd && (
                <p className="mt-1 font-medium text-amber-600 dark:text-amber-400">
                  {t('billing.cancelsAtEnd')}
                </p>
              )}
            </div>
          </Card>

          {/* ── 2. Voice Usage Card ────────────────────────────── */}
          <Card className="rounded-md border border-zinc-200 bg-white p-5 shadow-xs dark:border-zinc-700/80 dark:bg-zinc-900">
            <div className="flex items-start justify-between">
              <div>
                <h4 className="flex items-center gap-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  <span className="flex size-6 items-center justify-center rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400">
                    <IconPhone className="size-3.5" />
                  </span>
                  {t('billing.voiceUsageTitle')}
                </h4>
                <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                  {t('billing.voiceUsageDesc')}
                </p>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-4 border-t border-zinc-100 pt-4 dark:border-zinc-800 sm:grid-cols-4">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-400">
                  {t('billing.talkMinutes')}
                </p>
                <p className="mt-1 text-xl font-bold text-zinc-900 dark:text-zinc-100">
                  {formatNumber(usage.monthMinutes)}
                </p>
                <p className="mt-0.5 text-[11px] text-zinc-400">{t('calls.thisMonth')}</p>
              </div>

              <div>
                <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-400">
                  {t('billing.aiCalls')}
                </p>
                <p className="mt-1 text-xl font-bold text-zinc-900 dark:text-zinc-100">
                  {formatNumber(usage.monthCalls)}
                </p>
                <p className="mt-0.5 text-[11px] text-zinc-400">{t('calls.thisMonth')}</p>
              </div>

              <div>
                <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-400">
                  {t('billing.monthEstimatedCost')}
                </p>
                <p className="mt-1 text-xl font-bold text-zinc-900 dark:text-zinc-100">
                  {formatCurrency(usage.voiceUsageCostUsd, currency)}
                </p>
                <p className="mt-0.5 text-[11px] text-zinc-400">{t('calls.thisMonth')}</p>
              </div>

              <div>
                <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-400">
                  {t('billing.totalCalls')}
                </p>
                <p className="mt-1 text-xl font-bold text-zinc-900 dark:text-zinc-100">
                  {formatNumber(usage.totalCalls)}
                </p>
                <p className="mt-0.5 text-[11px] text-zinc-400">{t('calls.allTime')}</p>
              </div>
            </div>

            {/* Trial Voice Credit Progress (Hanya saat masa trial) */}
            {isTrial && (
              <div className="mt-4 border-t border-zinc-100 pt-3 dark:border-zinc-800">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-zinc-800 dark:text-zinc-200">
                    {t('billing.trialCreditTitle')}
                  </span>
                  <span className="font-medium text-amber-700 dark:text-amber-300">
                    {t('billing.trialCreditRemaining', {
                      remaining: formatCurrency(usage.trialCreditRemainingUsd, currency),
                    })}
                  </span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                  <div
                    className="h-full rounded-full bg-amber-500 transition-all duration-500"
                    style={{
                      width: `${Math.min(100, Math.round((usage.trialCreditUsedUsd / (usage.trialCreditTotalUsd || 5)) * 100))}%`,
                    }}
                  />
                </div>
                <p className="mt-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                  {t('billing.trialCreditDesc')}
                </p>
              </div>
            )}
          </Card>

          {/* ── 3. Payment Method Card ─────────────────────────── */}
          <Card className="rounded-md border border-zinc-200 bg-white p-5 shadow-xs dark:border-zinc-700/80 dark:bg-zinc-900">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  {t('billing.paymentMethodTitle')}
                </h4>
                <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                  {isSubscribed
                    ? t('billing.paymentMethodManagedPaddle')
                    : t('billing.paymentMethodNone')}
                </p>
              </div>

              {isSubscribed && (
                <Button
                  label={t('billing.updatePaymentMethod')}
                  variant="ghost"
                  size="sm"
                  icon={<IconExternalLink className="size-3.5" />}
                  isLoading={actionBusy === 'portal'}
                  isDisabled={!data.paddleConfigured || !data.subscription || actionBusy !== null}
                  onClick={() => void runPortal()}
                />
              )}
            </div>

            <div className="mt-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
              <p className="text-[11px] leading-relaxed text-zinc-400 dark:text-zinc-500">
                {t('billing.paddleDisclaimer')}
              </p>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
