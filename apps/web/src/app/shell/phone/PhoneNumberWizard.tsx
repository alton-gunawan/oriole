import { useEffect, useRef, useState } from 'react';
import {
  Badge,
  Banner,
  Button,
  Dialog,
  DialogHeader,
  Layout,
  LayoutContent,
  LayoutFooter,
  TextInput,
} from '@astryxdesign/core';
import { useTranslation } from 'react-i18next';

import { apiFetch } from '../../../lib/api';
import { errorMessage } from '../../../lib/errors';
import type {
  TelnyxByocConnectResponse,
  TelnyxByocSearchResponse,
  VapiPhoneNumberOption,
  VapiProvisionResponse,
  WorkspaceIntegration,
} from '../../../lib/integrations';
import { useWorkspaceStore } from '../../../stores/workspace';
import { IconCheck, IconChevronLeft, IconChevronRight, IconPhone, IconPlug, IconX } from '../icons';
import { providerLabel } from './phone';
import { TestCallSection } from './TestCallSection';

type WizardStep = 1 | 2 | 3 | 4;
type ConnectMethod = 'vapi' | 'byo' | null;
type ByoProvider = 'telnyx' | 'twilio' | 'vonage' | 'other' | null;

/** Nomor Vapi yang sedang diprovision (belum aktif sampai dikonfirmasi). */
type ProvisionedNumber = { vapiPhoneNumberId: string; number: string | null; provider: string };

/** Status awal saat wizard dibuka dengan setup yang sudah berjalan (resume). */
export interface WizardInitialState {
  /** Nomor Vapi yang sudah diprovision (pending) — lanjut dari step Configure. */
  provisioned?: { vapiPhoneNumberId: string; number: string | null } | null;
}

const STEP_LABELS = [
  { step: 1, key: 'phoneNumber.step1' },
  { step: 2, key: 'phoneNumber.step2' },
  { step: 3, key: 'phoneNumber.step3' },
  { step: 4, key: 'phoneNumber.step4' },
] as const;

