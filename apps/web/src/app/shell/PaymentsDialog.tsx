import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Badge,
  Button,
  Dialog,
  DialogHeader,
  IconButton,
  Layout,
  LayoutContent,
  LayoutFooter,
  Selector,
  Skeleton,
  TextArea,
  TextInput,
  type BadgeVariant,
} from '@astryxdesign/core';
import { useTranslation } from 'react-i18next';

import { apiFetch } from '../../lib/api';
import { trackEvent } from '../../lib/analytics';
import { errorMessage } from '../../lib/errors';
import {
  formatPaymentAmount,
  type PaymentLinkRecord,
  type PaymentLinkResponse,
  type PaymentLinkStatus,
  type PaymentsListResponse,
} from '../../lib/payments';
import { formatDateTime } from '../../i18n/format';
import type { TranslationKey } from '../../i18n';
import {
  IconAlertTriangle,
  IconCheck,
  IconCopy,
  IconCreditCard,
  IconExternalLink,
  IconRefreshCw,
  IconTrash,
  IconX,
} from './icons';

/** Mata uang yang umum dipakai (subset daftar Paddle — kode asing ditolak server). */
const CURRENCY_OPTIONS = [
  'USD', 'EUR', 'GBP', 'AUD', 'CAD', 'JPY', 'SGD', 'HKD', 'CHF', 'SEK',
  'NOK', 'DKK', 'PLN', 'CZK', 'INR', 'KRW', 'MXN', 'BRL', 'THB', 'TRY',
  'TWD', 'VND', 'ZAR', 'CNY', 'NZD', 'PHP',
];

const STATUS_BADGE: Record<PaymentLinkStatus, { labelKey: TranslationKey; variant: BadgeVariant }> = {
  pending: { labelKey: 'payments.statusPending', variant: 'warning' },
  paid: { labelKey: 'payments.statusPaid', variant: 'success' },
  canceled: { labelKey: 'payments.statusCanceled', variant: 'neutral' },
};

function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  return Promise.reject(new Error('Clipboard tidak tersedia'));
}

/**
 * Dialog kelola payment link (Global Payments — Paddle).
 * Dibuka dari kartu Payments di halaman Integrations, dan dari halaman
 * detail booking (dengan `bookingId` → daftar & pembuatan ter-scope ke
 * booking itu). Status link diperbarui otomatis oleh webhook Paddle;
 * tombol refresh manual tersedia di header.
 */
