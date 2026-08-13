import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Skeleton, type BadgeVariant } from '@astryxdesign/core';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { ApiError, apiFetch } from '../../lib/api';
import { Card, EmptyState, PageHeader, ReloadMenuButton, SessionExpiredCard, StatCard } from '../shell/ui';
import { useWorkspaceStore } from '../../stores/workspace';
import { callStatusKey } from '../../i18n/enums';
import { formatDateTime } from '../../i18n/format';
import { IconAlertTriangle, IconClock, IconPhone } from '../shell/icons';

/* ── Types (mirror dari GET /api/calls) ────────────────────── */

interface CallRecord {
  id: string;
  calleCallId: string;
  phone: string;
  task: string | null;
  status: string | null;
  result: Record<string, unknown> | null;
  createdAt: string;
}

interface CallsResponse {
  calls: CallRecord[];
  summary: {
    totalCalls: number;
    monthCalls: number;
    completed: number;
    failed: number;
    totalSeconds: number;
  };
}

/* ── Helpers ───────────────────────────────────────────────── */

const STATUS_BADGE: Record<string, BadgeVariant> = {
  completed: 'success',
  success: 'success',
  failed: 'error',
  error: 'error',
  in_progress: 'warning',
  'in-progress': 'warning',
  pending: 'warning',
  queued: 'neutral',
  canceled: 'neutral',
  cancelled: 'neutral',
};

function statusLabel(status: string | null, t: TFunction): string {
  const key = callStatusKey(status);
  return key ? t(key) : (status ?? '');
}

function statusBadge(status: string | null): BadgeVariant {
  if (status && STATUS_BADGE[status]) return STATUS_BADGE[status];
  return 'neutral';
}

function formatDuration(seconds: number, t: TFunction): string {
  const minutes = Math.round(seconds / 60);
  return t('calls.minutes', { count: minutes });
}

function resultSnippet(result: Record<string, unknown> | null, t: TFunction): string {
  if (!result) return '—';
  for (const key of ['summary', 'outcome', 'result', 'transcript']) {
    const value = result[key];
    if (typeof value === 'string' && value.trim()) {
      return value.length > 130 ? `${value.slice(0, 130)}…` : value;
    }
  }
  return t('calls.resultSaved');
}

/* ── Page ──────────────────────────────────────────────────── */

export function CallsPage() {
  const { t } = useTranslation();
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const { data, isPending, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['calls', activeWorkspaceId],
    queryFn: () => apiFetch<CallsResponse>('/calls'),
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 1,
  });

  // 401 = sesi habis — apiFetch sudah mereset sesi dan RequireAuth akan
  // mengarahkan ke halaman masuk; jangan tampilkan kartu error ini.
  const isAuthExpiry = error instanceof ApiError && error.status === 401;
  const showError = isError && !isAuthExpiry;

  const summary = data?.summary;
  const successRate =
    summary && summary.totalCalls > 0
      ? Math.round((summary.completed / summary.totalCalls) * 100)
      : 0;

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('calls.title')}
        description={t('calls.description')}
        icon={IconPhone}
      >
        <ReloadMenuButton isFetching={isFetching} onReload={() => void refetch()} />
      </PageHeader>

      {/* Stat cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={t('calls.totalCalls')}
          value={isPending ? '…' : String(summary?.totalCalls ?? 0)}
          hint={t('calls.allTime')}
          icon={IconPhone}
        />
        <StatCard
          label={t('calls.thisMonth')}
          value={isPending ? '…' : String(summary?.monthCalls ?? 0)}
          hint={t('calls.sinceMonthStart')}
          icon={IconClock}
        />
        <StatCard
          label={t('calls.successRate')}
          value={isPending ? '…' : `${successRate}%`}
          hint={`${summary?.completed ?? 0} ${t('calls.completed')} · ${summary?.failed ?? 0} ${t('calls.failed')}`}
          icon={IconPhone}
        />
        <StatCard
          label={t('calls.talkDuration')}
          value={isPending ? '…' : formatDuration(summary?.totalSeconds ?? 0, t)}
          hint={t('calls.totalAllHistory')}
          icon={IconClock}
        />
      </div>

      {/* Error state */}
      {showError && (
        <Card className="flex flex-col items-center gap-4 p-10 text-center">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-red-50 text-red-500">
            <IconAlertTriangle className="size-6" />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-zinc-900">{t('errors.callsLoadTitle')}</h3>
            <p className="mt-1 text-sm text-zinc-500">
              {error instanceof ApiError
                ? t('errors.apiStatus', { status: error.status })
                : t('errors.apiConnection')}
            </p>
          </div>
          <Button label={t('common.retry')} variant="primary" onClick={() => void refetch()} />
        </Card>
      )}

      {/* Sesi habis — menunggu redirect ke halaman masuk */}
      {isAuthExpiry && <SessionExpiredCard />}

      {/* Loading skeleton */}
      {isPending && (
        <div className="space-y-4">
          <Skeleton width={192} height={28} />
          <div className="space-y-3">
            {[0, 1, 2, 3].map((i) => (
              <Card key={i} className="flex items-center gap-4 p-4">
                <Skeleton width={40} height={40} radius={2} />
                <div className="flex-1 space-y-2">
                  <Skeleton width="33%" height={16} />
                  <Skeleton width="66%" height={12} />
                </div>
                <Skeleton width={80} height={24} radius="rounded" />
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Call list */}
      {!isPending && !isError && data && (
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-500">
            {t('calls.history')}
          </h2>

          {data.calls.length === 0 ? (
            <EmptyState
              icon={IconPhone}
              title={t('calls.noCallsTitle')}
              description={t('calls.noCallsDesc')}
            />
          ) : (
            <Card className="divide-y divide-zinc-100">
              {data.calls.map((call) => (
                <div
                  key={call.id}
                  className="flex flex-col gap-3 p-4 transition hover:bg-zinc-50/60 sm:flex-row sm:items-center sm:gap-5"
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-600">
                    <IconPhone className="size-5" />
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <p className="text-sm font-semibold text-zinc-900">{call.phone}</p>
                      <Badge variant={statusBadge(call.status)} label={statusLabel(call.status, t)} />
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                      {resultSnippet(call.result, t)}
                    </p>
                  </div>

                  <div className="shrink-0 text-right">
                    <p className="text-xs font-medium text-zinc-700">{formatDateTime(call.createdAt)}</p>
                    {call.task && <p className="mt-0.5 text-xs text-zinc-400">{call.task}</p>}
                  </div>
                </div>
              ))}
            </Card>
          )}
        </section>
      )}
    </div>
  );
}

/* Re-export type agar halaman lain bisa memakai bentuk response. */
export type { CallRecord, CallsResponse };