/** Kartu metode koneksi — pilihan utama step 1. */
function MethodCard({
  title,
  description,
  footer,
  cta,
  onClick,
  icon,
}: {
  title: string;
  description: string;
  footer?: string;
  cta: string;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  return (
    <div className="flex flex-col rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4">
      <span className="flex size-10 items-center justify-center rounded-xl bg-amber-500/10 text-amber-600">
        {icon}
      </span>
      <p className="mt-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</p>
      <p className="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{description}</p>
      {footer && <p className="mt-2 text-xs font-medium text-zinc-400">{footer}</p>}
      <Button
        className="mt-4 w-full"
        label={cta}
        variant="primary"
        size="sm"
        onClick={onClick}
      />
    </div>
  );
}

/**
 * Wizard "Connect phone number" — 4 langkah: Choose method → Connect →
 * Configure → Test. Dua jalur koneksi:
 *  1. Vapi number — provision nomor baru (US) lalu konfirmasi di akhir.
 *  2. Bring your own — provider Telnyx (key workspace, search, connect);
 *     Twilio/Vonage/BYO tampil jujur sebagai "coming soon".
 * Saat `replaceMode`, nomor lama diganti (backend melepas nomor lama).
 */
export function PhoneNumberWizardDialog({
  isOpen,
  onOpenChange,
  replaceMode,
  currentNumber,
  initialState,
  existingNumbers,
  onComplete,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  replaceMode?: boolean;
  currentNumber?: string | null;
  initialState?: WizardInitialState | null;
  /** Nomor yang sudah ada di akun Vapi (GET /integrations/vapi) — dipakai
   *  jalur "use existing" tanpa membeli nomor baru. */
  existingNumbers?: VapiPhoneNumberOption[] | null;
  onComplete: () => void;
}) {
  const { t } = useTranslation();
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const assistantName =
    useWorkspaceStore((s) => s.workspaces.find((w) => w.id === activeWorkspaceId)?.callAssistantName) ??
    'Sarah';

  const [step, setStep] = useState<WizardStep>(1);
  const [method, setMethod] = useState<ConnectMethod>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // ── Jalur Vapi number ──
  const [areaCode, setAreaCode] = useState('');
  const [provisionBusy, setProvisionBusy] = useState(false);
  const [connectBusy, setConnectBusy] = useState<string | null>(null);
  const [provisioned, setProvisioned] = useState<ProvisionedNumber | null>(null);

  // ── Jalur Bring your own ──
  const [byoProvider, setByoProvider] = useState<ByoProvider>(null);
  const [byoKey, setByoKey] = useState('');
  const [byoCountry, setByoCountry] = useState('ID');
  const [byoArea, setByoArea] = useState('');
  const [byoResult, setByoResult] = useState<TelnyxByocSearchResponse | null>(null);
  const [byoNumber, setByoNumber] = useState('');
  const [byoSearching, setByoSearching] = useState(false);
  const [byoConnecting, setByoConnecting] = useState(false);
  const [byoConnected, setByoConnected] = useState<WorkspaceIntegration | null>(null);

  // Guard anti-double-release: jangan cancel-provision setelah finish.
  const finishedRef = useRef(false);
  const methodRef = useRef<ConnectMethod>(null);
  // Reset hanya saat transisi tutup → buka (bukan saat props berubah).
  const prevOpenRef = useRef(false);

  useEffect(() => {
    const justOpened = isOpen && !prevOpenRef.current;
    prevOpenRef.current = isOpen;
    if (!justOpened) return;
    const resume = initialState?.provisioned;
    // Reset total setiap dibuka.
    setStep(resume ? 3 : 1);
    setMethod(resume ? 'vapi' : null);
    setError(null);
    setBusy(false);
    setAreaCode('');
    setProvisionBusy(false);
    setProvisioned(
      resume
        ? { vapiPhoneNumberId: resume.vapiPhoneNumberId, number: resume.number, provider: 'vapi' }
        : null,
    );
    setByoProvider(null);
    setByoKey('');
    setByoCountry('ID');
    setByoArea('');
    setByoResult(null);
    setByoNumber('');
    setByoConnecting(false);
    setByoConnected(null);
    finishedRef.current = false;
    methodRef.current = resume ? 'vapi' : null;
  }, [isOpen, initialState]);

  useEffect(() => {
    methodRef.current = method;
  }, [method]);

  /** Nomor yang sedang diproses wizard (untuk summary configure). */
  const currentSetupNumber =
    method === 'vapi'
      ? provisioned?.number
      : method === 'byo'
        ? (byoConnected?.identifier ?? byoNumber) || null
        : null;

  const closeWithRelease = async () => {
    // Batal di tengah wizard Vapi → lepas nomor provision agar tidak
    // menganggur (best-effort; server juga membersihkan pending lama).
    if (!finishedRef.current && methodRef.current === 'vapi' && provisioned) {
      try {
        await apiFetch('/integrations/vapi/cancel-provision', { method: 'POST' });
      } catch {
        // Gagal lepas → pending tetap ada; panel menampilkan "Continue setup".
      }
    }
    onOpenChange(false);
    onComplete();
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) void closeWithRelease();
  };

  const chooseMethod = (next: Exclude<ConnectMethod, null>) => {
    setMethod(next);
    setError(null);
    setStep(2);
  };

  /* ── Jalur Vapi number ── */
  /** Pakai nomor yang SUDAH ada di akun Vapi — tidak membeli nomor baru.
   *  Backend (POST /integrations/vapi/connect) menautkannya ke workspace;
   *  confirm/cancel-provision di langkah berikutnya jadi no-op (non-pending). */
  const useExistingNumber = async (vapiPhoneNumberId: string) => {
    setError(null);
    setConnectBusy(vapiPhoneNumberId);
    try {
      const response = await apiFetch<{ integration: WorkspaceIntegration }>(
        '/integrations/vapi/connect',
        {
          method: 'POST',
          body: JSON.stringify({ vapiPhoneNumberId }),
        },
      );
      setProvisioned({
        vapiPhoneNumberId,
        number: response.integration.config.phoneNumber ?? null,
        provider: response.integration.config.provider ?? 'vapi',
      });
      setStep(3);
    } catch (err) {
      setError(errorMessage(err, t, 'phoneNumber.vapiConnectFailed'));
    } finally {
      setConnectBusy(null);
    }
  };

  const provisionNumber = async () => {
    setError(null);
    setProvisionBusy(true);
    try {
      const response = await apiFetch<VapiProvisionResponse>('/integrations/vapi/provision', {
        method: 'POST',
        body: JSON.stringify({ areaCode: areaCode.trim() || null }),
      });
      setProvisioned({
        vapiPhoneNumberId: response.vapiPhoneNumberId,
        number: response.number,
        provider: response.provider,
      });
      setStep(3);
    } catch (err) {
      setError(errorMessage(err, t, 'phoneNumber.vapiProvisionFailed'));
    } finally {
      setProvisionBusy(false);
    }
  };

  /* ── Jalur Bring your own (Telnyx) ── */
  const searchByo = async () => {
    setError(null);
    if (!byoKey.trim()) {
      setError(t('phoneNumber.byoKeyRequired'));
      return;
    }
    setByoSearching(true);
    try {
      const response = await apiFetch<TelnyxByocSearchResponse>('/integrations/vapi/byoc/search', {
        method: 'POST',
        body: JSON.stringify({
          apiKey: byoKey.trim(),
          countryCode: byoCountry.trim() || 'ID',
          areaCode: byoArea.trim() || null,
        }),
      });
      setByoResult(response);
      setByoNumber('');
    } catch (err) {
      setError(errorMessage(err, t, 'phoneNumber.byoSearchFailed'));
    } finally {
      setByoSearching(false);
    }
  };

  const connectByo = async () => {
    setError(null);
    if (!byoKey.trim()) {
      setError(t('phoneNumber.byoKeyRequired'));
      return;
    }
    if (!byoNumber.trim()) {
      setError(t('phoneNumber.byoNumberRequired'));
      return;
    }
    setByoConnecting(true);
    try {
      const response = await apiFetch<TelnyxByocConnectResponse>(
        '/integrations/vapi/byoc/connect',
        {
          method: 'POST',
          body: JSON.stringify({ apiKey: byoKey.trim(), phoneNumber: byoNumber.trim() }),
        },
      );
      setByoConnected(response.integration);
      setByoResult(null);
      setStep(3);
    } catch (err) {
      setError(errorMessage(err, t, 'phoneNumber.byoConnectFailed'));
    } finally {
      setByoConnecting(false);
    }
  };

  /* ── Selesai ── */
  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      // Vapi number: konfirmasi mengaktifkan nomor (clear pending + lepas
      // nomor lama bila replace). BYO sudah aktif saat connect.
      if (method === 'vapi' && provisioned) {
        await apiFetch<{ integration: WorkspaceIntegration }>('/integrations/vapi/confirm', {
          method: 'POST',
        });
      }
      finishedRef.current = true;
      // Tutup memicu closeWithRelease — finishedRef mencegah cancel-provision
      // dan onComplete() dipanggil sekali di sana.
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err, t, 'phoneNumber.finishFailed'));
    } finally {
      setBusy(false);
    }
  };

  const canContinueConfigure =
    (method === 'vapi' && provisioned !== null) ||
    (method === 'byo' && byoConnected !== null);

  const currentProvider =
    method === 'byo'
      ? providerLabel('byoc', 'telnyx', t)
      : providerLabel('operator', provisioned?.provider ?? 'vapi', t);

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={handleOpenChange}
      purpose="info"
      width={600}
      maxHeight="min(85vh, 680px)"
    >
      <Layout
        header={
          <DialogHeader
            title={
              replaceMode ? t('phoneNumber.wizardTitleReplace') : t('phoneNumber.wizardTitle')
            }
            subtitle={t('phoneNumber.wizardSubtitle')}
            onOpenChange={handleOpenChange}
            hasDivider
          />
        }
        content={
          <LayoutContent>
            {/* Replace banner — jangan buat user takut mengutak-atik nomor. */}
            {replaceMode && currentNumber && (
              <p className="mb-4 rounded-lg bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:text-amber-400">
                {t('phoneNumber.replaceBanner', { number: currentNumber })}
              </p>
            )}

            {/* Stepper */}
            <ol className="mb-5 flex items-center gap-1">
              {STEP_LABELS.map((item, index) => {
                const active = item.step === step;
                const done = item.step < step;
                return (
                  <li key={item.step} className="flex flex-1 items-center gap-1">
                    <span
                      className={`flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                        active
                          ? 'bg-amber-500 text-white'
                          : done
                            ? 'bg-emerald-500 text-white'
                            : 'bg-zinc-200 text-zinc-500 dark:bg-zinc-700 dark:text-zinc-400'
                      }`}
                    >
                      {done ? <IconCheck className="size-3" /> : item.step}
                    </span>
                    <span
                      className={`truncate text-[11px] font-medium ${
                        active
                          ? 'text-zinc-900 dark:text-zinc-100'
                          : 'text-zinc-400 dark:text-zinc-500'
                      }`}
                    >
                      {t(item.key)}
                    </span>
                    {index < STEP_LABELS.length - 1 && (
                      <span className="mx-1 h-px flex-1 bg-zinc-200 dark:bg-zinc-700" />
                    )}
                  </li>
                );
              })}
            </ol>

            {step === 1 && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <MethodCard
                  title={t('phoneNumber.methodVapiTitle')}
                  description={t('phoneNumber.methodVapiDesc')}
                  footer={t('phoneNumber.methodVapiAvailability')}
                  cta={t('phoneNumber.methodVapiCta')}
                  icon={<IconPhone className="size-5" />}
                  onClick={() => chooseMethod('vapi')}
                />
                <MethodCard
                  title={t('phoneNumber.methodByoTitle')}
                  description={t('phoneNumber.methodByoDesc')}
                  footer={t('phoneNumber.methodByoProviders')}
                  cta={t('phoneNumber.methodByoCta')}
                  icon={<IconPlug className="size-5" />}
                  onClick={() => chooseMethod('byo')}
                />
              </div>
            )}

            {step === 2 && method === 'vapi' && (
              <div className="space-y-4">
                {/* Pakai nomor yang sudah ada di akun Vapi — tanpa membeli. */}
                {existingNumbers && existingNumbers.length > 0 && (
                  <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4">
                    <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                      {t('phoneNumber.vapiUseExisting')}
                    </p>
                    <p className="mt-0.5 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                      {t('phoneNumber.vapiUseExistingDesc')}
                    </p>
                    <div className="mt-3 space-y-1.5">
                      {existingNumbers.map((n) => (
                        <div
                          key={n.id}
                          className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-2.5"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                              {n.number ?? n.name ?? '—'}
                            </p>
                            <p className="truncate text-xs text-zinc-400">{n.provider}</p>
                          </div>
                          <Button
                            label={
                              connectBusy === n.id
                                ? t('phoneNumber.connecting')
                                : t('phoneNumber.vapiUseExistingCta')
                            }
                            variant="secondary"
                            size="sm"
                            isLoading={connectBusy === n.id}
                            isDisabled={connectBusy !== null}
                            onClick={() => void useExistingNumber(n.id)}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                    {t('phoneNumber.vapiCountry')}
                  </p>
                  <div className="mt-1.5 flex items-center justify-between rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/60 px-3 py-2.5">
                    <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
                      {t('phoneNumber.vapiCountryUs')}
                    </span>
                    <Badge variant="neutral" label={t('phoneNumber.vapiUsOnly')} />
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-zinc-400">
                    {t('phoneNumber.vapiCountryHint')}
                  </p>
                </div>

                <div className="flex items-end gap-2">
                  <TextInput
                    label={t('phoneNumber.vapiAreaCode')}
                    value={areaCode}
                    onChange={(value) => {
                      setAreaCode(value.replace(/[^0-9]/g, '').slice(0, 10));
                      setError(null);
                    }}
                    placeholder={t('phoneNumber.vapiAreaCodePlaceholder')}
                    width="100%"
                  />
                  <Button
                    label={
                      provisionBusy
                        ? t('phoneNumber.vapiFinding')
                        : t('phoneNumber.vapiFindNumber')
                    }
                    variant="primary"
                    isLoading={provisionBusy}
                    isDisabled={provisionBusy}
                    onClick={() => void provisionNumber()}
                  />
                </div>
                <p className="text-xs leading-relaxed text-zinc-400">
                  {t('phoneNumber.vapiFindHint')}
                </p>

                {provisioned && (
                  <div className="flex items-start gap-3 rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 p-4">
                    <IconCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">
                        {t('phoneNumber.vapiFoundTitle')}
                      </p>
                      <p className="mt-0.5 text-lg font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
                        {provisioned.number ?? t('phoneNumber.provisioning')}
                      </p>
                      <p className="mt-0.5 text-xs text-emerald-700/80 dark:text-emerald-400/80">
                        {t('phoneNumber.vapiFoundDesc')}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}

            {step === 2 && method === 'byo' && (
              <div className="space-y-4">
                {byoProvider === null && (
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                      {t('phoneNumber.byoProviderTitle')}
                    </p>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      {(
                        [
                          { id: 'telnyx', labelKey: 'phoneNumber.byoProviderTelnyx', available: true },
                          { id: 'twilio', labelKey: 'phoneNumber.byoProviderTwilio', available: false },
                          { id: 'vonage', labelKey: 'phoneNumber.byoProviderVonage', available: false },
                          { id: 'other', labelKey: 'phoneNumber.byoProviderOther', available: false },
                        ] as const
                      ).map((provider) => (
                        <button
                          key={provider.id}
                          type="button"
                          onClick={() => {
                            setByoProvider(provider.id);
                            setError(null);
                          }}
                          className="flex flex-col items-start gap-1 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-3 text-left transition hover:border-zinc-300 dark:hover:border-zinc-600"
                        >
                          <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
                            {t(provider.labelKey)}
                          </span>
                          <span className="flex items-center gap-1.5">
                            {provider.id === 'telnyx' && (
                              <Badge variant="success" label={t('phoneNumber.byoProviderAvailable')} />
                            )}
                            {!provider.available && (
                              <Badge variant="neutral" label={t('phoneNumber.byoProviderComingSoon')} />
                            )}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {byoProvider === 'telnyx' && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                        {t('phoneNumber.byoTelnyxTitle')}
                      </p>
                      <Button
                        label={t('common.back')}
                        variant="ghost"
                        size="sm"
                        icon={<IconChevronLeft className="size-3.5" />}
                        onClick={() => setByoProvider(null)}
                      />
                    </div>
                    <form
                      id="byo-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void searchByo();
                      }}
                      className="space-y-3"
                    >
                      <TextInput
                        label={t('phoneNumber.byoKeyLabel')}
                        value={byoKey}
                        onChange={(value) => {
                          setByoKey(value);
                          setByoResult(null);
                        }}
                        placeholder="KEY01…"
                        type="password"
                        width="100%"
                      />
                      <div className="grid grid-cols-[110px_1fr] gap-2">
                        <TextInput
                          label={t('phoneNumber.byoCountryLabel')}
                          value={byoCountry}
                          onChange={(value) => {
                            setByoCountry(value.toUpperCase().slice(0, 2));
                            setByoResult(null);
                          }}
                          placeholder="ID"
                          width="100%"
                        />
                        <TextInput
                          label={t('phoneNumber.byoAreaLabel')}
                          value={byoArea}
                          onChange={(value) => {
                            setByoArea(value.replace(/[^0-9]/g, '').slice(0, 10));
                            setByoResult(null);
                          }}
                          placeholder={t('phoneNumber.byoAreaPlaceholder')}
                          width="100%"
                        />
                      </div>
                      <p className="text-xs leading-relaxed text-zinc-400">{t('phoneNumber.byoHint')}</p>
                      <Button
                        label={t('phoneNumber.byoSearchCta')}
                        variant="primary"
                        width="100%"
                        isLoading={byoSearching}
                        isDisabled={byoSearching || !byoKey.trim()}
                        onClick={() => void searchByo()}
                      />
                    </form>

                    {byoResult && (
                      <div className="space-y-3">
                        {byoResult.owned.length > 0 && (
                          <div>
                            <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                              {t('phoneNumber.byoOwnedLabel')}
                            </p>
                            <div className="mt-1.5 space-y-1.5">
                              {byoResult.owned.map((n) => (
                                <button
                                  key={n.phoneNumber}
                                  type="button"
                                  onClick={() => {
                                    setByoNumber(n.phoneNumber);
                                    setError(null);
                                  }}
                                  className={`flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-left text-sm transition ${
                                    byoNumber === n.phoneNumber
                                      ? 'border-sky-500 bg-sky-50 text-sky-700'
                                      : 'border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-800 dark:text-zinc-200 hover:border-zinc-300 dark:hover:border-zinc-600'
                                  }`}
                                >
                                  <span className="truncate font-medium">
                                    {n.phoneNumber}
                                    {n.locality ? (
                                      <span className="ml-1.5 text-xs font-normal text-zinc-400">
                                        · {n.locality}
                                      </span>
                                    ) : null}
                                  </span>
                                  <IconCheck
                                    className={`size-4 shrink-0 ${byoNumber === n.phoneNumber ? 'opacity-100' : 'opacity-0'}`}
                                  />
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                        {byoResult.available.length > 0 && (
                          <div>
                            <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                              {t('phoneNumber.byoAvailableLabel')}
                            </p>
                            <div className="mt-1.5 space-y-1.5">
                              {byoResult.available.map((n) => (
                                <button
                                  key={n.phoneNumber}
                                  type="button"
                                  onClick={() => {
                                    setByoNumber(n.phoneNumber);
                                    setError(null);
                                  }}
                                  className={`flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-left text-sm transition ${
                                    byoNumber === n.phoneNumber
                                      ? 'border-sky-500 bg-sky-50 text-sky-700'
                                      : 'border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-800 dark:text-zinc-200 hover:border-zinc-300 dark:hover:border-zinc-600'
                                  }`}
                                >
                                  <span className="truncate font-medium">
                                    {n.phoneNumber}
                                    {n.locality ? (
                                      <span className="ml-1.5 text-xs font-normal text-zinc-400">
                                        · {n.locality}
                                      </span>
                                    ) : null}
                                  </span>
                                  <IconCheck
                                    className={`size-4 shrink-0 ${byoNumber === n.phoneNumber ? 'opacity-100' : 'opacity-0'}`}
                                  />
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                        {byoResult.owned.length === 0 && byoResult.available.length === 0 && (
                          <p className="rounded-lg bg-zinc-50 dark:bg-zinc-900 px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400">
                            {t('phoneNumber.byoEmpty')}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {byoProvider !== null && byoProvider !== 'telnyx' && (
                  <div>
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                        {byoProvider === 'twilio'
                          ? t('phoneNumber.byoProviderTwilio')
                          : byoProvider === 'vonage'
                            ? t('phoneNumber.byoProviderVonage')
                            : t('phoneNumber.byoProviderOther')}
                      </p>
                      <Button
                        label={t('common.back')}
                        variant="ghost"
                        size="sm"
                        icon={<IconChevronLeft className="size-3.5" />}
                        onClick={() => setByoProvider(null)}
                      />
                    </div>
                    <div className="mt-3 rounded-xl border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 p-4">
                      <p className="text-sm font-semibold text-amber-700 dark:text-amber-400">
                        {t('phoneNumber.byoComingSoonTitle')}
                      </p>
                      <p className="mt-1 text-xs leading-relaxed text-amber-700/80 dark:text-amber-400/80">
                        {t('phoneNumber.byoComingSoonDesc')}
                      </p>
                      <p className="mt-2 text-xs leading-relaxed text-amber-700/70 dark:text-amber-400/70">
                        {t('phoneNumber.byoComingSoonWorkaround')}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}

            {step === 3 && (
              <div className="space-y-4">
                {/* Ringkasan nomor + provider */}
                <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4">
                  <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                    {t('phoneNumber.configureSummary')}
                  </p>
                  <div className="mt-2 space-y-1.5">
                    <div className="flex items-start justify-between gap-3 text-sm">
                      <span className="shrink-0 text-zinc-500 dark:text-zinc-400">{t('phoneNumber.numberLabel')}</span>
                      <span className="min-w-0 text-right font-semibold text-zinc-900 dark:text-zinc-100">
                        {currentSetupNumber ?? t('phoneNumber.provisioning')}
                      </span>
                    </div>
                    <div className="flex items-start justify-between gap-3 text-sm">
                      <span className="shrink-0 text-zinc-500 dark:text-zinc-400">{t('phoneNumber.providerLabel')}</span>
                      <span className="min-w-0 text-right font-semibold text-zinc-900 dark:text-zinc-100">
                        {currentProvider}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Assistant — user memilih produk, bukan primitive Vapi. */}
                <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4">
                  <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                    {t('phoneNumber.assistantTitle')}
                  </p>
                  <p className="mt-2 text-sm text-zinc-800 dark:text-zinc-200">
                    {t('phoneNumber.configureAssistantQuestion')}
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <span className="size-2.5 rounded-full bg-emerald-500" />
                    <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                      {assistantName}
                    </span>
                    <Badge variant="success" label={t('phoneNumber.assistantActive')} />
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                    {t('phoneNumber.configureAssistantHint')}
                  </p>
                </div>

                {/* Calling — outbound ON (core product), inbound OFF (MVP). */}
                <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4">
                  <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                    {t('phoneNumber.callingTitle')}
                  </p>
                  <div className="mt-3 space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                          {t('phoneNumber.outboundLabel')}
                        </p>
                        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                          {t('phoneNumber.outboundDesc')}
                        </p>
                      </div>
                      <Badge variant="success" label={t('phoneNumber.enabled')} />
                    </div>
                    <div className="flex items-center justify-between gap-3 border-t border-zinc-100 dark:border-zinc-800 pt-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                          {t('phoneNumber.inboundLabel')}
                        </p>
                        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                          {t('phoneNumber.inboundDesc')}
                        </p>
                      </div>
                      <Badge variant="neutral" label={t('phoneNumber.disabled')} />
                    </div>
                    <p className="border-t border-zinc-100 dark:border-zinc-800 pt-3 text-xs leading-relaxed text-zinc-400">
                      {t('phoneNumber.configureCallingHint')}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {step === 4 && (
              <div>
                <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  {t('phoneNumber.testTitle')}
                </p>
                <div className="mt-1.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-3 text-xs">
                  <div className="flex items-center justify-between gap-3 py-1">
                    <span className="shrink-0 text-zinc-500 dark:text-zinc-400">{t('phoneNumber.numberLabel')}</span>
                    <span className="min-w-0 text-right font-semibold text-zinc-900 dark:text-zinc-100">
                      {currentSetupNumber ?? '—'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3 py-1">
                    <span className="shrink-0 text-zinc-500 dark:text-zinc-400">{t('phoneNumber.assistantLabel')}</span>
                    <span className="min-w-0 text-right font-semibold text-zinc-900 dark:text-zinc-100">
                      {assistantName}
                    </span>
                  </div>
                </div>
                <div className="mt-4">
                  <TestCallSection />
                </div>
              </div>
            )}

            {error && (
              <Banner
                status="error"
                title={error}
                isDismissable
                onDismiss={() => setError(null)}
                className="mt-3"
              />
            )}
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <div className="flex items-center justify-between gap-2">
              <div className="flex gap-2">
                {step > 1 && (
                  <Button
                    label={t('common.back')}
                    variant="ghost"
                    icon={<IconChevronLeft className="size-3.5" />}
                    isDisabled={busy || provisionBusy || byoSearching || byoConnecting}
                    onClick={() => {
                      setError(null);
                      if (step === 2) setStep(1);
                      else if (step === 3) setStep(2);
                      else if (step === 4) setStep(3);
                    }}
                  />
                )}
                <Button
                  label={t('common.cancel')}
                  variant="ghost"
                  icon={<IconX className="size-3.5" />}
                  isDisabled={busy}
                  onClick={() => void closeWithRelease()}
                />
              </div>

              <div className="flex gap-2">
                {step === 2 && method === 'vapi' && (
                  <Button
                    label={t('common.continue')}
                    variant="primary"
                    icon={<IconChevronRight className="size-3.5" />}
                    isDisabled={!provisioned || provisionBusy}
                    onClick={() => setStep(3)}
                  />
                )}
                {step === 2 && method === 'byo' && byoProvider === 'telnyx' && (
                  <Button
                    label={t('phoneNumber.byoConnectCta')}
                    variant="primary"
                    isLoading={byoConnecting}
                    isDisabled={byoConnecting || !byoNumber.trim()}
                    onClick={() => void connectByo()}
                  />
                )}
                {step === 3 && (
                  <Button
                    label={t('common.continue')}
                    variant="primary"
                    icon={<IconChevronRight className="size-3.5" />}
                    isDisabled={!canContinueConfigure}
                    onClick={() => setStep(4)}
                  />
                )}
                {step === 4 && (
                  <Button
                    label={t('phoneNumber.finishSetup')}
                    variant="primary"
                    isLoading={busy}
                    isDisabled={busy}
                    onClick={() => void finish()}
                  />
                )}
              </div>
            </div>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
