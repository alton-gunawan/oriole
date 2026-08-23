import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Badge,
  Button,
  Dialog,
  DialogHeader,
  IconButton,
  Layout,
  LayoutContent,
  LayoutFooter,
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
import { IconAlertTriangle, IconCheck, IconCreditCard, IconRefreshCw } from './icons';

/* ── Types (mirror dari GET /api/billing) ──────────────────── */

type PlanId = 'free' | 'pro';

interface PlanInfo {
  id: PlanId;
  name: string;
  pricePerMonth: number;
  trialDays: number;
  usagePricing: string;
  cancelAnytime: boolean;
  features: string[];
}

interface BillingResponse {
  paddleConfigured: boolean;
  plan: PlanId;
  planInfo: PlanInfo;
  plans: PlanInfo[];
  usage: { totalCalls: number; monthCalls: number; totalSeconds: number };
  subscription: {
    status: string;
    paddleSubscriptionId: string;
    priceId: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
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

function formatMinutes(seconds: number): number {
  return Math.round(seconds / 60);
}

/** Harga bulanan (USD) → format mata uang sesuai locale. */
function formatPrice(pricePerMonth: number): string {
  return new Intl.NumberFormat(activeLocale(), {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(pricePerMonth);
}

/* ── Dialog billing ────────────────────────────────────────── */

export function BillingDialog({
  isOpen,
  onOpenChange,
}: {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => unknown;
}) {
  const { t } = useTranslation();
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const [actionBusy, setActionBusy] = useState<'checkout' | 'portal' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, isPending, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['billing', activeWorkspaceId],
    queryFn: () => apiFetch<BillingResponse>('/billing'),
    enabled: isOpen,
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 1,
  });

  const isAuthExpiry = error instanceof ApiError && error.status === 401;
  const showError = isError && !isAuthExpiry;

  const failAction = (err: unknown) => {
    const message = err instanceof Error ? err.message : t('errors.billingAction');
    setActionError(message);
    setActionBusy(null);
  };

  /** Checkout langganan → redirect ke Paddle. */
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
  const isSubscribed = data?.plan === 'pro' && !!sub && (sub.status === 'active' || sub.status === 'trialing');

  const subscriptionFeatures = [
    'Book appointments',
    'Confirm appointments',
    'Handle rescheduling',
    'Handle cancellations',
    'Manage staff & services',
    'Keep your existing phone number',
    'Unlimited bookings',
    'No setup fee',
  ];

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      purpose="info"
      width={760}
      maxHeight="min(85vh, 720px)"
    >
      <Layout
        header={
          <DialogHeader
            title={t('billing.title')}
            subtitle={t('billing.description')}
            startContent={<IconCreditCard className="size-5 shrink-0 text-amber-600" />}
            onOpenChange={onOpenChange}
            endContent={
              <IconButton
                icon={isFetching ? <Spinner size="sm" /> : <IconRefreshCw className="size-4" />}
                label={t('common.reload')}
                variant="ghost"
                size="sm"
                isDisabled={isFetching}
                onClick={() => void refetch()}
              />
            }
            hasDivider
          />
        }
        content={
          <LayoutContent>
            <div className="space-y-6">
              {/* Not configured banner */}
              {!isPending && data && !data.paddleConfigured && (
                <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3.5 dark:border-amber-900/60 dark:bg-amber-950/40">
                  <IconAlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-600 dark:text-amber-400" />
                  <div className="text-sm leading-relaxed text-amber-800 dark:text-amber-300">
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
                <Card className="flex flex-col items-center gap-4 p-10 text-center">
                  <span className="flex size-12 items-center justify-center rounded-2xl bg-red-50 text-red-500 dark:bg-red-950/50 dark:text-red-400">
                    <IconAlertTriangle className="size-6" />
                  </span>
                  <div>
                    <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t('errors.billingLoadTitle')}</h3>
                    <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{t('errors.apiConnection')}</p>
                  </div>
                  <Button label={t('common.retry')} variant="primary" onClick={() => void refetch()} />
                </Card>
              )}

              {/* Sesi habis */}
              {isAuthExpiry && <SessionExpiredCard />}

              {/* Loading skeleton */}
              {isPending && (
                <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
                  {[0, 1, 2].map((i) => (
                    <Card key={i} className="p-6">
                      <Skeleton width="33%" height={16} />
                      <Skeleton className="mt-4" width="66%" height={32} />
                      <Skeleton className="mt-6" width="100%" height={8} />
                    </Card>
                  ))}
                </div>
              )}

              {/* Content */}
              {!isPending && !isError && data && plan && usage && (
                <div className="space-y-6">
                  {/* Single Subscription Plan Card */}
                  <Card className="relative overflow-hidden p-6 sm:p-7 border border-amber-500/30 bg-gradient-to-br from-amber-500/[0.04] to-transparent">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="flex size-8 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600">
                            <IconCreditCard className="size-4" />
                          </span>
                          <span className="text-xs font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                            {t('billing.subscriptionCardTitle')}
                          </span>
                          {isSubscribed && sub && (
                            <Badge variant={badgeFor(sub.status, t).variant} label={badgeFor(sub.status, t).label} />
                          )}
                        </div>

                        <div className="mt-3 flex items-baseline gap-2">
                          <span className="text-4xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
                            {formatPrice(19)}
                          </span>
                          <span className="text-base font-medium text-zinc-500 dark:text-zinc-400">
                            {t('common.perMonth')}
                          </span>
                        </div>

                        <p className="mt-1 text-sm font-medium text-amber-700 dark:text-amber-300">
                          {t('billing.payAsYouUse')}
                        </p>
                      </div>

                      <div className="flex flex-wrap gap-2 sm:flex-col sm:items-end">
                        <span className="inline-flex items-center rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 border border-emerald-200 dark:bg-emerald-950/50 dark:border-emerald-800 dark:text-emerald-300">
                          {t('billing.trialBadgeWithCredit')}
                        </span>
                        <span className="inline-flex items-center rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-800 border border-amber-200 dark:bg-amber-950/50 dark:border-amber-800 dark:text-amber-300">
                          {t('billing.creditCardRequiredBadge')}
                        </span>
                        <span className="inline-flex items-center rounded-full bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-700 border border-zinc-200 dark:bg-zinc-800 dark:border-zinc-700 dark:text-zinc-300">
                          {t('billing.cancelAnytime')}
                        </span>
                      </div>
                    </div>

                    {/* Features list */}
                    <div className="mt-6 border-t border-zinc-100 dark:border-zinc-800/80 pt-5">
                      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                        {subscriptionFeatures.map((feature) => (
                          <div key={feature} className="flex items-start gap-2.5 text-sm text-zinc-700 dark:text-zinc-300">
                            <IconCheck className="mt-0.5 size-4 shrink-0 text-emerald-500" />
                            <span>{feature}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Active Subscription / Trial Details */}
                    {sub && (
                      <div className="mt-6 space-y-3 rounded-xl bg-zinc-50 dark:bg-zinc-900/80 p-4 text-xs text-zinc-600 dark:text-zinc-400 border border-zinc-100 dark:border-zinc-800">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium">{t('billing.status')}</span>
                          <Badge variant={badgeFor(sub.status, t).variant} label={badgeFor(sub.status, t).label} />
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium">{t('billing.renewal')}</span>
                          <span className="font-semibold text-zinc-800 dark:text-zinc-200">{formatDate(sub.currentPeriodEnd)}</span>
                        </div>

                        {sub.status === 'trialing' && (
                          <div className="mt-2 border-t border-zinc-200/60 dark:border-zinc-800 pt-3">
                            <div className="flex items-center justify-between">
                              <span className="font-semibold text-zinc-800 dark:text-zinc-200">
                                {t('billing.trialCreditTitle')}
                              </span>
                              <span className="font-medium text-amber-700 dark:text-amber-300">
                                {t('billing.trialCreditUsed', {
                                  used: formatPrice(Math.min(5, (usage.totalSeconds / 60) * 0.15)),
                                })}
                              </span>
                            </div>
                            <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                              <div
                                className="h-full rounded-full bg-amber-500 transition-all duration-500"
                                style={{
                                  width: `${Math.min(100, Math.round(((usage.totalSeconds / 60) * 0.15 / 5) * 100))}%`,
                                }}
                              />
                            </div>
                            <p className="mt-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                              {t('billing.trialCreditDesc')}
                            </p>
                          </div>
                        )}

                        {sub.cancelAtPeriodEnd && (
                          <p className="pt-1 text-amber-700 dark:text-amber-400 font-medium">
                            {t('billing.cancelsAtEnd')}
                          </p>
                        )}
                      </div>
                    )}
                  </Card>

                  {/* Usage Summary */}
                  <Card className="p-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t('billing.usageTitle')}</h3>
                        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                          {t('billing.usageDesc')}
                        </p>
                      </div>
                    </div>

                    <div className="mt-5 grid grid-cols-2 gap-4 border-t border-zinc-100 dark:border-zinc-800 pt-5 sm:grid-cols-4">
                      <div>
                        <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                          {t('billing.aiCalls')}
                        </p>
                        <p className="mt-1 text-2xl font-bold text-zinc-900 dark:text-zinc-100">
                          {formatNumber(usage.monthCalls)}
                        </p>
                        <p className="text-[11px] text-zinc-400 mt-0.5">{t('calls.thisMonth')}</p>
                      </div>
                      <div>
                        <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                          {t('billing.talkMinutes')}
                        </p>
                        <p className="mt-1 text-2xl font-bold text-zinc-900 dark:text-zinc-100">
                          {formatNumber(formatMinutes(usage.totalSeconds))}
                        </p>
                        <p className="text-[11px] text-zinc-400 mt-0.5">{t('calls.thisMonth')}</p>
                      </div>
                      <div>
                        <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                          {t('billing.totalCalls')}
                        </p>
                        <p className="mt-1 text-2xl font-bold text-zinc-900 dark:text-zinc-100">
                          {formatNumber(usage.totalCalls)}
                        </p>
                        <p className="text-[11px] text-zinc-400 mt-0.5">{t('calls.allTime')}</p>
                      </div>
                      <div>
                        <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                          {t('billing.paymentMethod')}
                        </p>
                        <p className="mt-1 text-sm font-semibold text-zinc-700 dark:text-zinc-300">
                          {data.paddleConfigured ? t('billing.paddleMor') : t('billing.notConnected')}
                        </p>
                      </div>
                    </div>
                  </Card>
                </div>
              )}
            </div>
          </LayoutContent>
        }
        footer={
          data ? (
            <LayoutFooter hasDivider>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between w-full">
                <div>
                  {!isSubscribed && (
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      {t('billing.cardRequiredNotice')}
                    </p>
                  )}
                  {actionError && (
                    <p role="alert" className="text-xs text-red-600">{actionError}</p>
                  )}
                </div>
                <div className="flex justify-end gap-2 shrink-0">
                  {isSubscribed ? (
                    <Button
                      label={actionBusy === 'portal' ? t('billing.openingPortal') : t('billing.manageBilling')}
                      variant="primary"
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
            </LayoutFooter>
          ) : undefined
        }
      />
    </Dialog>
  );
}

