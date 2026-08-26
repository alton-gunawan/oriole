import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { Trans, useTranslation } from 'react-i18next';
import {
  Badge,
  Button,
  Dialog,
  DialogHeader,
  DropdownMenu,
  DropdownMenuItem,
  InputGroup,
  Layout,
  LayoutContent,
  LayoutFooter,
  MultiSelector,
  NumberInput,
  Pagination,
  Selector,
  SelectorOption,
  Skeleton,
  StatusDot,
  Switch,
  Table,
  TextArea,
  TextInput,
  Tokenizer,
  paginateData,
  pixel,
  proportional,
  useTablePagination,
  useTableSelection,
  useTableSelectionState,
  useToast,
  type SearchableItem,
  type SearchSource,
  type TableColumn,
} from '@astryxdesign/core';

import { ApiError, apiFetch } from '../../lib/api';
import { tintedBadgeVariant } from '../../lib/badge-variant';
import { errorMessage } from '../../lib/errors';
import type { StaffRecord } from '../../lib/staff';
import {
  type CreateServicePayload,
  type ServiceRecord,
  type UpdateServicePayload,
  formatServiceDuration,
  formatServicePrice,
  getTemplateServicesForIndustry,
  SERVICE_CURRENCIES,
} from '../../lib/services';
import { useWorkspaceStore } from '../../stores/workspace';
import {
  IconAlertTriangle,
  IconArrowUpRight,
  IconDotsHorizontal,
  IconEdit,
  IconPlus,
  IconRefreshCw,
  IconSearch,
  IconServices,
  IconSparkles,
  IconTrash,
  IconX,
} from '../shell/icons';
import { ServiceDetailDialog } from '../components/ServiceDetailDialog';
import { Card, ConfirmDialog, EmptyState, PageHeader, ReloadMenuButton } from '../shell/ui';

/** Dropdown aksi per baris layanan — tombol ⋯ membuka menu (lihat detail, edit, hapus). */
function ServiceActionsMenu({
  onView,
  onEdit,
  onDelete,
}: {
  onView: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <DropdownMenu
      placement="below"
      menuWidth={140}
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
        icon={<IconArrowUpRight className="size-4" />}
        label={t('common.view')}
        onClick={onView}
      />
      <DropdownMenuItem
        icon={<IconEdit className="size-4" />}
        label={t('common.edit')}
        onClick={onEdit}
      />
      <DropdownMenuItem
        icon={<IconTrash className="size-4 text-red-500" />}
        label={<span className="font-medium text-red-600">{t('common.delete')}</span>}
        onClick={onDelete}
      />
    </DropdownMenu>
  );
}

/** Baris tabel: ServiceRecord + index signature (Table butuh Record<string, unknown>). */
type ServiceTableRow = ServiceRecord & Record<string, unknown>;

/** Warna teks opsi filter status — selaras dengan variant StatusDot-nya. */
const STATUS_TEXT: Record<string, string> = {
  '': 'text-zinc-500 dark:text-zinc-400',
  active: 'text-emerald-600',
  inactive: 'text-zinc-500 dark:text-zinc-400',
};

/**
 * Teks array legacy (kolom dulu text, di-wrap jadi text[] di migrasi #0021):
 * JSON ("[\"a\",\"b\"]") atau literal array PG ("{a,b}") → daftar item.
 * Kembalikan null bila bukan representasi array.
 */
function parseArrayText(text: string): string[] | null {
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((item) => String(item));
    } catch {
      // Bukan JSON valid — perlakukan sebagai kategori tunggal biasa.
    }
    return null;
  }
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const inner = trimmed.slice(1, -1);
    if (!inner.trim()) return [];
    const items: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (ch === '"') {
        if (inQuotes && inner[i + 1] === '"') {
          current += '"';
          i++;
          continue;
        }
        inQuotes = !inQuotes;
        continue;
      }
      if (ch === '\\' && inQuotes && i + 1 < inner.length) {
        current += inner[i + 1];
        i++;
        continue;
      }
      if (ch === ',' && !inQuotes) {
        items.push(current.trim());
        current = '';
        continue;
      }
      current += ch;
    }
    items.push(current.trim());
    return items;
  }
  return null;
}

/**
 * Daftar kategori tampilan — legacy yang tersimpan sebagai SATU elemen berisi
 * teks array ("[\"perawatan\",\"rambut\"]") di-flatten jadi item terpisah,
 * dengan dedupe case-insensitive (selaras dengan normalisasi backend).
 */
function expandCategoryList(categories: string[] | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const category of categories ?? []) {
    const parts = parseArrayText(category) ?? [category];
    for (const part of parts) {
      const clean = part.trim();
      if (!clean) continue;
      const key = clean.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(clean);
    }
  }
  return out;
}

