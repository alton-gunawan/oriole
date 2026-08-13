import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Badge, EmptyState, Skeleton, type BadgeVariant } from '@astryxdesign/core';

import { ApiError, apiFetch } from '../../lib/api';
import type { BookingRecord, BookingsListResponse } from '../../lib/bookings';
import type { IntegrationListResponse } from '../../lib/integrations';
import { useSessionStore } from '../../stores/session';
import { useWorkspaceStore } from '../../stores/workspace';
import { bookingStatusKey } from '../../i18n/enums';
import { formatDateTime } from '../../i18n/format';
import { IconCalendar, IconChart, IconDashboard, IconPhone, IconPlus, IconRefreshCw, IconUsers } from '../shell/icons';
import { Card, PageHeader, StatCard } from '../shell/ui';

const QUICK_LINKS = [
  { to: '/app/bookings', labelKey: 'dashboard.quickBookings' },
  { to: '/app/contacts', labelKey: 'dashboard.quickContacts' },
  { to: '/app/analytics', labelKey: 'dashboard.quickAnalytics' },
] as const;

/** Warna status → variant Badge Astryx (sama dengan halaman Bookings). */
const STATUS_BADGE: Record<BookingRecord['status'], BadgeVariant> = {
  pending: 'warning',
  confirmed: 'success',
  cancelled: 'error',
  completed: 'neutral',
};

function statusLabel(status: string | null, t: TFunction): string {
  const key = bookingStatusKey(status);
  return key ? t(key) : (status ?? '');
}

/**
 * Integrasi yang melakukan sinkronisasi data (punya lastSyncAt) — webhook
 * keluar tidak termasuk karena bukan "data sync".
 */
const DATA_SYNC_TYPES = ['google-forms', 'tally', 'google-calendar', 'notion'];

