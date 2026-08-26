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
import type { ServiceRecord } from '../../lib/services';
import {
  type StaffRecord,
  type StaffResponse,
  WEEKDAY_LABEL_KEYS,
} from '../../lib/staff';
import { useWorkspaceStore } from '../../stores/workspace';
import { formatDate, formatDateTime } from '../../i18n/format';
import { bookingStatusKey } from '../../i18n/enums';
import {
  IconAlertTriangle,
  IconBookmark,
  IconCalendar,
  IconCheck,
  IconClock,
  IconCopy,
  IconEdit,
  IconExternalLink,
  IconMail,
  IconPhone,
  IconSearch,
  IconStaff,
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

/** Konversi menit sejak tengah malam → "HH:MM". */
function toTimeString(minutes: number): string {
  const h = Math.floor(Math.max(0, minutes) / 60);
  const m = Math.max(0, minutes) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export interface StaffDetailDialogProps {
  staffId?: string | null;
  initialStaff?: StaffRecord | null;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onEdit?: (staff: StaffRecord) => void;
  onSchedule?: (staff: StaffRecord) => void;
  servicesData?: ServiceRecord[];
}

export function StaffDetailDialog({
  staffId,
  initialStaff,
  isOpen,
  onOpenChange,
  onEdit,
  onSchedule,
  servicesData,
}: StaffDetailDialogProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const [activeTab, setActiveTab] = useState<'info' | 'bookings'>('info');

  // Filter untuk riwayat booking di drawer
  const [bookingSearch, setBookingSearch] = useState('');
  const [bookingStatusFilter, setBookingStatusFilter] = useState<string>('');
  const [copiedField, setCopiedField] = useState<'email' | 'phone' | null>(null);

  const effectiveId = staffId || initialStaff?.id;

  const staffQuery = useQuery({
    queryKey: ['staff-detail', activeWorkspaceId, effectiveId],
    queryFn: () => apiFetch<StaffResponse>(`/staff/${effectiveId}`),
    enabled: isOpen && Boolean(effectiveId),
    initialData: initialStaff ? { staff: initialStaff } : undefined,
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 1,
  });

  const staff = staffQuery.data?.staff ?? initialStaff;

  // Query layanan jika belum dipass
  const servicesQuery = useQuery({
    queryKey: ['services', activeWorkspaceId],
    queryFn: () => apiFetch<{ services: ServiceRecord[] }>('/services'),
    enabled: isOpen && !servicesData && Boolean(activeWorkspaceId),
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 1,
  });

  const servicesList = servicesData ?? servicesQuery.data?.services ?? [];

  // Layanan yang ditugaskan ke staf ini
  const assignedServices = useMemo(() => {
    if (!staff) return [];
    return servicesList.filter(
      (s: ServiceRecord) => s.staffIds.includes(staff.id) || s.staffIds.length === 0,
    );
  }, [servicesList, staff]);

  // Cari riwayat booking untuk staf ini
  const bookingsQuery = useQuery({
    queryKey: ['staff-bookings', activeWorkspaceId, staff?.id, staff?.name],
    queryFn: async () => {
      if (!staff?.id && !staff?.name) return { bookings: [], total: 0 };
      const params = new URLSearchParams();
      params.set('pageSize', '100');
      return apiFetch<BookingsListResponse>(`/bookings?${params.toString()}`);
    },
    enabled: isOpen && Boolean(staff?.id || staff?.name),
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 1,
  });

  const allBookings = useMemo(() => {
    if (!staff) return [];
    return (bookingsQuery.data?.bookings ?? []).filter(
      (b) => b.staffId === staff.id,
    );
  }, [bookingsQuery.data?.bookings, staff]);

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
  }, [bookingSearch, bookingStatusFilter, isOpen, staff?.id]);

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

  const copyToClipboard = (text: string, field: 'email' | 'phone') => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => {
      setCopiedField((curr) => (curr === field ? null : curr));
    }, 2000);
  };

  // Jadwal unik per hari
  const scheduleDays = useMemo(() => {
    if (!staff) return [];
    const map = new Map<number, string[]>();
    for (const s of staff.schedules) {
      const timeStr = `${toTimeString(s.startMinutes)} – ${toTimeString(s.endMinutes)}`;
      const existing = map.get(s.dayOfWeek) ?? [];
      existing.push(timeStr);
      map.set(s.dayOfWeek, existing);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a - b);
  }, [staff]);

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open && document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        if (!open) {
          setActiveTab('info');
          setBookingSearch('');
          setBookingStatusFilter('');
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
              title={staff?.name ?? t('staffDetail.title', { defaultValue: 'Staff' })}
              subtitle={
                staff?.createdAt
                  ? t('staffDetail.createdAt', {
                      date: formatDate(staff.createdAt),
                      defaultValue: `Added ${formatDate(staff.createdAt)}`,
                    })
                  : staff?.email ?? staff?.phone ?? t('staffDetail.description', { defaultValue: 'Staff details' })
              }
              startContent={
                <div className="size-8 shrink-0 overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-700/60 bg-zinc-100 dark:bg-zinc-800">
                  <img
                    src={`https://api.dicebear.com/10.x/critters/svg?seed=${encodeURIComponent((staff?.name || staff?.id) ?? 'staff')}`}
                    alt={staff?.name ?? 'Staff'}
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
                  label={t('staffDetail.info', { defaultValue: 'Staff info' })}
                  icon={<IconStaff className="size-4" />}
                />
                <Tab
                  value="bookings"
                  label={t('staffDetail.bookingHistory', { defaultValue: 'Bookings' })}
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
              {staffQuery.isPending && !staff && (
                <div className="space-y-3">
                  <Skeleton width="100%" height={80} />
                  <Skeleton width="100%" height={140} />
                </div>
              )}

              {staffQuery.isError && !staff && (
                <Card className="flex flex-col items-center gap-3 p-6 text-center">
                  <IconAlertTriangle className="size-6 text-red-500" />
                  <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                    {t('staffDetail.notFound', {
                      defaultValue: 'This staff member no longer exists. They may have been deleted.',
                    })}
                  </p>
                </Card>
              )}

              {staff && activeTab === 'info' && (
                <div className="py-1">
                  <MetadataList
                    columns="single"
                    label={{ position: 'start', width: 140 }}
                  >
                    <MetadataListItem label={t('common.status')}>
                      <div className="flex items-center gap-1.5">
                        <StatusDot
                          variant={staff.isActive ? 'success' : 'neutral'}
                          label={staff.isActive ? t('staff.active') : t('staff.inactive')}
                        />
                        <span
                          className={`text-sm font-semibold ${
                            staff.isActive
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : 'text-zinc-500 dark:text-zinc-400'
                          }`}
                        >
                          {staff.isActive ? t('staff.active') : t('staff.inactive')}
                        </span>
                      </div>
                    </MetadataListItem>

                    <MetadataListItem
                      label={t('common.email')}
                      icon={<IconMail className="size-4 text-zinc-400" />}
                    >
                      {staff.email ? (
                        <div className="flex items-center justify-between gap-2">
                          <a
                            href={`mailto:${staff.email}`}
                            className="truncate text-sm font-semibold text-zinc-900 transition hover:text-amber-600 dark:text-zinc-100 dark:hover:text-amber-400"
                          >
                            {staff.email}
                          </a>
                          <button
                            type="button"
                            onClick={() => copyToClipboard(staff.email!, 'email')}
                            title={t('contactDetail.copyEmail', { defaultValue: 'Copy email' })}
                            className="flex size-6 items-center justify-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 cursor-pointer"
                          >
                            {copiedField === 'email' ? (
                              <IconCheck className="size-3.5 text-emerald-600" />
                            ) : (
                              <IconCopy className="size-3.5" />
                            )}
                          </button>
                        </div>
                      ) : (
                        <span className="text-sm text-zinc-400">—</span>
                      )}
                    </MetadataListItem>

                    <MetadataListItem
                      label={t('common.phone')}
                      icon={<IconPhone className="size-4 text-zinc-400" />}
                    >
                      {staff.phone ? (
                        <div className="flex items-center justify-between gap-2">
                          <a
                            href={`tel:${staff.phone}`}
                            className="truncate text-sm font-semibold text-zinc-900 transition hover:text-amber-600 dark:text-zinc-100 dark:hover:text-amber-400"
                          >
                            {staff.phone}
                          </a>
                          <button
                            type="button"
                            onClick={() => copyToClipboard(staff.phone!, 'phone')}
                            title={t('contactDetail.copyPhone', { defaultValue: 'Copy phone' })}
                            className="flex size-6 items-center justify-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 cursor-pointer"
                          >
                            {copiedField === 'phone' ? (
                              <IconCheck className="size-3.5 text-emerald-600" />
                            ) : (
                              <IconCopy className="size-3.5" />
                            )}
                          </button>
                        </div>
                      ) : (
                        <span className="text-sm text-zinc-400">—</span>
                      )}
                    </MetadataListItem>

                    <MetadataListItem
                      label={t('staff.timezone')}
                      icon={<IconClock className="size-4 text-zinc-400" />}
                    >
                      <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                        {staff.timezone}
                      </span>
                    </MetadataListItem>

                    <MetadataListItem
                      label={t('staff.colBuffer')}
                      icon={<IconClock className="size-4 text-zinc-400" />}
                    >
                      <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                        {staff.bufferMinutes > 0
                          ? t('staff.bufferShort', { minutes: staff.bufferMinutes })
                          : '—'}
                      </span>
                    </MetadataListItem>

                    <MetadataListItem
                      label={t('staffDetail.assignedServices', { defaultValue: 'Assigned services' })}
                      icon={<IconBookmark className="size-4 text-zinc-400" />}
                    >
                      {assignedServices.length > 0 ? (
                        <div className="flex flex-wrap gap-1.5">
                          {assignedServices.map((srv: ServiceRecord) => (
                            <Badge
                              key={srv.id}
                              variant={tintedBadgeVariant(srv.name)}
                              label={srv.name}
                            />
                          ))}
                        </div>
                      ) : (
                        <span className="text-sm text-zinc-500 dark:text-zinc-400">
                          {t('staffDetail.noServicesAssigned', {
                            defaultValue: 'All general services',
                          })}
                        </span>
                      )}
                    </MetadataListItem>

                    <MetadataListItem
                      label={t('staffDetail.schedule', { defaultValue: 'Working schedule' })}
                      icon={<IconCalendar className="size-4 text-zinc-400" />}
                    >
                      {scheduleDays.length > 0 ? (
                        <div className="space-y-1">
                          {scheduleDays.map(([dayOfWeek, ranges]) => {
                            const labelKey = WEEKDAY_LABEL_KEYS[dayOfWeek];
                            return (
                              <div
                                key={dayOfWeek}
                                className="flex items-center justify-between gap-2 text-xs text-zinc-600 dark:text-zinc-300"
                              >
                                <span className="font-medium">
                                  {labelKey ? t(labelKey) : `Day ${dayOfWeek}`}
                                </span>
                                <span>{ranges.join(', ')}</span>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <span className="text-sm text-zinc-400">
                          {t('staff.noScheduleHint', { defaultValue: 'No schedule configured' })}
                        </span>
                      )}
                    </MetadataListItem>
                  </MetadataList>
                </div>
              )}

              {staff && activeTab === 'bookings' && (
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
                        : t('staffDetail.noBookings', {
                            defaultValue: 'No bookings found for this staff member.',
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
              {onSchedule && staff && (
                <Button
                  label={t('staff.editSchedule')}
                  variant="secondary"
                  size="sm"
                  icon={<IconCalendar className="size-3.5" />}
                  onClick={() => {
                    onOpenChange(false);
                    onSchedule(staff);
                  }}
                />
              )}
              {onEdit && staff && (
                <Button
                  label={t('common.edit')}
                  variant="secondary"
                  size="sm"
                  icon={<IconEdit className="size-3.5" />}
                  onClick={() => {
                    onOpenChange(false);
                    onEdit(staff);
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
