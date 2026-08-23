import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { TFunction } from 'i18next';
import { Trans, useTranslation } from 'react-i18next';
import {
  Badge,
  Button,
  DateRangeInput,
  DropdownMenu,
  DropdownMenuItem,
  Pagination,
  Selector,
  SelectorOption,
  Skeleton,
  StatusDot,
  Table,
  TextInput,
  Typeahead,
  pixel,
  proportional,
  useTablePagination,
  useTableSelection,
  useTableSelectionState,
  useTableStickyColumns,
  useToast,
  type BadgeVariant,
  type ButtonVariant,
  type DateRange,
  type SearchableItem,
  type SearchSource,
  type StatusDotVariant,
  type TableColumn,
} from '@astryxdesign/core';

import { ApiError, apiFetch } from '../../lib/api';
import {
  applyRangeFilter,
  type BookingRecord,
  type BookingsListResponse,
  type CustomersResponse,
} from '../../lib/bookings';
import { useWorkspaceStore } from '../../stores/workspace';
import type { StaffListResponse } from '../../lib/staff';
import { bookingStatusKey } from '../../i18n/enums';
import { formatDateTime } from '../../i18n/format';
import type { TranslationKey } from '../../i18n';
import {
  IconAlertTriangle,
  IconArrowUpRight,
  IconCalendar,
  IconCalendarCheck,
  IconCheck,
  IconDotsHorizontal,
  IconPlus,
  IconSearch,
  IconTrash,
  IconUsers,
  IconX,
} from '../shell/icons';
import { Card, EmptyState, PageHeader, ReloadMenuButton } from '../shell/ui';

/** Warna status → variant Badge Astryx (theme-neutral). */
const STATUS_BADGE: Record<BookingRecord['status'], BadgeVariant> = {
  pending: 'warning',
  confirmed: 'success',
  cancelled: 'error',
  completed: 'neutral',
};

/** Variant StatusDot per status booking — selaras dengan STATUS_BADGE. */
const STATUS_DOT: Record<BookingRecord['status'], StatusDotVariant> = {
  pending: 'warning',
  confirmed: 'success',
  cancelled: 'error',
  completed: 'neutral',
};

/** Warna teks opsi filter status — mengikuti variant dot-nya. */
const STATUS_TEXT: Record<string, string> = {
  '': 'text-zinc-500 dark:text-zinc-400',
  pending: 'text-amber-600',
  confirmed: 'text-emerald-600',
  completed: 'text-zinc-500 dark:text-zinc-400',
  cancelled: 'text-red-600',
};

/** Baris tabel: BookingRecord + index signature (Table butuh Record<string, unknown>). */
type BookingTableRow = BookingRecord & Record<string, unknown>;

/** Item dropdown filter customer (Astryx Typeahead). */
type CustomerItem = SearchableItem;