export function ServicesPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const activeWorkspace = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === s.activeWorkspaceId) ?? null,
  );
  const queryClient = useQueryClient();

  const [isPopulating, setIsPopulating] = useState(false);

  const handlePopulateFromIndustry = async () => {
    const templates = getTemplateServicesForIndustry(
      activeWorkspace?.industry,
      activeWorkspace?.templateCategory,
    );
    if (!templates.length) return;

    setIsPopulating(true);
    try {
      for (const tpl of templates) {
        await apiFetch<{ service: ServiceRecord }>('/services', {
          method: 'POST',
          body: JSON.stringify({
            name: tpl.name,
            durationMinutes: tpl.duration,
            priceMinor: tpl.price ? Math.round(tpl.price * 100) : null,
            currency: 'USD',
          }),
        });
      }
      toast({
        body: t('services.populateSuccess'),
        type: 'info',
        isAutoHide: true,
        autoHideDuration: 4000,
      });
      await queryClient.invalidateQueries({ queryKey: ['services', activeWorkspaceId] });
    } catch (err) {
      toast({
        body: errorMessage(err, t, 'errors.generic'),
        type: 'error',
        isAutoHide: true,
        autoHideDuration: 5000,
      });
    } finally {
      setIsPopulating(false);
    }
  };

  const { data, isPending, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['services', activeWorkspaceId],
    queryFn: () => apiFetch<{ services: ServiceRecord[] }>('/services'),
    enabled: Boolean(activeWorkspaceId),
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 3,
  });

  // Staf (untuk chip nama di kolom staf + opsi MultiSelector) — di-fetch paralel.
  const { data: staffData } = useQuery({
    queryKey: ['staff', activeWorkspaceId],
    queryFn: () => apiFetch<{ staff: StaffRecord[] }>('/staff'),
    enabled: Boolean(activeWorkspaceId),
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 3,
  });

  const servicesList = data?.services ?? [];
  const activeStaff = (staffData?.staff ?? []).filter((staff) => staff.isActive);
  const staffNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const staff of staffData?.staff ?? []) map.set(staff.id, staff.name);
    return map;
  }, [staffData]);

  const isAuthExpiry = error instanceof ApiError && error.status === 401;
  const showError = isError && !isAuthExpiry;

  // ── Filter layanan — dipersist di URL agar bisa dibagikan ──
  const [searchParams, setSearchParams] = useSearchParams();
  const serviceIdParam = searchParams.get('serviceId');
  const [viewService, setViewService] = useState<ServiceRecord | null>(null);

  const searchFilter = searchParams.get('q') ?? '';
  const rawStatus = searchParams.get('status') ?? '';
  const statusFilter = rawStatus === 'active' || rawStatus === 'inactive' ? rawStatus : '';
  // Kategori multi-select — di-persist sebagai parameter URL berulang (?category=a&category=b).
  const categoryFilter = useMemo(() => searchParams.getAll('category').sort(), [searchParams]);
  const categoryKey = categoryFilter.join('\u0000');
  const hasFilters = Boolean(searchFilter.trim() || statusFilter || categoryFilter.length > 0);

  const [debouncedSearch, setDebouncedSearch] = useState(searchFilter);
  const [debouncedStatus, setDebouncedStatus] = useState(statusFilter);
  const [debouncedCategory, setDebouncedCategory] = useState<string[]>(categoryFilter);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchFilter);
      setDebouncedStatus(statusFilter);
      setDebouncedCategory(categoryFilter);
      setPage(1);
      setSelectedKeys(new Set());
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchFilter, statusFilter, categoryKey]);

  const setFilter = (key: 'q' | 'status', value: string) => {
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
  // Multi-kategori: tulis semua nilai sekaligus (hapus lalu append berulang).
  const setCategoryFilter = (values: string[]) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('category');
        for (const value of values) next.append('category', value);
        return next;
      },
      { replace: true },
    );
  };
  const resetFilters = () => {
    setSearchParams(
      (prev) => {
        prev.delete('q');
        prev.delete('status');
        prev.delete('category');
        return prev;
      },
      { replace: true },
    );
  };

  // Kategori unik dari SELURUH daftar layanan (tak terfilter) — opsi Selector
  // tetap stabil meski filter lain sedang aktif.
  const categoryOptions = useMemo(() => {
    const set = new Set<string>();
    for (const service of servicesList) for (const category of expandCategoryList(service.category)) set.add(category);
    return [...set].sort();
  }, [servicesList]);

  // Sumber pencarian Tokenizer kategori — kandidat dari kategori yang sudah ada.
  // `hasCreate` di komponen menambah token baru dari teks bebas (Enter).
  const categorySource = useMemo<SearchSource<SearchableItem>>(
    () => ({
      search: (query) => {
        const q = query.trim().toLowerCase();
        return categoryOptions
          .filter((category) => !q || category.toLowerCase().includes(q))
          .map((category) => ({ id: category, label: category }));
      },
      bootstrap: () => categoryOptions.map((category) => ({ id: category, label: category })),
    }),
    [categoryOptions],
  );

  // Filter client-side: cari (nama/deskripsi/kategori) + status + kategori.
  const filteredList = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    return servicesList.filter((service) => {
      if (debouncedStatus === 'active' && !service.isActive) return false;
      if (debouncedStatus === 'inactive' && service.isActive) return false;
      if (debouncedCategory.length > 0) {
        const serviceCategories = service.category ?? [];
        if (!debouncedCategory.some((category) => serviceCategories.includes(category))) return false;
      }
      if (q) {
        const haystack = [service.name, service.description, ...expandCategoryList(service.category)]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [servicesList, debouncedSearch, debouncedStatus, debouncedCategory]);

  // ── Dialog tambah layanan ─────────────────────────────────
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [addName, setAddName] = useState('');
  const [addDescription, setAddDescription] = useState('');
  const [addDuration, setAddDuration] = useState(60);
  const [addPrice, setAddPrice] = useState<number | null>(null);
  const [addCurrency, setAddCurrency] = useState<string>('IDR');
  const [addCategories, setAddCategories] = useState<string[]>([]);
  const [addStaffIds, setAddStaffIds] = useState<string[]>([]);
  const [addError, setAddError] = useState<string | null>(null);

  const closeAdd = () => {
    setIsAddOpen(false);
    setAddError(null);
  };
  const openAdd = () => {
    setAddName('');
    setAddDescription('');
    setAddDuration(60);
    setAddPrice(null);
    setAddCurrency('IDR');
    setAddCategories([]);
    setAddStaffIds([]);
    setAddError(null);
    setIsAddOpen(true);
  };

  const addMutation = useMutation({
    mutationFn: (payload: CreateServicePayload) =>
      apiFetch<{ service: ServiceRecord }>('/services', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      closeAdd();
      queryClient.invalidateQueries({ queryKey: ['services', activeWorkspaceId] });
    },
    onError: (err) => setAddError(errorMessage(err, t, 'errors.saveService')),
  });

  const submitAdd = (event: FormEvent) => {
    event.preventDefault();
    if (!addName.trim()) {
      setAddError(t('services.nameRequired'));
      return;
    }
    setAddError(null);
    addMutation.mutate({
      name: addName.trim(),
      description: addDescription.trim() || undefined,
      durationMinutes: addDuration,
      priceMinor: addPrice === null ? null : Math.round(addPrice * 100),
      currency: addCurrency,
      category: addCategories.length > 0 ? addCategories : undefined,
      staffIds: addStaffIds,
    });
  };

  // ── Dialog edit layanan ────────────────────────────────────
  const [editing, setEditing] = useState<ServiceRecord | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editDuration, setEditDuration] = useState(60);
  const [editPrice, setEditPrice] = useState<number | null>(null);
  const [editCurrency, setEditCurrency] = useState('USD');
  const [editCategories, setEditCategories] = useState<string[]>([]);
  const [editStaffIds, setEditStaffIds] = useState<string[]>([]);
  const [editIsActive, setEditIsActive] = useState(true);
  const [editError, setEditError] = useState<string | null>(null);

  const openEdit = (service: ServiceRecord) => {
    setEditing(service);
    setEditName(service.name);
    setEditDescription(service.description ?? '');
    setEditDuration(service.durationMinutes);
    setEditPrice(service.priceMinor === null ? null : service.priceMinor / 100);
    setEditCurrency(service.currency);
    setEditCategories(expandCategoryList(service.category));
    setEditStaffIds(service.staffIds);
    setEditIsActive(service.isActive);
    setEditError(null);
  };

  const editMutation = useMutation({
    mutationFn: (payload: UpdateServicePayload) =>
      apiFetch<{ service: ServiceRecord }>(`/services/${editing?.id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      setEditing(null);
      queryClient.invalidateQueries({ queryKey: ['services', activeWorkspaceId] });
      queryClient.invalidateQueries({ queryKey: ['bookings', activeWorkspaceId] });
    },
    onError: (err) => setEditError(errorMessage(err, t, 'errors.saveService')),
  });

  const submitEdit = (event: FormEvent) => {
    event.preventDefault();
    if (!editing || !editName.trim()) return;
    setEditError(null);
    editMutation.mutate({
      name: editName.trim(),
      description: editDescription.trim() || null,
      durationMinutes: editDuration,
      priceMinor: editPrice === null ? null : Math.round(editPrice * 100),
      currency: editCurrency,
      category: editCategories.length > 0 ? editCategories : null,
      isActive: editIsActive,
      staffIds: editStaffIds,
    });
  };

  // ── Hapus layanan ──────────────────────────────────────────
  const [deleteTarget, setDeleteTarget] = useState<ServiceRecord | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/services/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setDeleteTarget(null);
      setDeleteError(null);
      queryClient.invalidateQueries({ queryKey: ['services', activeWorkspaceId] });
      queryClient.invalidateQueries({ queryKey: ['bookings', activeWorkspaceId] });
    },
    onError: (err) => {
      setDeleteTarget(null);
      setDeleteError(errorMessage(err, t, 'errors.deleteService'));
    },
  });

  // ── Tampilan tabel: pagination client-side (mirror StaffPage) ──
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const visibleRows = useMemo<ServiceTableRow[]>(
    () => paginateData(filteredList, page, pageSize) as ServiceTableRow[],
    [filteredList, page, pageSize],
  );

  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const resetSelection = () => setSelectedKeys(new Set());

  const { selectionConfig } = useTableSelectionState({
    data: visibleRows,
    idKey: 'id',
    selectedKeys,
    setSelectedKeys,
  });
  const selectionPlugin = useTableSelection({
    ...selectionConfig,
    getRowLabel: (service) => service.name,
  });

  const paginationPlugin = useTablePagination<ServiceTableRow>({
    page,
    onPageChange: setPage,
    totalItems: filteredList.length,
    pageSize,
    position: 'none',
    align: 'end',
  });

  const changePageSize = (value: string) => {
    const next = Number(value);
    if (!Number.isFinite(next) || next <= 0 || next === pageSize) return;
    setPageSize(next);
    setPage(1);
    resetSelection();
  };

  // ── Aksi bulk (seleksi baris) — PATCH isActive / DELETE per id ──
  const [bulkError, setBulkError] = useState<string | null>(null);

  const bulkStatusMutation = useMutation({
    mutationFn: ({ ids, isActive }: { ids: string[]; isActive: boolean }) =>
      Promise.all(
        ids.map((id) =>
          apiFetch(`/services/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ isActive }),
          }),
        ),
      ),
    onMutate: () => setBulkError(null),
    onSuccess: (_data, variables) => {
      resetSelection();
      toast({
        body: variables.isActive
          ? t('services.bulkActivated', { count: variables.ids.length })
          : t('services.bulkDeactivated', { count: variables.ids.length }),
        type: 'info',
        isAutoHide: true,
        autoHideDuration: 4000,
      });
      queryClient.invalidateQueries({ queryKey: ['services', activeWorkspaceId] });
      queryClient.invalidateQueries({ queryKey: ['bookings', activeWorkspaceId] });
    },
    onError: (err) => {
      const msg = errorMessage(err, t, 'errors.saveService');
      setBulkError(msg);
      toast({
        body: msg,
        type: 'error',
        isAutoHide: true,
        autoHideDuration: 5000,
      });
    },
  });

  const [bulkDeleteIds, setBulkDeleteIds] = useState<string[] | null>(null);

  const bulkDeleteMutation = useMutation({
    mutationFn: (ids: string[]) =>
      Promise.all(ids.map((id) => apiFetch(`/services/${id}`, { method: 'DELETE' }))),
    onMutate: () => setBulkError(null),
    onSuccess: (_data, variables) => {
      setBulkDeleteIds(null);
      resetSelection();
      toast({
        body: t('services.bulkDeleted', { count: variables.length }),
        type: 'info',
        isAutoHide: true,
        autoHideDuration: 4000,
      });
      queryClient.invalidateQueries({ queryKey: ['services', activeWorkspaceId] });
      queryClient.invalidateQueries({ queryKey: ['bookings', activeWorkspaceId] });
    },
    onError: (err) => {
      setBulkDeleteIds(null);
      const msg = errorMessage(err, t, 'errors.deleteService');
      setBulkError(msg);
      toast({
        body: msg,
        type: 'error',
        isAutoHide: true,
        autoHideDuration: 5000,
      });
    },
  });

  const lastPage = filteredList.length ? Math.max(1, Math.ceil(filteredList.length / pageSize)) : 1;
  useEffect(() => {
    if (filteredList.length > 0 && page > lastPage) setPage(lastPage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredList.length, page, lastPage, pageSize]);

  /** Kolom tabel layanan — data-driven; aksi baris memakai handler dialog di atas. */
  const serviceColumns = useMemo<TableColumn<ServiceTableRow>[]>(() => [
    {
      key: 'service',
      header: t('services.colService'),
      width: proportional(3),
      renderCell: (service) => (
        <button
          type="button"
          onClick={() => setViewService(service)}
          title={t('serviceDetail.openDetail', { defaultValue: 'View service details' })}
          className="group flex min-w-0 items-center gap-3 text-left cursor-pointer"
        >
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-zinc-200 dark:border-zinc-700/60 bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 group-hover:text-amber-600 dark:group-hover:text-amber-400 transition">
            <IconServices className="size-4" />
          </div>
          <span className="min-w-0">
            <span className="block truncate text-base font-semibold text-zinc-900 dark:text-zinc-100 transition group-hover:text-amber-600 dark:group-hover:text-amber-400">
              {service.name}
            </span>
            {service.description && (
              <span className="block truncate text-xs text-zinc-500 dark:text-zinc-400">
                {service.description}
              </span>
            )}
          </span>
        </button>
      ),
    },
    {
      key: 'duration',
      header: t('services.colDuration'),
      width: pixel(110),
      renderCell: (service) => (
        <span className="block min-w-0 text-base text-zinc-600 dark:text-zinc-400">
          {formatServiceDuration(service.durationMinutes)}
        </span>
      ),
    },
    {
      key: 'price',
      header: t('services.colPrice'),
      width: proportional(2),
      renderCell: (service) => {
        const price = formatServicePrice(service.priceMinor, service.currency);
        return (
          <span className="block min-w-0 text-base text-zinc-600 dark:text-zinc-400">
            {price ?? <span className="text-zinc-300 dark:text-zinc-600">—</span>}
          </span>
        );
      },
    },
    {
      key: 'category',
      header: t('services.colCategory'),
      width: proportional(2),
      renderCell: (service) => {
        const categories = expandCategoryList(service.category);
        if (categories.length === 0) {
          return <span className="text-base text-zinc-300 dark:text-zinc-600">—</span>;
        }
        // Hanya tampilkan kategori pertama + badge "+N" untuk sisanya (mirip
        // text-ellipsis) — tidak memenuhi kolom dengan semua kategori.
        const [first, ...rest] = categories;
        return (
          <span className="inline-flex max-w-full items-center gap-1">
            <Badge
              variant={tintedBadgeVariant(first)}
              label={<span className="block max-w-40 truncate">{first}</span>}
            />
            {rest.length > 0 && <Badge variant="neutral" label={`+${rest.length}`} />}
          </span>
        );
      },
    },
    {
      key: 'staff',
      header: t('services.colStaff'),
      width: proportional(2),
      renderCell: (service) => {
        if (service.staffIds.length === 0) {
          return <span className="text-base text-zinc-400 dark:text-zinc-500">{t('services.noStaffHint')}</span>;
        }
        // Sama seperti kategori: staf pertama sebagai Badge berwarna (deterministik
        // dari nama, agar staf yang sama selalu berwarna sama) + badge "+N" sisanya.
        const [firstId, ...restIds] = service.staffIds;
        const firstName = staffNameById.get(firstId) ?? '?';
        return (
          <span className="inline-flex max-w-full items-center gap-1">
            <Badge
              variant={tintedBadgeVariant(firstName)}
              label={<span className="block max-w-40 truncate">{firstName}</span>}
            />
            {restIds.length > 0 && <Badge variant="neutral" label={`+${restIds.length}`} />}
          </span>
        );
      },
    },
    {
      key: 'actions',
      header: t('services.colActions'),
      width: pixel(72),
      align: 'end',
      renderCell: (service) => (
        <span className="flex items-center justify-end">
          <ServiceActionsMenu
            onView={() => setViewService(service)}
            onEdit={() => openEdit(service)}
            onDelete={() => setDeleteTarget(service)}
          />
        </span>
      ),
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [t, staffNameById]);

  return (
    <div className="flex min-h-[calc(100vh-10rem)] flex-1 flex-col space-y-6">
      <PageHeader title={t('services.title')} description={t('services.description')} icon={IconServices}>
        <ReloadMenuButton isFetching={isFetching} onReload={() => void refetch()} />
        <Button
          label={t('services.add')}
          variant="primary"
          icon={<IconPlus className="size-4" />}
          onClick={openAdd}
        />
      </PageHeader>

      <div className="flex flex-1 flex-col space-y-4">
        {/* Filter bar — mirror StaffPage: cari layanan + status + kategori. */}
        {!isPending && !isError && data && servicesList.length > 0 && (
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <div className="min-w-0 flex-1">
              <TextInput
                label={t('services.colService')}
                isLabelHidden
                placeholder={t('services.searchPlaceholder')}
                value={searchFilter}
                onChange={(value) => setFilter('q', value)}
                startIcon={<IconSearch className="size-4" />}
                width="100%"
              />
            </div>

            <div className="min-w-0 flex-1">
              <Selector
                label={t('common.status')}
                isLabelHidden
                placeholder={t('services.allStatuses')}
                options={[
                  {
                    value: '',
                    label: t('services.allStatuses'),
                    icon: <StatusDot variant="neutral" label={t('services.allStatuses')} />,
                  },
                  {
                    value: 'active',
                    label: t('services.active'),
                    icon: <StatusDot variant="success" label={t('services.active')} />,
                  },
                  {
                    value: 'inactive',
                    label: t('services.inactive'),
                    icon: <StatusDot variant="neutral" label={t('services.inactive')} />,
                  },
                ]}
                value={statusFilter}
                onChange={(value) => setFilter('status', value ?? '')}
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

            <div className="min-w-0 flex-1">
              <MultiSelector
                label={t('services.colCategory')}
                isLabelHidden
                placeholder={t('services.allCategories')}
                options={categoryOptions.map((category) => ({ value: category, label: category }))}
                value={categoryFilter}
                onChange={setCategoryFilter}
                hasSearch
                searchPlaceholder={t('services.searchCategories')}
                hasSelectAll
                selectAllLabel={t('services.allCategories')}
                hasClear
                triggerDisplay="count"
                width="100%"
              />
            </div>

            <div className="flex items-center gap-3 lg:ml-auto">
              {hasFilters && (
                <Button
                  label={t('services.resetFilter')}
                  variant="ghost"
                  size="sm"
                  onClick={resetFilters}
                />
              )}
            </div>
          </div>
        )}

      {deleteError && (
        <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-400">
          {deleteError}
        </p>
      )}

      {showError && (
        <Card className="flex flex-col items-center gap-4 p-10 text-center">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-red-50 text-red-500 dark:bg-red-950/50 dark:text-red-400">
            <IconAlertTriangle className="size-6" />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t('errors.servicesLoadTitle')}</h3>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              {error instanceof ApiError ? t('errors.apiStatus', { status: error.status }) : t('errors.apiConnection')}
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
              <Skeleton width="24%" height={14} />
              <Skeleton width="12%" height={12} />
              <Skeleton width="14%" height={12} />
              <Skeleton width="18%" height={12} />
              <Skeleton width="16%" height={12} />
              <Skeleton className="ml-auto" width={72} height={22} />
            </div>
          ))}
        </Card>
      )}

      {!isPending && !isError && data && (
        <div className="flex flex-1 flex-col">
          {servicesList.length === 0 ? (
            <EmptyState
              icon={IconServices}
              title={t('services.emptyTitle')}
              description={t('services.emptyDesc')}
              variant="transparent"
              className="flex-1 min-h-[500px]"
              actions={
                <div className="flex flex-col sm:flex-row items-center gap-3">
                  <Button
                    label={isPopulating ? t('services.populatingTemplate') : t('services.populateTemplate')}
                    variant="secondary"
                    icon={<IconSparkles className="size-4 text-amber-500" />}
                    isLoading={isPopulating}
                    isDisabled={isPopulating}
                    onClick={() => void handlePopulateFromIndustry()}
                  />
                  <Button
                    label={t('services.createFirst')}
                    variant="primary"
                    icon={<IconPlus className="size-4" />}
                    isDisabled={isPopulating}
                    onClick={openAdd}
                  />
                </div>
              }
            />
          ) : filteredList.length === 0 ? (
            <EmptyState
              icon={IconServices}
              title={t('services.emptyFilteredTitle')}
              description={t('services.emptyFilteredDesc')}
              variant="transparent"
              className="flex-1 min-h-[500px]"
              action={{
                label: t('services.resetFilter'),
                onClick: resetFilters,
                variant: 'secondary',
                icon: <IconRefreshCw className="size-4" />,
              }}
            />
          ) : (
            <>
              {/* Floating bottom center row selection toolbar */}
              {selectedKeys.size > 0 && (
                <div
                  role="region"
                  aria-label={t('services.selectedCount', { count: selectedKeys.size })}
                  className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 flex items-center gap-3 rounded-2xl border border-zinc-200/90 bg-white/95 px-4 py-2.5 shadow-2xl backdrop-blur-md transition-all animate-in fade-in slide-in-from-bottom-5 duration-200 dark:border-zinc-700/90 dark:bg-zinc-900/95 max-w-[calc(100vw-2rem)]"
                >
                  {bulkError && (
                    <div
                      role="alert"
                      className="absolute -top-10 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-lg border border-red-200 bg-red-50 px-3 py-1 text-xs font-medium text-red-700 shadow-md dark:border-red-900/60 dark:bg-red-950/90 dark:text-red-400"
                    >
                      {bulkError}
                    </div>
                  )}

                  <div className="flex items-center gap-2 border-r border-zinc-200 pr-3 dark:border-zinc-700">
                    <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 whitespace-nowrap">
                      {t('services.selectedCount', { count: selectedKeys.size })}
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      label={t('services.activate')}
                      variant="secondary"
                      size="sm"
                      isDisabled={bulkStatusMutation.isPending}
                      isLoading={bulkStatusMutation.isPending}
                      onClick={() =>
                        bulkStatusMutation.mutate({ ids: [...selectedKeys], isActive: true })
                      }
                    />
                    <Button
                      label={t('services.deactivate')}
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
                      isDisabled={bulkStatusMutation.isPending || bulkDeleteMutation.isPending}
                      onClick={() => setBulkDeleteIds([...selectedKeys])}
                    />
                    <button
                      type="button"
                      aria-label={t('services.clearSelection')}
                      title={t('services.clearSelection')}
                      disabled={bulkStatusMutation.isPending || bulkDeleteMutation.isPending}
                      onClick={resetSelection}
                      className="ml-1 inline-flex size-7 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 disabled:pointer-events-none disabled:opacity-50"
                    >
                      <IconX className="size-4" />
                    </button>
                  </div>
                </div>
              )}

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
                  columns={serviceColumns}
                  idKey="id"
                  density="balanced"
                  dividers="none"
                  hasHover
                  textOverflow="truncate"
                  plugins={{ selection: selectionPlugin, pagination: paginationPlugin }}
                />
              </Card>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 px-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
                    {t('services.rowsPerPage')}
                  </span>
                  <Selector
                    label={t('services.rowsPerPage')}
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
                    i18nKey="services.showingRows"
                    values={{ shown: visibleRows.length, total: filteredList.length }}
                    components={{ strong: <strong className="font-bold text-black dark:text-zinc-100" /> }}
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
        </div>
      )}
      </div>

      {/* Dialog tambah layanan */}
      <Dialog isOpen={isAddOpen} onOpenChange={(open) => { if (!open) closeAdd(); }} purpose="info" width={560}>
        <Layout
          header={
            <DialogHeader
              title={t('services.addTitle')}
              subtitle={t('services.addSubtitle')}
              startContent={<IconServices className="size-5 shrink-0 text-amber-600" />}
              onOpenChange={(open) => { if (!open) closeAdd(); }}
              hasDivider
            />
          }
          content={
            <LayoutContent>
              <form id="add-service-form" onSubmit={submitAdd} className="space-y-5">
                <TextInput
                  label={t('common.name')}
                  placeholder={t('services.namePlaceholder')}
                  value={addName}
                  onChange={setAddName}
                  isRequired
                />
                <TextArea
                  label={t('services.descriptionLabel')}
                  placeholder={t('services.descriptionPlaceholder')}
                  value={addDescription}
                  onChange={setAddDescription}
                  isOptional
                  rows={2}
                />
                <div className="grid grid-cols-2 gap-4">
                  <NumberInput
                    label={t('services.duration')}
                    description={t('services.durationDesc')}
                    value={addDuration}
                    onChange={(value) => setAddDuration(value ?? 60)}
                    min={5}
                    max={720}
                    width="100%"
                  />
                  <InputGroup
                    label={t('services.price')}
                    description={t('services.priceDesc')}
                    isOptional
                    className="w-full"
                  >
                    <Selector
                      label={t('services.currency')}
                      isLabelHidden
                      options={SERVICE_CURRENCIES.map((code) => ({ value: code, label: code }))}
                      value={addCurrency}
                      onChange={(value) => setAddCurrency(value ?? 'IDR')}
                      style={{ flex: '0 0 auto', width: 'fit-content' }}
                    />
                    <NumberInput
                      label={t('services.price')}
                      isLabelHidden
                      value={addPrice}
                      onChange={(value) => setAddPrice(value ?? null)}
                      min={0}
                      step={0.01}
                      hasClear
                      width="100%"
                    />
                  </InputGroup>
                </div>
                <Tokenizer
                  label={t('services.category')}
                  placeholder={t('services.categoryPlaceholder')}
                  description={t('services.categoryDesc')}
                  searchSource={categorySource}
                  value={addCategories.map((category) => ({ id: category, label: category }))}
                  onChange={(items) => setAddCategories(items.map((item) => item.label))}
                  isOptional
                  hasCreate
                  hasEntriesOnFocus
                  width="100%"
                />
                <MultiSelector
                  label={t('services.staff')}
                  description={t('services.staffDesc')}
                  placeholder={t('services.staffPlaceholder')}
                  options={activeStaff.map((staff) => ({ value: staff.id, label: staff.name }))}
                  value={addStaffIds}
                  onChange={setAddStaffIds}
                  hasSearch
                  searchPlaceholder={t('services.searchStaff')}
                  triggerDisplay="badges"
                  maxBadges={3}
                  hasClear
                  width="100%"
                />
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
                  form="add-service-form"
                  isLoading={addMutation.isPending}
                />
              </div>
            </LayoutFooter>
          }
        />
      </Dialog>

      {/* Dialog edit layanan */}
      <Dialog isOpen={editing !== null} onOpenChange={(open) => { if (!open) setEditing(null); }} purpose="info" width={560}>
        <Layout
          header={
            <DialogHeader
              title={t('services.editTitle')}
              subtitle={editing?.name}
              startContent={<IconServices className="size-5 shrink-0 text-amber-600" />}
              onOpenChange={(open) => { if (!open) setEditing(null); }}
              hasDivider
            />
          }
          content={
            <LayoutContent>
              <form id="edit-service-form" onSubmit={submitEdit} className="space-y-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <TextInput
                      label={t('common.name')}
                      placeholder={t('services.namePlaceholder')}
                      value={editName}
                      onChange={setEditName}
                      isRequired
                      width="100%"
                    />
                  </div>
                  <div className="shrink-0 pt-7">
                    <Switch
                      label={t('services.active')}
                      value={editIsActive}
                      onChange={setEditIsActive}
                    />
                  </div>
                </div>
                <TextArea
                  label={t('services.descriptionLabel')}
                  placeholder={t('services.descriptionPlaceholder')}
                  value={editDescription}
                  onChange={setEditDescription}
                  isOptional
                  rows={2}
                />
                <div className="grid grid-cols-2 gap-4">
                  <NumberInput
                    label={t('services.duration')}
                    description={t('services.durationDesc')}
                    value={editDuration}
                    onChange={(value) => setEditDuration(value ?? 60)}
                    min={5}
                    max={720}
                    width="100%"
                  />
                  <InputGroup
                    label={t('services.price')}
                    description={t('services.priceDesc')}
                    isOptional
                    className="w-full"
                  >
                    <Selector
                      label={t('services.currency')}
                      isLabelHidden
                      options={SERVICE_CURRENCIES.map((code) => ({ value: code, label: code }))}
                      value={editCurrency}
                      onChange={(value) => setEditCurrency(value ?? 'USD')}
                      style={{ flex: '0 0 auto', width: 'fit-content' }}
                    />
                    <NumberInput
                      label={t('services.price')}
                      isLabelHidden
                      value={editPrice}
                      onChange={(value) => setEditPrice(value ?? null)}
                      min={0}
                      step={0.01}
                      hasClear
                      width="100%"
                    />
                  </InputGroup>
                </div>
                <Tokenizer
                  label={t('services.category')}
                  placeholder={t('services.categoryPlaceholder')}
                  description={t('services.categoryDesc')}
                  searchSource={categorySource}
                  value={editCategories.map((category) => ({ id: category, label: category }))}
                  onChange={(items) => setEditCategories(items.map((item) => item.label))}
                  isOptional
                  hasCreate
                  hasEntriesOnFocus
                  width="100%"
                />
                <MultiSelector
                  label={t('services.staff')}
                  description={t('services.staffDesc')}
                  placeholder={t('services.staffPlaceholder')}
                  options={activeStaff.map((staff) => ({ value: staff.id, label: staff.name }))}
                  value={editStaffIds}
                  onChange={setEditStaffIds}
                  hasSearch
                  searchPlaceholder={t('services.searchStaff')}
                  triggerDisplay="badges"
                  maxBadges={3}
                  hasClear
                  width="100%"
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
                  form="edit-service-form"
                  isLoading={editMutation.isPending}
                />
              </div>
            </LayoutFooter>
          }
        />
      </Dialog>

      {/* Dialog hapus layanan */}
      <ConfirmDialog
        isOpen={deleteTarget !== null || bulkDeleteIds !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
            setBulkDeleteIds(null);
          }
        }}
        title={
          bulkDeleteIds
            ? t('services.bulkDeleteTitle', { count: bulkDeleteIds.length })
            : t('services.deleteTitle')
        }
        description={
          bulkDeleteIds
            ? t('services.bulkDeleteDesc', { count: bulkDeleteIds.length })
            : t('services.deleteDesc', { name: deleteTarget?.name ?? '' })
        }
        actionLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        isActionLoading={deleteMutation.isPending || bulkDeleteMutation.isPending}
        onAction={() => {
          if (bulkDeleteIds) {
            bulkDeleteMutation.mutate(bulkDeleteIds);
          } else if (deleteTarget) {
            deleteMutation.mutate(deleteTarget.id);
          }
        }}
      />

      {/* Dialog detail layanan (menggunakan Astryx Dialog, pola Customers) */}
      <ServiceDetailDialog
        isOpen={viewService !== null || Boolean(serviceIdParam)}
        serviceId={serviceIdParam || viewService?.id}
        initialService={viewService}
        staffData={staffData?.staff}
        onEdit={(service) => openEdit(service)}
        onOpenChange={(open) => {
          if (!open) {
            setViewService(null);
            if (serviceIdParam) {
              setSearchParams(
                (prev) => {
                  const n = new URLSearchParams(prev);
                  n.delete('serviceId');
                  return n;
                },
                { replace: true },
              );
            }
          }
        }}
      />
    </div>
  );
}
