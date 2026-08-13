import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { Trans, useTranslation } from 'react-i18next';
import {
  Badge,
  Button,
  DateInput,
  Dialog,
  DialogHeader,
  DropdownMenu,
  DropdownMenuItem,
  IconButton,
  Layout,
  LayoutContent,
  LayoutFooter,
  NumberInput,
  Pagination,
  Selector,
  SelectorOption,
  Skeleton,
  StatusDot,
  Switch,
  Table,
  TextInput,
  TimeInput,
  paginateData,
  pixel,
  proportional,
  useTablePagination,
  useTableSelection,
  useTableSelectionState,
  type ISODateString,
  type ISOTimeString,
  type TableColumn,
} from '@astryxdesign/core';

import { ApiError, apiFetch } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import {
  type CreateStaffPayload,
  type ScheduleDraft,
  type StaffRecord,
  type StaffTimeOff,
  type UpdateStaffPayload,
  WEEKDAY_LABEL_KEYS,
} from '../../lib/staff';
import { useWorkspaceStore } from '../../stores/workspace';
import { PhoneInput } from '../components/PhoneInput';
import {
  IconAlertTriangle,
  IconCalendar,
  IconClock,
  IconDotsHorizontal,
  IconEdit,
  IconPlus,
  IconSearch,
  IconStaff,
  IconTrash,
  IconUsers,
} from '../shell/icons';
import { Card, ConfirmDialog, EmptyState, PageHeader, ReloadMenuButton } from '../shell/ui';

/** Zona waktu umum untuk Selector — backend memvalidasi IANA, daftar ini
 *  mencakup mayoritas pasar (Asia Tenggara + global). */
const COMMON_TIMEZONES = [
  'Asia/Jakarta',
  'Asia/Makassar',
  'Asia/Pontianak',
  'Asia/Jayapura',
  'Asia/Singapore',
  'Asia/Kuala_Lumpur',
  'Asia/Bangkok',
  'Asia/Manila',
  'Asia/Ho_Chi_Minh',
  'Asia/Seoul',
  'Asia/Tokyo',
  'Asia/Hong_Kong',
  'Asia/Shanghai',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Australia/Sydney',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'UTC',
];

