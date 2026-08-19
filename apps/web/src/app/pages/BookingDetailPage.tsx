import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import {
  Badge,
  Button,
  DateInput,
  Dialog,
  DialogHeader,
  DropdownMenu,
  DropdownMenuItem,
  Layout,
  LayoutContent,
  LayoutFooter,
  Selector,
  Skeleton,
  TextArea,
  TextInput,
  TimeInput,
  type BadgeVariant,
  type ISODateString,
  type ISOTimeString,
} from '@astryxdesign/core';
import type { GoalCustomization } from '@oriole/call-goals';
import { dayjs } from '../../lib/dayjs-setup';

import { ApiError, apiFetch } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import type { BookingDetailResponse, BookingRecord, CallRecord } from '../../lib/bookings';
import type { StaffListResponse } from '../../lib/staff';
import type { ServicesListResponse } from '../../lib/services';
import {
  callDurationParts,
  callSummaryText,
  deriveCallOutcome,
  type CallDurationParts,
  type CallOutcome,
} from '../../lib/booking-detail';
import { useWorkspaceStore } from '../../stores/workspace';
import { PhoneInput } from '../components/PhoneInput';
import { bookingStatusKey, callStatusKey } from '../../i18n/enums';
import { formatDateTime, formatShortDateTime } from '../../i18n/format';
import type { TranslationKey } from '../../i18n';
import { AiBehaviorCard } from '../shell/AiBehaviorCard';
import { Card, ConfirmDialog, PageHeader } from '../shell/ui';
import {
  IconAlertTriangle,
  IconArrowRight,
  IconCalendar,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconDotsHorizontal,
  IconEdit,
  IconPhone,
  IconRepeat,
  IconX,
} from '../shell/icons';

/** Warna status booking → variant Badge Astryx. */
const STATUS_BADGE: Record<BookingRecord['status'], BadgeVariant> = {
  pending: 'warning',
  confirmed: 'success',
  cancelled: 'error',
  completed: 'neutral',
};

/** Warna status panggilan CALL-E → variant Badge Astryx. */
function callStatusBadge(status: string | null): BadgeVariant {
  if (status === 'completed' || status === 'success') return 'success';
  if (status === 'failed' || status === 'error') return 'error';
  return 'neutral';
}

function statusLabel(status: string | null, t: TFunction): string {
  const key = bookingStatusKey(status);
  return key ? t(key) : (status ?? '');
}

/** Label status panggilan CALL-E (Completed/Failed/Queued/...) via katalog i18n. */
function callStatusLabel(status: string | null, t: TFunction): string {
  const key = callStatusKey(status);
  return key ? t(key) : (status ?? '');
}

/** Tampilan hero per outcome AI call — label, kalimat ringkasan, ikon, warna. */
const OUTCOME_META: Record<
  CallOutcome,
  { labelKey: TranslationKey; summaryKey: TranslationKey; icon: ReactNode; dotClass: string }
> = {
  confirmed: {
    labelKey: 'bookingDetail.outcome.confirmed',
    summaryKey: 'bookingDetail.summary.confirmed',
    icon: <IconCheck className="size-4" />,
    dotClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400',
  },
  'reschedule-requested': {
    labelKey: 'bookingDetail.outcome.reschedule',
    summaryKey: 'bookingDetail.summary.reschedule',
    icon: <IconCalendar className="size-4" />,
    dotClass: 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400',
  },
  cancelled: {
    labelKey: 'bookingDetail.outcome.cancelled',
    summaryKey: 'bookingDetail.summary.cancelled',
    icon: <IconX className="size-4" />,
    dotClass: 'bg-red-100 text-red-600 dark:bg-red-950/50 dark:text-red-400',
  },
  'no-answer': {
    labelKey: 'bookingDetail.outcome.noAnswer',
    summaryKey: 'bookingDetail.summary.noAnswer',
    icon: <IconPhone className="size-4" />,
    dotClass: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
  },
  failed: {
    labelKey: 'bookingDetail.outcome.failed',
    summaryKey: 'bookingDetail.summary.failed',
    icon: <IconAlertTriangle className="size-4" />,
    dotClass: 'bg-red-100 text-red-600 dark:bg-red-950/50 dark:text-red-400',
  },
  unknown: {
    labelKey: 'bookingDetail.outcome.unknown',
    summaryKey: 'bookingDetail.summary.unknown',
    icon: <IconPhone className="size-4" />,
    dotClass: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
  },
};

