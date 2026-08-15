import { useQuery } from '@tanstack/react-query';
import { BarChart, DonutChart } from '@tremor/react';
import type { ReactNode } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { ApiError, apiFetch } from '../../lib/api';
import { activeLocale, formatNumber } from '../../i18n/format';
import { bookingStatusKey, callStatusKey } from '../../i18n/enums';
import {
  IconAlertTriangle,
  IconCalendar,
  IconChart,
  IconChat,
  IconPhone,
} from '../shell/icons';
import { Card, EmptyState, PageHeader, SessionExpiredCard, StatCard } from '../shell/ui';
import { useWorkspaceStore } from '../../stores/workspace';

/* ── Types (mirror dari GET /api/analytics/overview) ────────── */

interface AnalyticsOverview {
  summary: {
    bookingsTotal: number;
    bookingsThisMonth: number;
    callsTotal: number;
    callsThisMonth: number;
    messagesTotal: number;
    needsAttention: number;
  };
  bookingsByMonth: { month: string; count: number }[];
  bookingStatus: { status: string; count: number }[];
  callOutcomes: { status: string; count: number }[];
  messagesByChannel: { channel: string; inbound: number; outbound: number }[];
  funnel: { step: 'created' | 'confirmed' | 'completed'; count: number }[];
}

/* ── Warna Tremor per slug (fallback zinc untuk slug asing) ── */

const STATUS_COLORS: Record<string, string> = {
  pending: 'amber',
  confirmed: 'blue',
  completed: 'emerald',
  cancelled: 'red',
};

const CALL_COLORS: Record<string, string> = {
  completed: 'emerald',
  success: 'emerald',
  failed: 'red',
  error: 'red',
  in_progress: 'amber',
  'in-progress': 'amber',
  pending: 'amber',
  queued: 'zinc',
  canceled: 'zinc',
  cancelled: 'zinc',
};

function statusColor(status: string): string {
  return STATUS_COLORS[status] ?? 'zinc';
}

function callColor(status: string): string {
  return CALL_COLORS[status] ?? 'zinc';
}

/* ── Funnel konversi (custom, proporsional) ─────────────────── */

const FUNNEL_STEPS = [
  { step: 'created', color: '#d4d4d8' },
  { step: 'confirmed', color: '#60a5fa' },
  { step: 'completed', color: '#10b981' },
] as const;

type FunnelStep = (typeof FUNNEL_STEPS)[number]['step'];

