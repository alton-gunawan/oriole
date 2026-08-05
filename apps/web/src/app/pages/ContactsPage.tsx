import { useEffect, useState, type FormEvent } from 'react';
import { keepPreviousData, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  AlertDialog,
  Button,
  Dialog,
  DialogHeader,
  IconButton,
  Skeleton,
  TextArea,
  TextInput,
} from '@astryxdesign/core';

import { ApiError, apiFetch } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import type { ContactRecord, ContactsListResponse, CreateContactPayload } from '../../lib/contacts';
import { useWorkspaceStore } from '../../stores/workspace';
import { PhoneInput } from '../components/PhoneInput';
import { IconAlertTriangle, IconPlus, IconSearch, IconTrash, IconUsers } from '../shell/icons';
import { Card, EmptyState, PageHeader } from '../shell/ui';

export function ContactsPage() {
  const { t } = useTranslation();
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const queryClient = useQueryClient();

  // ── Pencarian (server-side, debounce 300ms) ─────────────────
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

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
    queryKey: ['contacts', activeWorkspaceId, debouncedQuery],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      if (debouncedQuery) params.set('q', debouncedQuery);
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
  // Redup saat query pencarian baru sedang dimuat (placeholder = data lama).
  const isSearchLoading = isFetching && isPlaceholderData;

  // ── Dialog tambah kontak ────────────────────────────────────
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const closeAddDialog = () => {
    setIsAddOpen(false);
    setFormError(null);
  };
  const openAddDialog = () => {
    setName('');
    setPhone('');
    setEmail('');
    setNotes('');
    setFormError(null);
    setIsAddOpen(true);
  };

  const addMutation = useMutation({
    mutationFn: (payload: CreateContactPayload) =>
      apiFetch<{ contact: ContactRecord }>('/contacts', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      closeAddDialog();
      queryClient.invalidateQueries({ queryKey: ['contacts', activeWorkspaceId] });
    },
    onError: (err) => {
      setFormError(errorMessage(err, t, 'errors.saveContact'));
    },
  });

  const submitContact = (event: FormEvent) => {
    event.preventDefault();
    const cleanName = name.trim();
    const cleanPhone = phone.trim();
    if (!cleanName || !cleanPhone) {
      setFormError(t('errors.contactRequired'));
      return;
    }
    setFormError(null);
    addMutation.mutate({
      name: cleanName,
      phone: cleanPhone,
      email: email.trim() || undefined,
      notes: notes.trim() || undefined,
    });
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
      >
        <Button
          label={t('contacts.new')}
          variant="primary"
          icon={<IconPlus className="size-4" />}
          onClick={openAddDialog}
        />
      </PageHeader>

      <Card className="p-3">
        <TextInput
          label={t('contacts.search')}
          isLabelHidden
          placeholder={t('contacts.searchPlaceholder')}
          value={query}
          onChange={setQuery}
          startIcon={<IconSearch className="size-4" />}
          width="100%"
        />
      </Card>

      {deleteError && (
        <p
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          {deleteError}
        </p>
      )}

      {showError && (
        <Card className="flex flex-col items-center gap-4 p-10 text-center">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-red-50 text-red-500">
            <IconAlertTriangle className="size-6" />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-zinc-900">{t('errors.contactsLoadTitle')}</h3>
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
          {contacts.length === 0 ? (
            <EmptyState
              icon={IconUsers}
              title={debouncedQuery ? t('contacts.emptySearchTitle') : t('contacts.emptyTitle')}
              description={
                debouncedQuery ? t('contacts.emptySearchDesc') : t('contacts.emptyDesc')
              }
              action={{ label: t('contacts.add'), onClick: openAddDialog }}
            />
          ) : (
            <Card>
              <div
                // inert: blokir interaksi saat pencarian sedang memuat data baru.
                inert={isSearchLoading}
                className={`divide-y divide-zinc-100 transition-opacity duration-200 ${
                  isSearchLoading ? 'pointer-events-none opacity-40' : ''
                }`}
              >
                {contacts.map((contact) => (
                  <div key={contact.id} className="flex items-center gap-3 p-4">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-amber-100 text-sm font-bold text-amber-700">
                      {contact.name.slice(0, 1).toUpperCase()}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-zinc-900">{contact.name}</p>
                      <p className="truncate text-xs text-zinc-500">
                        {contact.phone}
                        {contact.email ? ` · ${contact.email}` : ''}
                      </p>
                      {contact.notes && (
                        <p className="mt-0.5 truncate text-[11px] text-zinc-400">{contact.notes}</p>
                      )}
                    </div>
                    <IconButton
                      icon={<IconTrash className="size-4" />}
                      label={t('contacts.deleteFor', { name: contact.name })}
                      variant="ghost"
                      size="sm"
                      onClick={() => setDeleteTarget(contact)}
                    />
                  </div>
                ))}
              </div>
            </Card>
          )}
          {hasNextPage && contacts.length > 0 && (
            <div className="flex justify-center pt-2">
              <Button
                label={t('common.loadMore')}
                variant="secondary"
                isLoading={isFetchingNextPage}
                isDisabled={isFetchingNextPage || isFetching}
                onClick={() => void fetchNextPage()}
              />
            </div>
          )}
        </>
      )}

      {/* Dialog tambah kontak */}
      <Dialog
        isOpen={isAddOpen}
        onOpenChange={(open) => {
          if (!open) closeAddDialog();
        }}
        purpose="form"
        width={520}
      >
        <DialogHeader
          title={t('contacts.addTitle')}
          subtitle={t('contacts.addSubtitle')}
          onOpenChange={(open) => {
            if (!open) closeAddDialog();
          }}
          hasDivider
        />
        <form onSubmit={submitContact} className="space-y-5 p-6">
          <TextInput
            label={t('common.name')}
            placeholder={t('contacts.namePlaceholder')}
            value={name}
            onChange={setName}
            isRequired
          />
          <PhoneInput
            label={t('contacts.phoneLabel')}
            value={phone}
            onChange={setPhone}
            isRequired
          />
          <TextInput
            label={t('common.email')}
            type="email"
            placeholder={t('contacts.emailPlaceholder')}
            value={email}
            onChange={setEmail}
            isOptional
          />
          <TextArea
            label={t('common.notes')}
            placeholder={t('contacts.notesPlaceholder')}
            value={notes}
            onChange={setNotes}
            rows={3}
            isOptional
          />
          {formError && (
            <p
              role="alert"
              className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
            >
              {formError}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button
              label={t('common.cancel')}
              variant="ghost"
              onClick={closeAddDialog}
              isDisabled={addMutation.isPending}
            />
            <Button
              label={t('common.saveContact')}
              variant="primary"
              type="submit"
              isLoading={addMutation.isPending}
            />
          </div>
        </form>
      </Dialog>

      {/* Konfirmasi hapus kontak */}
      <AlertDialog
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
