import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { composeCallGoal, type GoalCustomization } from '@oriole/call-goals';
import {
  Badge,
  Button,
  DateTimeInput,
  Selector,
  TextArea,
  TextInput,
  type BadgeVariant,
  type ISODateTimeString,
} from '@astryxdesign/core';

import { ApiError, apiFetch } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import type { BookingDetailResponse, BookingRecord, CallRecord } from '../../lib/bookings';
import { useWorkspaceStore } from '../../stores/workspace';
import { PhoneInput } from '../components/PhoneInput';
import { bookingStatusKey } from '../../i18n/enums';
import { formatDateTime } from '../../i18n/format';
import type { TranslationKey } from '../../i18n';
import { GoalCustomizer } from '../shell/GoalCustomizer';
import { IconAlertTriangle, IconCalendar, IconChevronLeft, IconEdit, IconPhone, IconTrash } from '../shell/icons';
import { Card, PageHeader } from '../shell/ui';

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

function resultSnippet(result: Record<string, unknown> | null, t: TFunction): string {
  if (!result) return t('bookingDetail.noResult');
  for (const key of ['summary', 'outcome', 'result']) {
    const value = result[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return t('bookingDetail.resultSaved');
}

/** Konversi ISO → value input datetime-local (waktu lokal browser). */
function toDateTimeLocal(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const STATUS_OPTIONS: { value: BookingRecord['status']; labelKey: TranslationKey }[] = [
  { value: 'pending', labelKey: 'status.pending' },
  { value: 'confirmed', labelKey: 'status.confirmed' },
  { value: 'completed', labelKey: 'status.completed' },
  { value: 'cancelled', labelKey: 'status.cancelled' },
];

export function BookingDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);

  // ── Form edit booking ──────────────────────────────────────
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editCustomerName, setEditCustomerName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editScheduledAt, setEditScheduledAt] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editStatus, setEditStatus] = useState<BookingRecord['status']>('pending');
  const [editError, setEditError] = useState<string | null>(null);

  // ── Hapus booking (konfirmasi inline) ─────────────────────
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const startEdit = (booking: BookingRecord) => {
    setEditTitle(booking.title);
    setEditCustomerName(booking.customerName ?? '');
    setEditPhone(booking.phone ?? '');
    setEditScheduledAt(toDateTimeLocal(booking.scheduledAt));
    setEditDescription(booking.description ?? '');
    setEditStatus(booking.status);
    setEditError(null);
    setIsEditing(true);
  };

  const submitEdit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!id) return;
    setEditError(null);
    const trimmedTitle = editTitle.trim();
    if (!trimmedTitle || !editScheduledAt) return;
    editBookingMutation.mutate({
      title: trimmedTitle,
      customerName: editCustomerName.trim() || null,
      phone: editPhone.trim() || null,
      scheduledAt: new Date(editScheduledAt).toISOString(),
      description: editDescription.trim() || null,
      status: editStatus,
    });
  };

  const editBookingMutation = useMutation({
    mutationFn: (fields: {
      title: string;
      customerName: string | null;
      phone: string | null;
      scheduledAt: string;
      description: string | null;
      status: BookingRecord['status'];
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

  const deleteBookingMutation = useMutation({
    mutationFn: () => apiFetch(`/bookings/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bookings', activeWorkspaceId] });
      navigate('/app/bookings');
    },
    onError: (err) => {
      setDeleteError(errorMessage(err, t, 'errors.deleteBooking'));
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

  const [triggerResult, setTriggerResult] = useState<string | null>(null);
  const [triggerError, setTriggerError] = useState<string | null>(null);

  const saveGoalMutation = useMutation({
    mutationFn: (goal: GoalCustomization | null) =>
      apiFetch(`/bookings/${id}`, { method: 'PATCH', body: JSON.stringify({ goal }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['booking', activeWorkspaceId, id] }),
  });

  const triggerCallMutation = useMutation({
    mutationFn: () => apiFetch<{ call: { id: string; status: string } }>(`/bookings/${id}/trigger-call`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
    onSuccess: (response) => {
      setTriggerError(null);
      setTriggerResult(t('bookingDetail.callCreated', { id: response.call.id, status: response.call.status }));
      queryClient.invalidateQueries({ queryKey: ['booking', activeWorkspaceId, id] });
    },
    onError: (err) => {
      setTriggerResult(null);
      setTriggerError(errorMessage(err, t, 'errors.triggerCall'));
    },
  });

  const isAuthExpiry = error instanceof ApiError && error.status === 401;

  if (isPending) {
    return <div className="h-40 animate-pulse rounded-2xl bg-zinc-200/70" />;
  }

  if (isError && !isAuthExpiry && !data) {
    return (
      <Card className="flex flex-col items-center gap-4 p-10 text-center">
        <span className="flex size-12 items-center justify-center rounded-2xl bg-red-50 text-red-500">
          <IconAlertTriangle className="size-6" />
        </span>
        <div>
          <h3 className="text-sm font-semibold text-zinc-900">{t('errors.bookingNotFoundTitle')}</h3>
          <p className="mt-1 text-sm text-zinc-500">
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
  const effectiveGoal = composeCallGoal({ booking: bookingContext, business, customization });

  return (
    <div className="space-y-8">
      <PageHeader
        title={booking.title}
        description={t('bookingDetail.fromProject', {
          name: business.name ?? '—',
          date: formatDateTime(booking.createdAt),
        })}
      >
        <Link
          to="/app/bookings"
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-medium text-zinc-600 transition hover:bg-zinc-50"
        >
          <IconChevronLeft className="size-4" />
          {t('common.back')}
        </Link>
        <Button
          label={isEditing ? t('common.close') : t('common.edit')}
          variant="secondary"
          icon={<IconEdit className="size-4" />}
          onClick={() => (isEditing ? setIsEditing(false) : startEdit(booking))}
        />
        <Badge variant={STATUS_BADGE[booking.status]} label={statusLabel(booking.status, t)} />
      </PageHeader>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Kolom utama: info booking + goal AI */}
        <div className="space-y-6 lg:col-span-2">
          <Card className="p-5">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">{t('common.schedule')}</p>
                <p className="mt-1 text-sm font-medium text-zinc-900">{formatDateTime(booking.scheduledAt)}</p>
                <p className="mt-0.5 text-xs text-zinc-500">{t('bookingDetail.timezone', { timezone: booking.timezone })}</p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">{t('common.customer')}</p>
                <p className="mt-1 text-sm font-medium text-zinc-900">{booking.customerName ?? '—'}</p>
                <p className="mt-0.5 text-xs text-zinc-500">{booking.phone ?? t('bookingDetail.noPhoneYet')}</p>
              </div>
            </div>
            {booking.description && (
              <p className="mt-4 border-t border-zinc-100 pt-4 text-sm leading-relaxed text-zinc-600">
                {booking.description}
              </p>
            )}
          </Card>

          {/* Form edit booking (toggle) */}
          {isEditing && (
            <Card className="border-amber-200 bg-amber-50/30 p-5">
              <form onSubmit={submitEdit} className="space-y-4">
                <h2 className="text-sm font-semibold text-zinc-900">{t('bookingDetail.editTitle')}</h2>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <TextInput
                    className="sm:col-span-2"
                    label={t('bookingNew.bookingTitle')}
                    isRequired
                    value={editTitle}
                    onChange={setEditTitle}
                    width="100%"
                  />

                  <TextInput
                    label={t('bookingNew.customerName')}
                    value={editCustomerName}
                    onChange={setEditCustomerName}
                    width="100%"
                  />

                  <PhoneInput
                    label={t('bookingNew.phone')}
                    value={editPhone}
                    onChange={setEditPhone}
                  />

                  <DateTimeInput
                    label={t('bookingNew.schedule')}
                    isRequired
                    value={editScheduledAt ? (editScheduledAt as ISODateTimeString) : undefined}
                    onChange={(value) => setEditScheduledAt(value ?? '')}
                    width="100%"
                  />

                  <Selector
                    label={t('common.status')}
                    options={STATUS_OPTIONS.map((option) => ({ ...option, label: t(option.labelKey) }))}
                    value={editStatus}
                    onChange={(value) => setEditStatus(value as BookingRecord['status'])}
                    width="100%"
                  />

                  <TextArea
                    className="sm:col-span-2"
                    label={t('bookingNew.notes')}
                    rows={3}
                    value={editDescription}
                    onChange={setEditDescription}
                    width="100%"
                  />
                </div>

                {editError && <p role="alert" className="text-sm text-red-600">{editError}</p>}

                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    {confirmDelete ? (
                      <div className="rounded-xl border border-red-200 bg-red-50 p-3">
                        <p className="text-xs font-medium text-red-700">
                          {t('bookingDetail.deleteQuestion')}
                        </p>
                        {deleteError && <p role="alert" className="mt-1.5 text-xs text-red-600">{deleteError}</p>}
                        <div className="mt-2.5 flex gap-2">
                          <Button
                            label={t('common.cancel')}
                            variant="ghost"
                            size="sm"
                            isDisabled={deleteBookingMutation.isPending}
                            onClick={() => {
                              setConfirmDelete(false);
                              setDeleteError(null);
                            }}
                          />
                          <Button
                            label={t('common.delete')}
                            variant="destructive"
                            size="sm"
                            isLoading={deleteBookingMutation.isPending}
                            isDisabled={deleteBookingMutation.isPending}
                            onClick={() => deleteBookingMutation.mutate()}
                          />
                        </div>
                      </div>
                    ) : (
                      <Button
                        label={t('bookingDetail.deleteBooking')}
                        variant="ghost"
                        size="sm"
                        icon={<IconTrash className="size-3.5" />}
                        onClick={() => {
                          setConfirmDelete(true);
                          setDeleteError(null);
                        }}
                      />
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      label={t('common.cancel')}
                      variant="ghost"
                      onClick={() => setIsEditing(false)}
                    />
                    <Button
                      label={t('common.save')}
                      variant="primary"
                      isLoading={editBookingMutation.isPending}
                      isDisabled={editBookingMutation.isPending || !editTitle.trim() || !editScheduledAt}
                      type="submit"
                    />
                  </div>
                </div>
              </form>
            </Card>
          )}

          {/* Progressive disclosure goal CALL-E */}
          <div>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-500">
              {t('bookingDetail.aiCallHeading')}
            </h2>
            <GoalCustomizer
              booking={bookingContext}
              business={business}
              autoDecision={autoGoal}
              value={customization}
              onChange={(goal) => saveGoalMutation.mutate(goal)}
              disabled={booking.status === 'cancelled' || booking.status === 'completed'}
            />

            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
              <Button
                label={triggerCallMutation.isPending ? t('bookingDetail.calling') : t('bookingDetail.triggerNow')}
                variant="primary"
                icon={<IconPhone className="size-4" />}
                isLoading={triggerCallMutation.isPending}
                isDisabled={
                  triggerCallMutation.isPending ||
                  !booking.phone ||
                  booking.status === 'cancelled' ||
                  booking.status === 'completed'
                }
                onClick={() => triggerCallMutation.mutate()}
              />
              {!booking.phone && (
                <p className="text-xs text-zinc-500">{t('bookingDetail.addPhoneHint')}</p>
              )}
            </div>

            {triggerResult && (
              <p className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                {triggerResult}
              </p>
            )}
            {triggerError && (
              <p role="alert" className="mt-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {triggerError}
              </p>
            )}
          </div>
        </div>

        {/* Kolom samping: ringkasan goal + riwayat panggilan */}
        <div className="space-y-6">
          <Card className="p-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">{t('bookingDetail.goalToSend')}</p>
            <p className="mt-2 text-sm font-semibold text-zinc-900">{effectiveGoal?.title ?? t('common.noCall')}</p>
            {effectiveGoal && (
              <pre className="mt-3 max-h-52 overflow-auto whitespace-pre-wrap rounded-lg bg-zinc-950 p-3 text-[11px] leading-relaxed text-zinc-300">
                {effectiveGoal.prompt}
              </pre>
            )}
          </Card>

          <Card className="p-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
              {t('bookingDetail.callHistory', { count: calls.length })}
            </p>
            {calls.length === 0 ? (
              <p className="mt-3 text-sm text-zinc-500">{t('bookingDetail.noCalls')}</p>
            ) : (
              <div className="mt-3 space-y-3">
                {calls.map((call: CallRecord) => (
                  <div key={call.id} className="rounded-xl border border-zinc-100 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-semibold text-zinc-800">{formatDateTime(call.createdAt)}</p>
                      <Badge variant={callStatusBadge(call.status)} label={statusLabel(call.status, t)} />
                    </div>
                    {call.goalType && <p className="mt-1 text-[11px] font-medium text-amber-600">{call.goalType}</p>}
                    <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">{resultSnippet(call.result, t)}</p>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card className="p-5">
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <IconCalendar className="size-4 text-zinc-400" />
              <span>
                {t('bookingDetail.attempts', {
                  count: booking.callAttempts.total,
                  total: booking.callAttempts.total,
                  failed: booking.callAttempts.failed,
                })}
              </span>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