function FunnelChart({ data, t }: { data: AnalyticsOverview['funnel']; t: TFunction }) {
  const max = Math.max(...data.map((row) => row.count), 1);

  return (
    <div className="space-y-4">
      {FUNNEL_STEPS.map(({ step, color }, index) => {
        const count = data.find((row) => row.step === (step as FunnelStep))?.count ?? 0;
        const width = count === 0 ? 0 : Math.max(8, Math.round((count / max) * 100));
        const pct = max > 0 ? Math.round((count / max) * 100) : 0;
        const label =
          step === 'created'
            ? t('analytics.funnelCreated')
            : step === 'confirmed'
              ? t('analytics.funnelConfirmed')
              : t('analytics.funnelCompleted');
        return (
          <div key={step}>
            <div className="mb-1.5 flex items-baseline justify-between text-xs">
              <span className="flex items-center gap-1.5 font-medium text-zinc-700 dark:text-zinc-300">
                <span className="inline-block size-2 rounded-full" style={{ backgroundColor: color }} />
                {label}
              </span>
              <span className="tabular-nums text-zinc-500 dark:text-zinc-400">
                {formatNumber(count)} <span className="text-zinc-400">· {pct}%</span>
              </span>
            </div>
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${width}%`, backgroundColor: color }}
              />
            </div>
            {index < FUNNEL_STEPS.length - 1 && (
              <p className="mt-1 text-xs text-zinc-400">{t('analytics.funnelStepHint')}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ── Chart card wrapper ─────────────────────────────────────── */

function ChartCard({
  title,
  subtitle,
  icon,
  children,
  className = '',
}: {
  title: string;
  subtitle?: string;
  icon: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={`p-5 sm:p-6 ${className}`}>
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h3>
          {subtitle && <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{subtitle}</p>}
        </div>
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-600">
          {icon}
        </span>
      </div>
      {children}
    </Card>
  );
}

/* ── Page ───────────────────────────────────────────────────── */

export function AnalyticsPage() {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? activeLocale();
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['analytics', activeWorkspaceId],
    queryFn: () => apiFetch<AnalyticsOverview>('/analytics/overview'),
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 1,
  });

  const isAuthExpiry = error instanceof ApiError && error.status === 401;
  const showError = isError && !isAuthExpiry;

  // Label bulan mengikuti bahasa aktif (Intl) — bukan array statis.
  const monthLabel = (month: string) =>
    new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1).toLocaleString(
      language,
      { month: 'short' },
    );

  const bookingMonthData = (data?.bookingsByMonth ?? []).map((row) => ({
    bulan: monthLabel(row.month),
    bookings: row.count,
  }));

  const statusDonut = (data?.bookingStatus ?? []).map((row) => ({
    name: bookingStatusKey(row.status) ? t(bookingStatusKey(row.status)!) : row.status,
    value: row.count,
    status: row.status,
  }));

  const callDonut = (data?.callOutcomes ?? []).map((row) => ({
    name: callStatusKey(row.status) ? t(callStatusKey(row.status)!) : row.status,
    value: row.count,
    status: row.status,
  }));

  // Label kategori (legend) memakai i18n — key data mengikuti agar tremor
  // menampilkan nama yang benar-benar terbaca, bukan slug Inggris mentah.
  const inboundLabel = t('analytics.inbound');
  const outboundLabel = t('analytics.outbound');
  const channelData = (data?.messagesByChannel ?? []).map((row) => ({
    channel:
      row.channel === 'whatsapp'
        ? t('channels.whatsapp')
        : row.channel === 'telegram'
          ? t('channels.telegram')
          : row.channel,
    [inboundLabel]: row.inbound,
    [outboundLabel]: row.outbound,
  }));

  const isEmpty =
    data &&
    data.summary.bookingsTotal === 0 &&
    data.summary.callsTotal === 0 &&
    data.summary.messagesTotal === 0;

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('analytics.title')}
        description={t('analytics.description')}
        icon={IconChart}
      />

      {/* Stat cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={t('analytics.bookingsThisMonth')}
          value={isPending ? '…' : String(data?.summary.bookingsThisMonth ?? 0)}
          hint={t('analytics.ofTotal', { total: data ? formatNumber(data.summary.bookingsTotal) : '…' })}
          icon={IconCalendar}
        />
        <StatCard
          label={t('analytics.callsThisMonth')}
          value={isPending ? '…' : String(data?.summary.callsThisMonth ?? 0)}
          hint={t('analytics.ofTotal', { total: data ? formatNumber(data.summary.callsTotal) : '…' })}
          icon={IconPhone}
        />
        <StatCard
          label={t('analytics.messagesTotal')}
          value={isPending ? '…' : String(data?.summary.messagesTotal ?? 0)}
          hint={t('analytics.allChannels')}
          icon={IconChat}
        />
        <StatCard
          label={t('analytics.needsAttention')}
          value={isPending ? '…' : String(data?.summary.needsAttention ?? 0)}
          hint={t('analytics.needsAttentionHint')}
          icon={IconAlertTriangle}
        />
      </div>

      {/* Error state */}
      {showError && (
        <Card className="flex flex-col items-center gap-4 p-10 text-center">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-red-50 text-red-500 dark:bg-red-950/50 dark:text-red-400">
            <IconAlertTriangle className="size-6" />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t('analytics.errorTitle')}</h3>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              {error instanceof ApiError
                ? t('errors.apiStatus', { status: error.status })
                : t('errors.apiConnection')}
            </p>
          </div>
          <button
            onClick={() => void refetch()}
            className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700"
          >
            {t('common.retry')}
          </button>
        </Card>
      )}

      {/* Sesi habis */}
      {isAuthExpiry && <SessionExpiredCard />}

      {/* Loading skeleton untuk area chart */}
      {isPending && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <Card className="animate-pulse p-5 sm:p-6 lg:col-span-2">
            <div className="mb-5 h-4 w-40 rounded bg-zinc-100 dark:bg-zinc-800" />
            <div className="h-56 rounded-lg bg-zinc-100 dark:bg-zinc-800" />
          </Card>
          <Card className="animate-pulse p-5 sm:p-6">
            <div className="mb-5 h-4 w-32 rounded bg-zinc-100 dark:bg-zinc-800" />
            <div className="h-56 rounded-full bg-zinc-100 dark:bg-zinc-800" />
          </Card>
        </div>
      )}

      {/* Empty state */}
      {!isPending && !isError && isEmpty && (
        <EmptyState
          icon={IconChart}
          title={t('analytics.emptyTitle')}
          description={t('analytics.emptyDesc')}
        />
      )}

      {/* Charts */}
      {!isPending && !isError && data && !isEmpty && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* 1. Booking per bulan */}
          <ChartCard
            title={t('analytics.bookingsByMonth')}
            subtitle={t('analytics.last12Months')}
            icon={<IconCalendar className="size-4.5" />}
            className="lg:col-span-2"
          >
            <BarChart
              data={bookingMonthData}
              index="bulan"
              categories={['bookings']}
              colors={['amber']}
              showLegend={false}
              showGridLines={false}
              yAxisWidth={40}
              className="h-56"
            />
          </ChartCard>

          {/* 2. Status booking */}
          <ChartCard
            title={t('analytics.bookingStatus')}
            subtitle={t('analytics.statusSubtitle')}
            icon={<IconCalendar className="size-4.5" />}
          >
            {statusDonut.length > 0 ? (
              <DonutChart
                data={statusDonut}
                index="name"
                category="value"
                colors={statusDonut.map((row) => statusColor(row.status))}
                valueFormatter={(value) => formatNumber(value)}
                showLabel={false}
                className="h-56"
              />
            ) : (
              <p className="py-16 text-center text-sm text-zinc-400">{t('analytics.noStatusData')}</p>
            )}
          </ChartCard>

          {/* 3. Hasil panggilan AI */}
          <ChartCard
            title={t('analytics.callOutcomes')}
            subtitle={t('analytics.callOutcomesSubtitle')}
            icon={<IconPhone className="size-4.5" />}
          >
            {callDonut.length > 0 ? (
              <DonutChart
                data={callDonut}
                index="name"
                category="value"
                colors={callDonut.map((row) => callColor(row.status))}
                valueFormatter={(value) => formatNumber(value)}
                showLabel={false}
                className="h-56"
              />
            ) : (
              <p className="py-16 text-center text-sm text-zinc-400">{t('analytics.noCallsData')}</p>
            )}
          </ChartCard>

          {/* 4. Pesan per channel */}
          <ChartCard
            title={t('analytics.messagesByChannel')}
            subtitle={t('analytics.channelSubtitle')}
            icon={<IconChat className="size-4.5" />}
            className="lg:col-span-2"
          >
            {channelData.length > 0 ? (
              <BarChart
                data={channelData}
                index="channel"
                categories={[inboundLabel, outboundLabel]}
                // Amber = inbound (aksen brand), emerald = outbound (sukses/
                // terkirim) — selaras dengan palet status & funnel di halaman.
                colors={['amber', 'emerald']}
                stack
                showLegend
                showGridLines={false}
                yAxisWidth={40}
                className="h-56"
              />
            ) : (
              <p className="py-16 text-center text-sm text-zinc-400">{t('analytics.noChannelData')}</p>
            )}
          </ChartCard>

          {/* 5. Funnel konversi */}
          <ChartCard
            title={t('analytics.conversionFunnel')}
            subtitle={t('analytics.funnelSubtitle')}
            icon={<IconChart className="size-4.5" />}
          >
            <FunnelChart data={data.funnel} t={t} />
          </ChartCard>
        </div>
      )}
    </div>
  );
}