/** Warna dot kecil di baris Call History — selaras dengan OUTCOME_META. */
const OUTCOME_DOT: Record<CallOutcome, string> = {
  confirmed: 'bg-emerald-500',
  'reschedule-requested': 'bg-amber-500',
  cancelled: 'bg-red-500',
  failed: 'bg-red-500',
  'no-answer': 'bg-zinc-300 dark:bg-zinc-600',
  unknown: 'bg-zinc-300 dark:bg-zinc-600',
};

/** Kalimat ringkasan hasil AI call — dari outcome (kalimat turunan). */
function outcomeSummary(outcome: CallOutcome, name: string, date: string, t: TFunction): string {
  return t(OUTCOME_META[outcome].summaryKey, { name, date });
}

/** Durasi panggilan → label (\"32 sec\", \"2 min\", \"2 min 5 sec\"). */
function formatCallDuration(parts: CallDurationParts | null, t: TFunction): string {
  if (!parts) return '—';
  if (parts.minutes === 0) return t('bookingDetail.durationSeconds', { count: parts.seconds });
  if (parts.seconds === 0) return t('bookings.duration', { count: parts.minutes });
  return t('bookingDetail.durationMinSec', { count: parts.minutes, sec: parts.seconds });
}

/** Kartu seksi detail — judul uppercase + aksi opsional + konten. */
function DetailSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border-t border-zinc-100 pt-4 dark:border-zinc-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold uppercase tracking-wider text-blue-600 dark:text-blue-400">{title}</h2>
        {action}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Baris label/nilai — dipakai di kartu Appointment & detail panggilan. */
function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-3">
      <dt className="shrink-0 text-sm font-semibold text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className="min-w-0 truncate text-base font-medium text-zinc-900 dark:text-zinc-100">{value}</dd>
    </div>
  );
}

