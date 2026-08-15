import { useMemo, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  Button,
  DateTimeInput,
  Dialog,
  DialogHeader,
  Layout,
  LayoutContent,
  NumberInput,
  Selector,
  Switch,
  TextArea,
  TextInput,
  type ISODateTimeString,
} from '@astryxdesign/core';

import { ApiError, apiFetch } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import type {
  BookingCreateResponse,
  BookingsListResponse,
  RecurrenceRule,
} from '../../lib/bookings';
import type { StaffListResponse } from '../../lib/staff';
import type { ServiceRecord, ServicesListResponse } from '../../lib/services';
import { useWorkspaceStore } from '../../stores/workspace';
import { PhoneInput } from '../components/PhoneInput';
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
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);

  // ── Title diambil dari layanan katalog (bukan input manual) ──
  const [title, setTitle] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [phone, setPhone] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [description, setDescription] = useState('');
  const [timezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
  );
  // ── Layanan katalog & staf (availabilitas) ──────────────────
  const [serviceId, setServiceId] = useState<string>('');
  const [staffId, setStaffId] = useState<string>('');
  // ── Pengulangan (recurring appointments) ───────────────────
  const [isRecurring, setIsRecurring] = useState(false);
  const [recurrence, setRecurrence] = useState<RecurrenceRule>({
    frequency: 'weekly',
    interval: 1,
    weekdays: [],
    count: 4,
  });

  // Daftar staf workspace — untuk Selector penugasan.
  const { data: staffPage } = useQuery({
    queryKey: ['staff', activeWorkspaceId],
    queryFn: () => apiFetch<StaffListResponse>('/staff'),
    enabled: Boolean(activeWorkspaceId),
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 1,
  });
  const activeStaff = staffPage?.staff.filter((staff) => staff.isActive) ?? [];

  // Daftar layanan katalog — Selector auto-fill title/durasi/staf saat dipilih.
  const { data: servicesPage } = useQuery({
    queryKey: ['services', activeWorkspaceId],
    queryFn: () => apiFetch<ServicesListResponse>('/services'),
    enabled: Boolean(activeWorkspaceId),
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 1,
  });
  const activeServices = servicesPage?.services.filter((service) => service.isActive) ?? [];

  /** Auto-fill dari layanan katalog: title = nama layanan (bukan input
   *  manual), staf = staf tunggal ter-assign (bila layanan hanya punya satu
   *  staf). Durasi tidak diedit di sini — selalu diambil dari katalog. */
  const applyService = (service: ServiceRecord) => {
    setServiceId(service.id);
    setTitle(service.name);
    if (service.staffIds.length === 1) setStaffId(service.staffIds[0]);
  };

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

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      const response = await apiFetch<BookingCreateResponse>('/bookings', {
        method: 'POST',
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || undefined,
          scheduledAt: new Date(scheduledAt).toISOString(),
          timezone,
          customerName: customerName.trim() || undefined,
          phone: phone.trim() || undefined,
          // Booking WAJIB berasal dari layanan katalog — title & durasi
          // diisi otomatis dari service (server juga mengisi bila kosong).
          serviceId: serviceId || undefined,
          staffId: staffId || undefined,
          // Hanya kirim recurrence bila toggle aktif & aturan valid.
          recurrence:
            isRecurring && (recurrence.count ?? 1) > 0 ? recurrence : undefined,
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
        icon={IconCalendar}
      >
        <Link
          to="/app/bookings"
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm font-medium text-zinc-600 dark:text-zinc-400 transition hover:bg-zinc-50 dark:hover:bg-zinc-900"
        >
          <IconChevronLeft className="size-4" />
          {t('common.cancel')}
        </Link>
      </PageHeader>

      <form onSubmit={onSubmit} className="space-y-6">
        <Card className="space-y-5 p-5 sm:p-6">
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            {/* Layanan katalog — WAJIB dipilih. Title, durasi, dan staf
                tunggal diisi otomatis dari service; tidak ada input manual. */}
            <div className="sm:col-span-2">
              <Selector
                label={t('bookingNew.service')}
                description={t('bookingNew.serviceDesc')}
                placeholder={t('bookingNew.servicePlaceholder')}
                options={activeServices.map((service) => ({ value: service.id, label: service.name }))}
                value={serviceId || null}
                onChange={(value) => {
                  const id = value ?? '';
                  const service = activeServices.find((item) => item.id === id);
                  if (service) applyService(service);
                  else setServiceId(''); // clear → booking tanpa service tidak bisa disubmit
                }}
                hasClear
                isRequired
                hasSearch
                searchPlaceholder={t('bookingNew.serviceSearch')}
                width="100%"
              />
              {activeServices.length === 0 && (
                <p className="mt-2 text-xs text-zinc-400">
                  {t('bookingNew.noServicesHint')}{' '}
                  <Link
                    to="/app/services"
                    className="font-semibold text-amber-600 transition hover:text-amber-700"
                  >
                    {t('bookingNew.manageServices')}
                  </Link>
                </p>
              )}
            </div>

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
                className="mt-1.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium text-amber-700 transition hover:bg-amber-50 hover:text-amber-800 dark:hover:bg-amber-950/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500"
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

            {/* Staf penanggung jawab — otomatis dari layanan (satu staf) atau
                dipilih manual bila layanan punya banyak staf. Dipakai mesin
                availabilitas untuk mencegah double-booking. Durasi selalu
                diambil dari katalog layanan — tidak ada input manual. */}
            <div className="sm:col-span-2">
              <Selector
                label={t('bookingNew.staff')}
                description={t('bookingNew.staffDesc')}
                placeholder={t('bookingNew.staffPlaceholder')}
                options={activeStaff.map((staff) => ({ value: staff.id, label: staff.name }))}
                value={staffId || null}
                onChange={(value) => setStaffId(value ?? '')}
                hasClear
                width="100%"
              />
              {activeStaff.length === 0 && (
                <p className="mt-2 text-xs text-zinc-400">
                  {t('bookingNew.noStaffHint')}{' '}
                  <Link
                    to="/app/staff"
                    className="font-semibold text-amber-600 transition hover:text-amber-700"
                  >
                    {t('bookingNew.manageStaff')}
                  </Link>
                </p>
              )}
            </div>

            {/* Pengulangan — ekspansi jadi beberapa instance booking satu seri. */}
            <div className="sm:col-span-2 rounded-xl border border-zinc-100 dark:border-zinc-800 p-4">
              <Switch
                label={t('bookingNew.repeat')}
                description={t('bookingNew.repeatDesc')}
                value={isRecurring}
                onChange={setIsRecurring}
              />
              {isRecurring && (
                <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Selector
                    label={t('bookingNew.repeatFrequency')}
                    options={[
                      { value: 'daily', label: t('bookingNew.frequencyDaily') },
                      { value: 'weekly', label: t('bookingNew.frequencyWeekly') },
                      { value: 'monthly', label: t('bookingNew.frequencyMonthly') },
                    ]}
                    value={recurrence.frequency}
                    onChange={(value) =>
                      setRecurrence((prev) => ({ ...prev, frequency: (value as RecurrenceRule['frequency']) ?? 'weekly' }))
                    }
                    width="100%"
                  />
                  <NumberInput
                    label={t('bookingNew.repeatInterval')}
                    value={recurrence.interval ?? 1}
                    onChange={(value) => setRecurrence((prev) => ({ ...prev, interval: value ?? 1 }))}
                    min={1}
                    max={90}
                    width="100%"
                  />
                  {recurrence.frequency === 'weekly' && (
                    <div className="sm:col-span-2">
                      <p className="mb-1.5 text-xs font-medium text-zinc-600 dark:text-zinc-400">{t('bookingNew.repeatWeekdays')}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((day, index) => {
                          const selected = (recurrence.weekdays ?? []).includes(index);
                          return (
                            <button
                              key={day}
                              type="button"
                              aria-pressed={selected}
                              onClick={() =>
                                setRecurrence((prev) => {
                                  const weekdays = prev.weekdays ?? [];
                                  const next = selected
                                    ? weekdays.filter((d) => d !== index)
                                    : [...weekdays, index].sort((a, b) => a - b);
                                  return { ...prev, weekdays: next };
                                })
                              }
                              className={`size-8 rounded-full text-xs font-semibold transition ${
                                selected
                                  ? 'bg-amber-500 text-white shadow-sm'
                                  : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700'
                              }`}
                            >
                              {day}
                            </button>
                          );
                        })}
                      </div>
                      <p className="mt-1.5 text-xs text-zinc-400">{t('bookingNew.repeatWeekdaysHint')}</p>
                    </div>
                  )}
                  <NumberInput
                    label={t('bookingNew.repeatCount')}
                    description={t('bookingNew.repeatCountDesc')}
                    value={recurrence.count ?? 1}
                    onChange={(value) => setRecurrence((prev) => ({ ...prev, count: value ?? 1 }))}
                    min={1}
                    max={52}
                    width="100%"
                  />
                </div>
              )}
            </div>

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

        {error && (
          <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-400">
            {error}
          </p>
        )}

        <div className="flex justify-end">
          <Button
            label={t('bookingNew.submit')}
            variant="primary"
            isLoading={isSubmitting}
            // Booking harus berasal dari layanan katalog — tidak ada booking
            // tanpa service.
            isDisabled={!serviceId || !scheduledAt}
            type="submit"
          />
        </div>
      </form>

      {/* Dialog pilih kontak — sumber: customer pada booking project ini */}
      <Dialog isOpen={isPickerOpen} onOpenChange={closePicker} purpose="info" width={520}>
        <Layout
          header={
            <DialogHeader
              title={t('bookingNew.pickContactTitle')}
              subtitle={t('bookingNew.pickContactSubtitle')}
              onOpenChange={closePicker}
              hasDivider
            />
          }
          content={
            <LayoutContent>
              <div className="space-y-3">
                <TextInput
                  label={t('bookingNew.searchContact')}
                  isLabelHidden
                  placeholder={t('bookingNew.searchPlaceholder')}
                  value={contactQuery}
                  onChange={setContactQuery}
                  startIcon={<IconSearch className="size-4" />}
                  width="100%"
                />

                <div aria-live="polite" className="max-h-72 overflow-y-auto">
                  {isContactsLoading ? (
                    <p className="px-1 py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">{t('bookingNew.loadingContacts')}</p>
                  ) : contactsError ? (
                    <p role="alert" className="px-1 py-8 text-center text-sm text-red-600">
                      {t('errors.loadContactsBody')}
                    </p>
                  ) : filteredContacts.length === 0 ? (
                    <p className="px-1 py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
                      {contactQuery.trim()
                        ? t('bookingNew.noMatch')
                        : t('bookingNew.noContacts')}
                    </p>
                  ) : (
                    <ul className="space-y-1.5">
                      {filteredContacts.map((contact) => (
                        <li key={contact.phone}>
                          <button
                            type="button"
                            onClick={() => applyContact(contact)}
                            className="flex w-full items-center gap-3 rounded-lg bg-zinc-50 dark:bg-zinc-900 px-3 py-2 text-left transition hover:bg-amber-50 hover:ring-1 hover:ring-amber-200 focus-visible:bg-amber-50 focus-visible:ring-1 focus-visible:ring-amber-300 focus-visible:outline-none"
                          >
                            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-xs font-bold text-amber-700">
                              {(contact.name ?? '?').slice(0, 1).toUpperCase()}
                            </span>
                            <span className="min-w-0">
                              <span className="block truncate text-[15px] font-medium text-zinc-800 dark:text-zinc-200">
                                {contact.name ?? t('common.noName')}
                              </span>
                              <span className="block truncate text-sm text-zinc-500 dark:text-zinc-400">{contact.phone}</span>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </LayoutContent>
          }
        />
      </Dialog>
    </div>
  );
}