/** Waktu relatif ringkas untuk status sync (locale-aware via i18n). */
function relativeSyncTime(iso: string, t: TFunction): string {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return t('dashboard.syncJustNow');
  if (minutes < 60) return t('dashboard.syncMinutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('dashboard.syncHours', { count: hours });
  return t('dashboard.syncDays', { count: Math.floor(hours / 24) });
}

/** Mirrors GET /api/analytics/overview — agregat per workspace aktif. */
interface AnalyticsOverview {
  summary: {
    bookingsTotal: number;
    bookingsThisMonth: number;
    callsTotal: number;
    callsThisMonth: number;
    messagesTotal: number;
    contactsTotal: number;
    needsAttention: number;
  };
}

export function DashboardPage() {
  const { t } = useTranslation();
  const user = useSessionStore((s) => s.user);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const firstName = (user?.name ?? user?.email ?? t('dashboard.fallbackName')).split(' ')[0];

  // Semua angka dashboard kini data riil per workspace (X-Workspace-Id header
  // dikirim apiFetch dari store). Query key memuat workspace → saat pindah
  // project, data refetch otomatis dan semua kartu ikut berubah.
  const { data: overview } = useQuery({
    queryKey: ['analytics-overview', activeWorkspaceId],
    queryFn: () => apiFetch<AnalyticsOverview>('/analytics/overview'),
    enabled: Boolean(activeWorkspaceId),
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 1,
  });

  // Booking terbaru — daftar riil (bukan EmptyState statis).
  const { data: recentData, isPending: isRecentPending } = useQuery({
    queryKey: ['dashboard-recent-bookings', activeWorkspaceId],
    queryFn: () => {
      const params = new URLSearchParams({ page: '1', pageSize: '5' });
      return apiFetch<BookingsListResponse>(`/bookings?${params.toString()}`);
    },
    enabled: Boolean(activeWorkspaceId),
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 1,
  });
  const recentBookings = recentData?.bookings ?? [];
  const hasRealBookings = recentData !== undefined && recentBookings.length > 0;

  const summary = overview?.summary;
  const bookingsValue = summary === undefined ? '…' : String(summary.bookingsTotal);
  const contactsValue = summary === undefined ? '…' : String(summary.contactsTotal);
  const callsValue = summary === undefined ? '…' : String(summary.callsThisMonth);
  const attentionValue = summary === undefined ? '…' : String(summary.needsAttention);

  // Status sinkronisasi data — lastSyncAt termuda di antara integrasi data.
  // Refetch berkala agar chip ikut ter-update saat cron Google Forms / webhook
  // Tally berjalan tanpa perlu reload halaman.
  const { data: integrationsData } = useQuery({
    queryKey: ['integrations', activeWorkspaceId],
    queryFn: () => apiFetch<IntegrationListResponse>('/integrations'),
    enabled: Boolean(activeWorkspaceId),
    refetchInterval: 60_000,
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 1,
  });

  const syncIntegrations = (integrationsData?.integrations ?? []).filter((item) =>
    DATA_SYNC_TYPES.includes(item.integrationType),
  );
  const latestSyncAt =
    syncIntegrations
      .map((item) => item.lastSyncAt)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null;

  // Chip hanya tampil bila sudah ter-load (hindari flicker) DAN ada integrasi
  // data terhubung — tanpa integrasi, status sync tidak relevan di header.
  const syncChip =
    integrationsData !== undefined && syncIntegrations.length > 0 ? (
      <Link
        to="/app/integrations"
        title={t('integrations.title')}
        className="group flex items-center gap-2.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 transition hover:border-amber-300 hover:bg-amber-50/50"
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-zinc-400 transition group-hover:bg-amber-500/10 group-hover:text-amber-600">
          <IconRefreshCw className="size-3.5" />
        </span>
        <span className="min-w-0">
          <span className="block text-[10px] font-medium uppercase tracking-wider text-zinc-400">
            {t('dashboard.syncLabel')}
          </span>
          <span className="block truncate text-xs font-semibold text-zinc-700">
            {latestSyncAt
              ? relativeSyncTime(latestSyncAt, t)
              : t('dashboard.syncNever')}
          </span>
        </span>
      </Link>
    ) : null;

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('dashboard.greeting', { name: firstName })}
        description={t('dashboard.description')}
        icon={IconDashboard}
      >
        {syncChip}
      </PageHeader>

      {/* Stat cards — data riil per workspace */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={t('dashboard.bookings')}
          value={bookingsValue}
          hint={t('dashboard.allBookings')}
          icon={IconCalendar}
        />
        <StatCard
          label={t('dashboard.contacts')}
          value={contactsValue}
          hint={t('dashboard.allContacts')}
          icon={IconUsers}
        />
        <StatCard
          label={t('dashboard.aiCalls')}
          value={callsValue}
          hint={t('dashboard.thisMonthViaCalle')}
          icon={IconPhone}
        />
        <StatCard
          label={t('dashboard.needsAttention')}
          value={attentionValue}
          hint={t('dashboard.needsAttentionHint')}
          icon={IconChart}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Recent bookings — daftar riil */}
        <div className="lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-500">
            {t('dashboard.recentBookings')}
          </h2>
          {isRecentPending ? (
            <Card className="divide-y divide-zinc-100">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex items-center gap-4 px-5 py-4">
                  <Skeleton width="40%" height={14} />
                  <Skeleton className="ml-auto" width={90} height={14} />
                </div>
              ))}
            </Card>
          ) : hasRealBookings ? (
            <Card className="divide-y divide-zinc-100 p-0">
              {recentBookings.map((booking) => (
                <Link
                  key={booking.id}
                  to={`/app/bookings/${booking.id}`}
                  className="group flex items-center gap-4 px-5 py-4 transition hover:bg-amber-50/60"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-zinc-900 transition group-hover:text-amber-700">
                      {booking.title}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-zinc-500">
                      {formatDateTime(booking.scheduledAt)}
                      {booking.customerName ? ` · ${booking.customerName}` : ''}
                    </p>
                  </div>
                  <Badge
                    variant={STATUS_BADGE[booking.status]}
                    label={statusLabel(booking.status, t)}
                    style={{ fontSize: '0.875rem' }}
                  />
                </Link>
              ))}
            </Card>
          ) : (
            <EmptyState
              icon={<IconCalendar className="size-6" />}
              title={t('dashboard.noBookingsTitle')}
              description={t('dashboard.noBookingsDesc')}
              actions={
                <Link
                  to="/app/bookings/new"
                  className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-amber-600 active:scale-[0.98]"
                >
                  <IconPlus className="size-4" />
                  {t('dashboard.createBooking')}
                </Link>
              }
            />
          )}
        </div>

        {/* Quick actions */}
        <div>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-500">
            {t('dashboard.quickMenu')}
          </h2>
          <Card className="p-2">
            {QUICK_LINKS.map((item, i) => (
              <Link
                key={item.to}
                to={item.to}
                className={`flex items-center justify-between rounded-xl px-3 py-3 text-sm font-medium text-zinc-700 transition hover:bg-amber-50 hover:text-amber-700 ${
                  i > 0 ? 'mt-0.5' : ''
                }`}
              >
                {t(item.labelKey)}
                <IconPlus className="size-4 text-zinc-300" />
              </Link>
            ))}
            <div className="mt-0.5 border-t border-zinc-100 px-3 pb-2 pt-3">
              <p className="text-xs leading-relaxed text-zinc-400">{t('dashboard.note')}</p>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
