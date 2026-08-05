import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import {
  Badge,
  Button,
  DateInput,
  EmptyState,
  Selector,
  Skeleton,
  Table,
  pixel,
  proportional,
  useTableSelection,
  useTableSelectionState,
  type BadgeVariant,
  type ButtonVariant,
  type ISODateString,
  type TableColumn,
} from '@astryxdesign/core';

import { ApiError, apiFetch } from '../../lib/api';
import type { BookingRecord, BookingsListResponse } from '../../lib/bookings';
import { useWorkspaceStore } from '../../stores/workspace';
import { bookingStatusKey, goalTypeKey } from '../../i18n/enums';
import { formatDateTime } from '../../i18n/format';
import type { TranslationKey } from '../../i18n';
import { IconAlertTriangle, IconCalendar, IconPhone, IconPlus, IconRefreshCw } from '../shell/icons';
import { Card, PageHeader } from '../shell/ui';

/** Warna status → variant Badge Astryx (theme-neutral). */
const STATUS_BADGE: Record<BookingRecord['status'], BadgeVariant> = {
  pending: 'warning',
  confirmed: 'success',
  cancelled: 'error',
  completed: 'neutral',
};

/** Baris tabel: BookingRecord + index signature (Table butuh Record<string, unknown>). */
type BookingTableRow = BookingRecord & Record<string, unknown>;

