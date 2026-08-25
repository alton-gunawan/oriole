import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { Trans, useTranslation } from 'react-i18next';
import {
  Button,
  Dialog,
  DialogHeader,
  DropdownMenu,
  DropdownMenuItem,
  Layout,
  LayoutContent,
  LayoutFooter,
  Pagination,
  Selector,
  Skeleton,
  Table,
  TextArea,
  TextInput,
  paginateData,
  pixel,
  proportional,
  useTablePagination,
  useTableSelection,
  useTableSelectionState,
  type TableColumn,
} from '@astryxdesign/core';

import { ApiError, apiFetch } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import {
  buildCreateContactPayload,
  type ContactRecord,
  type ContactsListResponse,
  type CreateContactPayload,
  type UpdateContactPayload,
} from '../../lib/contacts';
import { useWorkspaceStore } from '../../stores/workspace';
import { formatDateTime } from '../../i18n/format';
import {
  IconAlertTriangle,
  IconArrowUpRight,
  IconDotsHorizontal,
  IconEdit,
  IconPlus,
  IconRefreshCw,
  IconSearch,
  IconTrash,
  IconUsers,
  IconX,
} from '../shell/icons';
import { PhoneInput } from '../components/PhoneInput';
import { CustomerDetailDialog } from '../components/CustomerDetailDialog';
import { Card, ConfirmDialog, EmptyState, PageHeader, ReloadMenuButton } from '../shell/ui';

/** Baris tabel: ContactRecord + index signature (Table butuh Record<string, unknown>). */
type ContactTableRow = ContactRecord & Record<string, unknown>;