/** Param URL tanggal valid (YYYY-MM-DD & tanggal kalender nyata) — selain itu diabaikan. */
function isValidDateParam(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00`).getTime());
}

const VALID_STATUSES: BookingRecord['status'][] = ['pending', 'confirmed', 'completed', 'cancelled'];

function statusLabel(status: string | null, t: TFunction): string {
  const key = bookingStatusKey(status);
  return key ? t(key) : (status ?? '');
}

/** Aksi status cepat yang tampil di kartu booking, sesuai status saat ini. */
type QuickAction = { to: BookingRecord['status']; labelKey: TranslationKey; variant: ButtonVariant };

/** Dropdown aksi per baris booking — tombol ⋯ polos (tanpa border/padding) di kolom Aksi.
 *  Item pertama selalu "View details" (buka halaman detail booking); aksi status
 *  cepat (jika ada untuk status saat ini) tampil di bawahnya. */
function BookingActionsMenu({
  bookingId,
  actions,
  isMutating,
  isMutatingThis,
  onAction,
}: {
  bookingId: string;
  actions: QuickAction[];
  isMutating: boolean;
  isMutatingThis: boolean;
  onAction: (bookingId: string, status: BookingRecord['status']) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  return (
    <DropdownMenu
      placement="below"
      menuWidth={180}
      isMenuOpen={open}
      onOpenChange={setOpen}
      button={{
        label: t('common.moreActions'),
        isIconOnly: true,
        icon: <IconDotsHorizontal className="size-4" />,
        variant: 'ghost',
        size: 'sm',
        isLoading: isMutatingThis,
        isDisabled: isMutating,
        style: { padding: 0 },
      }}
    >
      <DropdownMenuItem
        icon={<IconArrowUpRight className="size-4" />}
        label={t('bookings.viewDetails')}
        isDisabled={isMutating}
        onClick={() => navigate(`/app/bookings/${bookingId}`)}
      />
      {actions.map((action) => (
        <DropdownMenuItem
          key={action.to}
          icon={
            action.to === 'cancelled' ? (
              <IconTrash className="size-4 text-red-500" />
            ) : (
              <IconCheck className="size-4 text-emerald-600" />
            )
          }
          label={
            <span
              className={
                action.to === 'cancelled'
                  ? 'font-medium text-red-600'
                  : 'font-medium text-emerald-700'
              }
            >
              {t(action.labelKey)}
            </span>
          }
          isDisabled={isMutating}
          onClick={() => onAction(bookingId, action.to)}
        />
      ))}
    </DropdownMenu>
  );
}

const QUICK_ACTIONS: Record<
  BookingRecord['status'],
  QuickAction[]
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

/** Selang tick label relatif "Updated Xm ago" — 30 dtk cukup untuk menit. */
const LIVE_STATUS_TICK_MS = 30_000;

/**
 * Indikator kesegaran data Bookings di header — dot astryx + label waktu
 * fetch terakhir. Berdenyut saat sedang mengambil data, berubah amber bila
 * data basi (> 10 menit), dan tooltip menampilkan waktu absolut fetch.
 */
function BookingsLiveStatus({
  dataUpdatedAt,
  isFetching,
}: {
  dataUpdatedAt: number;
  isFetching: boolean;
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), LIVE_STATUS_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const fetchedAt = dataUpdatedAt
    ? new Date(dataUpdatedAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : null;

  // Label ditampilkan SEBAGAI teks di samping dot — StatusDot astryx hanya
  // merender dot (label = aria-label, bukan teks terlihat).
  const render = (variant: StatusDotVariant, label: string, tooltip?: string) => (
    <span className="inline-flex items-center gap-1.5">
      <StatusDot variant={variant} label={label} isPulsing={variant === 'success' && isFetching} tooltip={tooltip} />
      <span className="text-base font-medium text-zinc-500 dark:text-zinc-400">{label}</span>
    </span>
  );

  if (isFetching) {
    return render('success', t('bookings.statusUpdating'), fetchedAt ? `${t('bookings.statusLastFetched')} ${fetchedAt}` : undefined);
  }
  if (!dataUpdatedAt) {
    return render('neutral', t('bookings.statusNoData'));
  }

  const seconds = Math.max(0, Math.round((now - dataUpdatedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  const label =
    seconds < 60 ? t('bookings.statusLive') : t('bookings.statusMinutesAgo', { minutes });
  // Data dianggap basi bila lebih dari 10 menit sejak fetch terakhir.
  const variant: StatusDotVariant = seconds > 600 ? 'warning' : 'success';

  return render(variant, label, `${t('bookings.statusLastFetched')} ${fetchedAt}`);
}

export function BookingsPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const queryClient = useQueryClient();

  // Nama staf per id — untuk badge staf & durasi di kolom jadwal.
  const { data: staffPage } = useQuery({
    queryKey: ['staff', activeWorkspaceId],
    queryFn: () => apiFetch<StaffListResponse>('/staff'),
    enabled: Boolean(activeWorkspaceId),
    // Retry dengan backoff (1s/2s/4s default react-query) — kegagalan sesaat
    // (API restart, Neon cold-start) pulih sendiri tanpa user klik Retry.
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 3,
  });
  const staffNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const staff of staffPage?.staff ?? []) map.set(staff.id, staff.name);
    return map;
  }, [staffPage]);

  // ── Filter daftar booking — dipersist di URL agar bisa dibagikan ──
  const [searchParams, setSearchParams] = useSearchParams();

  const rawStatus = searchParams.get('status');
  const statusFilter: BookingRecord['status'] | '' =
    rawStatus && (VALID_STATUSES as readonly string[]).includes(rawStatus)
      ? (rawStatus as BookingRecord['status'])
      : '';
  // Judul dibaca MENTAH (tanpa trim) — TextInput dikontrol oleh nilai ini;
  // trim hanya saat query & hasFilters agar spasi antar-kata tidak hilang
  // saat mengetik (mis. "teeth whitening" → jangan jadi "teethwhitening").
  const titleFilter = searchParams.get('title') ?? '';
  const titleHasValue = titleFilter.trim().length > 0;
  const customerFilter = (searchParams.get('customer') ?? '').trim();
  const fromRaw = searchParams.get('from') ?? '';
  const toRaw = searchParams.get('to') ?? '';
  const fromFilter = isValidDateParam(fromRaw) ? fromRaw : '';
  const toFilter = isValidDateParam(toRaw) ? toRaw : '';
  const hasFilters = Boolean(statusFilter || titleHasValue || customerFilter || fromFilter || toFilter);
  // Nilai DateRangeInput — hanya terbentuk bila kedua ujung ada di URL.
  // Cast per-property: from/to sudah divalidasi isValidDateParam (YYYY-MM-DD)
  // sehingga aman dinaikkan ke tipe template-literal ISODateString milik DateRange.
  const dateRangeValue: DateRange | null =
    fromFilter && toFilter
      ? { start: fromFilter as DateRange['start'], end: toFilter as DateRange['end'] }
      : null;

  // Salinan filter yang baru dipakai query setelah input berhenti berubah
  // (debounce 300ms) — mengetik tanggal tidak lagi memicu fetch per huruf.
  // URL & input tetap responsif secara instan (sumber kebenaran = searchParams).
  // Reset halaman & seleksi ikut di-commit di sini: filter baru + page 1
  // tiba dalam satu render → tepat satu fetch (tanpa fetch ganda filter lama
  // saat user berada di halaman > 1).
  const [debouncedStatus, setDebouncedStatus] = useState(statusFilter);
  const [debouncedTitle, setDebouncedTitle] = useState(titleFilter);
  const [debouncedCustomer, setDebouncedCustomer] = useState(customerFilter);
  const [debouncedFrom, setDebouncedFrom] = useState(fromFilter);
  const [debouncedTo, setDebouncedTo] = useState(toFilter);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedStatus(statusFilter);
      setDebouncedTitle(titleFilter);
      setDebouncedCustomer(customerFilter);
      setDebouncedFrom(fromFilter);
      setDebouncedTo(toFilter);
      setPage(1);
      setSelectedKeys(new Set());
    }, 300);
    return () => clearTimeout(timer);
  }, [statusFilter, titleFilter, customerFilter, fromFilter, toFilter]);

  /** Tulis satu param filter ke URL tanpa menghapus param lain (replace: tak menumpuk riwayat browser). */
  const setFilter = (key: 'status' | 'title' | 'customer' | 'from' | 'to', value: string) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  };
  const resetFilters = () => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('status');
        next.delete('title');
        next.delete('customer');
        next.delete('from');
        next.delete('to');
        return next;
      },
      { replace: true },
    );
  };
  /** Tulis kedua ujung rentang dalam SATU setSearchParams (lihat
      applyRangeFilter di lib/bookings — logika murni, diuji unit). */
  const setRangeFilter = (range: DateRange | null) => {
    setSearchParams((prev) => applyRangeFilter(prev, range), { replace: true });
  };


  // Pagination offset (server-side) — dipakai useTablePagination di bawah.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const {
    data,
    isPending,
    isError,
    error,
    refetch,
    isFetching,
    isPlaceholderData,
    dataUpdatedAt,
  } = useQuery({
    queryKey: ['bookings', activeWorkspaceId, debouncedStatus, debouncedTitle.trim(), debouncedCustomer, debouncedFrom, debouncedTo, page, pageSize],
    queryFn: () => {
      const params = new URLSearchParams();
      if (debouncedStatus) params.set('status', debouncedStatus);
      const titleQuery = debouncedTitle.trim();
      if (titleQuery) params.set('title', titleQuery);
      if (debouncedCustomer) params.set('customer', debouncedCustomer);
      // Input tanggal → batas hari lokal → ISO UTC (scheduled_at tersimpan ber-timezone).
      if (debouncedFrom) params.set('from', new Date(`${debouncedFrom}T00:00:00`).toISOString());
      if (debouncedTo) params.set('to', new Date(`${debouncedTo}T23:59:59.999`).toISOString());
      params.set('page', String(page));
      params.set('pageSize', String(pageSize));
      return apiFetch<BookingsListResponse>(`/bookings?${params.toString()}`);
    },
    // Tampilkan data lama saat filter/halaman berubah — hindari kedipan skeleton.
    placeholderData: keepPreviousData,
    // Retry dengan backoff (1s/2s/4s default react-query): API dev restart
    // tiap file disimpan (tsx watch) dan Neon bisa cold-start > 10s — blip
    // sesaat tidak boleh menampilkan "Couldn't load bookings" yang buntu.
    // 401 tetap tidak di-retry (lapisan auth menangani refresh).
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 3,
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
      const snapshot = queryClient.getQueriesData<BookingsListResponse>({
        queryKey: ['bookings', activeWorkspaceId],
      });
      const previousLists = new Map<string, BookingsListResponse | undefined>();
      for (const [key, value] of snapshot) {
        previousLists.set(JSON.stringify(key), value);
      }

      queryClient.setQueriesData<BookingsListResponse>(
        { queryKey: ['bookings', activeWorkspaceId], type: 'active' },
        (old) =>
          old && {
            ...old,
            bookings: old.bookings.map((booking) =>
              ids.includes(booking.id) ? { ...booking, status } : booking,
            ),
          },
      );

      return { previousLists };
    },
    onSuccess: (_data, variables) => {
      if (variables.ids.length > 1) {
        toast({
          body: t('bookings.bulkStatusUpdated', { count: variables.ids.length }),
          type: 'info',
          isAutoHide: true,
          autoHideDuration: 4000,
        });
      }
    },
    onError: (err, variables, context) => {
      context?.previousLists.forEach((value, key) => {
        queryClient.setQueryData(JSON.parse(key) as string[], value);
      });
      const msg = err instanceof Error ? err.message : t('errors.changeStatus');
      setActionError(msg);
      if (variables.ids.length > 1) {
        toast({
          body: msg,
          type: 'error',
          isAutoHide: true,
          autoHideDuration: 5000,
        });
      }
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

  // Baris di halaman aktif — select-all bekerja atas array ini.
  const visibleRows = useMemo<BookingTableRow[]>(
    () => (data ? (data.bookings as BookingTableRow[]) : []),
    [data],
  );

  const { selectionConfig } = useTableSelectionState({
    data: visibleRows,
    idKey: 'id',
    selectedKeys,
    setSelectedKeys,
  });
  // getRowLabel ada di config plugin (bukan state) — label checkbox per baris.
  // Booking diidentifikasi oleh layanan katalog, bukan judul manual.
  const selectionPlugin = useTableSelection({
    ...selectionConfig,
    getRowLabel: (booking) => booking.serviceName ?? booking.title ?? t('bookings.noService'),
  });

  // Pagination astryx — kanan bawah tabel; totalItems dari server (mode offset).
  // Plugin tanpa render sendiri (position: 'none') — kontrol pagination
  // dirender manual di bawah tabel (di luar blok berbordernya), lihat footer.
  const paginationPlugin = useTablePagination<BookingTableRow>({
    page,
    onPageChange: setPage,
    totalItems: data?.total ?? 0,
    pageSize,
    position: 'none',
    align: 'end',
  });

  // Kolom Aksi di-freeze di sisi kanan saat tabel melebar (scroll horizontal)
  // — aksi baris selalu terlihat tanpa menggulir ke ujung.
  const stickyColumnsPlugin = useTableStickyColumns<BookingTableRow>({ endKeys: ['actions'] });

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

  /** Ganti ukuran halaman: reset ke halaman 1 + kosongkan seleksi (data baru). */
  const changePageSize = (value: string) => {
    const next = Number(value);
    if (!Number.isFinite(next) || next <= 0 || next === pageSize) return;
    setPageSize(next);
    setPage(1);
    resetSelection();
  };

  // ── Filter customer — Typeahead (input + dropdown) ─────────
  // Sumber saran = GET /api/bookings/customers (nama customer unik di
  // workspace, urut dari booking paling baru). Memilih item / mengosongkan
  // langsung meng-commit filter ke URL — perilaku sama dengan filter lain.
  // Debounce 150ms milik Typeahead untuk pencarian saran; filter daftar
  // tetap memakai debounce 300ms bersama di atas.
  const customerSearchSource = useMemo<SearchSource<CustomerItem>>(() => {
    let controller: AbortController | null = null;
    const load = async (q: string): Promise<CustomerItem[]> => {
      controller?.abort();
      controller = new AbortController();
      try {
        const params = new URLSearchParams();
        if (q.trim()) params.set('q', q.trim());
        params.set('limit', '10');
        const res = await apiFetch<CustomersResponse>(`/bookings/customers?${params.toString()}`, {
          signal: controller.signal,
        });
        return res.customers.map((customer) => ({
          id: customer.name,
          label: customer.name,
        }));
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return [];
        // Gagal memuat saran → dropdown kosong; filter daftar tetap berfungsi.
        return [];
      }
    };
    return {
      search: (query) => load(query),
      bootstrap: () => load(''),
      cancel: () => controller?.abort(),
    };
  }, []);

  /** Nilai Typeahead saat ini — dari URL (sumber kebenaran filter). */
  const customerValue = useMemo<CustomerItem | null>(
    () => (customerFilter ? { id: customerFilter, label: customerFilter } : null),
    [customerFilter],
  );
  const handleCustomerChange = (item: CustomerItem | null) => {
    setFilter('customer', item?.label ?? '');
  };



  // Snap ke halaman terakhir bila dataset menyusut (mis. status berubah /
  // booking dihapus di perangkat lain) dan halaman aktif kini melebihi jumlah
  // halaman — hindari menampilkan empty state saat data masih ada di halaman
  // sebelumnya.
  const lastPage = data?.total ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;
  useEffect(() => {
    if (data && data.total !== undefined && data.total > 0 && page > lastPage) {
      setPage(lastPage);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, page, lastPage, pageSize]);

  /** Kolom tabel booking — data-driven (renderCell dipakai untuk konten kaya). */
  const bookingColumns = useMemo<TableColumn<BookingTableRow>[]>(() => [
    // Kolom Service = identitas booking (nama layanan katalog) sekaligus link
    // ke detail. Booking diambil dari services — tidak ada kolom title manual.
    {
      key: 'service',
      header: t('bookings.colService'),
      width: proportional(3),
      renderCell: (booking) => (
        <Link to={`/app/bookings/${booking.id}`} className="group block min-w-0">
          <span className="block truncate text-base font-semibold text-zinc-900 dark:text-zinc-100 transition group-hover:text-amber-600">
            {booking.serviceName ?? booking.title ?? t('bookings.noService')}
          </span>
        </Link>
      ),
    },
    {
      key: 'schedule',
      header: t('bookings.colSchedule'),
      width: proportional(2),
      renderCell: (booking) => (
        <span className="block min-w-0">
          <span className="block truncate text-base text-zinc-600 dark:text-zinc-400">
            {formatDateTime(booking.scheduledAt)}
          </span>
        </span>
      ),
    },
    {
      key: 'staff',
      header: t('bookings.colStaff'),
      width: proportional(1),
      renderCell: (booking) => {
        if (!booking.staffId) {
          return (
            <span className="block text-base text-zinc-400 dark:text-zinc-500">—</span>
          );
        }
        const staffName = staffNameById.get(booking.staffId);
        return (
          <a
            href={`/app/staff/${booking.staffId}`}
            target="_blank"
            rel="noreferrer"
            title={t('bookings.openStaffDetail')}
            className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-base text-zinc-600 transition hover:text-amber-700 hover:underline dark:text-zinc-400 dark:hover:text-amber-400"
          >
            <IconUsers className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate">{staffName}</span>
          </a>
        );
      },
    },
    {
      key: 'duration',
      header: t('bookings.colDuration'),
      width: pixel(100),
      renderCell: (booking) => (
        <span className="block truncate text-base text-zinc-600 dark:text-zinc-400">
          {booking.durationMinutes > 0
            ? t('bookings.duration', { count: booking.durationMinutes })
            : '—'}
        </span>
      ),
    },
    {
      key: 'customer',
      header: t('bookings.colCustomer'),
      width: proportional(2),
      renderCell: (booking) => {
        // Semua baris = link biru ke detail customer (tab baru). Booking lama
        // tanpa contactId lewat /contacts/ensure yang memastikan kontak ada
        // (idempoten) lalu membuka detail-nya — jadi tiap baris berfungsi.
        const contactHref = booking.contactId
          ? `/app/contacts/${booking.contactId}`
          : `/app/contacts/ensure?booking=${booking.id}`;
        return (
          <a
            href={contactHref}
            target="_blank"
            rel="noreferrer"
            title={t('bookings.openContactDetail')}
            className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-base text-blue-600 transition hover:text-blue-700 hover:underline dark:text-blue-400 dark:hover:text-blue-300"
          >
            <span className="truncate">
              {booking.customerName ?? t('common.noName')} · {booking.phone ?? t('common.noPhone')}
            </span>
            <IconArrowUpRight className="size-3.5 shrink-0" aria-hidden="true" />
          </a>
        );
      },
    },
    {
      key: 'status',
      header: t('bookings.colStatus'),
      width: pixel(120),
      renderCell: (booking) => (
        <Badge
          variant={STATUS_BADGE[booking.status]}
          label={statusLabel(booking.status, t)}
          // Samakan ukuran teks chip dengan kolom lain (font-size-sm → base).
          style={{ fontSize: '0.875rem' }}
        />
      ),
    },
    {
      key: 'actions',
      header: t('bookings.colActions'),
      width: pixel(72),
      align: 'end',
      renderCell: (booking) => {
        const actions = QUICK_ACTIONS[booking.status] ?? [];
        const isMutatingThis = mutating?.ids.includes(booking.id) ?? false;
        return (
          <span className="flex items-center justify-end">
            <BookingActionsMenu
              bookingId={booking.id}
              actions={actions}
              isMutating={mutating !== null}
              isMutatingThis={isMutatingThis}
              onAction={changeStatus}
            />
          </span>
        );
      },
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [t, mutating, staffNameById]);

  const isAuthExpiry = error instanceof ApiError && error.status === 401;
  // Jangan timpa data yang masih tampil dengan kartu error: saat fetch gagal
  // dengan data lama tersedia (placeholderData), tampilkan data itu — retry
  // di atas akan menyegarkannya. Kartu error hanya muncul bila TIDAK ada
  // data sama sekali (fetch gagal di awal).
  const showError = isError && !isAuthExpiry && !isPlaceholderData;
  // Redup saat filter baru sedang dimuat (placeholder = data filter lama).
  const isFilterLoading = isFetching && isPlaceholderData;


  return (
    <div className="flex min-h-[calc(100vh-10rem)] flex-1 flex-col space-y-6">
      <PageHeader
        title={t('bookings.title')}
        description={t('bookings.description')}
        icon={IconCalendarCheck}
        status={
          <BookingsLiveStatus
            dataUpdatedAt={dataUpdatedAt}
            isFetching={isFetching}
          />
        }
      >
        <ReloadMenuButton
          isFetching={isFetching}
          onReload={() => {
            void refetch();
          }}
        />
        <Link
          to="/app/bookings/new"
          className="inline-flex items-center gap-2 rounded-lg bg-amber-500 h-8 px-4 text-base font-semibold text-white shadow-sm transition hover:bg-amber-600 active:scale-[0.98]"
        >
          <IconPlus className="size-4" />
          {t('bookings.new')}
        </Link>
      </PageHeader>

      <div className="flex flex-1 flex-col space-y-4">
        {/* Filter bar — komponen Astryx (TextInput + Typeahead + Selector + DateInput) */}
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="min-w-0 flex-1">
            <TextInput
              label={t('bookings.colService')}
              isLabelHidden
              placeholder={t('bookings.servicePlaceholder')}
              value={titleFilter}
              onChange={(value) => setFilter('title', value)}
              startIcon={<IconSearch className="size-4" />}
              width="100%"
            />
          </div>

          <div className="min-w-0 flex-1">
            <Typeahead<CustomerItem>
              label={t('common.customer')}
              isLabelHidden
              placeholder={t('bookings.customerPlaceholder')}
              searchSource={customerSearchSource}
              value={customerValue}
              onChange={handleCustomerChange}
              emptySearchResultsText={t('bookings.noCustomerMatches')}
              hasEntriesOnFocus
              maxMenuItems={8}
              startIcon={<IconSearch className="size-4" />}
              width="100%"
            />
          </div>

          <div className="min-w-0 flex-1">
            <Selector
              label={t('common.status')}
              isLabelHidden
              placeholder={t('bookings.allStatuses')}
              options={[
                {
                  value: '',
                  label: t('bookings.allStatuses'),
                  icon: <StatusDot variant="neutral" label={t('bookings.allStatuses')} />,
                },
                ...VALID_STATUSES.map((status) => ({
                  value: status,
                  label: statusLabel(status, t),
                  icon: <StatusDot variant={STATUS_DOT[status]} label={statusLabel(status, t)} />,
                })),
              ]}
              value={statusFilter}
              onChange={(value) => setFilter('status', value)}
              width="100%"
              renderOption={(option) => (
                <SelectorOption
                  icon={option.icon}
                  label={
                    <span className={STATUS_TEXT[option.value] ?? 'text-zinc-500 dark:text-zinc-400'}>
                      {option.label}
                    </span>
                  }
                />
              )}
            />
          </div>

          {/* Filter rentang tanggal — satu DateRangeInput dengan kalender dua bulan
              (Astryx Calendar numberOfMonths={2}); dari & sampai tetap disimpan
              sebagai dua param URL terpisah (from/to) agar API & shareable URL
              tidak berubah. */}
          <div className="min-w-0 flex-1">
            <DateRangeInput
              label={t('bookings.dateRange')}
              isLabelHidden
              placeholder={t('bookings.dateRangePlaceholder')}
              value={dateRangeValue}
              numberOfMonths={2}
              hasClear
              onChange={setRangeFilter}
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
          </div>
        </div>

      {/* Konten tabel — daftar booking dengan filter. Kalender kini berada di
          halaman Calendar (/app/calendar). */}
      <div className="flex flex-1 flex-col">
          {showError && (
            <Card className="flex flex-1 min-h-[460px] flex-col items-center justify-center gap-4 p-10 text-center">
              <span className="flex size-12 items-center justify-center rounded-2xl bg-red-50 text-red-500 dark:bg-red-950/50 dark:text-red-400">
                <IconAlertTriangle className="size-6" />
              </span>
              <div>
                <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{t('errors.bookingsLoadTitle')}</h3>
                <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
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
                  className="flex items-center gap-6 border-b border-zinc-100 dark:border-zinc-800 px-5 py-4 last:border-b-0"
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
              className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-400"
            >
              {actionError}
            </p>
          )}

          {!isPending && !isError && data && (
            <>
              {data.bookings.length === 0 ? (
                <EmptyState
                  icon={IconCalendar}
                  title={hasFilters ? t('bookings.emptyFilteredTitle') : t('bookings.emptyTitle')}
                  description={
                    hasFilters ? t('bookings.emptyFilteredDesc') : t('bookings.emptyDesc')
                  }
                  className="flex-1 min-h-[500px]"
                  actions={
                    hasFilters ? undefined : (
                      <Link
                        to="/app/bookings/new"
                        className="inline-flex items-center gap-2 rounded-lg bg-amber-500 h-8 px-4 text-base font-semibold text-white shadow-sm transition hover:bg-amber-600 active:scale-[0.98]"
                      >
                        <IconPlus className="size-4" />
                        {t('bookings.createFirst')}
                      </Link>
                    )
                  }
                />
              ) : (
                <>
                  {/* Floating bottom center row selection toolbar */}
                  {selectedKeys.size > 0 && (
                    <div
                      role="region"
                      aria-label={t('bookings.selectedCount', { count: selectedKeys.size })}
                      className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 flex items-center gap-3 rounded-2xl border border-zinc-200/90 bg-white/95 px-4 py-2.5 shadow-2xl backdrop-blur-md transition-all animate-in fade-in slide-in-from-bottom-5 duration-200 dark:border-zinc-700/90 dark:bg-zinc-900/95 max-w-[calc(100vw-2rem)]"
                    >
                      {actionError && (
                        <div
                          role="alert"
                          className="absolute -top-10 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-lg border border-red-200 bg-red-50 px-3 py-1 text-xs font-medium text-red-700 shadow-md dark:border-red-900/60 dark:bg-red-950/90 dark:text-red-400"
                        >
                          {actionError}
                        </div>
                      )}

                      <div className="flex items-center gap-2 border-r border-zinc-200 pr-3 dark:border-zinc-700">
                        <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 whitespace-nowrap">
                          {t('bookings.selectedCount', { count: selectedKeys.size })}
                        </span>
                      </div>

                      <div className="flex items-center gap-2">
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
                        <button
                          type="button"
                          aria-label={t('bookings.clearSelection')}
                          title={t('bookings.clearSelection')}
                          disabled={mutating !== null}
                          onClick={resetSelection}
                          className="ml-1 inline-flex size-7 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 disabled:pointer-events-none disabled:opacity-50"
                        >
                          <IconX className="size-4" />
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Transparan: tabel tanpa border/background pembungkus; radius 0.
                      Border horizontal atas & bawah membingkai tabel. Pagination
                      dirender manual di footer — DI LUAR blok berbordernya. */}
                  <Card
                    variant="transparent"
                    className="overflow-hidden"
                    style={{
                      borderTop: '1px solid #e4e4e7',
                      borderBottom: '1px solid #e4e4e7',
                      '--_card-radius': '0px',
                    }}
                  >
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
                        dividers="none"
                        hasHover
                        textOverflow="truncate"
                        plugins={{
                          selection: selectionPlugin,
                          pagination: paginationPlugin,
                          sticky: stickyColumnsPlugin,
                        }}
                      />
                    </div>
                  </Card>

                  {/* Footer: rows-per-page (kiri) + info realtime jumlah baris terlihat */}
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3 px-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
                        {t('bookings.rowsPerPage')}
                      </span>
                      <Selector
                        label={t('bookings.rowsPerPage')}
                        isLabelHidden
                        placement="above"
                        width={88}
                        options={[10, 25, 50, 100].map((n) => ({
                          value: String(n),
                          label: String(n),
                        }))}
                        value={String(pageSize)}
                        onChange={changePageSize}
                      />
                    </div>
                    <p className="text-sm text-zinc-400">
                      <Trans
                        i18nKey="bookings.showingRows"
                        values={{ shown: visibleRows.length, total: data?.total ?? 0 }}
                        components={{ strong: <strong className="font-bold text-black dark:text-zinc-100" /> }}
                      />
                    </p>
                    {/* Pagination di ujung kanan, di luar border tabel */}
                    <Pagination
                      page={page}
                      onChange={setPage}
                      totalItems={data?.total ?? 0}
                      pageSize={pageSize}
                    />
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
