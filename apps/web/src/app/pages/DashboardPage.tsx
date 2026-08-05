import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';

import { apiFetch } from '../../lib/api';
import { useSessionStore } from '../../stores/session';
import { useWorkspaceStore } from '../../stores/workspace';
import { IconCalendar, IconChart, IconPhone, IconPlus, IconUsers } from '../shell/icons';
import { Card, EmptyState, PageHeader, StatCard } from '../shell/ui';

const QUICK_LINKS = [
  { to: '/app/bookings', labelKey: 'dashboard.quickBookings' },
  { to: '/app/contacts', labelKey: 'dashboard.quickContacts' },
  { to: '/app/analytics', labelKey: 'dashboard.quickAnalytics' },
  { to: '/app/settings', labelKey: 'dashboard.quickSettings' },
] as const;

export function DashboardPage() {
  const { t } = useTranslation();
  const user = useSessionStore((s) => s.user);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const firstName = (user?.name ?? user?.email ?? t('dashboard.fallbackName')).split(' ')[0];

  // Stat "Panggilan AI" memakai data riil dari /api/calls (bulan ini).
  const { data: callsData } = useQuery({
    queryKey: ['dashboard-calls', activeWorkspaceId],
    queryFn: () => apiFetch<{ summary: { monthCalls: number; totalCalls: number } }>('/calls'),
  });
  const monthCalls = callsData?.summary.monthCalls;

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('dashboard.greeting', { name: firstName })}
        description={t('dashboard.description')}
      />

      {/* Stat cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={t('dashboard.bookings')}
          value="12"
          hint={t('dashboard.next4Weeks')}
          icon={IconCalendar}
          trend={{ label: '8%', positive: true }}
        />
        <StatCard
          label={t('dashboard.contacts')}
          value="348"
          hint={t('dashboard.allContacts')}
          icon={IconUsers}
          trend={{ label: '3.2%', positive: true }}
        />
        <StatCard
          label={t('dashboard.revenue')}
          value="$2.4k"
          hint={t('dashboard.thisMonth')}
          icon={IconChart}
          trend={{ label: '12%', positive: true }}
        />
        <StatCard
          label={t('dashboard.aiCalls')}
          value={monthCalls === undefined ? '…' : String(monthCalls)}
          hint={t('dashboard.viaCalle')}
          icon={IconPhone}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Recent bookings */}
        <div className="lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-500">
            {t('dashboard.recentBookings')}
          </h2>
          <EmptyState
            icon={IconCalendar}
            title={t('dashboard.noBookingsTitle')}
            description={t('dashboard.noBookingsDesc')}
            action={{ label: t('dashboard.createBooking'), disabled: true }}
          />
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
              <p className="text-xs leading-relaxed text-zinc-400">
                {t('dashboard.note')}
              </p>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