/** Dropdown aksi per baris kontak — tombol ⋯ membuka menu (buka detail, edit, hapus). */
function ContactActionsMenu({
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

export function ContactsPage() {
  const { t } = useTranslation();
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const contactIdParam = searchParams.get('contactId');
  const [viewContact, setViewContact] = useState<ContactRecord | null>(null);

  // ── Dialog edit kontak (pola Services & Staff) ─────────────
  const [editing, setEditing] = useState<ContactRecord | null>(null);
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editError, setEditError] = useState<string | null>(null);

  const openEdit = (contact: ContactRecord) => {
    setEditing(contact);
    setEditName(contact.name);
    setEditPhone(contact.phone);
    setEditEmail(contact.email ?? '');
    setEditNotes(contact.notes ?? '');
    setEditError(null);
  };

  const editMutation = useMutation({
    mutationFn: (payload: UpdateContactPayload) =>
      apiFetch<{ contact: ContactRecord }>(`/contacts/${editing?.id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      setEditing(null);
      setEditError(null);
      queryClient.invalidateQueries({ queryKey: ['contacts', activeWorkspaceId] });
      queryClient.invalidateQueries({ queryKey: ['contact', activeWorkspaceId] });
      queryClient.invalidateQueries({ queryKey: ['bookings', activeWorkspaceId] });
    },
    onError: (err) => setEditError(errorMessage(err, t, 'errors.saveContact')),
  });

  const submitEdit = (event: FormEvent) => {
    event.preventDefault();
    if (!editing || !editName.trim() || !editPhone.trim()) return;
    setEditError(null);
    editMutation.mutate({
      name: editName.trim(),
      phone: editPhone.trim(),
      email: editEmail.trim() || null,
      notes: editNotes.trim() || null,
    });
  };

  // ── Filter per-kolom (pola Bookings): Nama / Telepon / Email, debounce 300ms ──
  const [filters, setFilters] = useState({ name: '', phone: '', email: '' });
  const [debouncedFilters, setDebouncedFilters] = useState(filters);
  useEffect(() => {
    const timer = setTimeout(
      () =>
        setDebouncedFilters({
          name: filters.name.trim(),
          phone: filters.phone.trim(),
          email: filters.email.trim(),
        }),
      300,
    );
    return () => clearTimeout(timer);
  }, [filters]);

  const setFilter = (key: 'name' | 'phone' | 'email', value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };
  const resetFilters = () => setFilters({ name: '', phone: '', email: '' });
  const hasFilters = Boolean(
    debouncedFilters.name || debouncedFilters.phone || debouncedFilters.email,
  );

  const {
    data,
    isPending,
    isError,
    error,
    refetch,
    isFetching,
    isPlaceholderData,
  } = useQuery({
    queryKey: [
      'contacts',
      activeWorkspaceId,
      debouncedFilters.name,
      debouncedFilters.phone,
      debouncedFilters.email,
    ],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set('limit', '200');
      if (debouncedFilters.name) params.set('name', debouncedFilters.name);
      if (debouncedFilters.phone) params.set('phone', debouncedFilters.phone);
      if (debouncedFilters.email) params.set('email', debouncedFilters.email);
      const qs = params.toString();
      return apiFetch<ContactsListResponse>(`/contacts${qs ? `?${qs}` : ''}`);
    },
    placeholderData: keepPreviousData,
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 1,
  });

  const contacts = data?.contacts ?? [];
  const isAuthExpiry = error instanceof ApiError && error.status === 401;
  const showError = isError && !isAuthExpiry;
  // Redup saat query filter baru sedang dimuat (placeholder = data lama).
  const isSearchLoading = isFetching && isPlaceholderData;

  // ── Kolom tabel kontak — data-driven, pola tabel Bookings ──
  const contactColumns = useMemo<TableColumn<ContactTableRow>[]>(
    () => [
      // Kolom Contact = identitas kontak (avatar + nama) sekaligus membuka modal detail.
      {
        key: 'contact',
        header: t('common.name'),
        width: proportional(3),
        renderCell: (contact) => (
          <button
            type="button"
            onClick={() => setViewContact(contact)}
            title={t('contacts.openDetail')}
            className="group flex min-w-0 items-center gap-3 text-left cursor-pointer"
          >
            <div className="size-9 shrink-0 overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-700/60 bg-zinc-100 dark:bg-zinc-800">
              <img
                src={`https://api.dicebear.com/10.x/critters/svg?seed=${encodeURIComponent(contact.name || contact.id)}`}
                alt={contact.name}
                className="size-full object-cover"
                loading="lazy"
              />
            </div>
            <span className="min-w-0">
              <span className="block truncate text-base font-semibold text-zinc-900 dark:text-zinc-100 transition group-hover:text-amber-600 dark:group-hover:text-amber-400">
                {contact.name}
              </span>
              {contact.email && (
                <span className="block truncate text-xs text-zinc-500 dark:text-zinc-400">
                  {contact.email}
                </span>
              )}
            </span>
          </button>
        ),
      },
      {
        key: 'phone',
        header: t('common.phone'),
        width: proportional(2),
        renderCell: (contact) => (
          <span className="block truncate text-base text-zinc-600 dark:text-zinc-400">
            {contact.phone || <span className="text-zinc-300 dark:text-zinc-600">—</span>}
          </span>
        ),
      },
      {
        key: 'notes',
        header: t('common.notes'),
        width: proportional(2),
        renderCell: (contact) => (
          <span className="block truncate text-base text-zinc-600 dark:text-zinc-400">
            {contact.notes ?? <span className="text-zinc-300 dark:text-zinc-600">—</span>}
          </span>
        ),
      },
      {
        key: 'created',
        header: t('contacts.colCreated'),
        width: pixel(150),
        renderCell: (contact) => (
          <span className="block truncate text-base text-zinc-600 dark:text-zinc-400">
            {formatDateTime(contact.createdAt)}
          </span>
        ),
      },
      {
        key: 'actions',
        header: t('contacts.colActions'),
        width: pixel(72),
        align: 'end',
        renderCell: (contact) => (
          <span className="flex items-center justify-end">
            <ContactActionsMenu
              onView={() => setViewContact(contact)}
              onEdit={() => openEdit(contact)}
              onDelete={() => setDeleteTarget(contact)}
            />
          </span>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t],
  );

  // ── Dialog tambah kontak — mengikuti pola dialog tambah staf ──
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [addName, setAddName] = useState('');
  const [addPhone, setAddPhone] = useState('');
  const [addEmail, setAddEmail] = useState('');
  const [addNotes, setAddNotes] = useState('');
  const [addError, setAddError] = useState<string | null>(null);

  const closeAdd = () => {
    if (addMutation.isPending) return;
    setIsAddOpen(false);
    setAddError(null);
  };

  const openAdd = () => {
    setAddName('');
    setAddPhone('');
    setAddEmail('');
    setAddNotes('');
    setAddError(null);
    setIsAddOpen(true);
  };

  const addMutation = useMutation({
    mutationFn: (payload: CreateContactPayload) =>
      apiFetch<{ contact: ContactRecord }>('/contacts', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      setIsAddOpen(false);
      setAddError(null);
      queryClient.invalidateQueries({ queryKey: ['contacts', activeWorkspaceId] });
    },
    onError: (err) => setAddError(errorMessage(err, t, 'errors.saveContact')),
  });

  const submitAdd = (event: FormEvent) => {
    event.preventDefault();
    const payload = buildCreateContactPayload({
      name: addName,
      phone: addPhone,
      email: addEmail,
      notes: addNotes,
    });
    if (!payload) {
      setAddError(t('errors.contactRequired'));
      return;
    }
    setAddError(null);
    addMutation.mutate(payload);
  };

  // ── Hapus kontak (konfirmasi AlertDialog) ───────────────────
  const [deleteTarget, setDeleteTarget] = useState<ContactRecord | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/contacts/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setDeleteTarget(null);
      setDeleteError(null);
      queryClient.invalidateQueries({ queryKey: ['contacts', activeWorkspaceId] });
      queryClient.invalidateQueries({ queryKey: ['bookings', activeWorkspaceId] });
    },
    onError: (err) => {
      setDeleteTarget(null);
      setDeleteError(errorMessage(err, t, 'errors.deleteContact'));
    },
  });

  // ── Tampilan tabel: pagination client-side (mirror ServicesPage / StaffPage) ──
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const visibleRows = useMemo<ContactTableRow[]>(
    () => paginateData(contacts, page, pageSize) as ContactTableRow[],
    [contacts, page, pageSize],
  );

  // ── Seleksi baris (useTableSelection) — untuk aksi bulk (mis. hapus masal) ──
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const resetSelection = () => setSelectedKeys(new Set());

  // Reset page & seleksi saat filter berubah
  useEffect(() => {
    setPage(1);
    resetSelection();
  }, [debouncedFilters]);

  // Jaga `page` tidak out-of-bounds jika data berkurang
  const lastPage = contacts.length ? Math.max(1, Math.ceil(contacts.length / pageSize)) : 1;
  useEffect(() => {
    if (page > lastPage) {
      setPage(lastPage);
    }
  }, [contacts.length, page, lastPage, pageSize]);

  const { selectionConfig } = useTableSelectionState({
    data: visibleRows,
    idKey: 'id',
    selectedKeys,
    setSelectedKeys,
  });

  // getRowLabel ada di config plugin (bukan state) — label checkbox per baris.
  const selectionPlugin = useTableSelection({
    ...selectionConfig,
    getRowLabel: (contact) => contact.name,
  });

  const paginationPlugin = useTablePagination<ContactTableRow>({
    page,
    onPageChange: setPage,
    totalItems: contacts.length,
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

  // ── Aksi bulk (seleksi baris) — DELETE per id (mirror BookingsPage / StaffPage) ──
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkDeleteIds, setBulkDeleteIds] = useState<string[] | null>(null);

  const bulkDeleteMutation = useMutation({
    mutationFn: (ids: string[]) =>
      Promise.all(ids.map((id) => apiFetch(`/contacts/${id}`, { method: 'DELETE' }))),
    onMutate: () => setBulkError(null),
    onSuccess: () => {
      setBulkDeleteIds(null);
      resetSelection();
      queryClient.invalidateQueries({ queryKey: ['contacts', activeWorkspaceId] });
      queryClient.invalidateQueries({ queryKey: ['bookings', activeWorkspaceId] });
    },
    onError: (err) => {
      setBulkDeleteIds(null);
      setBulkError(errorMessage(err, t, 'errors.deleteContact'));
    },
  });

  return (
    <div className="flex min-h-[calc(100vh-10rem)] flex-1 flex-col space-y-6">
      <PageHeader
        title={t('contacts.title')}
        description={t('contacts.description')}
        icon={IconUsers}
      >
        {/* Menu reload — sama seperti Bookings/Calls. */}
        <ReloadMenuButton isFetching={isFetching} onReload={() => void refetch()} />
        <Button
          label={t('contacts.add')}
          variant="primary"
          icon={<IconPlus className="size-4" />}
          onClick={openAdd}
        />
      </PageHeader>

      <div className="flex flex-1 flex-col space-y-4">
        {/* Filter bar — mengikuti pola Bookings: tiap filter di kolomnya sendiri (flex-1). */}
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="min-w-0 flex-1">
            <TextInput
              label={t('common.name')}
              isLabelHidden
              placeholder={t('contacts.filterNamePlaceholder')}
              value={filters.name}
              onChange={(value) => setFilter('name', value)}
              startIcon={<IconSearch className="size-4" />}
              width="100%"
            />
          </div>
          <div className="min-w-0 flex-1">
            <TextInput
              label={t('contacts.phoneLabel')}
              isLabelHidden
              placeholder={t('contacts.filterPhonePlaceholder')}
              value={filters.phone}
              onChange={(value) => setFilter('phone', value)}
              startIcon={<IconSearch className="size-4" />}
              width="100%"
            />
          </div>
          <div className="min-w-0 flex-1">
            <TextInput
              label={t('common.email')}
              isLabelHidden
              type="email"
              placeholder={t('contacts.filterEmailPlaceholder')}
              value={filters.email}
              onChange={(value) => setFilter('email', value)}
              startIcon={<IconSearch className="size-4" />}
              width="100%"
            />
          </div>
          <div className="flex items-center gap-3 lg:ml-auto">
            {hasFilters && (
              <Button
                label={t('contacts.resetFilter')}
                variant="ghost"
                size="sm"
                onClick={resetFilters}
              />
            )}
          </div>
        </div>

      {deleteError && (
        <p
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-400"
        >
          {deleteError}
        </p>
      )}

      {showError && (
        <Card className="flex flex-col items-center gap-4 p-10 text-center">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-red-50 text-red-500 dark:bg-red-950/50 dark:text-red-400">
            <IconAlertTriangle className="size-6" />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t('errors.contactsLoadTitle')}</h3>
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

      {!isPending && !isError && data && (
        <div className="flex flex-1 flex-col">
          {contacts.length === 0 ? (
            <EmptyState
              icon={IconUsers}
              title={hasFilters ? t('contacts.emptySearchTitle') : t('contacts.emptyTitle')}
              description={
                hasFilters ? t('contacts.emptySearchDesc') : t('contacts.emptyDesc')
              }
              variant="transparent"
              className="flex-1 min-h-[500px]"
              action={
                hasFilters
                  ? {
                      label: t('contacts.resetFilter'),
                      onClick: resetFilters,
                      variant: 'secondary',
                      icon: <IconRefreshCw className="size-4" />,
                    }
                  : { label: t('contacts.createFirst'), onClick: openAdd }
              }
            />
          ) : (
            <>
              {/* Floating bottom center row selection toolbar (mirror BookingsPage) */}
              {selectedKeys.size > 0 && (
                <div
                  role="region"
                  aria-label={t('contacts.selectedCount', { count: selectedKeys.size })}
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
                      {t('contacts.selectedCount', { count: selectedKeys.size })}
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      label={t('common.delete')}
                      variant="destructive"
                      size="sm"
                      isDisabled={bulkDeleteMutation.isPending}
                      isLoading={bulkDeleteMutation.isPending}
                      onClick={() => setBulkDeleteIds([...selectedKeys])}
                    />
                    <button
                      type="button"
                      aria-label={t('contacts.clearSelection')}
                      title={t('contacts.clearSelection')}
                      disabled={bulkDeleteMutation.isPending}
                      onClick={resetSelection}
                      className="ml-1 inline-flex size-7 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 disabled:pointer-events-none disabled:opacity-50"
                    >
                      <IconX className="size-4" />
                    </button>
                  </div>
                </div>
              )}

              {/* Transparan: tabel tanpa border/background pembungkus; radius 0.
                  Border horizontal atas & bawah membingkai tabel. Footer (jumlah
                  & Load more) dirender manual DI LUAR blok berbordernya — pola
                  tabel Bookings. */}
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
                  inert={isSearchLoading}
                  className={`transition-opacity duration-200 ${
                    isSearchLoading ? 'pointer-events-none opacity-40' : ''
                  }`}
                >
                  <Table
                    data={visibleRows}
                    columns={contactColumns}
                    idKey="id"
                    density="balanced"
                    dividers="none"
                    hasHover
                    textOverflow="truncate"
                    plugins={{
                      selection: selectionPlugin,
                      pagination: paginationPlugin,
                    }}
                  />
                </div>
              </Card>

              {/* Footer: rows per page + jumlah terlihat + Pagination numerik (mirror ServicesPage & StaffPage) */}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 px-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
                    {t('contacts.rowsPerPage')}
                  </span>
                  <Selector
                    label={t('contacts.rowsPerPage')}
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
                    i18nKey="contacts.showingRows"
                    values={{ shown: visibleRows.length, total: contacts.length }}
                    components={{ strong: <strong className="font-bold text-black dark:text-zinc-100" /> }}
                  />
                </p>
                <Pagination
                  page={page}
                  onChange={setPage}
                  totalItems={contacts.length}
                  pageSize={pageSize}
                />
              </div>
            </>
          )}
        </div>
      )}
      </div>

      {/* Dialog tambah kontak — struktur, spacing, footer, dan error placement
          mengikuti dialog tambah staf agar semua resource forms konsisten. */}
      <Dialog
        isOpen={isAddOpen}
        onOpenChange={(open) => {
          if (!open) closeAdd();
        }}
        purpose="info"
        width={520}
      >
        <Layout
          header={
            <DialogHeader
              title={t('contacts.addTitle')}
              subtitle={t('contacts.addSubtitle')}
              startContent={<IconUsers className="size-5 shrink-0 text-amber-600" />}
              onOpenChange={(open) => {
                if (!open) closeAdd();
              }}
              hasDivider
            />
          }
          content={
            <LayoutContent>
              <form id="add-contact-form" onSubmit={submitAdd} className="space-y-5">
                <TextInput
                  label={t('common.name')}
                  placeholder={t('contacts.namePlaceholder')}
                  value={addName}
                  onChange={setAddName}
                  isRequired
                />
                <PhoneInput
                  label={t('common.phone')}
                  placeholder={t('contacts.phonePlaceholder')}
                  value={addPhone}
                  onChange={setAddPhone}
                  isRequired
                />
                <TextInput
                  label={t('common.email')}
                  type="email"
                  placeholder={t('contacts.emailPlaceholder')}
                  value={addEmail}
                  onChange={setAddEmail}
                  isOptional
                />
                <TextArea
                  label={t('common.notes')}
                  placeholder={t('contacts.notesPlaceholder')}
                  value={addNotes}
                  onChange={setAddNotes}
                  isOptional
                  rows={3}
                  width="100%"
                />
              </form>
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              {addError && (
                <p role="alert" className="pb-2 text-right text-sm text-red-600">
                  {addError}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button
                  label={t('common.cancel')}
                  variant="ghost"
                  onClick={closeAdd}
                  isDisabled={addMutation.isPending}
                />
                <Button
                  label={t('common.saveContact')}
                  variant="primary"
                  type="submit"
                  form="add-contact-form"
                  isLoading={addMutation.isPending}
                />
              </div>
            </LayoutFooter>
          }
        />
      </Dialog>

      {/* Dialog edit kontak (menggunakan Astryx Dialog, pola Services & Staff) */}
      <Dialog
        isOpen={editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            if (editMutation.isPending) return;
            setEditing(null);
            setEditError(null);
          }
        }}
        purpose="info"
        width={480}
      >
        <Layout
          header={
            <DialogHeader
              title={t('contacts.editTitle')}
              subtitle={editing?.name || t('contacts.editSubtitle')}
              startContent={<IconUsers className="size-5 shrink-0 text-amber-600" />}
              onOpenChange={(open) => {
                if (!open && !editMutation.isPending) {
                  setEditing(null);
                  setEditError(null);
                }
              }}
              hasDivider
            />
          }
          content={
            <LayoutContent>
              <form id="edit-contact-form" onSubmit={submitEdit} className="space-y-4 py-1">
                <TextInput
                  label={t('common.name')}
                  placeholder={t('contacts.namePlaceholder')}
                  value={editName}
                  onChange={setEditName}
                  isRequired
                  width="100%"
                />
                <PhoneInput
                  label={t('common.phone')}
                  placeholder={t('contacts.phonePlaceholder')}
                  value={editPhone}
                  onChange={setEditPhone}
                  isRequired
                />
                <TextInput
                  label={t('common.email')}
                  placeholder={t('contacts.emailPlaceholder')}
                  value={editEmail}
                  onChange={setEditEmail}
                  type="email"
                  isOptional
                  width="100%"
                />
                <TextArea
                  label={t('common.notes')}
                  placeholder={t('contacts.notesPlaceholder')}
                  value={editNotes}
                  onChange={setEditNotes}
                  isOptional
                  rows={3}
                  width="100%"
                />
              </form>
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              {editError && (
                <p role="alert" className="pb-2 text-right text-sm text-red-600">
                  {editError}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button
                  label={t('common.cancel')}
                  variant="ghost"
                  onClick={() => setEditing(null)}
                  isDisabled={editMutation.isPending}
                />
                <Button
                  label={t('common.save')}
                  variant="primary"
                  type="submit"
                  form="edit-contact-form"
                  isLoading={editMutation.isPending}
                />
              </div>
            </LayoutFooter>
          }
        />
      </Dialog>

      {/* Konfirmasi hapus kontak — menutup saat klik di luar dialog. */}
      <ConfirmDialog
        isOpen={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t('contacts.deleteTitle')}
        description={t('contacts.deleteDesc', { name: deleteTarget?.name ?? '' })}
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
        onOpenChange={(open) => {
          if (!open) setBulkDeleteIds(null);
        }}
        title={t('contacts.bulkDeleteTitle', { count: bulkDeleteIds?.length ?? 0 })}
        description={t('contacts.bulkDeleteDesc', { count: bulkDeleteIds?.length ?? 0 })}
        cancelLabel={t('common.cancel')}
        actionLabel={t('common.delete')}
        actionVariant="destructive"
        isActionLoading={bulkDeleteMutation.isPending}
        onAction={() => {
          if (bulkDeleteIds) bulkDeleteMutation.mutate(bulkDeleteIds);
        }}
        width={420}
      />

      {/* Dialog detail customer (menggunakan Astryx Dialog) */}
      <CustomerDetailDialog
        isOpen={viewContact !== null || Boolean(contactIdParam)}
        contactId={contactIdParam || viewContact?.id}
        initialContact={viewContact}
        onEdit={(contact) => openEdit(contact)}
        onOpenChange={(open) => {
          if (!open) {
            setViewContact(null);
            if (contactIdParam) {
              setSearchParams(
                (prev) => {
                  const n = new URLSearchParams(prev);
                  n.delete('contactId');
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
