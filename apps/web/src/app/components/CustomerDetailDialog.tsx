import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import {
  Badge,
  Button,
  Dialog,
  DialogHeader,
  Layout,
  LayoutContent,
  LayoutFooter,
  Selector,
  SelectorOption,
  Skeleton,
  StatusDot,
  Tab,
  TabList,
  TextInput,
  type StatusDotVariant,
} from '@astryxdesign/core';

import { ApiError, apiFetch } from '../../lib/api';
import type { ContactDetailResponse, ContactRecord } from '../../lib/contacts';
import type { BookingRecord, BookingsListResponse } from '../../lib/bookings';
import { useWorkspaceStore } from '../../stores/workspace';
import { formatDate, formatDateTime } from '../../i18n/format';
import { bookingStatusKey } from '../../i18n/enums';
import {
  IconAlertTriangle,
  IconCalendar,
  IconCheck,
  IconCopy,
  IconEdit,
  IconExternalLink,
  IconMail,
  IconPhone,
  IconSearch,
} from '../shell/icons';
import { Card } from '../shell/ui';

const VALID_BOOKING_STATUSES: BookingRecord['status'][] = [
  'confirmed',
  'pending',
  'completed',
  'cancelled',
];

const STATUS_DOT: Record<BookingRecord['status'], StatusDotVariant> = {
  confirmed: 'success',
  completed: 'neutral',
  pending: 'warning',
  cancelled: 'error',
};

const STATUS_TEXT: Record<string, string> = {
  confirmed: 'text-emerald-600 dark:text-emerald-400',
  completed: 'text-zinc-500 dark:text-zinc-400',
  pending: 'text-amber-600 dark:text-amber-400',
  cancelled: 'text-red-600 dark:text-red-400',
};

function statusLabel(status: string | null, t: TFunction): string {
  const k = bookingStatusKey(status);
  return k ? t(k) : (status ?? '—');
}

export interface CustomerDetailDialogProps {
  contactId?: string | null;
  initialContact?: ContactRecord | null;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onEdit?: (contact: ContactRecord) => void;
}