/** Konversi menit sejak tengah malam → "HH:MM" untuk TimeInput. */
function toTimeString(minutes: number): ISOTimeString {
  const h = Math.floor(Math.max(0, minutes) / 60);
  const m = Math.max(0, minutes) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` as ISOTimeString;
}

/** Konversi "HH:MM" → menit sejak tengah malam. */
function toMinutes(time: string | undefined): number {
  if (!time) return 0;
  const [h, m] = time.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return 0;
  return h * 60 + m;
}

/** Format rentang menit → "09:00 – 17:00" untuk tampilan jadwal. */
function rangeLabel(startMinutes: number, endMinutes: number): string {
  return `${toTimeString(startMinutes)} – ${toTimeString(endMinutes)}`;
}

/** Format tanggal ISO → YYYY-MM-DD (bagian tanggal saja). */
function dateOnly(iso: string): string {
  return iso.slice(0, 10);
}

/** Jam langsung untuk zona waktu terpilih + UTC — dipakai di dialog tambah
 *  staf agar saat memilih zona waktu, user langsung melihat jam berapa
 *  sekarang di zona itu dibandingkan UTC. State lokal di komponen kecil ini
 *  saja, jadi hanya bagian ini yang re-render tiap detik (bukan seluruh page). */
function TimezoneClock({ timezone }: { timezone: string }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const timeIn = (tz: string) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).format(now);

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-zinc-500">
      <IconClock className="size-3" aria-hidden="true" />
      <span>{t('staff.timezoneLocalNow', { time: timeIn(timezone) })}</span>
      <span aria-hidden="true" className="text-zinc-300">·</span>
      <span className="text-zinc-400">{t('staff.timezoneUtcNow', { time: timeIn('UTC') })}</span>
    </div>
  );
}

const STAFF_COLORS = ['#f59e0b', '#0ea5e9', '#10b981', '#8b5cf6', '#ef4444', '#ec4899', '#14b8a6', '#6366f1', '#f97316', '#84cc16'];

/** Dropdown aksi per baris staf — tombol ⋯ membuka menu (jadwal, cuti, edit,
 *  hapus). Menggantikan deretan IconButton agar kolom aksi ringkas & konsisten
 *  dengan kolom aksi di BookingsPage. */
function StaffActionsMenu({
  staff,
  onSchedule,
  onTimeOff,
  onEdit,
  onDelete,
}: {
  staff: StaffRecord;
  onSchedule: () => void;
  onTimeOff: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
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
        style: { padding: 0 },
      }}
    >
      <DropdownMenuItem
        icon={<IconCalendar className="size-4" />}
        label={t('staff.editSchedule')}
        onClick={onSchedule}
      />
      <DropdownMenuItem
        icon={<IconClock className="size-4" />}
        label={t('staff.editTimeOff')}
        onClick={onTimeOff}
      />
      <DropdownMenuItem
        icon={<IconEdit className="size-4" />}
        label={t('staff.editFor', { name: staff.name })}
        onClick={onEdit}
      />
      <DropdownMenuItem
        icon={<IconTrash className="size-4 text-red-500" />}
        label={
          <span className="font-medium text-red-600">
            {t('staff.deleteFor', { name: staff.name })}
          </span>
        }
        onClick={onDelete}
      />
    </DropdownMenu>
  );
}

/** Baris tabel: StaffRecord + index signature (Table butuh Record<string, unknown>). */
type StaffTableRow = StaffRecord & Record<string, unknown>;

/** Warna teks opsi filter status — selaras dengan variant StatusDot-nya. */
const STATUS_TEXT: Record<string, string> = {
  '': 'text-zinc-500',
  active: 'text-emerald-600',
  inactive: 'text-zinc-500',
};

export function StaffPage() {
  const { t } = useTranslation();
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const queryClient = useQueryClient();

  const { data, isPending, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['staff', activeWorkspaceId],
    queryFn: () => apiFetch<{ staff: StaffRecord[] }>('/staff'),
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 1,
  });

  const staffList = data?.staff ?? [];
  const isAuthExpiry = error instanceof ApiError && error.status === 401;
  const showError = isError && !isAuthExpiry;

  // ── Filter staf (mirror BookingsPage) — dipersist di URL agar bisa dibagikan ──
  const [searchParams, setSearchParams] = useSearchParams();

  const searchFilter = searchParams.get('q') ?? '';
  // Status hanya menerima nilai whitelist (mirror BookingsPage VALID_STATUSES) —
  // nilai basi/typo di URL diabaikan agar Selector tidak memegang opsi tak dikenal.
  const rawStatus = searchParams.get('status') ?? '';
  const statusFilter = rawStatus === 'active' || rawStatus === 'inactive' ? rawStatus : '';
  const tzFilter = searchParams.get('tz') ?? '';
  const hasFilters = Boolean(searchFilter.trim() || statusFilter || tzFilter);

  // Salinan filter yang baru dipakai query setelah input berhenti berubah
  // (debounce 300ms) — mengetik tidak lagi memicu penyaringan per huruf.
  // URL & input tetap responsif secara instan (sumber kebenaran = searchParams).
  const [debouncedSearch, setDebouncedSearch] = useState(searchFilter);
  const [debouncedStatus, setDebouncedStatus] = useState(statusFilter);
  const [debouncedTz, setDebouncedTz] = useState(tzFilter);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchFilter);
      setDebouncedStatus(statusFilter);
      setDebouncedTz(tzFilter);
      setPage(1);
      setSelectedKeys(new Set());
    }, 300);
    return () => clearTimeout(timer);
  }, [searchFilter, statusFilter, tzFilter]);

  /** Tulis satu param filter ke URL tanpa menghapus param lain (replace: tak menumpuk riwayat browser). */
  const setFilter = (key: 'q' | 'status' | 'tz', value: string) => {
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
        next.delete('q');
        next.delete('status');
        next.delete('tz');
        return next;
      },
      { replace: true },
    );
  };

  // Zona waktu unik dari SELURUH daftar staf (tak terfilter) — opsi Selector
  // tetap stabil meski filter lain sedang aktif.
  const timezoneOptions = useMemo(() => {
    const set = new Set<string>();
    for (const staff of staffList) if (staff.timezone) set.add(staff.timezone);
    return [...set].sort();
  }, [staffList]);

  // Filter client-side: cari (nama/email/telepon) + status + zona waktu.
  const filteredList = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    return staffList.filter((staff) => {
      if (debouncedStatus === 'active' && !staff.isActive) return false;
      if (debouncedStatus === 'inactive' && staff.isActive) return false;
      if (debouncedTz && staff.timezone !== debouncedTz) return false;
      if (q) {
        const haystack = [staff.name, staff.email, staff.phone].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [staffList, debouncedSearch, debouncedStatus, debouncedTz]);

  // ── Dialog tambah staf ─────────────────────────────────────
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [addName, setAddName] = useState('');
  const [addEmail, setAddEmail] = useState('');
  const [addPhone, setAddPhone] = useState('');
  const [addTimezone, setAddTimezone] = useState('Asia/Jakarta');
  const [addColor, setAddColor] = useState(STAFF_COLORS[0]);
  const [addBuffer, setAddBuffer] = useState(0);
  const [addError, setAddError] = useState<string | null>(null);

  const closeAdd = () => {
    setIsAddOpen(false);
    setAddError(null);
  };
  const openAdd = () => {
    setAddName('');
    setAddEmail('');
    setAddPhone('');
    setAddTimezone('Asia/Jakarta');
    setAddColor(STAFF_COLORS[0]);
    setAddBuffer(0);
    setAddError(null);
    setIsAddOpen(true);
  };

  const addMutation = useMutation({
    mutationFn: (payload: CreateStaffPayload) =>
      apiFetch<{ staff: StaffRecord }>('/staff', { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: () => {
      closeAdd();
      queryClient.invalidateQueries({ queryKey: ['staff', activeWorkspaceId] });
    },
    onError: (err) => setAddError(errorMessage(err, t, 'errors.saveStaff')),
  });

  const submitAdd = (event: FormEvent) => {
    event.preventDefault();
    if (!addName.trim()) {
      setAddError(t('staff.nameRequired'));
      return;
    }
    setAddError(null);
    addMutation.mutate({
      name: addName.trim(),
      email: addEmail.trim() || undefined,
      phone: addPhone.trim() || undefined,
      timezone: addTimezone,
      color: addColor,
      bufferMinutes: addBuffer,
    });
  };

  // ── Dialog edit staf ───────────────────────────────────────
  const [editing, setEditing] = useState<StaffRecord | null>(null);
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editTimezone, setEditTimezone] = useState('UTC');
  const [editColor, setEditColor] = useState(STAFF_COLORS[0]);
  const [editBuffer, setEditBuffer] = useState(0);
  const [editIsActive, setEditIsActive] = useState(true);
  const [editError, setEditError] = useState<string | null>(null);

  const openEdit = (staff: StaffRecord) => {
    setEditing(staff);
    setEditName(staff.name);
    setEditEmail(staff.email ?? '');
    setEditPhone(staff.phone ?? '');
    setEditTimezone(staff.timezone);
    setEditColor(staff.color);
    setEditBuffer(staff.bufferMinutes);
    setEditIsActive(staff.isActive);
    setEditError(null);
  };

  const editMutation = useMutation({
    mutationFn: (payload: UpdateStaffPayload) =>
      apiFetch<{ staff: StaffRecord }>(`/staff/${editing?.id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      setEditing(null);
      queryClient.invalidateQueries({ queryKey: ['staff', activeWorkspaceId] });
      queryClient.invalidateQueries({ queryKey: ['bookings', activeWorkspaceId] });
    },
    onError: (err) => setEditError(errorMessage(err, t, 'errors.saveStaff')),
  });

  const submitEdit = (event: FormEvent) => {
    event.preventDefault();
    if (!editing || !editName.trim()) return;
    setEditError(null);
    editMutation.mutate({
      name: editName.trim(),
      email: editEmail.trim() || null,
      phone: editPhone.trim() || null,
      timezone: editTimezone,
      color: editColor,
      bufferMinutes: editBuffer,
      isActive: editIsActive,
    });
  };

  // ── Hapus staf ─────────────────────────────────────────────
  const [deleteTarget, setDeleteTarget] = useState<StaffRecord | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/staff/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setDeleteTarget(null);
      setDeleteError(null);
      queryClient.invalidateQueries({ queryKey: ['staff', activeWorkspaceId] });
      queryClient.invalidateQueries({ queryKey: ['bookings', activeWorkspaceId] });
    },
    onError: (err) => {
      setDeleteTarget(null);
      setDeleteError(errorMessage(err, t, 'errors.deleteStaff'));
    },
  });

  // ── Dialog jadwal mingguan ─────────────────────────────────
  const [scheduleStaff, setScheduleStaff] = useState<StaffRecord | null>(null);
  /** Draft per hari (0..6): daftar rentang {startMinutes, endMinutes}. */
  const [scheduleDraft, setScheduleDraft] = useState<ScheduleDraft[][]>([]);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [scheduleSaving, setScheduleSaving] = useState(false);

  const openSchedule = (staff: StaffRecord) => {
    const byDay: ScheduleDraft[][] = Array.from({ length: 7 }, () => []);
    for (const entry of staff.schedules) {
      byDay[entry.dayOfWeek]?.push({ dayOfWeek: entry.dayOfWeek, startMinutes: entry.startMinutes, endMinutes: entry.endMinutes });
    }
    setScheduleStaff(staff);
    setScheduleDraft(byDay);
    setScheduleError(null);
  };

  const setRange = (day: number, index: number, patch: Partial<ScheduleDraft>) => {
    setScheduleDraft((prev) => {
      const next = prev.map((dayRanges) => [...dayRanges]);
      const ranges = next[day] ?? [];
      if (ranges[index]) ranges[index] = { ...ranges[index], ...patch, dayOfWeek: day };
      return next;
    });
  };

  const addRange = (day: number) => {
    setScheduleDraft((prev) => {
      const next = prev.map((dayRanges) => [...dayRanges]);
      (next[day] ??= []).push({ dayOfWeek: day, startMinutes: 540, endMinutes: 1020 });
      return next;
    });
  };

  const removeRange = (day: number, index: number) => {
    setScheduleDraft((prev) => {
      const next = prev.map((dayRanges) => [...dayRanges]);
      next[day]?.splice(index, 1);
      return next;
    });
  };

  const saveSchedule = async () => {
    if (!scheduleStaff) return;
    const schedules = scheduleDraft.flatMap((dayRanges) => dayRanges.map((r) => ({ ...r })));
    // Validasi: end > start (dilakukan backend juga, tapi hindari request sia-sia).
    for (const range of schedules) {
      if (range.endMinutes <= range.startMinutes) {
        setScheduleError(t('staff.scheduleInvalidRange'));
        return;
      }
    }
    setScheduleSaving(true);
    setScheduleError(null);
    try {
      await apiFetch<{ staff: StaffRecord }>(`/staff/${scheduleStaff.id}/schedules`, {
        method: 'PUT',
        body: JSON.stringify({ schedules }),
      });
      setScheduleStaff(null);
      queryClient.invalidateQueries({ queryKey: ['staff', activeWorkspaceId] });
    } catch (err) {
      setScheduleError(errorMessage(err, t, 'errors.saveSchedule'));
    } finally {
      setScheduleSaving(false);
    }
  };

  // ── Dialog cuti ────────────────────────────────────────────
  const [timeOffStaff, setTimeOffStaff] = useState<StaffRecord | null>(null);
  const [timeOffStart, setTimeOffStart] = useState('');
  const [timeOffEnd, setTimeOffEnd] = useState('');
  const [timeOffReason, setTimeOffReason] = useState('');
  const [timeOffError, setTimeOffError] = useState<string | null>(null);

  const openTimeOff = (staff: StaffRecord) => {
    setTimeOffStaff(staff);
    setTimeOffStart('');
    setTimeOffEnd('');
    setTimeOffReason('');
    setTimeOffError(null);
  };

  const addTimeOffMutation = useMutation({
    mutationFn: (payload: { startDate: string; endDate: string; reason?: string }) =>
      apiFetch<{ timeOff: StaffTimeOff }>(`/staff/${timeOffStaff?.id}/time-off`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      setTimeOffStart('');
      setTimeOffEnd('');
      setTimeOffReason('');
      queryClient.invalidateQueries({ queryKey: ['staff', activeWorkspaceId] });
    },
    onError: (err) => setTimeOffError(errorMessage(err, t, 'errors.saveTimeOff')),
  });

  const submitTimeOff = (event: FormEvent) => {
    event.preventDefault();
    if (!timeOffStart || !timeOffEnd) return;
    if (timeOffEnd < timeOffStart) {
      setTimeOffError(t('staff.timeOffInvalidRange'));
      return;
    }
    setTimeOffError(null);
    addTimeOffMutation.mutate({
      startDate: timeOffStart,
      endDate: timeOffEnd,
      reason: timeOffReason.trim() || undefined,
    });
  };

  const removeTimeOffMutation = useMutation({
    mutationFn: ({ staffId, timeOffId }: { staffId: string; timeOffId: string }) =>
      apiFetch(`/staff/${staffId}/time-off/${timeOffId}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['staff', activeWorkspaceId] }),
    onError: (err) => setTimeOffError(errorMessage(err, t, 'errors.deleteTimeOff')),
  });

  // ── Tampilan tabel (mirror BookingsPage): pagination client-side ──
  // GET /api/staff mengembalikan SEMUA staf sekaligus (tanpa pagination
  // server) — data dislicing di client lewat paginateData (utilitas astryx
  // untuk client-side pagination). Plugin hanya menyediakan state/UI.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  // paginateData generik (T[] → T[]) — cast tunggal ke StaffTableRow cukup.
  // Pagination bekerja atas hasil FILTER (filter client-side, data utuh dari API).
  const visibleRows = useMemo<StaffTableRow[]>(
    () => paginateData(filteredList, page, pageSize) as StaffTableRow[],
    [filteredList, page, pageSize],
  );

  // ── Seleksi baris (useTableSelection) — untuk aksi bulk ──
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const resetSelection = () => setSelectedKeys(new Set());

  // Baris di halaman aktif — select-all bekerja atas array ini (mirror BookingsPage).
  const { selectionConfig } = useTableSelectionState({
    data: visibleRows,
    idKey: 'id',
    selectedKeys,
    setSelectedKeys,
  });
  // getRowLabel ada di config plugin (bukan state) — label checkbox per baris.
  const selectionPlugin = useTableSelection({
    ...selectionConfig,
    getRowLabel: (staff) => staff.name,
  });

  const paginationPlugin = useTablePagination<StaffTableRow>({
    page,
    onPageChange: setPage,
    totalItems: filteredList.length,
    pageSize,
    position: 'none',
    align: 'end',
  });

  /** Ganti ukuran halaman: reset ke halaman 1 + kosongkan seleksi (data baru). */
  const changePageSize = (value: string) => {
    const next = Number(value);
    if (!Number.isFinite(next) || next <= 0 || next === pageSize) return;
    setPageSize(next);
    setPage(1);
    resetSelection();
  };

  // ── Aksi bulk (seleksi baris) — PATCH isActive / DELETE per id, mirror
  //     BookingsPage (Promise.all; backend staff PATCH menerima partial body). ──
  const [bulkError, setBulkError] = useState<string | null>(null);

  const bulkStatusMutation = useMutation({
    mutationFn: ({ ids, isActive }: { ids: string[]; isActive: boolean }) =>
      Promise.all(
        ids.map((id) =>
          apiFetch(`/staff/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ isActive }),
          }),
        ),
      ),
    // Bersihkan error lama di awal aksi baru — kalau tidak, pesan gagal tetap
    // tampil walau percobaan berikutnya sukses (mirror BookingsPage onMutate).
    onMutate: () => setBulkError(null),
    onSuccess: () => {
      resetSelection();
      queryClient.invalidateQueries({ queryKey: ['staff', activeWorkspaceId] });
      queryClient.invalidateQueries({ queryKey: ['bookings', activeWorkspaceId] });
    },
    onError: (err) => setBulkError(errorMessage(err, t, 'errors.saveStaff')),
  });

  /** Id staf yang dipilih untuk dihapus bulk — null = dialog tertutup. */
  const [bulkDeleteIds, setBulkDeleteIds] = useState<string[] | null>(null);

  const bulkDeleteMutation = useMutation({
    mutationFn: (ids: string[]) =>
      Promise.all(ids.map((id) => apiFetch(`/staff/${id}`, { method: 'DELETE' }))),
    onMutate: () => setBulkError(null),
    onSuccess: () => {
      setBulkDeleteIds(null);
      resetSelection();
      queryClient.invalidateQueries({ queryKey: ['staff', activeWorkspaceId] });
      queryClient.invalidateQueries({ queryKey: ['bookings', activeWorkspaceId] });
    },
    onError: (err) => {
      setBulkDeleteIds(null);
      setBulkError(errorMessage(err, t, 'errors.deleteStaff'));
    },
  });

  // Snap ke halaman terakhir bila hasil filter/dataset menyusut dan halaman
  // aktif kini melebihi jumlah halaman — hindari tabel kosong.
  const lastPage = filteredList.length ? Math.max(1, Math.ceil(filteredList.length / pageSize)) : 1;
  useEffect(() => {
    if (filteredList.length > 0 && page > lastPage) setPage(lastPage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredList.length, page, lastPage, pageSize]);

  /** Kolom tabel staf — data-driven; aksi baris memakai handler dialog di atas. */
  const staffColumns = useMemo<TableColumn<StaffTableRow>[]>(() => [
    {
      key: 'member',
      header: t('staff.colMember'),
      width: proportional(3),
      renderCell: (staff) => (
        <span className="flex min-w-0 items-center gap-3">
          <span
            className="flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white shadow-sm"
            style={{ backgroundColor: staff.color }}
          >
            {staff.name.slice(0, 2).toUpperCase()}
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold text-zinc-900">{staff.name}</span>
              {!staff.isActive && <Badge variant="neutral" label={t('staff.inactive')} />}
            </span>
            <span className="mt-0.5 block truncate text-xs text-zinc-500">
              {[staff.email, staff.phone].filter(Boolean).join(' · ') || '—'}
            </span>
          </span>
        </span>
      ),
    },
    {
      key: 'timezone',
      header: t('staff.timezone'),
      width: proportional(2),
      renderCell: (staff) => (
        <span className="block min-w-0">
          <span className="flex items-center gap-1.5 text-sm text-zinc-600">
            <IconClock className="size-3.5 shrink-0 text-zinc-400" aria-hidden="true" />
            <span className="truncate">{staff.timezone}</span>
          </span>
          {staff.bufferMinutes > 0 && (
            <span className="mt-0.5 block text-xs text-zinc-400">
              {t('staff.bufferShort', { minutes: staff.bufferMinutes })}
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'schedule',
      header: t('staff.colSchedule'),
      width: proportional(3),
      renderCell: (staff) =>
        staff.schedules.length === 0 ? (
          <span className="text-sm text-zinc-400">{t('staff.noScheduleHint')}</span>
        ) : (
          <span className="flex flex-wrap gap-1">
            {staff.schedules.map((entry) => (
              <span
                key={entry.id}
                className="inline-flex items-center gap-1 rounded-md bg-zinc-100 px-1.5 py-0.5 text-[11px] font-medium text-zinc-600"
              >
                {t(WEEKDAY_LABEL_KEYS[entry.dayOfWeek] ?? WEEKDAY_LABEL_KEYS[0]).slice(0, 3)}
                <span className="text-zinc-400">{rangeLabel(entry.startMinutes, entry.endMinutes)}</span>
              </span>
            ))}
          </span>
        ),
    },
    {
      key: 'timeOff',
      header: t('staff.timeOff'),
      width: pixel(150),
      renderCell: (staff) =>
        staff.timeOff.length === 0 ? (
          <span className="text-sm text-zinc-300">—</span>
        ) : (
          <span className="block min-w-0 text-sm text-zinc-600">
            <span className="block truncate">
              {t('staff.timeOffCount', { count: staff.timeOff.length })}
            </span>
            {/* timeOff sudah terurut naik dari API — entri pertama = cuti terdekat. */}
            <span className="mt-0.5 block truncate text-xs text-zinc-400">
              {dateOnly(staff.timeOff[0].startDate)}
            </span>
          </span>
        ),
    },
    {
      key: 'actions',
      header: t('staff.colActions'),
      width: pixel(72),
      align: 'end',
      renderCell: (staff) => (
        <span className="flex items-center justify-end">
          <StaffActionsMenu
            staff={staff}
            onSchedule={() => openSchedule(staff)}
            onTimeOff={() => openTimeOff(staff)}
            onEdit={() => openEdit(staff)}
            onDelete={() => setDeleteTarget(staff)}
          />
        </span>
      ),
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [t]);

  return (
    <div className="space-y-8">
      <PageHeader title={t('staff.title')} description={t('staff.description')} icon={IconStaff}>
        <ReloadMenuButton isFetching={isFetching} onReload={() => void refetch()} />
        <button
          type="button"
          onClick={openAdd}
          className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-amber-600 active:scale-[0.98]"
        >
          <IconPlus className="size-4" />
          {t('staff.add')}
        </button>
      </PageHeader>

      {/* Filter bar — mirror BookingsPage: cari staf + status + zona waktu.
          Hanya muncul saat sudah ada staf (daftar kosong = empty state tambah). */}
      {!isPending && !isError && data && staffList.length > 0 && (
        <Card className="p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
            <div className="min-w-0 flex-1">
              <TextInput
                label={t('staff.colMember')}
                placeholder={t('staff.searchPlaceholder')}
                value={searchFilter}
                onChange={(value) => setFilter('q', value)}
                startIcon={<IconSearch className="size-4" />}
                width="100%"
              />
            </div>

            <div className="min-w-0 flex-1">
              <Selector
                label={t('common.status')}
                options={[
                  {
                    value: '',
                    label: t('staff.allStatuses'),
                    icon: <StatusDot variant="neutral" label={t('staff.allStatuses')} />,
                  },
                  {
                    value: 'active',
                    label: t('staff.active'),
                    icon: <StatusDot variant="success" label={t('staff.active')} />,
                  },
                  {
                    value: 'inactive',
                    label: t('staff.inactive'),
                    icon: <StatusDot variant="neutral" label={t('staff.inactive')} />,
                  },
                ]}
                value={statusFilter}
                onChange={(value) => setFilter('status', value ?? '')}
                width="100%"
                renderOption={(option) => (
                  <SelectorOption
                    icon={option.icon}
                    label={
                      <span className={STATUS_TEXT[option.value] ?? 'text-zinc-500'}>
                        {option.label}
                      </span>
                    }
                  />
                )}
              />
            </div>

            <div className="min-w-0 flex-1">
              <Selector
                label={t('staff.timezone')}
                options={[
                  { value: '', label: t('staff.allTimezones') },
                  ...timezoneOptions.map((tz) => ({ value: tz, label: tz })),
                ]}
                value={tzFilter}
                onChange={(value) => setFilter('tz', value ?? '')}
                width="100%"
              />
            </div>

            <div className="flex items-center gap-3 lg:ml-auto">
              {hasFilters && (
                <Button
                  label={t('staff.resetFilter')}
                  variant="ghost"
                  size="sm"
                  onClick={resetFilters}
                />
              )}
            </div>
          </div>
        </Card>
      )}

      {deleteError && (
        <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {deleteError}
        </p>
      )}

      {showError && (
        <Card className="flex flex-col items-center gap-4 p-10 text-center">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-red-50 text-red-500">
            <IconAlertTriangle className="size-6" />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-zinc-900">{t('errors.staffLoadTitle')}</h3>
            <p className="mt-1 text-sm text-zinc-500">
              {error instanceof ApiError ? t('errors.apiStatus', { status: error.status }) : t('errors.apiConnection')}
            </p>
          </div>
          <Button label={t('common.retry')} variant="primary" onClick={() => void refetch()} />
        </Card>
      )}

      {isPending && (
        <Card className="divide-y divide-zinc-100">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3 p-4">
              <Skeleton width={40} height={40} radius={4} />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton width="40%" height={14} />
                <Skeleton width="66%" height={12} />
              </div>
            </div>
          ))}
        </Card>
      )}

      {!isPending && !isError && data && (
        <>
          {staffList.length === 0 ? (
            <EmptyState
              icon={IconUsers}
              title={t('staff.emptyTitle')}
              description={t('staff.emptyDesc')}
              action={{ label: t('staff.add'), onClick: openAdd }}
            />
          ) : filteredList.length === 0 ? (
            <EmptyState
              icon={IconUsers}
              title={t('staff.emptyFilteredTitle')}
              description={t('staff.emptyFilteredDesc')}
              action={{ label: t('staff.resetFilter'), onClick: resetFilters }}
            />
          ) : (
            <>
              {selectedKeys.size > 0 && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-sm font-medium text-zinc-800">
                      {t('staff.selectedCount', { count: selectedKeys.size })}
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        label={t('staff.activate')}
                        variant="secondary"
                        size="sm"
                        isDisabled={bulkStatusMutation.isPending}
                        isLoading={bulkStatusMutation.isPending}
                        onClick={() =>
                          bulkStatusMutation.mutate({ ids: [...selectedKeys], isActive: true })
                        }
                      />
                      <Button
                        label={t('staff.deactivate')}
                        variant="secondary"
                        size="sm"
                        isDisabled={bulkStatusMutation.isPending}
                        isLoading={bulkStatusMutation.isPending}
                        onClick={() =>
                          bulkStatusMutation.mutate({ ids: [...selectedKeys], isActive: false })
                        }
                      />
                      <Button
                        label={t('common.delete')}
                        variant="destructive"
                        size="sm"
                        isDisabled={
                          bulkStatusMutation.isPending || bulkDeleteMutation.isPending
                        }
                        onClick={() => setBulkDeleteIds([...selectedKeys])}
                      />
                      <Button
                        label={t('staff.clearSelection')}
                        variant="ghost"
                        size="sm"
                        isDisabled={
                          bulkStatusMutation.isPending || bulkDeleteMutation.isPending
                        }
                        onClick={resetSelection}
                      />
                    </div>
                  </div>
                  {bulkError && (
                    <p role="alert" className="mt-3 text-sm text-red-600">{bulkError}</p>
                  )}
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
                <Table
                  data={visibleRows}
                  columns={staffColumns}
                  idKey="id"
                  density="balanced"
                  dividers="none"
                  hasHover
                  textOverflow="truncate"
                  plugins={{ selection: selectionPlugin, pagination: paginationPlugin }}
                />
              </Card>

              {/* Footer: rows-per-page (kiri) + info jumlah baris terlihat */}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 px-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-zinc-500">
                    {t('staff.rowsPerPage')}
                  </span>
                  <Selector
                    label={t('staff.rowsPerPage')}
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
                    i18nKey="staff.showingRows"
                    values={{ shown: visibleRows.length, total: filteredList.length }}
                    components={{ strong: <strong className="font-bold text-black" /> }}
                  />
                </p>
                <Pagination
                  page={page}
                  onChange={setPage}
                  totalItems={filteredList.length}
                  pageSize={pageSize}
                />
              </div>
            </>
          )}
        </>
      )}

      {/* Dialog tambah staf */}
      <Dialog isOpen={isAddOpen} onOpenChange={(open) => { if (!open) closeAdd(); }} purpose="info" width={520}>
        <Layout
          header={
            <DialogHeader
              title={t('staff.addTitle')}
              subtitle={t('staff.addSubtitle')}
              onOpenChange={(open) => { if (!open) closeAdd(); }}
              hasDivider
            />
          }
          content={
            <LayoutContent>
              <form id="add-staff-form" onSubmit={submitAdd} className="space-y-5">
                <TextInput
                  label={t('common.name')}
                  placeholder={t('staff.namePlaceholder')}
                  value={addName}
                  onChange={setAddName}
                  isRequired
                />
                <TextInput
                  label={t('common.email')}
                  type="email"
                  placeholder={t('staff.emailPlaceholder')}
                  value={addEmail}
                  onChange={setAddEmail}
                  isOptional
                />
                <PhoneInput
                  label={t('common.phone')}
                  value={addPhone}
                  onChange={setAddPhone}
                  isOptional
                />
                <div>
                  <Selector
                    label={t('staff.timezone')}
                    options={COMMON_TIMEZONES.map((tz) => ({ value: tz, label: tz }))}
                    value={addTimezone}
                    onChange={(value) => setAddTimezone(value ?? 'UTC')}
                    hasSearch
                    searchPlaceholder={t('staff.searchTimezone')}
                    width="100%"
                  />
                  <TimezoneClock timezone={addTimezone} />
                </div>
                {/* Buffer & warna — tiap field di barisnya sendiri agar form
                    tidak sempit; warna memakai kolom penuh seperti field lain. */}
                <NumberInput
                  label={t('staff.buffer')}
                  description={t('staff.bufferDesc')}
                  value={addBuffer}
                  onChange={(value) => setAddBuffer(value ?? 0)}
                  min={0}
                  max={120}
                  width="100%"
                />
                <div>
                  <p className="mb-1.5 text-xs font-medium text-zinc-600">{t('staff.color')}</p>
                  <div className="flex items-center gap-1.5">
                    {STAFF_COLORS.map((color) => (
                      <button
                        key={color}
                        type="button"
                        aria-label={color}
                        onClick={() => setAddColor(color)}
                        className={`size-6 rounded-full transition ${
                          addColor === color ? 'ring-2 ring-zinc-900 ring-offset-2' : 'hover:scale-110'
                        }`}
                        style={{ backgroundColor: color }}
                      />
                    ))}
                  </div>
                </div>
              </form>
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              {addError && <p role="alert" className="pb-2 text-right text-sm text-red-600">{addError}</p>}
              <div className="flex justify-end gap-2">
                <Button label={t('common.cancel')} variant="ghost" onClick={closeAdd} isDisabled={addMutation.isPending} />
                <Button
                  label={t('common.save')}
                  variant="primary"
                  type="submit"
                  form="add-staff-form"
                  isLoading={addMutation.isPending}
                />
              </div>
            </LayoutFooter>
          }
        />
      </Dialog>

      {/* Dialog edit staf */}
      <Dialog isOpen={editing !== null} onOpenChange={(open) => { if (!open) setEditing(null); }} purpose="info" width={520}>
        <Layout
          header={
            <DialogHeader
              title={t('staff.editTitle')}
              subtitle={editing?.name}
              onOpenChange={(open) => { if (!open) setEditing(null); }}
              hasDivider
            />
          }
          content={
            <LayoutContent>
              <form id="edit-staff-form" onSubmit={submitEdit} className="space-y-5">
                <TextInput
                  label={t('common.name')}
                  placeholder={t('staff.namePlaceholder')}
                  value={editName}
                  onChange={setEditName}
                  isRequired
                />
                <TextInput
                  label={t('common.email')}
                  type="email"
                  placeholder={t('staff.emailPlaceholder')}
                  value={editEmail}
                  onChange={setEditEmail}
                  isOptional
                />
                <PhoneInput
                  label={t('common.phone')}
                  value={editPhone}
                  onChange={setEditPhone}
                  isOptional
                />
                <Selector
                  label={t('staff.timezone')}
                  options={COMMON_TIMEZONES.map((tz) => ({ value: tz, label: tz }))}
                  value={editTimezone}
                  onChange={(value) => setEditTimezone(value ?? 'UTC')}
                  hasSearch
                  searchPlaceholder={t('staff.searchTimezone')}
                  width="100%"
                />
                <div className="flex flex-col gap-5 sm:flex-row sm:items-end">
                  <div className="min-w-0 flex-1">
                    <NumberInput
                      label={t('staff.buffer')}
                      description={t('staff.bufferDesc')}
                      value={editBuffer}
                      onChange={(value) => setEditBuffer(value ?? 0)}
                      min={0}
                      max={120}
                      width="100%"
                    />
                  </div>
                  <div>
                    <p className="mb-1.5 text-xs font-medium text-zinc-600">{t('staff.color')}</p>
                    <div className="flex items-center gap-1.5">
                      {STAFF_COLORS.map((color) => (
                        <button
                          key={color}
                          type="button"
                          aria-label={color}
                          onClick={() => setEditColor(color)}
                          className={`size-6 rounded-full transition ${
                            editColor === color ? 'ring-2 ring-zinc-900 ring-offset-2' : 'hover:scale-110'
                          }`}
                          style={{ backgroundColor: color }}
                        />
                      ))}
                    </div>
                  </div>
                </div>
                <Switch
                  label={t('staff.active')}
                  description={t('staff.activeDesc')}
                  value={editIsActive}
                  onChange={setEditIsActive}
                />
              </form>
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              {editError && <p role="alert" className="pb-2 text-right text-sm text-red-600">{editError}</p>}
              <div className="flex justify-end gap-2">
                <Button label={t('common.cancel')} variant="ghost" onClick={() => setEditing(null)} isDisabled={editMutation.isPending} />
                <Button
                  label={t('common.save')}
                  variant="primary"
                  type="submit"
                  form="edit-staff-form"
                  isLoading={editMutation.isPending}
                />
              </div>
            </LayoutFooter>
          }
        />
      </Dialog>

      {/* Dialog jadwal mingguan */}
      <Dialog
        isOpen={scheduleStaff !== null}
        onOpenChange={(open) => { if (!open) setScheduleStaff(null); }}
        purpose="info"
        width={560}
      >
        <Layout
          header={
            <DialogHeader
              title={t('staff.scheduleTitle', { name: scheduleStaff?.name ?? '' })}
              subtitle={t('staff.scheduleSubtitle', { timezone: scheduleStaff?.timezone ?? '' })}
              onOpenChange={(open) => { if (!open) setScheduleStaff(null); }}
              hasDivider
            />
          }
          content={
            <LayoutContent>
              <div className="space-y-4">
                {scheduleDraft.map((dayRanges, day) => (
                  <div key={day} className="rounded-xl border border-zinc-100 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-zinc-800">{t(WEEKDAY_LABEL_KEYS[day])}</p>
                      <button
                        type="button"
                        onClick={() => addRange(day)}
                        className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-semibold text-amber-600 transition hover:bg-amber-50"
                      >
                        <IconPlus className="size-3" />
                        {t('staff.addRange')}
                      </button>
                    </div>
                    {dayRanges.length === 0 ? (
                      <p className="mt-1.5 text-xs text-zinc-400">{t('staff.dayOff')}</p>
                    ) : (
                      <div className="mt-2 space-y-2">
                        {dayRanges.map((range, index) => (
                          <div key={index} className="flex items-center gap-2">
                            <div className="flex min-w-0 flex-1 items-center gap-2">
                              <TimeInput
                                label={t('staff.startTime')}
                                isLabelHidden
                                hourFormat="24h"
                                value={toTimeString(range.startMinutes)}
                                onChange={(value) => setRange(day, index, { startMinutes: toMinutes(value) })}
                                width="100%"
                              />
                              <span className="text-xs text-zinc-400">—</span>
                              <TimeInput
                                label={t('staff.endTime')}
                                isLabelHidden
                                hourFormat="24h"
                                value={toTimeString(range.endMinutes)}
                                onChange={(value) => setRange(day, index, { endMinutes: toMinutes(value) })}
                                width="100%"
                              />
                            </div>
                            <IconButton
                              icon={<IconTrash className="size-4" />}
                              label={t('staff.removeRange')}
                              variant="ghost"
                              size="sm"
                              onClick={() => removeRange(day, index)}
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              {scheduleError && <p role="alert" className="pb-2 text-right text-sm text-red-600">{scheduleError}</p>}
              <div className="flex justify-end gap-2">
                <Button label={t('common.cancel')} variant="ghost" onClick={() => setScheduleStaff(null)} isDisabled={scheduleSaving} />
                <Button label={t('common.save')} variant="primary" isLoading={scheduleSaving} onClick={() => void saveSchedule()} />
              </div>
            </LayoutFooter>
          }
        />
      </Dialog>

      {/* Dialog cuti */}
      <Dialog
        isOpen={timeOffStaff !== null}
        onOpenChange={(open) => { if (!open) setTimeOffStaff(null); }}
        purpose="info"
        width={480}
      >
        <Layout
          header={
            <DialogHeader
              title={t('staff.timeOffTitle', { name: timeOffStaff?.name ?? '' })}
              subtitle={t('staff.timeOffSubtitle')}
              onOpenChange={(open) => { if (!open) setTimeOffStaff(null); }}
              hasDivider
            />
          }
          content={
            <LayoutContent>
              <div className="space-y-5">
                <form id="add-time-off-form" onSubmit={submitTimeOff} className="space-y-4 rounded-xl border border-zinc-100 p-3">
                  <div className="grid grid-cols-2 gap-3">
                    <DateInput
                      label={t('staff.startDate')}
                      value={timeOffStart ? (timeOffStart as ISODateString) : undefined}
                      onChange={(value) => setTimeOffStart(value ?? '')}
                      format="date"
                      isRequired
                    />
                    <DateInput
                      label={t('staff.endDate')}
                      value={timeOffEnd ? (timeOffEnd as ISODateString) : undefined}
                      onChange={(value) => setTimeOffEnd(value ?? '')}
                      format="date"
                      isRequired
                    />
                  </div>
                  <TextInput
                    label={t('staff.reason')}
                    placeholder={t('staff.reasonPlaceholder')}
                    value={timeOffReason}
                    onChange={setTimeOffReason}
                    isOptional
                  />
                  {timeOffError && <p role="alert" className="text-sm text-red-600">{timeOffError}</p>}
                  <div className="flex justify-end">
                    <Button
                      label={t('staff.addTimeOff')}
                      variant="secondary"
                      size="sm"
                      icon={<IconPlus className="size-3.5" />}
                      isLoading={addTimeOffMutation.isPending}
                      isDisabled={addTimeOffMutation.isPending || !timeOffStart || !timeOffEnd}
                      type="submit"
                    />
                  </div>
                </form>

                {(timeOffStaff?.timeOff.length ?? 0) === 0 ? (
                  <p className="text-sm text-zinc-500">{t('staff.noTimeOff')}</p>
                ) : (
                  <div className="space-y-2">
                    {timeOffStaff?.timeOff.map((entry) => (
                      <div key={entry.id} className="flex items-center gap-3 rounded-xl border border-zinc-100 px-3 py-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-zinc-800">
                            {dateOnly(entry.startDate)} → {dateOnly(entry.endDate)}
                          </p>
                          {entry.reason && <p className="truncate text-xs text-zinc-500">{entry.reason}</p>}
                        </div>
                        <IconButton
                          icon={<IconTrash className="size-4" />}
                          label={t('staff.deleteTimeOff')}
                          variant="ghost"
                          size="sm"
                          isLoading={removeTimeOffMutation.isPending}
                          onClick={() =>
                            removeTimeOffMutation.mutate({ staffId: timeOffStaff.id, timeOffId: entry.id })
                          }
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              <div className="flex justify-end">
                <Button label={t('common.close')} variant="ghost" onClick={() => setTimeOffStaff(null)} />
              </div>
            </LayoutFooter>
          }
        />
      </Dialog>

      {/* Konfirmasi hapus staf */}
      <ConfirmDialog
        isOpen={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={t('staff.deleteTitle')}
        description={t('staff.deleteDesc', { name: deleteTarget?.name ?? '' })}
        cancelLabel={t('common.cancel')}
        actionLabel={t('common.delete')}
        actionVariant="destructive"
        isActionLoading={deleteMutation.isPending}
        onAction={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
        }}
        width={420}
      />

      {/* Konfirmasi hapus bulk (seleksi baris) */}
      <ConfirmDialog
        isOpen={bulkDeleteIds !== null}
        onOpenChange={(open) => { if (!open) setBulkDeleteIds(null); }}
        title={t('staff.bulkDeleteTitle', { count: bulkDeleteIds?.length ?? 0 })}
        description={t('staff.bulkDeleteDesc', { count: bulkDeleteIds?.length ?? 0 })}
        cancelLabel={t('common.cancel')}
        actionLabel={t('common.delete')}
        actionVariant="destructive"
        isActionLoading={bulkDeleteMutation.isPending}
        onAction={() => {
          if (bulkDeleteIds) bulkDeleteMutation.mutate(bulkDeleteIds);
        }}
        width={420}
      />
    </div>
  );
}
