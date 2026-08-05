import { useMemo, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  Button,
  DateTimeInput,
  Dialog,
  DialogHeader,
  TextArea,
  TextInput,
  type ISODateTimeString,
} from '@astryxdesign/core';
import {
  determineCallGoal,
  type BookingGoalContext,
  type BusinessGoalContext,
  type GoalCustomization,
  type Industry,
} from '@oriole/call-goals';

import { ApiError, apiFetch } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import type { BookingRecord, BookingsListResponse } from '../../lib/bookings';
import { useWorkspaceStore } from '../../stores/workspace';
import { PhoneInput } from '../components/PhoneInput';
import { GoalCustomizer } from '../shell/GoalCustomizer';
import { IconChevronLeft, IconCalendar, IconSearch, IconUsers } from '../shell/icons';
import { Card, PageHeader } from '../shell/ui';

/** Kontak = customer (nama + telepon) yang pernah dipakai di booking project ini. */
interface ContactSuggestion {
  name: string | null;
  phone: string;
}

export function BookingNewPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const workspace = workspaces.find((item) => item.id === activeWorkspaceId);

  const [title, setTitle] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [phone, setPhone] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [description, setDescription] = useState('');
  const [timezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
  );
  const [customization, setCustomization] = useState<GoalCustomization | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // ── Pilih dari kontak ──────────────────────────────────────
  const [isPickerOpen, setPickerOpen] = useState(false);
  const [contactQuery, setContactQuery] = useState('');

  // Data kontak dimuat malas (lazy) — hanya saat dialog dibuka.
  const {
    data: contactsPage,
    isPending: isContactsLoading,
    error: contactsError,
  } = useQuery({
    queryKey: ['bookings-contacts', activeWorkspaceId],
    queryFn: () => apiFetch<BookingsListResponse>('/bookings?limit=200'),
    enabled: isPickerOpen,
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 1,
  });

  /** Kontak unik per nomor — urutan terbaru (API sorted desc(scheduledAt)) menang. */
  const contacts = useMemo<ContactSuggestion[]>(() => {
    const seen = new Set<string>();
    const list: ContactSuggestion[] = [];
    for (const booking of contactsPage?.bookings ?? []) {
      if (!booking.phone) continue;
      const key = booking.phone.replace(/\D/g, '');
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({ name: booking.customerName, phone: booking.phone });
    }
    return list;
  }, [contactsPage]);

  const filteredContacts = useMemo(() => {
    const query = contactQuery.trim().toLowerCase();
    if (!query) return contacts;
    return contacts.filter(
      (contact) =>
        (contact.name ?? '').toLowerCase().includes(query) ||
        contact.phone.toLowerCase().includes(query),
    );
  }, [contacts, contactQuery]);

  const openPicker = () => {
    setContactQuery('');
    setPickerOpen(true);
  };

  const closePicker = (open: boolean) => {
    if (!open) {
      setPickerOpen(false);
      setContactQuery('');
    }
  };

  const applyContact = (contact: ContactSuggestion) => {
    setPhone(contact.phone);
    // Isi nama hanya bila kontak punya nama — jangan menghapus nama yang sudah diketik.
    if (contact.name) setCustomerName(contact.name);
    setPickerOpen(false);
    setContactQuery('');
  };

  const business: BusinessGoalContext = {
    id: activeWorkspaceId,
    name: workspace?.name ?? null,
    industry: (workspace?.industry as Industry | null | undefined) ?? null,
  };

  const bookingContext: BookingGoalContext = {
    id: 'new',
    title: title.trim() || t('bookingNew.title'),
    status: 'pending',
    scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : new Date().toISOString(),
    timezone,
    customerName: customerName.trim() || null,
    phone: phone.trim() || null,
    changeRequested: false,
    noShowCount: 0,
    previousCallAttempts: 0,
    failedCallAttempts: 0,
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      const response = await apiFetch<{ booking: BookingRecord }>('/bookings', {
        method: 'POST',
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || undefined,
          scheduledAt: new Date(scheduledAt).toISOString(),
          timezone,
          customerName: customerName.trim() || undefined,
          phone: phone.trim() || undefined,
          goal: customization ?? undefined,
        }),
      });
      navigate(`/app/bookings/${response.booking.id}`, { replace: true });
    } catch (err) {
      setError(errorMessage(err, t, 'errors.createBooking'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('bookingNew.title')}
        description={t('bookingNew.description')}
      >
        <Link
          to="/app/bookings"
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-medium text-zinc-600 transition hover:bg-zinc-50"
        >
          <IconChevronLeft className="size-4" />
          {t('common.cancel')}
        </Link>
      </PageHeader>

      <form onSubmit={onSubmit} className="space-y-6">
        <Card className="space-y-5 p-5 sm:p-6">
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <TextInput
              className="sm:col-span-2"
              label={t('bookingNew.bookingTitle')}
              isRequired
              value={title}
              onChange={setTitle}
              placeholder={t('bookingNew.titlePlaceholder')}
              width="100%"
            />

            <TextInput
              label={t('bookingNew.customerName')}
              value={customerName}
              onChange={setCustomerName}
              placeholder={t('bookingNew.customerPlaceholder')}
              width="100%"
            />

            <div>
              <PhoneInput
                label={t('bookingNew.phone')}
                description={t('bookingNew.phoneDesc')}
                value={phone}
                onChange={setPhone}
              />
              <button
                type="button"
                onClick={openPicker}
                className="mt-1.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium text-amber-700 transition hover:bg-amber-50 hover:text-amber-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500"
              >
                <IconUsers className="size-3.5" />
                {t('bookingNew.pickContact')}
              </button>
            </div>

            <DateTimeInput
              className="sm:col-span-2"
              label={t('bookingNew.schedule')}
              description={t('bookingNew.timezone', { timezone })}
              isRequired
              value={scheduledAt ? (scheduledAt as ISODateTimeString) : undefined}
              onChange={(value) => setScheduledAt(value ?? '')}
              width="100%"
            />

            <TextArea
              className="sm:col-span-2"
              label={t('bookingNew.notes')}
              rows={3}
              value={description}
              onChange={setDescription}
              placeholder={t('bookingNew.notesPlaceholder')}
              width="100%"
            />
          </div>
        </Card>

        {/* Progressive disclosure goal CALL-E */}
        <div>
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-zinc-500">
            <IconCalendar className="size-4" />
            {t('bookingNew.autoCallHeading')}
          </h2>
          <GoalCustomizer
            booking={bookingContext}
            business={business}
            autoDecision={determineCallGoal(bookingContext)}
            value={customization}
            onChange={setCustomization}
          />
        </div>

        {error && (
          <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </p>
        )}

        <div className="flex justify-end">
          <Button
            label={t('bookingNew.submit')}
            variant="primary"
            isLoading={isSubmitting}
            isDisabled={!title.trim() || !scheduledAt}
            type="submit"
          />
        </div>
      </form>

      {/* Dialog pilih kontak — sumber: customer pada booking project ini */}
      <Dialog isOpen={isPickerOpen} onOpenChange={closePicker} purpose="form" width={520}>
        <DialogHeader
          title={t('bookingNew.pickContactTitle')}
          subtitle={t('bookingNew.pickContactSubtitle')}
          onOpenChange={closePicker}
          hasDivider
        />
        <div className="p-5">
          <TextInput
            label={t('bookingNew.searchContact')}
            isLabelHidden
            placeholder={t('bookingNew.searchPlaceholder')}
            value={contactQuery}
            onChange={setContactQuery}
            startIcon={<IconSearch className="size-4" />}
            width="100%"
          />

          <div aria-live="polite" className="mt-3 max-h-72 overflow-y-auto">
            {isContactsLoading ? (
              <p className="px-1 py-8 text-center text-sm text-zinc-500">{t('bookingNew.loadingContacts')}</p>
            ) : contactsError ? (
              <p role="alert" className="px-1 py-8 text-center text-sm text-red-600">
                {t('errors.loadContactsBody')}
              </p>
            ) : filteredContacts.length === 0 ? (
              <p className="px-1 py-8 text-center text-sm text-zinc-500">
                {contactQuery.trim()
                  ? t('bookingNew.noMatch')
                  : t('bookingNew.noContacts')}
              </p>
            ) : (
              <ul className="divide-y divide-zinc-100 overflow-hidden rounded-xl border border-zinc-200">
                {filteredContacts.map((contact) => (
                  <li key={contact.phone}>
                    <button
                      type="button"
                      onClick={() => applyContact(contact)}
                      className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition hover:bg-amber-50 focus-visible:bg-amber-50 focus-visible:outline-none"
                    >
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-xs font-bold text-zinc-600">
                        {(contact.name ?? '?').slice(0, 1).toUpperCase()}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-zinc-800">
                          {contact.name ?? t('common.noName')}
                        </span>
                        <span className="block truncate text-xs text-zinc-500">{contact.phone}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Dialog>
    </div>
  );
}