export function CustomerDetailDialog({
  contactId,
  initialContact,
  isOpen,
  onOpenChange,
  onEdit,
}: CustomerDetailDialogProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const [copiedField, setCopiedField] = useState<'phone' | 'email' | null>(null);
  const [activeTab, setActiveTab] = useState<'info' | 'bookings'>('info');

  // Filter untuk riwayat booking di drawer
  const [bookingSearch, setBookingSearch] = useState('');
  const [bookingStatusFilter, setBookingStatusFilter] = useState<string>('');

  const effectiveId = contactId || initialContact?.id;

  const contactQuery = useQuery({
    queryKey: ['contact', activeWorkspaceId, effectiveId],
    queryFn: () => apiFetch<ContactDetailResponse>(`/contacts/${effectiveId}`),
    enabled: isOpen && Boolean(effectiveId),
    initialData: initialContact ? { contact: initialContact } : undefined,
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 1,
  });

  const contact = contactQuery.data?.contact ?? initialContact;

  // Cari riwayat booking untuk customer ini (berdasarkan nomor telepon customer)
  const bookingsQuery = useQuery({
    queryKey: ['contact-bookings', activeWorkspaceId, contact?.phone],
    queryFn: async () => {
      if (!contact?.phone) return { bookings: [], total: 0 };
      const params = new URLSearchParams();
      params.set('phone', contact.phone);
      params.set('pageSize', '50');
      return apiFetch<BookingsListResponse>(`/bookings?${params.toString()}`);
    },
    enabled: isOpen && Boolean(contact?.phone),
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 1,
  });

  const allBookings = bookingsQuery.data?.bookings ?? [];

  const filteredBookings = useMemo(() => {
    return allBookings.filter((b) => {
      if (bookingStatusFilter && b.status !== bookingStatusFilter) {
        return false;
      }
      if (bookingSearch.trim()) {
        const q = bookingSearch.toLowerCase().trim();
        const matchTitle = b.title?.toLowerCase().includes(q);
        const matchService = b.serviceName?.toLowerCase().includes(q);
        if (!matchTitle && !matchService) return false;
      }
      return true;
    });
  }, [allBookings, bookingStatusFilter, bookingSearch]);

  const copyToClipboard = (text: string, field: 'phone' | 'email') => {
    void navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const handleBookingClick = (bookingId: string) => {
    onOpenChange(false);
    navigate(`/app/bookings/${bookingId}`);
  };

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open && document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        onOpenChange(open);
      }}
      purpose="info"
      width={460}
      maxHeight="100dvh"
      position={{ top: 0, right: 0, bottom: 0 }}
      style={{
        height: '100dvh',
        maxHeight: '100dvh',
        margin: 0,
        marginLeft: 'auto',
        borderRadius: 0,
      }}
      className="h-[100dvh] max-h-[100dvh] m-0 ml-auto rounded-none border-l border-zinc-200 dark:border-zinc-800 shadow-2xl"
    >
      <Layout
        header={
          <div className="flex flex-col">
            <DialogHeader
              title={contact?.name ?? t('contactDetail.title')}
              subtitle={
                contact?.createdAt
                  ? t('contactDetail.createdAt', { date: formatDate(contact.createdAt) })
                  : t('contactDetail.description')
              }
              startContent={
                <div className="size-8 shrink-0 overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-700/60 bg-zinc-100 dark:bg-zinc-800">
                  <img
                    src={`https://api.dicebear.com/10.x/critters/svg?seed=${encodeURIComponent((contact?.name || contact?.id) ?? 'customer')}`}
                    alt={contact?.name ?? 'Customer'}
                    className="size-full object-cover"
                    loading="lazy"
                  />
                </div>
              }
              onOpenChange={onOpenChange}
              hasDivider={false}
            />
            <div className="px-5 pt-1">
              <TabList
                value={activeTab}
                onChange={(val) => setActiveTab(val as 'info' | 'bookings')}
                hasDivider
                layout="fill"
              >
                <Tab
                  value="info"
                  label={t('contactDetail.info', { defaultValue: 'Contact Information' })}
                  icon={<IconPhone className="size-4" />}
                />
                <Tab
                  value="bookings"
                  label={t('contactDetail.bookingHistory', { defaultValue: 'Booking History' })}
                  icon={<IconCalendar className="size-4" />}
                  endContent={
                    allBookings.length > 0 ? (
                      <Badge
                        variant="neutral"
                        label={String(allBookings.length)}
                      />
                    ) : null
                  }
                />
              </TabList>
            </div>
          </div>
        }
        content={
          <LayoutContent>
            <div className="py-2">
              {contactQuery.isPending && !contact && (
                <div className="space-y-3">
                  <Skeleton width="100%" height={80} />
                  <Skeleton width="100%" height={140} />
                </div>
              )}

              {contactQuery.isError && !contact && (
                <Card className="flex flex-col items-center gap-3 p-6 text-center">
                  <IconAlertTriangle className="size-6 text-red-500" />
                  <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                    {t('contactDetail.notFound')}
                  </p>
                </Card>
              )}

              {contact && activeTab === 'info' && (
                <div className="space-y-4">
                  {/* Informasi Kontak */}
                  <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-xs dark:border-zinc-700/80 dark:bg-zinc-900 space-y-3.5">
                    {/* Telepon */}
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <IconPhone className="size-4 shrink-0 text-zinc-400" />
                        <div className="min-w-0">
                          <span className="block text-[11px] font-medium text-zinc-400 uppercase tracking-wide">
                            {t('common.phone')}
                          </span>
                          {contact.phone ? (
                            <a
                              href={`tel:${contact.phone}`}
                              className="truncate text-sm font-semibold text-zinc-900 transition hover:text-amber-600 dark:text-zinc-100 dark:hover:text-amber-400"
                            >
                              {contact.phone}
                            </a>
                          ) : (
                            <span className="text-sm text-zinc-400">—</span>
                          )}
                        </div>
                      </div>
                      {contact.phone && (
                        <button
                          type="button"
                          onClick={() => copyToClipboard(contact.phone, 'phone')}
                          title={t('contactDetail.copyPhone', { defaultValue: 'Copy phone' })}
                          className="flex size-7 items-center justify-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 cursor-pointer"
                        >
                          {copiedField === 'phone' ? (
                            <IconCheck className="size-3.5 text-emerald-600" />
                          ) : (
                            <IconCopy className="size-3.5" />
                          )}
                        </button>
                      )}
                    </div>

                    {/* Email */}
                    <div className="border-t border-zinc-100 pt-3 dark:border-zinc-800 flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <IconMail className="size-4 shrink-0 text-zinc-400" />
                        <div className="min-w-0">
                          <span className="block text-[11px] font-medium text-zinc-400 uppercase tracking-wide">
                            {t('common.email')}
                          </span>
                          {contact.email ? (
                            <a
                              href={`mailto:${contact.email}`}
                              className="truncate text-sm font-semibold text-zinc-900 transition hover:text-amber-600 dark:text-zinc-100 dark:hover:text-amber-400"
                            >
                              {contact.email}
                            </a>
                          ) : (
                            <span className="text-sm text-zinc-400">—</span>
                          )}
                        </div>
                      </div>
                      {contact.email && (
                        <button
                          type="button"
                          onClick={() => {
                            if (contact.email) copyToClipboard(contact.email, 'email');
                          }}
                          title={t('contactDetail.copyEmail', { defaultValue: 'Copy email' })}
                          className="flex size-7 items-center justify-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 cursor-pointer"
                        >
                          {copiedField === 'email' ? (
                            <IconCheck className="size-3.5 text-emerald-600" />
                          ) : (
                            <IconCopy className="size-3.5" />
                          )}
                        </button>
                      )}
                    </div>

                    {/* Catatan */}
                    {contact.notes && (
                      <div className="border-t border-zinc-100 pt-3 dark:border-zinc-800">
                        <span className="block text-[11px] font-medium text-zinc-400 uppercase tracking-wide">
                          {t('common.notes')}
                        </span>
                        <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
                          {contact.notes}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {contact && activeTab === 'bookings' && (
                <div className="space-y-2.5">
                  {/* Filter & Search Bar */}
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <TextInput
                        label={t('bookings.colService')}
                        isLabelHidden
                        placeholder={t('bookings.servicePlaceholder')}
                        value={bookingSearch}
                        onChange={setBookingSearch}
                        startIcon={<IconSearch className="size-3.5 text-zinc-400" />}
                        width="100%"
                      />
                    </div>
                    <div className="shrink-0 w-36">
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
                          ...VALID_BOOKING_STATUSES.map((status) => ({
                            value: status,
                            label: statusLabel(status, t),
                            icon: <StatusDot variant={STATUS_DOT[status]} label={statusLabel(status, t)} />,
                          })),
                        ]}
                        value={bookingStatusFilter}
                        onChange={(value) => setBookingStatusFilter(value || '')}
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
                  </div>

                  {bookingsQuery.isPending && (
                    <div className="space-y-1.5 pt-1">
                      <Skeleton width="100%" height={48} />
                      <Skeleton width="100%" height={48} />
                      <Skeleton width="100%" height={48} />
                    </div>
                  )}

                  {!bookingsQuery.isPending && filteredBookings.length === 0 && (
                    <div className="rounded-lg border border-dashed border-zinc-200 p-6 text-center text-xs text-zinc-400 dark:border-zinc-800">
                      {bookingSearch || bookingStatusFilter
                        ? t('bookings.emptyTitle')
                        : t('contactDetail.noBookings', { defaultValue: 'No bookings found for this customer.' })}
                    </div>
                  )}

                  {/* List Booking Item (gap rapat/ringkas) */}
                  <div className="space-y-1.5">
                    {filteredBookings.map((booking) => {
                      const key = bookingStatusKey(booking.status);
                      const statusLabelText = key ? t(key) : booking.status;
                      return (
                        <div
                          key={booking.id}
                          role="button"
                          tabIndex={0}
                          onClick={() => handleBookingClick(booking.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              handleBookingClick(booking.id);
                            }
                          }}
                          className="group flex cursor-pointer items-center justify-between gap-3 rounded-md border border-zinc-200/80 bg-white px-3 py-2 transition hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700 dark:hover:bg-zinc-800/50 shadow-2xs"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-semibold text-zinc-900 group-hover:text-amber-600 dark:text-zinc-100 dark:group-hover:text-amber-400">
                              {booking.serviceName || booking.title}
                            </p>
                            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                              {formatDateTime(booking.scheduledAt)}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <StatusDot
                              variant={STATUS_DOT[booking.status] ?? 'neutral'}
                              label={statusLabelText}
                            />
                            <span className={`text-xs font-medium ${STATUS_TEXT[booking.status] ?? 'text-zinc-500'}`}>
                              {statusLabelText}
                            </span>
                            <IconExternalLink className="size-3.5 text-zinc-400 opacity-0 transition-opacity group-hover:opacity-100" />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <div className="flex w-full items-center justify-end gap-2">
              {onEdit && contact && (
                <Button
                  label={t('common.edit')}
                  variant="secondary"
                  size="sm"
                  icon={<IconEdit className="size-3.5" />}
                  onClick={() => {
                    onOpenChange(false);
                    onEdit(contact);
                  }}
                />
              )}
              <Button
                label={t('common.close')}
                variant="secondary"
                size="sm"
                onClick={() => onOpenChange(false)}
              />
            </div>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
