import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Badge } from '@astryxdesign/core';

import { apiFetch } from '../../lib/api';
import type { StaffRecord, StaffResponse } from '../../lib/staff';
import { useWorkspaceStore } from '../../stores/workspace';
import { formatDate } from '../../i18n/format';
import { Card } from '../shell/ui';
import {
  IconCalendar,
  IconChevronLeft,
  IconClock,
  IconMail,
  IconPhone,
  IconUsers,
} from '../shell/icons';

/** Menit sejak tengah malam → "HH:MM". */
function toTimeString(minutes: number): string {
  const h = Math.floor(Math.max(0, minutes) / 60);
  const m = Math.max(0, minutes) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

const WEEKDAY_KEYS = [
  'staff.weekdaySunday',
  'staff.weekdayMonday',
  'staff.weekdayTuesday',
  'staff.weekdayWednesday',
  'staff.weekdayThursday',
  'staff.weekdayFriday',
  'staff.weekdaySaturday',
] as const;

/**
 * Detail satu staf — dibuka dari kolom Staff di tabel Bookings (tab baru),
 * mirip kolom Customer. Menampilkan kontak, zona waktu, jadwal mingguan, dan
 * cuti. Read-only; pengelolaan tetap di halaman /app/staff.
 */
export function StaffDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

  const { data, error } = useQuery({
    queryKey: ['staff-detail', activeWorkspaceId, id],
    queryFn: () => apiFetch<StaffResponse>(`/staff/${id}`),
    enabled: Boolean(activeWorkspaceId && id),
    retry: false,
  });
  const staff: StaffRecord | undefined = data?.staff;

  if (error) {
    return (
      <div className="space-y-4">
        <Link
          to="/app/staff"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-zinc-500 transition hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          <IconChevronLeft className="size-4" />
          {t('staff.title')}
        </Link>
        <Card className="p-6">
          <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{t('staff.detailNotFound')}</p>
        </Card>
      </div>
    );
  }

  if (!staff) {
    return (
      <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
        <span className="size-2.5 animate-pulse rounded-full bg-amber-500" />
        {t('phoneNumber.connecting')}
      </div>
    );
  }

  // Jadwal dikelompokkan per hari (hari dengan beberapa rentang tampil sekali).
  const scheduleDays = staff.schedules.filter(
    (s, i, arr) => arr.findIndex((x) => x.dayOfWeek === s.dayOfWeek) === i,
  );

  return (
    <div className="space-y-8">
      <Link
        to="/app/staff"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-zinc-500 transition hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
      >
        <IconChevronLeft className="size-4" />
        {t('staff.title')}
      </Link>

      <div className="flex items-center gap-3">
        <span
          className="flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white shadow-sm"
          style={{ backgroundColor: staff.color }}
        >
          {staff.name.slice(0, 2).toUpperCase()}
        </span>
        <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
          {staff.name}
        </h1>
        {!staff.isActive && <Badge variant="neutral" label={t('staff.inactive')} />}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Kontak */}
        <Card className="p-5">
          <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">
            {t('staff.detailContact')}
          </p>
          <div className="mt-3 space-y-2.5 text-sm">
            <p className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300">
              <IconMail className="size-4 shrink-0 text-zinc-400" />
              {staff.email ?? '—'}
            </p>
            <p className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300">
              <IconPhone className="size-4 shrink-0 text-zinc-400" />
              {staff.phone ?? '—'}
            </p>
            <p className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300">
              <IconClock className="size-4 shrink-0 text-zinc-400" />
              {staff.timezone}
            </p>
            <p className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
              <IconUsers className="size-4 shrink-0 text-zinc-400" />
              {t('staff.bufferShort', { minutes: staff.bufferMinutes })}
            </p>
          </div>
        </Card>

        {/* Jadwal mingguan */}
        <Card className="p-5">
          <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">
            {t('staff.detailSchedule')}
          </p>
          {scheduleDays.length === 0 ? (
            <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">{t('staff.noScheduleHint')}</p>
          ) : (
            <div className="mt-3 space-y-2 text-sm">
              {scheduleDays.map((s) => (
                <p key={s.id} className="flex items-center justify-between gap-3">
                  <span className="text-zinc-700 dark:text-zinc-300">
                    {t(WEEKDAY_KEYS[s.dayOfWeek] ?? WEEKDAY_KEYS[0])}
                  </span>
                  <span className="text-zinc-500 dark:text-zinc-400">
                    {staff.schedules
                      .filter((x) => x.dayOfWeek === s.dayOfWeek)
                      .map((x) => `${toTimeString(x.startMinutes)} – ${toTimeString(x.endMinutes)}`)
                      .join(', ')}
                  </span>
                </p>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Cuti */}
      <Card className="p-5">
        <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-zinc-400">
          <IconCalendar className="size-4" />
          {t('staff.detailTimeOff')}
        </p>
        {staff.timeOff.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">{t('staff.detailTimeOffEmpty')}</p>
        ) : (
          <div className="mt-3 space-y-2 text-sm">
            {staff.timeOff.map((off) => (
              <p key={off.id} className="flex items-center justify-between gap-3">
                <span className="text-zinc-700 dark:text-zinc-300">
                  {formatDate(off.startDate)} – {formatDate(off.endDate)}
                </span>
                <span className="text-xs text-zinc-500 dark:text-zinc-400">{off.reason ?? '—'}</span>
              </p>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
