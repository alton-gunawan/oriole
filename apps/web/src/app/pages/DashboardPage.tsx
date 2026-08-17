import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Badge, EmptyState, Skeleton, type BadgeVariant } from '@astryxdesign/core';

import { ApiError, apiFetch } from '../../lib/api';
import type { BookingRecord, BookingsListResponse } from '../../lib/bookings';
import { useSessionStore } from '../../stores/session';
import { useWorkspaceStore } from '../../stores/workspace';
import { bookingStatusKey } from '../../i18n/enums';
import { formatDateTime } from '../../i18n/format';
import { IconCalendar, IconChart, IconDashboard, IconPhone, IconPlus, IconUsers } from '../shell/icons';
import { Card, PageHeader, StatCard } from '../shell/ui';

const QUICK_LINKS = [
  { to: '/app/bookings', labelKey: 'dashboard.quickBookings' },
  { to: '/app/contacts', labelKey: 'dashboard.quickContacts' },
  { to: '/app/calendar', labelKey: 'dashboard.quickCalendar' },
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
  // bisnis, data refetch otomatis dan semua kartu ikut berubah.
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

    return (
    <div className="space-y-8">
      <PageHeader
        title={t('dashboard.greeting', { name: firstName })}
        description={t('dashboard.description')}
        icon={IconDashboard}
      />

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
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            {t('dashboard.recentBookings')}
          </h2>
          {isRecentPending ? (
            <Card className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex items-center gap-4 px-5 py-4">
                  <Skeleton width="40%" height={14} />
                  <Skeleton className="ml-auto" width={90} height={14} />
                </div>
              ))}
            </Card>
          ) : hasRealBookings ? (
            <Card className="divide-y divide-zinc-100 dark:divide-zinc-800 p-0">
              {recentBookings.map((booking) => (
                <Link
                  key={booking.id}
                  to={`/app/bookings/${booking.id}`}
                  className="group flex items-center gap-4 px-5 py-4 transition hover:bg-amber-50/60 dark:hover:bg-amber-950/30"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100 transition group-hover:text-amber-700">
                      {booking.title}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">
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
                  className="inline-flex items-center gap-2 rounded-lg bg-amber-500 h-8 px-4 text-base font-semibold text-white shadow-sm transition hover:bg-amber-600 active:scale-[0.98]"
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
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            {t('dashboard.quickMenu')}
          </h2>
          <Card className="p-2">
            {QUICK_LINKS.map((item, i) => (
              <Link
                key={item.to}
                to={item.to}
                className={`flex items-center justify-between rounded-xl px-3 py-3 text-sm font-medium text-zinc-700 dark:text-zinc-300 transition hover:bg-amber-50 hover:text-amber-700 ${
                  i > 0 ? 'mt-0.5' : ''
                }`}
              >
                {t(item.labelKey)}
                <IconPlus className="size-4 text-zinc-300" />
              </Link>
            ))}
            <div className="mt-0.5 border-t border-zinc-100 dark:border-zinc-800 px-3 pb-2 pt-3">
              <p className="text-xs leading-relaxed text-zinc-400">{t('dashboard.note')}</p>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