export function PaymentsDialog({
  isOpen,
  onOpenChange,
  bookingId = null,
  defaultTitle = '',
  defaultCustomerName = '',
}: {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => unknown;
  /** Scope ke satu booking (dari halaman detail); null = semua link workspace. */
  bookingId?: string | null;
  defaultTitle?: string;
  defaultCustomerName?: string;
}) {
  const { t } = useTranslation();

  const [payments, setPayments] = useState<PaymentLinkRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [cancelingId, setCancelingId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [createdOk, setCreatedOk] = useState<string | null>(null);

  // ── Form create ────────────────────────────────────────────
  const [title, setTitle] = useState(defaultTitle);
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [description, setDescription] = useState('');
  const [customerName, setCustomerName] = useState(defaultCustomerName);
  const [customerEmail, setCustomerEmail] = useState('');

  // Reset form + muat ulang tiap dialog dibuka (data status bisa berubah
  // dari webhook saat dialog tertutup).
  useEffect(() => {
    if (!isOpen) return;
    setTitle(defaultTitle);
    setAmount('');
    setCurrency('USD');
    setDescription('');
    setCustomerName(defaultCustomerName);
    setCustomerEmail('');
    setCreatedOk(null);
    setActionError(null);
    void loadPayments();
    // Analitik: pembukaan dialog checkout (sinyal funnel pembayaran).
    void trackEvent('payments_dialog_opened', {
      booking_id: bookingId ?? undefined,
      source: bookingId ? 'booking' : 'integrations',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, bookingId, defaultTitle, defaultCustomerName]);

  const loadPayments = useCallback(async () => {
    setLoadError(null);
    try {
      const params = new URLSearchParams();
      if (bookingId) params.set('bookingId', bookingId);
      const query = params.toString() ? `?${params.toString()}` : '';
      const response = await apiFetch<PaymentsListResponse>(`/payments${query}`);
      setPayments(response.payments);
    } catch (err) {
      setLoadError(errorMessage(err, t, 'payments.loadFailed'));
    }
  }, [bookingId, t]);

  const createPayment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setActionError(null);
    setCreatedOk(null);
    const parsedAmount = Number(amount);
    if (!title.trim()) {
      setActionError(t('payments.titleRequired'));
      return;
    }
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setActionError(t('payments.amountRequired'));
      return;
    }
    setCreating(true);
    try {
      const response = await apiFetch<PaymentLinkResponse>('/payments', {
        method: 'POST',
        body: JSON.stringify({
          bookingId: bookingId ?? null,
          title: title.trim(),
          amount: parsedAmount,
          currency,
          description: description.trim() || null,
          customerName: customerName.trim() || null,
          customerEmail: customerEmail.trim() || null,
        }),
      });
      setPayments((prev) => [response.payment, ...(prev ?? [])]);
      setCreatedOk(t('payments.createdOk', { title: response.payment.title }));
      setAmount('');
      setDescription('');
      setCustomerEmail('');
    } catch (err) {
      setActionError(errorMessage(err, t, 'payments.createFailed'));
    } finally {
      setCreating(false);
    }
  };

  const cancelPayment = async (payment: PaymentLinkRecord) => {
    setActionError(null);
    setCancelingId(payment.id);
    try {
      const response = await apiFetch<PaymentLinkResponse>(`/payments/${payment.id}/cancel`, {
        method: 'POST',
      });
      setPayments((prev) =>
        (prev ?? []).map((item) => (item.id === payment.id ? response.payment : item)),
      );
    } catch (err) {
      setActionError(errorMessage(err, t, 'payments.cancelFailed'));
    } finally {
      setCancelingId(null);
    }
  };

  const copyUrl = async (payment: PaymentLinkRecord) => {
    if (!payment.checkoutUrl) return;
    try {
      await copyToClipboard(payment.checkoutUrl);
      setCopiedId(payment.id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      setActionError(t('channels.copyFailed'));
    }
  };

  const list = payments ?? [];

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      purpose="info"
      width={720}
      maxHeight="min(85vh, 720px)"
    >
      <Layout
        header={
          <DialogHeader
            title={t('payments.dialogTitle')}
            subtitle={bookingId ? t('payments.dialogSubtitleBooking') : t('payments.dialogSubtitle')}
            startContent={<IconCreditCard className="size-5 shrink-0 text-amber-600" />}
            onOpenChange={onOpenChange}
            endContent={
              <IconButton
                icon={<IconRefreshCw className="size-4" />}
                label={t('common.reload')}
                variant="ghost"
                size="sm"
                onClick={() => void loadPayments()}
              />
            }
            hasDivider
          />
        }
        content={
          <LayoutContent>
            <div className="space-y-6">
              {/* Provider tetap — detail hanya di dalam dialog, bukan di kartu. */}
              <p className="flex items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400">
                <IconCreditCard className="size-3.5 shrink-0 text-zinc-400" />
                <span className="font-medium uppercase tracking-wider text-zinc-400">{t('payments.providerLabel')}</span>
                <span className="text-zinc-700 dark:text-zinc-300">{t('payments.providerValue')}</span>
              </p>

              {/* Form create */}
              <form onSubmit={createPayment} className="space-y-4 rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50/60 dark:bg-zinc-900/60 p-4">
                <div className="flex items-center gap-2">
                  <IconCreditCard className="size-4 text-amber-600" />
                  <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t('payments.createTitle')}</h3>
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <TextInput
                    label={t('payments.itemLabel')}
                    isRequired
                    value={title}
                    onChange={setTitle}
                    placeholder={t('payments.itemPlaceholder')}
                    width="100%"
                    className="sm:col-span-2"
                  />
                  <TextInput
                    label={t('payments.amountLabel')}
                    isRequired
                    value={amount}
                    onChange={setAmount}
                    placeholder="0.00"
                    width="100%"
                  />
                  <Selector
                    label={t('payments.currencyLabel')}
                    options={CURRENCY_OPTIONS.map((code) => ({ value: code, label: code }))}
                    value={currency}
                    onChange={(value) => setCurrency(value)}
                    width="100%"
                  />
                  <TextInput
                    label={t('payments.customerNameLabel')}
                    value={customerName}
                    onChange={setCustomerName}
                    width="100%"
                    // PII customer — jangan pernah ter-capture analitik/replay.
                    className="ph-no-capture"
                  />
                  <TextInput
                    label={t('payments.customerEmailLabel')}
                    type="email"
                    value={customerEmail}
                    onChange={setCustomerEmail}
                    placeholder="customer@example.com"
                    width="100%"
                    // PII customer — jangan pernah ter-capture analitik/replay.
                    className="ph-no-capture"
                  />
                  <TextArea
                    label={t('payments.descriptionLabel')}
                    rows={2}
                    value={description}
                    onChange={setDescription}
                    width="100%"
                    className="sm:col-span-2"
                  />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs text-zinc-400">{t('payments.createHint')}</p>
                  <Button
                    label={t('payments.createCta')}
                    variant="primary"
                    isLoading={creating}
                    isDisabled={creating}
                  />
                </div>
              </form>

              {createdOk && (
                <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400">
                  {createdOk}
                </p>
              )}
              {actionError && (
                <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-950/50 dark:text-red-400">
                  {actionError}
                </p>
              )}
              {loadError && (
                <p role="alert" className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-950/50 dark:text-red-400">
                  <IconAlertTriangle className="mt-0.5 size-4 shrink-0" />
                  {loadError}
                </p>
              )}

              {/* Daftar payment link */}
              <section>
                <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t('payments.listTitle')}</h3>
                <p className="mt-0.5 text-xs text-zinc-400">
                  {bookingId ? t('payments.listDescBooking') : t('payments.listDesc')}
                </p>

                {payments === null ? (
                  <div className="mt-4 space-y-3">
                    {[0, 1].map((i) => (
                      <div key={i} className="rounded-xl border border-zinc-100 dark:border-zinc-800 p-4">
                        <Skeleton width="40%" height={14} />
                        <Skeleton className="mt-3" width="25%" height={14} />
                      </div>
                    ))}
                  </div>
                ) : list.length === 0 ? (
                  <div className="mt-4 rounded-xl border border-dashed border-zinc-200 dark:border-zinc-700 px-4 py-8 text-center">
                    <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('payments.empty')}</p>
                    <p className="mt-1 text-xs text-zinc-400">{t('payments.emptyHint')}</p>
                  </div>
                ) : (
                  <ul className="mt-4 space-y-3">
                    {list.map((payment) => {
                      const badge = STATUS_BADGE[payment.status];
                      return (
                        <li key={payment.id} className="rounded-xl border border-zinc-100 dark:border-zinc-800 p-4">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{payment.title}</p>
                                <Badge variant={badge.variant} label={t(badge.labelKey)} />
                              </div>
                              <p className="mt-1 text-sm font-bold text-zinc-800 dark:text-zinc-200">
                                {formatPaymentAmount(payment.amountMinor, payment.currency)}
                              </p>
                              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-400">
                                {payment.bookingTitle && (
                                  <span>{t('payments.forBooking', { title: payment.bookingTitle })}</span>
                                )}
                                <span>{formatDateTime(payment.createdAt)}</span>
                                {payment.paidAt && <span>{t('payments.paidAt', { time: formatDateTime(payment.paidAt) })}</span>}
                                {payment.customerName && <span>{payment.customerName}</span>}
                              </div>
                            </div>

                            {payment.checkoutUrl && payment.status === 'pending' && (
                              <div className="flex shrink-0 items-center gap-2">
                                <Button
                                  label={t('payments.openCheckout')}
                                  variant="secondary"
                                  size="sm"
                                  icon={<IconExternalLink className="size-3.5" />}
                                  onClick={() => window.open(payment.checkoutUrl ?? '', '_blank', 'noopener,noreferrer')}
                                />
                                <Button
                                  label={copiedId === payment.id ? t('channels.copied') : t('channels.copy')}
                                  variant="ghost"
                                  size="sm"
                                  icon={copiedId === payment.id ? <IconCheck className="size-3.5" /> : <IconCopy className="size-3.5" />}
                                  onClick={() => void copyUrl(payment)}
                                />
                                <Button
                                  label={t('payments.cancelCta')}
                                  variant="ghost"
                                  size="sm"
                                  icon={<IconTrash className="size-3.5" />}
                                  isLoading={cancelingId === payment.id}
                                  isDisabled={cancelingId !== null}
                                  onClick={() => void cancelPayment(payment)}
                                />
                              </div>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </div>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <p className="flex items-center gap-1.5 text-xs text-zinc-400">
              <IconCreditCard className="size-3.5" />
              {t('payments.footerNote')}
            </p>
            <Button label={t('common.close')} variant="secondary" icon={<IconX className="size-4" />} onClick={() => onOpenChange(false)} />
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
