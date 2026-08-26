import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import type { TFunction } from 'i18next';
import { Trans, useTranslation } from 'react-i18next';
import {
  Badge,
  Button,
  Dialog,
  DialogHeader,
  Layout,
  LayoutContent,
  LayoutFooter,
  MetadataList,
  MetadataListItem,
  Pagination,
  Selector,
  SelectorOption,
  Skeleton,
  StatusDot,
  Tab,
  TabList,
  TextInput,
  paginateData,
  type StatusDotVariant,
} from '@astryxdesign/core';

import { ApiError, apiFetch } from '../../lib/api';
import { tintedBadgeVariant } from '../../lib/badge-variant';
import type { BookingRecord, BookingsListResponse } from '../../lib/bookings';
import {
  formatServiceDuration,
  formatServicePrice,
  type ServiceRecord,
  type ServiceResponse,
} from '../../lib/services';
import type { StaffRecord } from '../../lib/staff';
import { useWorkspaceStore } from '../../stores/workspace';
import { formatDate, formatDateTime } from '../../i18n/format';
import { bookingStatusKey } from '../../i18n/enums';
import {
  IconAlertTriangle,
  IconBookmark,
  IconCalendar,
  IconClock,
  IconCreditCard,
  IconEdit,
  IconExternalLink,
  IconSearch,
  IconServices,
  IconUsers,
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

/**
 * Teks array legacy JSON/PG: string -> list of items.
 */
function expandCategories(categories: string[] | null | undefined): string[] {
  if (!categories || categories.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const cat of categories) {
    const clean = cat.trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

export interface ServiceDetailDialogProps {
  serviceId?: string | null;
  initialService?: ServiceRecord | null;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onEdit?: (service: ServiceRecord) => void;
  staffData?: StaffRecord[];
}

export function ServiceDetailDialog({
  serviceId,
  initialService,
  isOpen,
  onOpenChange,
  onEdit,
  staffData,
}: ServiceDetailDialogProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const [activeTab, setActiveTab] = useState<'info' | 'bookings'>('info');

  // Filter untuk riwayat booking di drawer
  const [bookingSearch, setBookingSearch] = useState('');
  const [bookingStatusFilter, setBookingStatusFilter] = useState<string>('');

  const effectiveId = serviceId || initialService?.id;

  const serviceQuery = useQuery({
    queryKey: ['service', activeWorkspaceId, effectiveId],
    queryFn: () => apiFetch<ServiceResponse>(`/services/${effectiveId}`),
    enabled: isOpen && Boolean(effectiveId),
    initialData: initialService ? { service: initialService } : undefined,
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 1,
  });

  const service = serviceQuery.data?.service ?? initialService;

  // Staf query jika belum dipass
  const staffQuery = useQuery({
    queryKey: ['staff', activeWorkspaceId],
    queryFn: () => apiFetch<{ staff: StaffRecord[] }>('/staff'),
    enabled: isOpen && !staffData && Boolean(activeWorkspaceId),
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 1,
  });

  const staffList = staffData ?? staffQuery.data?.staff ?? [];
  const staffNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const staff of staffList) map.set(staff.id, staff.name);
    return map;
  }, [staffList]);

  // Cari riwayat booking untuk layanan ini
  const bookingsQuery = useQuery({
    queryKey: ['service-bookings', activeWorkspaceId, service?.id, service?.name],
    queryFn: async () => {
      if (!service?.id && !service?.name) return { bookings: [], total: 0 };
      const params = new URLSearchParams();
      params.set('pageSize', '100');
      return apiFetch<BookingsListResponse>(`/bookings?${params.toString()}`);
    },
    enabled: isOpen && Boolean(service?.id || service?.name),
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 1,
  });

  const allBookings = useMemo(() => {
    if (!service) return [];
    return (bookingsQuery.data?.bookings ?? []).filter(
      (b) => b.serviceId === service.id || b.serviceName === service.name || b.title === service.name,
    );
  }, [bookingsQuery.data?.bookings, service]);

  const filteredBookings = useMemo(() => {
    return allBookings.filter((b) => {
      if (bookingStatusFilter && b.status !== bookingStatusFilter) {
        return false;
      }
      if (bookingSearch.trim()) {
        const q = bookingSearch.toLowerCase().trim();
        const matchCustomer = b.customerName?.toLowerCase().includes(q);
        const matchPhone = b.phone?.toLowerCase().includes(q);
        const matchTitle = b.title?.toLowerCase().includes(q);
        if (!matchCustomer && !matchPhone && !matchTitle) return false;
      }
      return true;
    });
  }, [allBookings, bookingStatusFilter, bookingSearch]);

  const BOOKINGS_PAGE_SIZE = 5;
  const [bookingPage, setBookingPage] = useState(1);

  // Reset page saat filter/search berubah atau dialog dibuka
  useEffect(() => {
    setBookingPage(1);
  }, [bookingSearch, bookingStatusFilter, isOpen, service?.id]);

  const lastBookingPage = filteredBookings.length
    ? Math.max(1, Math.ceil(filteredBookings.length / BOOKINGS_PAGE_SIZE))
    : 1;

  useEffect(() => {
    if (bookingPage > lastBookingPage) {
      setBookingPage(lastBookingPage);
    }
  }, [filteredBookings.length, bookingPage, lastBookingPage]);

  const pagedBookings = useMemo(() => {
    return paginateData(filteredBookings, bookingPage, BOOKINGS_PAGE_SIZE);
  }, [filteredBookings, bookingPage]);

  const handleBookingClick = (bookingId: string) => {
    onOpenChange(false);
    navigate(`/app/bookings/${bookingId}`);
  };

  const categories = expandCategories(service?.category);
  const formattedPrice = service ? formatServicePrice(service.priceMinor, service.currency) : null;
  const formattedDuration = service ? formatServiceDuration(service.durationMinutes) : null;

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
              title={service?.name ?? t('serviceDetail.title', { defaultValue: 'Service' })}
              subtitle={
                service?.createdAt
                  ? t('serviceDetail.createdAt', {
                      date: formatDate(service.createdAt),
                      defaultValue: `Added ${formatDate(service.createdAt)}`,
                    })
                  : t('serviceDetail.description', { defaultValue: 'Service details' })
              }
              startContent={
                <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-zinc-200 dark:border-zinc-700/60 bg-zinc-100 dark:bg-zinc-800 text-amber-600 dark:text-amber-400">
                  <IconServices className="size-4" />
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
                  label={t('serviceDetail.info', { defaultValue: 'Service details' })}
                  icon={<IconServices className="size-4" />}
                />
                <Tab
                  value="bookings"
                  label={t('serviceDetail.bookingHistory', { defaultValue: 'Bookings' })}
                  icon={<IconCalendar className="size-4" />}
                  endContent={
                    allBookings.length > 0 ? (
                      <Badge variant="neutral" label={String(allBookings.length)} />
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
              {serviceQuery.isPending && !service && (
                <div className="space-y-3">
                  <Skeleton width="100%" height={80} />
                  <Skeleton width="100%" height={140} />
                </div>
              )}

              {serviceQuery.isError && !service && (
                <Card className="flex flex-col items-center gap-3 p-6 text-center">
                  <IconAlertTriangle className="size-6 text-red-500" />
                  <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                    {t('serviceDetail.notFound', {
                      defaultValue: 'This service no longer exists. It may have been deleted.',
                    })}
                  </p>
                </Card>
              )}

              {service && activeTab === 'info' && (
                <div className="py-1">
                  <MetadataList
                    columns="single"
                    label={{ position: 'start', width: 140 }}
                  >
                    <MetadataListItem label={t('common.status')}>
                      <div className="flex items-center gap-1.5">
                        <StatusDot
                          variant={service.isActive ? 'success' : 'neutral'}
                          label={service.isActive ? t('services.active') : t('services.inactive')}
                        />
                        <span
                          className={`text-sm font-semibold ${
                            service.isActive
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : 'text-zinc-500 dark:text-zinc-400'
                          }`}
                        >
                          {service.isActive ? t('services.active') : t('services.inactive')}
                        </span>
                      </div>
                    </MetadataListItem>

                    <MetadataListItem
                      label={t('services.colDuration')}
                      icon={<IconClock className="size-4 text-zinc-400" />}
                    >
                      <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                        {formattedDuration}
                      </span>
                    </MetadataListItem>

                    <MetadataListItem
                      label={t('services.colPrice')}
                      icon={<IconCreditCard className="size-4 text-zinc-400" />}
                    >
                      <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                        {formattedPrice ?? <span className="text-zinc-400 font-normal">—</span>}
                      </span>
                    </MetadataListItem>

                    <MetadataListItem
                      label={t('services.colCategory')}
                      icon={<IconBookmark className="size-4 text-zinc-400" />}
                    >
                      {categories.length > 0 ? (
                        <div className="flex flex-wrap gap-1.5">
                          {categories.map((cat) => (
                            <Badge key={cat} variant={tintedBadgeVariant(cat)} label={cat} />
                          ))}
                        </div>
                      ) : (
                        <span className="text-sm text-zinc-400">—</span>
                      )}
                    </MetadataListItem>

                    <MetadataListItem
                      label={t('services.colStaff')}
                      icon={<IconUsers className="size-4 text-zinc-400" />}
                    >
                      {service.staffIds.length > 0 ? (
                        <div className="flex flex-wrap gap-1.5">
                          {service.staffIds.map((staffId) => {
                            const name = staffNameById.get(staffId) ?? '?';
                            return (
                              <Badge key={staffId} variant={tintedBadgeVariant(name)} label={name} />
                            );
                          })}
                        </div>
                      ) : (
                        <span className="text-sm text-zinc-500 dark:text-zinc-400">
                          {t('services.noStaffHint', { defaultValue: 'All staff' })}
                        </span>
                      )}
                    </MetadataListItem>

                    {service.description && (
                      <MetadataListItem label={t('services.descriptionLabel')}>
                        <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
                          {service.description}
                        </p>
                      </MetadataListItem>
                    )}
                  </MetadataList>
                </div>
              )}

              {service && activeTab === 'bookings' && (
                <div className="space-y-2.5">
                  {/* Filter & Search Bar */}
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <TextInput
                        label={t('common.name')}
                        isLabelHidden
                        placeholder={t('contacts.filterNamePlaceholder', {
                          defaultValue: 'Search customer…',
                        })}
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
                            icon: (
                              <StatusDot
                                variant={STATUS_DOT[status]}
                                label={statusLabel(status, t)}
                              />
                            ),
                          })),
                        ]}
                        value={bookingStatusFilter}
                        onChange={(value) => setBookingStatusFilter(value || '')}
                        width="100%"
                        renderOption={(option) => (
                          <SelectorOption
                            icon={option.icon}
                            label={
                              <span
                                className={
                                  STATUS_TEXT[option.value] ?? 'text-zinc-500 dark:text-zinc-400'
                                }
                              >
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
                        : t('serviceDetail.noBookings', {
                            defaultValue: 'No bookings found for this service.',
                          })}
                    </div>
                  )}

                  {/* List Booking Item */}
                  <div className="space-y-1.5">
                    {pagedBookings.map((booking) => {
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
                              {booking.customerName || booking.phone || booking.title}
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
                            <span
                              className={`text-xs font-medium ${STATUS_TEXT[booking.status] ?? 'text-zinc-500'}`}
                            >
                              {statusLabelText}
                            </span>
                            <IconExternalLink className="size-3.5 text-zinc-400 opacity-0 transition-opacity group-hover:opacity-100" />
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {filteredBookings.length > BOOKINGS_PAGE_SIZE && (
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-zinc-100 pt-2.5 dark:border-zinc-800">
                      <p className="text-xs text-zinc-400">
                        <Trans
                          i18nKey="bookings.showingRows"
                          values={{ shown: pagedBookings.length, total: filteredBookings.length }}
                          components={{
                            strong: <strong className="font-semibold text-zinc-700 dark:text-zinc-300" />,
                          }}
                        />
                      </p>
                      <Pagination
                        page={bookingPage}
                        onChange={setBookingPage}
                        totalItems={filteredBookings.length}
                        pageSize={BOOKINGS_PAGE_SIZE}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <div className="flex w-full items-center justify-end gap-2">
              {onEdit && service && (
                <Button
                  label={t('common.edit')}
                  variant="secondary"
                  size="sm"
                  icon={<IconEdit className="size-3.5" />}
                  onClick={() => {
                    onOpenChange(false);
                    onEdit(service);
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