/** Param URL tanggal valid (YYYY-MM-DD & tanggal kalender nyata) — selain itu diabaikan. */
function isValidDateParam(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00`).getTime());
}

/** Konversi string tanggal yang sudah divalidasi → ISODateString untuk DateInput. */
function asDate(value: string): ISODateString | undefined {
  return value ? (value as ISODateString) : undefined;
}

const VALID_STATUSES: BookingRecord['status'][] = ['pending', 'confirmed', 'completed', 'cancelled'];

function statusLabel(status: string | null, t: TFunction): string {
  const key = bookingStatusKey(status);
  return key ? t(key) : (status ?? '');
}

/** Aksi status cepat yang tampil di kartu booking, sesuai status saat ini. */
const QUICK_ACTIONS: Record<
  BookingRecord['status'],
  { to: BookingRecord['status']; labelKey: TranslationKey; variant: ButtonVariant }[]
> = {
  pending: [
    { to: 'confirmed', labelKey: 'bookings.confirm', variant: 'primary' },
    { to: 'cancelled', labelKey: 'bookings.cancel', variant: 'destructive' },
  ],
  confirmed: [
    { to: 'completed', labelKey: 'bookings.complete', variant: 'secondary' },
    { to: 'cancelled', labelKey: 'bookings.cancel', variant: 'destructive' },
  ],
  cancelled: [],
  completed: [],
};

export function BookingsPage() {
  const { t } = useTranslation();
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const queryClient = useQueryClient();

  // ── Filter daftar booking — dipersist di URL agar bisa dibagikan ──
  const [searchParams, setSearchParams] = useSearchParams();

  const rawStatus = searchParams.get('status');
  const statusFilter: BookingRecord['status'] | '' =
    rawStatus && (VALID_STATUSES as readonly string[]).includes(rawStatus)
      ? (rawStatus as BookingRecord['status'])
      : '';
  const fromRaw = searchParams.get('from') ?? '';
  const toRaw = searchParams.get('to') ?? '';
  const fromFilter = isValidDateParam(fromRaw) ? fromRaw : '';
  const toFilter = isValidDateParam(toRaw) ? toRaw : '';
  const hasFilters = Boolean(statusFilter || fromFilter || toFilter);

  /** Tulis satu param filter ke URL tanpa menghapus param lain. */
  const setFilter = (key: 'status' | 'from' | 'to', value: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    });
  };
  const resetFilters = () => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('status');
      next.delete('from');
      next.delete('to');
      return next;
    });
  };

  const {
    data,
    isPending,
    isError,
    error,
    refetch,
    isFetching,
    isPlaceholderData,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ['bookings', activeWorkspaceId, statusFilter, fromFilter, toFilter],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      // Input tanggal → batas hari lokal → ISO UTC (scheduled_at tersimpan ber-timezone).
      if (fromFilter) params.set('from', new Date(`${fromFilter}T00:00:00`).toISOString());
      if (toFilter) params.set('to', new Date(`${toFilter}T23:59:59.999`).toISOString());
      if (pageParam) params.set('cursor', pageParam);
      const qs = params.toString();
      return apiFetch<BookingsListResponse>(`/bookings${qs ? `?${qs}` : ''}`);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    // Tampilkan data lama saat filter berubah — hindari kedipan skeleton.
    placeholderData: keepPreviousData,
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 1,
  });

  // Aksi status — satu atau lebih booking sedang diproses dalam satu waktu.
  const [mutating, setMutating] = useState<{
    ids: string[];
    to: BookingRecord['status'];
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const statusMutation = useMutation({
    mutationFn: ({ ids, status }: { ids: string[]; status: BookingRecord['status'] }) =>
      Promise.all(
        ids.map((id) =>
          apiFetch(`/bookings/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ status }),
          }),
        ),
      ),
    // Optimistic: ubah status di cache seketika; rollback bila request gagal.
    onMutate: async ({ ids, status }) => {
      setActionError(null);
      await queryClient.cancelQueries({ queryKey: ['bookings', activeWorkspaceId] });

      // Snapshot semua varian filter (query key berisi filter) untuk rollback.
      const snapshot = queryClient.getQueriesData<
        InfiniteData<BookingsListResponse, string | null>
      >({
        queryKey: ['bookings', activeWorkspaceId],
      });
      const previousLists = new Map<
        string,
        InfiniteData<BookingsListResponse, string | null> | undefined
      >();
      for (const [key, value] of snapshot) {
        previousLists.set(JSON.stringify(key), value);
      }

      queryClient.setQueriesData<InfiniteData<BookingsListResponse, string | null>>(
        { queryKey: ['bookings', activeWorkspaceId], type: 'active' },
        (old) =>
          old && {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              bookings: page.bookings.map((booking) =>
                ids.includes(booking.id) ? { ...booking, status } : booking,
              ),
            })),
          },
      );

      return { previousLists };
    },
    onError: (err, _variables, context) => {
      context?.previousLists.forEach((value, key) => {
        queryClient.setQueryData(JSON.parse(key) as string[], value);
      });
      setActionError(err instanceof Error ? err.message : t('errors.changeStatus'));
    },
    onSettled: (_data, _error, variables) => {
      setMutating(null);
      // Seleksi lama tidak mencerminkan data terkini — kosongkan hanya untuk
      // aksi bulk (beberapa id). Quick action satu baris mempertahankan seleksi.
      if (variables.ids.length > 1) setSelectedKeys(new Set());
      // Sinkronkan dengan server setelah selesai (sukses maupun gagal).
      queryClient.invalidateQueries({ queryKey: ['bookings', activeWorkspaceId] });
      queryClient.invalidateQueries({ queryKey: ['booking', activeWorkspaceId] });
    },
  });

  const changeStatus = (bookingId: string, status: BookingRecord['status']) => {
    setMutating({ ids: [bookingId], to: status });
    statusMutation.mutate({ ids: [bookingId], status });
  };

  // ── Seleksi baris (useTableSelection) — untuk aksi bulk status ──
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

  // Data visible (semua halaman) — select-all bekerja atas array ini.
  const visibleRows = useMemo<BookingTableRow[]>(
    () => (data ? (data.pages.flatMap((page) => page.bookings) as BookingTableRow[]) : []),
    [data],
  );

  const { selectionConfig } = useTableSelectionState({
    data: visibleRows,
    idKey: 'id',
    selectedKeys,
    setSelectedKeys,
  });
  // getRowLabel ada di config plugin (bukan state) — label checkbox per baris.
  const selectionPlugin = useTableSelection({
    ...selectionConfig,
    getRowLabel: (booking) => booking.title,
  });

  /** Aksi bulk pada semua booking terpilih. */
  const bulkChangeStatus = (status: BookingRecord['status']) => {
    const ids = [...selectedKeys];
    if (ids.length === 0) return;
    setMutating({ ids, to: status });
    statusMutation.mutate({ ids, status });
  };

  // Status unik dari baris terpilih — dipakai untuk menampilkan aksi bulk yang relevan.
  const selectedStatuses = useMemo(
    () => new Set(visibleRows.filter((booking) => selectedKeys.has(booking.id)).map((booking) => booking.status)),
    [visibleRows, selectedKeys],
  );
  const canBulkConfirm = selectedStatuses.has('pending');
  const canBulkComplete = selectedStatuses.has('confirmed');
  const canBulkCancel = selectedStatuses.has('pending') || selectedStatuses.has('confirmed');

  // Saat filter berubah, seleksi lama tidak lagi merepresentasikan data terlihat.
  const resetSelection = () => setSelectedKeys(new Set());

  useEffect(() => {
    resetSelection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, fromFilter, toFilter]);

  /** Kolom tabel booking — data-driven (renderCell dipakai untuk konten kaya). */
  const bookingColumns = useMemo<TableColumn<BookingTableRow>[]>(() => [
    {
      key: 'title',
      header: t('bookings.colTitle'),
      width: proportional(2),
      renderCell: (booking) => (
        <Link to={`/app/bookings/${booking.id}`} className="group block min-w-0">
          <span className="block truncate text-sm font-semibold text-zinc-900 transition group-hover:text-amber-600">
            {booking.title}
          </span>
          <span className="mt-0.5 block truncate text-xs text-zinc-500">
            {formatDateTime(booking.scheduledAt)}
          </span>
        </Link>
      ),
    },
    {
      key: 'customer',
      header: t('bookings.colCustomer'),
      width: proportional(1),
      renderCell: (booking) => (
        <span className="block truncate text-xs text-zinc-600">
          {booking.customerName ?? t('common.noName')} · {booking.phone ?? t('common.noPhone')}
        </span>
      ),
    },
    {
      key: 'goal',
      header: t('bookings.colGoal'),
      width: proportional(2),
      renderCell: (booking) => {
        const goalType = booking.autoGoal.goalType;
        return (
          <span className="flex min-w-0 items-start gap-2">
            <IconPhone className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
            <span className="min-w-0">
              <span className="block truncate text-xs font-semibold text-zinc-800">
                {goalType ? t(goalTypeKey(goalType) ?? 'common.noCall') : t('common.noCall')}
              </span>
              <span className="block truncate text-[11px] text-zinc-500">{booking.autoGoal.reason}</span>
            </span>
          </span>
        );
      },
    },
    {
      key: 'status',
      header: t('bookings.colStatus'),
      width: pixel(120),
      renderCell: (booking) => (
        <Badge variant={STATUS_BADGE[booking.status]} label={statusLabel(booking.status, t)} />
      ),
    },
    {
      key: 'actions',
      header: t('bookings.colActions'),
      width: pixel(240),
      align: 'end',
      renderCell: (booking) => {
        const actions = QUICK_ACTIONS[booking.status] ?? [];
        const isMutatingThis = mutating?.ids.includes(booking.id) ?? false;
        if (actions.length === 0) return <span className="text-xs text-zinc-300">—</span>;
        return (
          <span className="flex items-center justify-end gap-1.5">
            {actions.map((action) => (
              <Button
                key={action.to}
                label={t(action.labelKey)}
                variant={action.variant}
                size="sm"
                isDisabled={mutating !== null}
                isLoading={isMutatingThis && mutating?.to === action.to}
                onClick={() => changeStatus(booking.id, action.to)}
              />
            ))}
          </span>
        );
      },
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [t, mutating]);

  const isAuthExpiry = error instanceof ApiError && error.status === 401;
  const showError = isError && !isAuthExpiry;
  // Redup saat filter baru sedang dimuat (placeholder = data filter lama).
  const isFilterLoading = isFetching && isPlaceholderData;

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('bookings.title')}
        description={t('bookings.description')}
      >
        <Button
          label={t('common.reload')}
          variant="secondary"
          icon={<IconRefreshCw className="size-4" />}
          isLoading={isFetching}
          isDisabled={isFetching}
          onClick={() => void refetch()}
        />
        <Link
          to="/app/bookings/new"
          className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-amber-600 active:scale-[0.98]"
        >
          <IconPlus className="size-4" />
          {t('bookings.new')}
        </Link>
      </PageHeader>

      {/* Filter bar — komponen Astryx (Selector + DateInput) */}
      <Card className="p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
          <div className="min-w-0 flex-1">
            <Selector
              label={t('common.status')}
              placeholder={t('bookings.allStatuses')}
              options={[
                { value: '', label: t('bookings.allStatuses') },
                { value: 'pending', label: t('status.pending') },
                { value: 'confirmed', label: t('status.confirmed') },
                { value: 'completed', label: t('status.completed') },
                { value: 'cancelled', label: t('status.cancelled') },
              ]}
              value={statusFilter}
              onChange={(value) => setFilter('status', value)}
              width="100%"
            />
          </div>

          <div className="min-w-0 flex-1">
            <DateInput
              label={t('bookings.fromDate')}
              value={asDate(fromFilter)}
              max={asDate(toFilter)}
              onChange={(value) => setFilter('from', value ?? '')}
              width="100%"
            />
          </div>

          <div className="min-w-0 flex-1">
            <DateInput
              label={t('bookings.toDate')}
              value={asDate(toFilter)}
              min={asDate(fromFilter)}
              onChange={(value) => setFilter('to', value ?? '')}
              width="100%"
            />
          </div>

          <div className="flex items-center gap-3 lg:ml-auto">
            {hasFilters && (
              <Button
                label={t('bookings.resetFilter')}
                variant="ghost"
                size="sm"
                onClick={resetFilters}
              />
            )}
            {!isPending && data && (
              <p
                className={`text-xs text-zinc-500 transition-opacity duration-200 ${
                  isFilterLoading ? 'opacity-40' : ''
                }`}
              >
                {t('bookings.count', { count: data.pages.reduce((sum, page) => sum + page.bookings.length, 0) })}
                {isFilterLoading && t('bookings.loadingIndicator')}
              </p>
            )}
          </div>
        </div>
      </Card>

      {showError && (
        <Card className="flex flex-col items-center gap-4 p-10 text-center">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-red-50 text-red-500">
            <IconAlertTriangle className="size-6" />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-zinc-900">{t('errors.bookingsLoadTitle')}</h3>
            <p className="mt-1 text-sm text-zinc-500">
              {error instanceof ApiError
                ? t('errors.apiStatus', { status: error.status })
                : t('errors.apiConnection')}
            </p>
          </div>
          <Button label={t('common.retry')} variant="primary" onClick={() => void refetch()} />
        </Card>
      )}

      {isPending && (
        <Card className="overflow-hidden">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="flex items-center gap-6 border-b border-zinc-100 px-5 py-4 last:border-b-0"
            >
              <Skeleton width="28%" height={14} />
              <Skeleton width="18%" height={12} />
              <Skeleton width="26%" height={12} />
              <Skeleton className="ml-auto" width={90} height={22} />
            </div>
          ))}
        </Card>
      )}

      {actionError && (
        <p
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          {actionError}
        </p>
      )}

      {!isPending && !isError && data && (
        <>
          {data.pages[0].bookings.length === 0 ? (
            <EmptyState
              icon={<IconCalendar className="size-6" />}
              title={hasFilters ? t('bookings.emptyFilteredTitle') : t('bookings.emptyTitle')}
              description={
                hasFilters ? t('bookings.emptyFilteredDesc') : t('bookings.emptyDesc')
              }
              actions={
                hasFilters ? undefined : (
                  <Link
                    to="/app/bookings/new"
                    className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-amber-600 active:scale-[0.98]"
                  >
                    <IconPlus className="size-4" />
                    {t('bookings.createFirst')}
                  </Link>
                )
              }
            />
          ) : (
            <>
              {selectedKeys.size > 0 && (
                <div className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-sm font-medium text-zinc-800">
                    {t('bookings.selectedCount', { count: selectedKeys.size })}
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      label={t('bookings.confirm')}
                      variant="primary"
                      size="sm"
                      isDisabled={mutating !== null || !canBulkConfirm}
                      isLoading={mutating !== null && mutating.ids.length > 1 && mutating.to === 'confirmed'}
                      onClick={() => bulkChangeStatus('confirmed')}
                    />
                    <Button
                      label={t('bookings.complete')}
                      variant="secondary"
                      size="sm"
                      isDisabled={mutating !== null || !canBulkComplete}
                      isLoading={mutating !== null && mutating.ids.length > 1 && mutating.to === 'completed'}
                      onClick={() => bulkChangeStatus('completed')}
                    />
                    <Button
                      label={t('bookings.cancel')}
                      variant="destructive"
                      size="sm"
                      isDisabled={mutating !== null || !canBulkCancel}
                      isLoading={mutating !== null && mutating.ids.length > 1 && mutating.to === 'cancelled'}
                      onClick={() => bulkChangeStatus('cancelled')}
                    />
                    <Button
                      label={t('bookings.clearSelection')}
                      variant="ghost"
                      size="sm"
                      isDisabled={mutating !== null}
                      onClick={resetSelection}
                    />
                  </div>
                </div>
              )}

              <Card className="overflow-hidden">
                <div
                  // inert: blokir interaksi mouse & keyboard saat placeholder (filter lama).
                  inert={isFilterLoading}
                  className={`transition-opacity duration-200 ${
                    isFilterLoading ? 'pointer-events-none opacity-40' : ''
                  }`}
                >
                  <Table
                    data={visibleRows}
                    columns={bookingColumns}
                    idKey="id"
                    density="balanced"
                    dividers="rows"
                    hasHover
                    textOverflow="truncate"
                    plugins={{ selection: selectionPlugin }}
                  />
                </div>
              </Card>
            </>
          )}
          {hasNextPage && data.pages[0].bookings.length > 0 && (
            <div className="flex justify-center pt-2">
              <Button
                label={t('common.loadMore')}
                variant="secondary"
                isLoading={isFetchingNextPage}
                // isFetching juga true saat filter berubah — cegah kursor lama dipakai.
                isDisabled={isFetchingNextPage || isFetching}
                onClick={() => void fetchNextPage()}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
