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

type PlanId = 'free' | 'pro' | 'business';

interface PlanInfo {
  id: PlanId;
  name: string;
  pricePerMonth: number;
  callsPerMonth: number;
  minutesPerMonth: number;
  inboundNumbersIncluded: number;
  features: string[];
}

interface BillingResponse {
  paddleConfigured: boolean;
  plan: PlanId;
  planInfo: PlanInfo;
  /** Semua paket (free → pro → business) untuk tabel perbandingan. */
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

/* ── Usage meter ───────────────────────────────────────────── */

function UsageBar({
  label,
  used,
  included,
  unit,
}: {
  label: string;
  used: number;
  included: number;
  unit: string;
}) {
  const { t } = useTranslation();
  const pct = Math.min(100, Math.round((used / Math.max(included, 1)) * 100));
  const over = used > included;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{label}</p>
        <p className={`text-xs font-semibold ${over ? 'text-red-600' : 'text-zinc-500 dark:text-zinc-400'}`}>
          {used} / {included} {unit}
        </p>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
        <div
          className={`h-full rounded-full transition-all duration-500 ${
            over ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-emerald-500'
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {over && (
        <p className="mt-1.5 text-xs text-red-600">
          {t('billing.overQuota')}
        </p>
      )}
    </div>
  );
}

/* ── Dialog billing ──────────────────────────────────────────
 * Dulu halaman /app/billing — kini dialog yang dibuka dari dropdown
 * akun di footer sidebar (menu → item "Billing"). Struktur mengikuti
 * dialog "Create business" (WorkspaceSettingsPage): Layout dengan
 * header tetap, konten scroll di tengah, dan footer aksi selalu
 * terlihat — tombol upgrade/portal tidak lagi terkubur di dalam kartu.
 * Data di-refetch otomatis tiap dialog dibuka (activeWorkspaceId di
 * queryKey + enabled: isOpen). */

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

  // 401 = sesi habis — apiFetch sudah mereset sesi dan RequireAuth akan
  // mengarahkan ke halaman masuk; jangan tampilkan kartu error ini.
  const isAuthExpiry = error instanceof ApiError && error.status === 401;
  const showError = isError && !isAuthExpiry;

  const failAction = (err: unknown) => {
    // apiFetch sudah mengekstrak `detail` (alasan asli, mis. dari Paddle)
    // bila ada — tampilkan apa adanya.
    const message = err instanceof Error ? err.message : t('errors.billingAction');
    setActionError(message);
    setActionBusy(null);
  };

  /** Checkout paket berbayar (pro | business) → redirect ke Paddle. */
  const runCheckout = async (target: 'pro' | 'business') => {
    setActionError(null);
    setActionBusy('checkout');
    try {
      const { url } = await apiFetch<{ url: string }>('/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({ plan: target }),
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
                        <code>PADDLE_PRO_PRICE_ID</code> / <code>PADDLE_BUSINESS_PRICE_ID</code> in <code>.env</code> to enable checkout & portal. Info below shows default status.
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

              {/* Sesi habis — menunggu redirect ke halaman masuk */}
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
                <>
                  <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
                    {/* Current plan */}
                    <Card className="p-6">
                      <div className="flex items-center gap-2.5">
                        <span className="flex size-9 items-center justify-center rounded-xl bg-amber-500/10 text-amber-600">
                          <IconCreditCard className="size-5" />
                        </span>
                        <div>
                          <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                            {t('billing.currentPlan')}
                          </p>
                          <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{plan.name}</p>
                        </div>
                      </div>

                      <p className="mt-5 text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
                        {formatPrice(plan.pricePerMonth)}
                        <span className="text-sm font-medium text-zinc-400">{t('common.perMonth')}</span>
                      </p>

                      <ul className="mt-5 space-y-2">
                        {plan.features.map((feature) => (
                          <li key={feature} className="flex items-start gap-2 text-sm text-zinc-600 dark:text-zinc-400">
                            <IconCheck className="mt-0.5 size-4 shrink-0 text-emerald-500" />
                            {feature}
                          </li>
                        ))}
                      </ul>

                      {sub && (
                        <div className="mt-6 space-y-1.5 rounded-xl bg-zinc-50 dark:bg-zinc-900 px-3 py-2.5 text-xs text-zinc-600 dark:text-zinc-400">
                          <div className="flex items-center justify-between gap-2">
                            <span>{t('billing.status')}</span>
                            <Badge variant={badgeFor(sub.status, t).variant} label={badgeFor(sub.status, t).label} />
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <span>{t('billing.renewal')}</span>
                            <span className="font-medium text-zinc-800 dark:text-zinc-200">{formatDate(sub.currentPeriodEnd)}</span>
                          </div>
                          {sub.cancelAtPeriodEnd && (
                            <p className="pt-1 text-amber-700">
                              {t('billing.cancelsAtEnd')}
                            </p>
                          )}
                        </div>
                      )}
                    </Card>

                    {/* Usage */}
                    <Card className="p-6 lg:col-span-2">
                      <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t('billing.usageTitle')}</h3>
                      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                        {t('billing.usageDesc', { plan: plan.name })}
                      </p>

                      <div className="mt-6 space-y-6">
                        <UsageBar
                          label={t('billing.aiCalls')}
                          used={usage.monthCalls}
                          included={plan.callsPerMonth}
                          unit={t('billing.callsUnit')}
                        />
                        <UsageBar
                          label={t('billing.talkMinutes')}
                          used={formatMinutes(usage.totalSeconds)}
                          included={plan.minutesPerMonth}
                          unit={t('billing.minutesUnit')}
                        />
                      </div>

                      <div className="mt-6 grid grid-cols-1 gap-4 border-t border-zinc-100 dark:border-zinc-800 pt-5 sm:grid-cols-3">
                        <div>
                          <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                            {t('billing.totalCalls')}
                          </p>
                          <p className="mt-1 text-lg font-bold text-zinc-900 dark:text-zinc-100">{formatNumber(usage.totalCalls)}</p>
                        </div>
                        <div>
                          <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                            {t('billing.totalMinutes')}
                          </p>
                          <p className="mt-1 text-lg font-bold text-zinc-900 dark:text-zinc-100">
                            {formatNumber(formatMinutes(usage.totalSeconds))}
                          </p>
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

                  {/* Plan comparison */}
                  <section>
                    <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                      {t('billing.comparePlans')}
                    </h2>
                    <Card className="overflow-x-auto">
                      <table className="w-full min-w-[640px] text-left text-sm">
                        <thead>
                          <tr className="border-b border-zinc-100 dark:border-zinc-800 text-xs uppercase tracking-wider text-zinc-400">
                            <th className="px-5 py-3.5 font-semibold">{t('billing.feature')}</th>
                            {data.plans.map((p) => {
                              return (
                                <th
                                  key={p.id}
                                  className={`px-5 py-3.5 font-semibold ${
                                    data.plan === p.id ? 'text-amber-600' : ''
                                  }`}
                                >
                                  {p.name}
                                  {data.plan === p.id && (
                                    <Badge variant="warning" label={t('billing.active')} className="ml-2" />
                                  )}
                                </th>
                              );
                            })}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                          <tr>
                            <td className="px-5 py-3 text-zinc-600 dark:text-zinc-400">{t('billing.price')}</td>
                            {data.plans.map((p) => (
                              <td key={p.id} className="px-5 py-3 font-semibold text-zinc-900 dark:text-zinc-100">
                                {formatPrice(p.pricePerMonth)}
                                <span className="text-xs font-medium text-zinc-400">
                                  {t('common.perMonth')}
                                </span>
                              </td>
                            ))}
                          </tr>
                          <tr>
                            <td className="px-5 py-3 text-zinc-600 dark:text-zinc-400">{t('billing.aiCallsPerMonth')}</td>
                            {data.plans.map((p) => (
                              <td key={p.id} className="px-5 py-3 text-zinc-900 dark:text-zinc-100">
                                {formatNumber(p.callsPerMonth)}
                              </td>
                            ))}
                          </tr>
                          <tr>
                            <td className="px-5 py-3 text-zinc-600 dark:text-zinc-400">{t('billing.minutesPerMonth')}</td>
                            {data.plans.map((p) => (
                              <td key={p.id} className="px-5 py-3 text-zinc-900 dark:text-zinc-100">
                                {formatNumber(p.minutesPerMonth)}
                              </td>
                            ))}
                          </tr>
                          <tr>
                            <td className="px-5 py-3 text-zinc-600 dark:text-zinc-400">{t('billing.inboundReceptionist')}</td>
                            {data.plans.map((p) => (
                              <td key={p.id} className="px-5 py-3 text-zinc-900 dark:text-zinc-100">
                                {p.inboundNumbersIncluded > 0 ? t('billing.oneNumberIncluded') : '—'}
                              </td>
                            ))}
                          </tr>
                          <tr>
                            <td className="px-5 py-3 text-zinc-600 dark:text-zinc-400">{t('billing.callHistory')}</td>
                            {data.plans.map((p) => (
                              <td key={p.id} className="px-5 py-3 text-zinc-900 dark:text-zinc-100">
                                {p.id === 'free' ? t('billing.days30') : t('billing.unlimited')}
                              </td>
                            ))}
                          </tr>
                          <tr>
                            <td className="px-5 py-3 text-zinc-600 dark:text-zinc-400">{t('billing.support')}</td>
                            {data.plans.map((p) => (
                              <td key={p.id} className="px-5 py-3 text-zinc-900 dark:text-zinc-100">
                                {p.id === 'free' ? t('billing.community') : t('billing.priority')}
                              </td>
                            ))}
                          </tr>
                        </tbody>
                      </table>
                    </Card>
                    <p className="mt-2 text-xs text-zinc-400">
                      {t('billing.usageNote')}
                    </p>
                  </section>
                </>
              )}
            </div>
          </LayoutContent>
        }
        footer={
          // Footer aksi hanya tampil saat data siap — saat loading/error tidak
          // ada tombol mati yang membingungkan (konten error punya tombol Retry).
          data ? (
            <LayoutFooter hasDivider>
              {actionError && (
                <p role="alert" className="pb-2 text-right text-sm text-red-600">{actionError}</p>
              )}
              <div className="flex justify-end gap-2">
                <Button
                  label={actionBusy === 'portal' ? t('billing.openingPortal') : t('billing.manageBilling')}
                  variant="secondary"
                  isLoading={actionBusy === 'portal'}
                  isDisabled={!data.paddleConfigured || !data.subscription || actionBusy !== null}
                  onClick={() => void runPortal()}
                />
                <Button
                  label={
                    actionBusy !== null
                      ? actionBusy === 'checkout'
                        ? t('billing.preparing')
                        : t('billing.openingPortal')
                      : data.plan === 'free'
                        ? t('billing.upgradePro')
                        : data.plan === 'pro'
                          ? t('billing.upgradeBusiness')
                          : t('billing.changePlan')
                  }
                  variant="primary"
                  isLoading={actionBusy !== null}
                  isDisabled={!data.paddleConfigured || actionBusy !== null}
                  onClick={() =>
                    void (data.plan === 'business'
                      ? runPortal()
                      : runCheckout(data.plan === 'free' ? 'pro' : 'business'))
                  }
                />
              </div>
            </LayoutFooter>
          ) : undefined
        }
      />
    </Dialog>
  );
}
