import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { keepPreviousData, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
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
  Skeleton,
  Table,
  TextArea,
  TextInput,
  pixel,
  proportional,
  type TableColumn,
} from '@astryxdesign/core';

import { ApiError, apiFetch } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import {
  buildCreateContactPayload,
  type ContactRecord,
  type ContactsListResponse,
  type CreateContactPayload,
} from '../../lib/contacts';
import { useWorkspaceStore } from '../../stores/workspace';
import { formatDateTime } from '../../i18n/format';
import {
  IconAlertTriangle,
  IconArrowUpRight,
  IconDotsHorizontal,
  IconPlus,
  IconSearch,
  IconTrash,
  IconUsers,
} from '../shell/icons';
import { PhoneInput } from '../components/PhoneInput';
import { Card, ConfirmDialog, EmptyState, PageHeader, ReloadMenuButton } from '../shell/ui';

/** Baris tabel: ContactRecord + index signature (Table butuh Record<string, unknown>). */
type ContactTableRow = ContactRecord & Record<string, unknown>;

/** Dropdown aksi per baris kontak — tombol ⋯ membuka menu (buka detail, hapus). */
function ContactActionsMenu({
  contact,
  onDelete,
}: {
  contact: ContactRecord;
  onDelete: () => void;
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
        style: { padding: 0 },
      }}
    >
      <DropdownMenuItem
        icon={<IconArrowUpRight className="size-4" />}
        label={t('contacts.openDetail')}
        onClick={() => navigate(`/app/contacts/${contact.id}`)}
      />
      <DropdownMenuItem
        icon={<IconTrash className="size-4 text-red-500" />}
        label={
          <span className="font-medium text-red-600">
            {t('contacts.deleteFor', { name: contact.name })}
          </span>
        }
        onClick={onDelete}
      />
    </DropdownMenu>
  );
}

export function ContactsPage() {
  const { t } = useTranslation();
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const queryClient = useQueryClient();

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
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: [
      'contacts',
      activeWorkspaceId,
      debouncedFilters.name,
      debouncedFilters.phone,
      debouncedFilters.email,
    ],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      if (debouncedFilters.name) params.set('name', debouncedFilters.name);
      if (debouncedFilters.phone) params.set('phone', debouncedFilters.phone);
      if (debouncedFilters.email) params.set('email', debouncedFilters.email);
      if (pageParam) params.set('cursor', pageParam);
      const qs = params.toString();
      return apiFetch<ContactsListResponse>(`/contacts${qs ? `?${qs}` : ''}`);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    placeholderData: keepPreviousData,
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 1,
  });

  const contacts = data?.pages.flatMap((page) => page.contacts) ?? [];
  const isAuthExpiry = error instanceof ApiError && error.status === 401;
  const showError = isError && !isAuthExpiry;
  // Redup saat query filter baru sedang dimuat (placeholder = data lama).
  const isSearchLoading = isFetching && isPlaceholderData;

  // ── Kolom tabel kontak — data-driven, pola tabel Bookings ──
  const contactColumns = useMemo<TableColumn<ContactTableRow>[]>(
    () => [
      // Kolom Contact = identitas kontak (avatar + nama) sekaligus link ke detail.
      {
        key: 'contact',
        header: t('common.name'),
        width: proportional(3),
        renderCell: (contact) => (
          <Link
            to={`/app/contacts/${contact.id}`}
            title={t('contacts.openDetail')}
            className="group flex min-w-0 items-center gap-3"
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-amber-100 text-sm font-bold text-amber-700">
              {contact.name.slice(0, 1).toUpperCase()}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-base font-semibold text-zinc-900 dark:text-zinc-100 transition group-hover:text-amber-600">
                {contact.name}
              </span>
              <span className="block truncate text-xs text-zinc-500 dark:text-zinc-400">
                {contact.phone}
                {contact.email ? ` · ${contact.email}` : ''}
              </span>
            </span>
          </Link>
        ),
      },
      {
        key: 'notes',
        header: t('common.notes'),
        width: proportional(2),
        renderCell: (contact) => (
          <span className="block truncate text-base text-zinc-600 dark:text-zinc-400">
            {contact.notes ?? <span className="text-zinc-300">—</span>}
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
            <ContactActionsMenu contact={contact} onDelete={() => setDeleteTarget(contact)} />
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
    },
    onError: (err) => {
      setDeleteTarget(null);
      setDeleteError(errorMessage(err, t, 'errors.deleteContact'));
    },
  });

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('contacts.title')}
        description={t('contacts.description')}
        icon={IconUsers}
      >
        {/* Menu reload — sama seperti Bookings/Calls. */}
        <ReloadMenuButton isFetching={isFetching} onReload={() => void refetch()} />
        <button
          type="button"
          onClick={openAdd}
          className="inline-flex items-center gap-2 rounded-lg bg-amber-500 h-8 px-4 text-base font-semibold text-white shadow-sm transition hover:bg-amber-600 active:scale-[0.98]"
        >
          <IconPlus className="size-4" />
          {t('contacts.add')}
        </button>
      </PageHeader>

      {/* Filter bar — mengikuti pola Bookings: tiap filter di kolomnya sendiri (flex-1). */}
      <Card className="p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
          <div className="min-w-0 flex-1">
            <TextInput
              label={t('common.name')}
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
      </Card>

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
        <>
          {contacts.length === 0 ? (
            <EmptyState
              icon={IconUsers}
              title={hasFilters ? t('contacts.emptySearchTitle') : t('contacts.emptyTitle')}
              description={
                hasFilters ? t('contacts.emptySearchDesc') : t('contacts.emptyDesc')
              }
              action={
                hasFilters
                  ? { label: t('contacts.resetFilter'), onClick: resetFilters }
                  : { label: t('contacts.add'), onClick: openAdd }
              }
            />
          ) : (
            <>
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
                    data={contacts as ContactTableRow[]}
                    columns={contactColumns}
                    idKey="id"
                    density="balanced"
                    dividers="none"
                    hasHover
                    textOverflow="truncate"
                  />
                </div>
              </Card>

              {/* Footer: jumlah kontak terlihat (kiri) + Load more (kanan).
                  Kontak memakai kursor pagination (tanpa total), jadi tombol
                  memuat halaman berikutnya menggantikan Pagination numerik. */}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 px-1">
                <p className="text-sm text-zinc-400">
                  <Trans
                    i18nKey="contacts.showingCount"
                    values={{ shown: contacts.length }}
                    components={{ strong: <strong className="font-bold text-black dark:text-zinc-100" /> }}
                  />
                </p>
                {hasNextPage && (
                  <Button
                    label={t('common.loadMore')}
                    variant="secondary"
                    size="sm"
                    isLoading={isFetchingNextPage}
                    isDisabled={isFetchingNextPage || isFetching}
                    onClick={() => void fetchNextPage()}
                  />
                )}
              </div>
            </>
          )}
        </>
      )}

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
    </div>
  );
}