export function BookingDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);

  // ── Form edit booking (dialog) ─────────────────────────────
  const [isEditing, setIsEditing] = useState(false);
  // Title tidak diedit manual — booking diambil dari layanan katalog.
  const [editCustomerName, setEditCustomerName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editDate, setEditDate] = useState<ISODateString | undefined>(undefined);
  const [editTime, setEditTime] = useState<ISOTimeString | undefined>(undefined);
  const [editDescription, setEditDescription] = useState('');
  const [editStaffId, setEditStaffId] = useState('');
  const [editServiceId, setEditServiceId] = useState('');
  const [editError, setEditError] = useState<string | null>(null);

  // ── Konfirmasi aksi header: cancel / delete ────────────────
  const [cancelOpen, setCancelOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [headerError, setHeaderError] = useState<string | null>(null);

  // ── Panel kustomisasi AI (accordion) ───────────────────────
  const [aiCustomizeOpen, setAiCustomizeOpen] = useState(false);

  const startEdit = (booking: BookingRecord) => {
    setEditCustomerName(booking.customerName ?? '');
    setEditPhone(booking.phone ?? '');
    const dt = dayjs(booking.scheduledAt);
    setEditDate(dt.format('YYYY-MM-DD') as ISODateString);
    setEditTime(dt.format('HH:mm') as ISOTimeString);
    setEditDescription(booking.description ?? '');
    setEditStaffId(booking.staffId ?? '');
    setEditServiceId(booking.serviceId ?? '');
    setEditError(null);
    setIsEditing(true);
  };

  const submitEdit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!id) return;
    setEditError(null);
    if (!editDate || !editTime) return;
    const scheduledAt = new Date(`${editDate}T${editTime}`).toISOString();
    // serviceId hanya dikirim saat BERUBAH — mengirimnya selalu akan membuat
    // server auto-fill durationMinutes dari layanan, menimpa durasi kustom.
    const fields: {
      customerName: string | null;
      phone: string | null;
      scheduledAt: string;
      description: string | null;
      staffId: string | null;
      serviceId?: string | null;
    } = {
      customerName: editCustomerName.trim() || null,
      phone: editPhone.trim() || null,
      scheduledAt,
      description: editDescription.trim() || null,
      staffId: editStaffId || null,
    };
    if (editServiceId !== (data?.booking.serviceId ?? '')) {
      fields.serviceId = editServiceId || null;
    }
    editBookingMutation.mutate(fields);
  };

  const editBookingMutation = useMutation({
    mutationFn: (fields: {
      customerName: string | null;
      phone: string | null;
      scheduledAt: string;
      description: string | null;
      staffId: string | null;
      serviceId?: string | null;
    }) =>
      apiFetch(`/bookings/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(fields),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['booking', activeWorkspaceId, id] });
      queryClient.invalidateQueries({ queryKey: ['bookings', activeWorkspaceId] });
      setIsEditing(false);
    },
    onError: (err) => {
      setEditError(errorMessage(err, t, 'errors.saveBooking'));
    },
  });

  const statusMutation = useMutation({
    mutationFn: (status: BookingRecord['status']) =>
      apiFetch(`/bookings/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['booking', activeWorkspaceId, id] });
      queryClient.invalidateQueries({ queryKey: ['bookings', activeWorkspaceId] });
      setCancelOpen(false);
    },
    onError: (err) => {
      setHeaderError(errorMessage(err, t, 'errors.changeStatus'));
    },
  });

  const { data, isPending, isError, error } = useQuery({
    queryKey: ['booking', activeWorkspaceId, id],
    queryFn: () => apiFetch<BookingDetailResponse>(`/bookings/${id}`),
    enabled: Boolean(id),
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 1,
  });

  const customization: GoalCustomization | null =
    data && (data.booking.goalType || data.booking.customInstruction)
      ? {
          goalType: (data.booking.goalType as GoalCustomization['goalType']) ?? undefined,
          customInstruction: data.booking.customInstruction ?? undefined,
        }
      : null;

  // Nama staf + opsi penugasan (staf aktif + staf yang sedang ditugaskan).
  const { data: staffPage } = useQuery({
    queryKey: ['staff', activeWorkspaceId],
    queryFn: () => apiFetch<StaffListResponse>('/staff'),
    enabled: Boolean(activeWorkspaceId),
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 1,
  });
  const staffName = staffPage?.staff.find((staff) => staff.id === data?.booking.staffId)?.name;
  const staffOptions = useMemo(() => {
    const assignedId = data?.booking.staffId;
    const list =
      staffPage?.staff.filter((staff) => staff.isActive || staff.id === assignedId) ?? [];
    return list.map((staff) => ({ value: staff.id, label: staff.name }));
  }, [staffPage, data]);

  // Layanan katalog — nama untuk kartu Appointment + opsi edit.
  const { data: servicesPage } = useQuery({
    queryKey: ['services', activeWorkspaceId],
    queryFn: () => apiFetch<{ services: ServicesListResponse['services'] }>('/services'),
    enabled: Boolean(activeWorkspaceId),
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 1,
  });
  const serviceOptions = useMemo(() => {
    const currentId = data?.booking.serviceId;
    const list =
      servicesPage?.services.filter((service) => service.isActive || service.id === currentId) ?? [];
    return list.map((service) => ({ value: service.id, label: service.name }));
  }, [servicesPage, data]);

  const isAuthExpiry = error instanceof ApiError && error.status === 401;

  if (isPending) {
    // Skeleton seluruh halaman — meniru struktur header + kartu seksi yang
    // dimuat, jadi tidak ada lompatan layout / area kosong saat data tiba.
    return (
      <div className="space-y-6" aria-busy="true">
        {/* Header skeleton — judul + badge status + tombol aksi */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-baseline sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <Skeleton width={220} height={24} radius={1} />
              <Skeleton width={76} height={22} radius={2} />
            </div>
            <Skeleton className="mt-2.5" width={340} height={14} radius={1} />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Skeleton width={124} height={32} radius={2} />
            <Skeleton width={36} height={32} radius={2} />
          </div>
        </div>

        {/* Bagian Appointment skeleton — 4 baris label/nilai */}
        <div className="border-t border-zinc-100 pt-4 dark:border-zinc-800">
          <Skeleton width={112} height={12} radius={1} />
          <div className="mt-4 space-y-3.5">
            {[0, 1, 2, 3].map((row) => (
              <div key={row} className="flex items-center justify-between gap-6">
                <Skeleton width={84} height={12} radius={1} />
                <Skeleton width="42%" height={12} radius={1} />
              </div>
            ))}
          </div>
        </div>

        {/* Bagian Customer skeleton — identitas + tautan */}
        <div className="border-t border-zinc-100 pt-4 dark:border-zinc-800">
          <Skeleton width={96} height={12} radius={1} />
          <div className="mt-4 space-y-3">
            <Skeleton width={168} height={14} radius={1} />
            <Skeleton width={124} height={12} radius={1} />
            <div className="flex items-center justify-between border-t border-zinc-100 pt-3 dark:border-zinc-800">
              <Skeleton width={110} height={12} radius={1} />
              <Skeleton width={16} height={16} radius={1} />
            </div>
          </div>
        </div>

        {/* Bagian AI Confirmation skeleton — hero dengan ikon + ringkasan */}
        <div className="border-t border-zinc-100 pt-4 dark:border-zinc-800">
          <div className="flex items-center justify-between gap-2">
            <Skeleton width={132} height={12} radius={1} />
            <Skeleton width={96} height={26} radius={2} />
          </div>
          <div className="mt-4 flex items-start gap-3">
            <Skeleton width={36} height={36} radius={3} />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton width="55%" height={14} radius={1} />
              <Skeleton width="85%" height={12} radius={1} />
              <Skeleton width="40%" height={12} radius={1} />
            </div>
          </div>
        </div>

        {/* Bagian Call History skeleton — baris panggilan dengan dot status */}
        <div className="border-t border-zinc-100 pt-4 dark:border-zinc-800">
          <Skeleton width={120} height={12} radius={1} />
          <div className="mt-4 space-y-4">
            {[0, 1].map((row) => (
              <div key={row} className="flex items-start gap-3">
                <Skeleton className="mt-1.5" width={8} height={8} radius={4} />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <Skeleton width="32%" height={12} radius={1} />
                    <Skeleton width={64} height={18} radius={2} />
                  </div>
                  <Skeleton width="70%" height={12} radius={1} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (isError && !isAuthExpiry && !data) {
    return (
      <Card className="flex flex-col items-center gap-4 p-10 text-center">
        <span className="flex size-12 items-center justify-center rounded-2xl bg-red-50 text-red-500 dark:bg-red-950/50 dark:text-red-400">
          <IconAlertTriangle className="size-6" />
        </span>
        <div>
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t('errors.bookingNotFoundTitle')}</h3>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            {error instanceof Error ? error.message : t('errors.bookingLoadBody')}
          </p>
        </div>
        <Link to="/app/bookings" className="text-sm font-semibold text-amber-600 hover:text-amber-700">
          {t('common.back')}
        </Link>
      </Card>
    );
  }

  if (!data) return null;

  const { booking, bookingContext, business, autoGoal, calls } = data;
  const isActive = booking.status === 'pending' || booking.status === 'confirmed';
  const serviceLabel = booking.serviceName ?? t('bookingDetail.unknownService');
  const customerName = booking.customerName ?? t('common.noName');

  // ── Hero AI confirmation — call terbaru, outcome bahasa bisnis ──
  const latestCall: CallRecord | null = calls[0] ?? null;
  const outcome = deriveCallOutcome(latestCall, {
    bookingCompleted: booking.status === 'completed',
  });
  const outcomeMeta = OUTCOME_META[outcome];
  const explicitSummary = latestCall ? callSummaryText(latestCall) : null;
  const summaryText =
    explicitSummary ??
    outcomeSummary(outcome, customerName, formatDateTime(booking.scheduledAt), t);
  const callDurationRaw =
    typeof latestCall?.result?.durationSeconds === 'number'
      ? latestCall.result.durationSeconds
      : null;
  const callDuration = latestCall ? callDurationParts(callDurationRaw) : null;

  // Link customer — kontak tertaut, atau one-shot ensure untuk booking lama.
  const contactHref = booking.contactId
    ? `/app/contacts/${booking.contactId}`
    : `/app/contacts/ensure?booking=${booking.id}`;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <>
            <IconCalendar className="size-3.5" aria-hidden="true" />
            {t('bookingDetail.pageLabel')}
          </>
        }
        title={customerName}
        description={t('bookingDetail.headingSubtitle', {
          service: serviceLabel,
          datetime: formatDateTime(booking.scheduledAt),
        })}
        status={<Badge variant={STATUS_BADGE[booking.status]} label={statusLabel(booking.status, t)} />}
      >
        <Link
          to="/app/bookings"
          className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 text-base font-medium text-zinc-700 dark:text-zinc-300 shadow-sm transition hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100 hover:border-zinc-300 dark:hover:border-zinc-600 active:scale-[0.98]"
        >
          <IconChevronLeft className="size-4" />
          {t('bookingDetail.backToBookings')}
        </Link>
        {/* Edit langsung di header — sebelah tombol Back. Pakai markup & kelas
            yang SAMA PERSIS dengan tombol Back (font-size, weight, line-height,
            ikon, border) agar kedua tombol benar-benar identik. */}
        <button
          type="button"
          onClick={() => startEdit(booking)}
          className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 text-base font-medium text-zinc-700 dark:text-zinc-300 shadow-sm transition hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100 hover:border-zinc-300 dark:hover:border-zinc-600 active:scale-[0.98]"
        >
          <IconEdit className="size-4" />
          {t('common.edit')}
        </button>
        {/* Menu ⋯ — hanya berisi aksi yang relevan untuk booking aktif; kalau
            tidak ada (cancelled/completed) tombolnya disembunyikan. */}
        {isActive && (
          <DropdownMenu
            placement="below"
            hasChevron={false}
            menuWidth={200}
            isMenuOpen={moreOpen}
            onOpenChange={setMoreOpen}
            button={{
              label: t('common.moreActions'),
              variant: 'ghost',
              size: 'md',
              isIconOnly: true,
              icon: <IconDotsHorizontal className="size-4 text-zinc-500 dark:text-zinc-400" />,
              style: { border: '1px solid var(--color-border-emphasized)' },
            }}
          >
            <DropdownMenuItem
              icon={<IconX className="size-4 text-red-500" />}
              label={<span className="font-medium text-red-600">{t('bookingDetail.cancelBooking')}</span>}
              onClick={() => {
                setMoreOpen(false);
                setCancelOpen(true);
              }}
            />
          </DropdownMenu>
        )}
      </PageHeader>

      {headerError && (
        <p
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-400"
        >
          {headerError}
        </p>
      )}

      {/* Konten 2 kolom — kiri 7/10 (appointment, AI, call history), kanan 3/10 (customer & notes). */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-10">
        {/* Kolom kiri — 7/10 */}
        <div className="min-w-0 space-y-6 lg:col-span-7">
          {/* ── APPOINTMENT ─────────────────────────────────────── */}
          <DetailSection title={t('bookingDetail.appointment')}>
        <dl className="divide-y divide-zinc-100 dark:divide-zinc-800">
          <InfoRow
            label={t('bookingDetail.service')}
            value={booking.serviceId ? serviceLabel : t('bookingDetail.unknownService')}
          />
          <InfoRow
            label={t('bookingDetail.staff')}
            value={booking.staffId ? (staffName ?? t('bookingDetail.unknownStaff')) : '—'}
          />
          <InfoRow label={t('bookingDetail.dateTime')} value={formatDateTime(booking.scheduledAt)} />
          <InfoRow
            label={t('bookingDetail.durationLabel')}
            value={booking.durationMinutes > 0 ? t('bookings.duration', { count: booking.durationMinutes }) : '—'}
          />
          {booking.timezone && <InfoRow label={t('bookingDetail.timezone')} value={booking.timezone} />}
        </dl>
        {booking.recurrenceSeriesId && (
          <p className="mt-3 flex items-center gap-1.5 text-sm font-medium text-amber-600">
            <IconRepeat className="size-3.5" aria-hidden="true" />
            {t('bookingDetail.recurring')}
          </p>
        )}
      </DetailSection>

      {/* ── AI CONFIRMATION (hero) ──────────────────────────── */}
      <DetailSection
        title={t('bookingDetail.aiConfirmation')}
        action={
          <Button
            label={t('bookingDetail.customizeAi')}
            variant="secondary"
            size="sm"
            icon={
              <IconChevronDown
                className={`size-3.5 transition ${aiCustomizeOpen ? 'rotate-180' : ''}`}
              />
            }
            isDisabled={booking.status === 'cancelled' || booking.status === 'completed'}
            onClick={() => setAiCustomizeOpen((value) => !value)}
          />
        }
      >
        {latestCall ? (
          <div className="flex items-start gap-3">
            <span
              className={`flex size-9 shrink-0 items-center justify-center rounded-xl ${outcomeMeta.dotClass}`}
            >
              {outcomeMeta.icon}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-base font-bold text-zinc-900 dark:text-zinc-100">
                {t(outcomeMeta.labelKey)}
              </p>
              <p className="mt-0.5 text-base leading-relaxed text-zinc-700 dark:text-zinc-300">
                {summaryText}
              </p>
              <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
                {t('bookingDetail.aiCalledBy', { name: customerName })} ·{' '}
                {formatShortDateTime(latestCall.createdAt)}
              </p>
              {(callDuration || explicitSummary) && (
                <dl className="mt-3 grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
                  {callDuration && (
                    <div>
                      <dt className="text-sm font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                        {t('bookingDetail.durationLabel')}
                      </dt>
                      <dd className="mt-0.5 text-base font-medium text-zinc-800 dark:text-zinc-200">
                        {formatCallDuration(callDuration, t)}
                      </dd>
                    </div>
                  )}
                  {explicitSummary && (
                    <div>
                      <dt className="text-sm font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                        {t('bookingDetail.summaryLabel')}
                      </dt>
                      <dd className="mt-0.5 text-base font-medium text-zinc-800 dark:text-zinc-200">
                        {explicitSummary}
                      </dd>
                    </div>
                  )}
                </dl>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500">
              <IconPhone className="size-4" />
            </span>
            <div>
              <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                {t('bookingDetail.noCalls')}
              </p>
              <p className="mt-0.5 text-sm text-zinc-600 dark:text-zinc-400">
                {t('bookingDetail.noCallsDesc')}
              </p>
            </div>
          </div>
        )}
      </DetailSection>

      {/* ── AI behavior — accordion kustomisasi goal (tanpa prompt mentah) ── */}
      <AiBehaviorCard
        booking={bookingContext}
        business={business}
        autoDecision={autoGoal}
        value={customization}
        open={aiCustomizeOpen}
        onOpenChange={setAiCustomizeOpen}
      />

      {/* ── CALL HISTORY ────────────────────────────────────── */}
      <DetailSection title={t('bookingDetail.callHistory', { count: calls.length })}>
        {calls.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('bookingDetail.noCalls')}</p>
        ) : (
          <ul className="space-y-3">
            {calls.map((call) => {
              const callOutcome = deriveCallOutcome(call, {
                bookingCompleted: booking.status === 'completed',
              });
              const callSummary =
                callSummaryText(call) ??
                outcomeSummary(callOutcome, customerName, formatDateTime(booking.scheduledAt), t);
              return (
                <li key={call.id} className="flex items-start gap-3">
                  <span
                    className={`mt-1.5 size-2 shrink-0 rounded-full ${OUTCOME_DOT[callOutcome]}`}
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
                        {formatShortDateTime(call.createdAt)}
                      </p>
                      <Badge
                        variant={callStatusBadge(call.status)}
                        label={callStatusLabel(call.status, t)}
                      />
                    </div>
                    <p className="mt-0.5 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                      {callSummary}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
          {booking.callAttempts.total > 0 && (
            <p className="mt-4 border-t border-zinc-100 pt-3 text-sm text-zinc-500 dark:text-zinc-400 dark:border-zinc-800">
              {t('bookingDetail.attempts', { count: booking.callAttempts.total })}
            </p>
          )}
        </DetailSection>
        </div>

        {/* Kolom kanan — 3/10: Customer & Notes */}
        <div className="min-w-0 space-y-6 lg:col-span-3">
          {/* ── CUSTOMER ────────────────────────────────────────── */}
          <DetailSection title={t('bookingDetail.customer')}>
            {/* Nama & telepon customer = PII — jangan pernah ter-capture analitik. */}
            <div className="ph-no-capture">
              <p className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{customerName}</p>
              <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
                {booking.phone ?? t('bookingDetail.noPhoneYet')}
              </p>
            </div>
            <div className="mt-4 border-t border-zinc-100 pt-3 dark:border-zinc-800">
              <Link
                to={contactHref}
                className="flex items-center justify-between text-sm font-semibold text-amber-600 transition hover:text-amber-700"
              >
                {t('bookingDetail.viewCustomer')}
                <IconArrowRight className="size-4" aria-hidden="true" />
              </Link>
            </div>
          </DetailSection>

          {/* ── NOTES ───────────────────────────────────────────── */}
          <DetailSection
            title={t('common.notes')}
            action={
              <Button
                label={t('common.edit')}
                variant="ghost"
                size="sm"
                icon={<IconEdit className="size-3.5" />}
                onClick={() => startEdit(booking)}
              />
            }
          >
            {booking.description ? (
              <p className="whitespace-pre-wrap text-base leading-relaxed text-zinc-700 dark:text-zinc-300">
                {booking.description}
              </p>
            ) : (
              <p className="text-base text-zinc-500 dark:text-zinc-400">{t('bookingDetail.noNotes')}</p>
            )}
          </DetailSection>
        </div>
      </div>

      {/* ── Dialog edit booking ─────────────────────────────── */}
      <Dialog
        isOpen={isEditing}
        onOpenChange={(open) => {
          if (!open) setIsEditing(false);
        }}
        purpose="info"
        width={520}
        maxHeight="min(85vh, 720px)"
      >
        <Layout
          header={
            <DialogHeader
              title={t('bookingDetail.editBooking')}
              subtitle={t('bookingDetail.editBookingDesc')}
              startContent={<IconEdit className="size-5 shrink-0 text-amber-600" />}
              onOpenChange={() => setIsEditing(false)}
              hasDivider
            />
          }
          content={
            <LayoutContent>
              <form id="edit-booking-form" onSubmit={submitEdit} className="space-y-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <DateInput
                    label={t('common.date')}
                    isRequired
                    value={editDate}
                    onChange={setEditDate}
                    width="100%"
                  />

                  <TimeInput
                    label={t('common.time')}
                    isRequired
                    value={editTime}
                    onChange={setEditTime}
                    hourFormat="24h"
                    width="100%"
                  />
                </div>

                <Selector
                  label={t('bookingDetail.service')}
                  placeholder={t('bookingNew.servicePlaceholder')}
                  options={serviceOptions}
                  value={editServiceId || null}
                  onChange={(value) => setEditServiceId(value ?? '')}
                  hasClear
                  width="100%"
                />

                <Selector
                  label={t('bookingNew.staff')}
                  description={t('bookingNew.staffDesc')}
                  placeholder={t('bookingNew.staffPlaceholder')}
                  options={staffOptions}
                  value={editStaffId || null}
                  onChange={(value) => setEditStaffId(value ?? '')}
                  hasClear
                  width="100%"
                />

                <TextInput
                  label={t('bookingNew.customerName')}
                  value={editCustomerName}
                  onChange={setEditCustomerName}
                  width="100%"
                  // PII customer — jangan pernah ter-capture analitik/replay.
                  className="ph-no-capture"
                />

                <PhoneInput
                  label={t('bookingNew.phone')}
                  value={editPhone}
                  onChange={setEditPhone}
                />

                <TextArea
                  label={t('bookingNew.notes')}
                  placeholder={t('bookingNew.notesPlaceholder')}
                  rows={3}
                  value={editDescription}
                  onChange={setEditDescription}
                  width="100%"
                />

                {editError && (
                  <p
                    role="alert"
                    className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-400"
                  >
                    {editError}
                  </p>
                )}
              </form>
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              <div className="flex items-center justify-end gap-2">
                <Button
                  label={t('common.cancel')}
                  variant="ghost"
                  isDisabled={editBookingMutation.isPending}
                  onClick={() => setIsEditing(false)}
                />
                <Button
                  label={t('common.save')}
                  variant="primary"
                  type="submit"
                  form="edit-booking-form"
                  isLoading={editBookingMutation.isPending}
                  isDisabled={editBookingMutation.isPending || !editDate || !editTime}
                />
              </div>
            </LayoutFooter>
          }
        />
      </Dialog>

      {/* ── Konfirmasi batalkan booking ─────────────────────── */}
      <ConfirmDialog
        isOpen={cancelOpen}
        onOpenChange={setCancelOpen}
        title={t('bookingDetail.cancelBooking')}
        description={t('bookingDetail.cancelQuestion')}
        actionLabel={t('bookingDetail.cancelBooking')}
        actionVariant="destructive"
        isActionLoading={statusMutation.isPending}
        onAction={() => statusMutation.mutate('cancelled')}
      />
    </div>
  );
}
