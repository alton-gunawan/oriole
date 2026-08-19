import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Dialog,
  DialogHeader,
  Layout,
  LayoutContent,
  LayoutFooter,
} from '@astryxdesign/core';
import { useTranslation } from 'react-i18next';

import { apiFetch } from '../../../lib/api';
import { errorMessage } from '../../../lib/errors';
import { formatDateTime } from '../../../i18n/format';
import type {
  VapiHealthResponse,
  VapiVoiceStatusResponse,
} from '../../../lib/integrations';
import { useWorkspaceStore } from '../../../stores/workspace';
import { ConfirmDialog } from '../ui';
import {
  IconAlertTriangle,
  IconCheck,
  IconPhone,
  IconRefresh,
  IconSettings,
  IconTrash,
  IconX,
} from '../icons';
import { displayNumber, providerLabel } from './phone';
import { TestCallSection } from './TestCallSection';

/** Satu baris cek health — ikon + label + nilai. */
function HealthRow({
  ok,
  label,
}: {
  ok: boolean;
  label: string;
}) {
  return (
    <li className="flex items-center gap-2 text-sm">
      {ok ? (
        <IconCheck className="size-4 shrink-0 text-emerald-500" />
      ) : (
        <IconX className="size-4 shrink-0 text-red-500" />
      )}
      <span className={ok ? 'text-zinc-700 dark:text-zinc-300' : 'font-medium text-red-600 dark:text-red-400'}>
        {label}
      </span>
    </li>
  );
}

/**
 * Detail / kelola nomor telepon yang terhubung: test call, ganti nomor,
 * ganti assistant, status calling, health card, dan danger zone (disconnect).
 * Dibuka dari kartu Phone Number di Settings → Voice AI.
 */
export function PhoneNumberManageDialog({
  isOpen,
  onOpenChange,
  onRefresh,
  onChangeNumber,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** Reload data panel (setelah disconnect / perubahan). */
  onRefresh: () => void;
  /** Buka wizard "Change number" (replace mode). */
  onChangeNumber: () => void;
}) {
  const { t } = useTranslation();
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const assistantName =
    useWorkspaceStore((s) => s.workspaces.find((w) => w.id === activeWorkspaceId)?.callAssistantName) ??
    'Sarah';

  const [voiceStatus, setVoiceStatus] = useState<VapiVoiceStatusResponse | null>(null);
  const [health, setHealth] = useState<VapiHealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showTest, setShowTest] = useState(false);
  const [healthLoading, setHealthLoading] = useState(false);

  // ── Change assistant (sub-dialog) ──
  const [assistantOpen, setAssistantOpen] = useState(false);

  // ── Disconnect (danger zone + konfirmasi ketik DISCONNECT) ──
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    setHealthLoading(true);
    try {
      const [v, h] = await Promise.all([
        apiFetch<VapiVoiceStatusResponse>('/integrations/vapi'),
        apiFetch<VapiHealthResponse>('/integrations/vapi/health'),
      ]);
      setVoiceStatus(v);
      setHealth(h);
    } catch (err) {
      setError(errorMessage(err, t, 'phoneNumber.loadFailed'));
    } finally {
      setHealthLoading(false);
    }
  }, [t]);

  const prevOpenRef = useRef(false);
  useEffect(() => {
    const justOpened = isOpen && !prevOpenRef.current;
    prevOpenRef.current = isOpen;
    if (!justOpened) return;
    setShowTest(false);
    setAssistantOpen(false);
    setDisconnectOpen(false);
    void load();
  }, [isOpen, load]);

  const selected = voiceStatus?.selected ?? null;
  const number = selected?.identifier ?? selected?.config.phoneNumber ?? null;
  const provider = providerLabel(selected?.config.mode, selected?.config.provider, t);
  const pending = selected?.config.provisionPending === true;

  const outboundReady = health?.outboundReady ?? false;

  const disconnect = async () => {
    setDisconnecting(true);
    setError(null);
    try {
      await apiFetch('/integrations/vapi', { method: 'DELETE' });
      setDisconnectOpen(false);
      onOpenChange(false);
      onRefresh();
    } catch (err) {
      setError(errorMessage(err, t, 'phoneNumber.disconnectFailed'));
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <>
      <Dialog
        isOpen={isOpen}
        onOpenChange={(open) => {
          if (!open) onOpenChange(false);
        }}
        purpose="info"
        width={560}
        maxHeight="min(85vh, 700px)"
      >
        <Layout
          header={
            <DialogHeader
              title={t('phoneNumber.manageTitle')}
              subtitle={`${displayNumber(number)} · ${provider}`}
              startContent={<IconPhone className="size-5 shrink-0 text-amber-600" />}
              onOpenChange={(open) => {
                if (!open) onOpenChange(false);
              }}
              hasDivider
            />
          }
          content={
            <LayoutContent>
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <Badge variant="success" label={t('phoneNumber.active')} />
                </div>

                {/* Action required — nomor terhubung tapi outbound belum siap. */}
                {!pending && !outboundReady && (
                  <div className="rounded-xl border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 p-4">
                    <p className="flex items-center gap-2 text-sm font-semibold text-amber-700 dark:text-amber-400">
                      <IconAlertTriangle className="size-4" />
                      {t('phoneNumber.notReady')}
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-amber-700/80 dark:text-amber-400/80">
                      {t('phoneNumber.notReadyDesc')}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        label={t('phoneNumber.fixSetup')}
                        variant="secondary"
                        size="sm"
                        onClick={() => void load()}
                      />
                    </div>
                  </div>
                )}

                {/* Aksi utama */}
                <div className="flex flex-wrap gap-2">
                  <Button
                    label={t('phoneNumber.testCall')}
                    variant="primary"
                    size="sm"
                    icon={<IconPhone className="size-3.5" />}
                    onClick={() => setShowTest((prev) => !prev)}
                  />
                  <Button
                    label={t('phoneNumber.changeNumber')}
                    variant="secondary"
                    size="sm"
                    icon={<IconSettings className="size-3.5" />}
                    onClick={onChangeNumber}
                  />
                </div>

                {showTest && (
                  <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4">
                    <TestCallSection />
                  </div>
                )}

                {/* Assistant */}
                <section className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4">
                  <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                    {t('phoneNumber.assistantTitle')}
                  </p>
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                        {assistantName}
                      </p>
                      <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                        {t('phoneNumber.assistantSubtitle')}
                      </p>
                    </div>
                    <Button
                      label={t('phoneNumber.changeAssistant')}
                      variant="ghost"
                      size="sm"
                      onClick={() => setAssistantOpen(true)}
                    />
                  </div>
                </section>

                {/* Calling */}
                <section className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4">
                  <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                    {t('phoneNumber.callingTitle')}
                  </p>
                  <div className="mt-3 space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                        {t('phoneNumber.outboundLabel')}
                      </p>
                      <Badge variant="success" label={t('phoneNumber.enabled')} />
                    </div>
                    <div className="flex items-center justify-between gap-3 border-t border-zinc-100 dark:border-zinc-800 pt-3">
                      <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                        {t('phoneNumber.inboundLabel')}
                      </p>
                      <Badge variant="neutral" label={t('phoneNumber.disabled')} />
                    </div>
                    <p className="border-t border-zinc-100 dark:border-zinc-800 pt-3 text-xs leading-relaxed text-zinc-400">
                      {t('phoneNumber.manageCallingHint')}
                    </p>
                  </div>
                </section>

                {/* Health */}
                <section className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                      {t('phoneNumber.healthTitle')}
                    </p>
                    <Button
                      label={t('phoneNumber.healthRefresh')}
                      variant="ghost"
                      size="sm"
                      icon={<IconRefresh className="size-3.5" />}
                      isLoading={healthLoading}
                      isDisabled={healthLoading}
                      onClick={() => void load()}
                    />
                  </div>
                  {health ? (
                    <>
                      <ul className="mt-3 space-y-2">
                        <HealthRow ok={health.numberActive} label={t('phoneNumber.healthNumber')} />
                        <HealthRow ok={health.assistantAssigned} label={t('phoneNumber.healthAssistant')} />
                        <HealthRow ok={health.outboundReady} label={t('phoneNumber.healthOutbound')} />
                        <HealthRow ok={health.configured && health.webhookConfigured} label={t('phoneNumber.healthVapi')} />
                      </ul>
                      <div className="mt-3 space-y-1 border-t border-zinc-100 dark:border-zinc-800 pt-3 text-xs text-zinc-500 dark:text-zinc-400">
                        <p>
                          {t('phoneNumber.healthChecked')}{' '}
                          <span className="font-medium text-zinc-700 dark:text-zinc-300">
                            {formatDateTime(health.checkedAt)}
                          </span>
                        </p>
                        <p>
                          {t('phoneNumber.healthLastCall')}{' '}
                          <span className="font-medium text-zinc-700 dark:text-zinc-300">
                            {formatDateTime(health.lastSuccessfulCallAt)}
                          </span>
                        </p>
                      </div>
                    </>
                  ) : (
                    <p className="mt-3 text-xs text-zinc-400">{t('phoneNumber.healthUnavailable')}</p>
                  )}
                </section>

                {/* Danger zone */}
                <section className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50/40 dark:bg-red-950/20 p-4">
                  <p className="text-xs font-medium uppercase tracking-wider text-red-500">
                    {t('phoneNumber.dangerZone')}
                  </p>
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                        {t('phoneNumber.disconnectTitle')}
                      </p>
                      <p className="mt-0.5 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                        {t('phoneNumber.disconnectDesc')}
                      </p>
                    </div>
                    <Button
                      label={t('phoneNumber.disconnectCta')}
                      variant="destructive"
                      size="sm"
                      icon={<IconTrash className="size-3.5" />}
                      onClick={() => setDisconnectOpen(true)}
                    />
                  </div>
                </section>

                {error && (
                  <p role="alert" className="text-xs font-medium text-red-600">{error}</p>
                )}
              </div>
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              <div className="flex justify-end">
                <Button
                  label={t('common.close')}
                  variant="ghost"
                  onClick={() => onOpenChange(false)}
                />
              </div>
            </LayoutFooter>
          }
        />
      </Dialog>

      {/* Change assistant — satu asisten workspace dipakai otomatis. */}
      <Dialog
        isOpen={assistantOpen}
        onOpenChange={setAssistantOpen}
        purpose="info"
        width={420}
      >
        <Layout
          header={
            <DialogHeader
              title={t('phoneNumber.assistantDialogTitle')}
              startContent={<IconPhone className="size-5 shrink-0 text-amber-600" />}
              onOpenChange={setAssistantOpen}
              hasDivider
            />
          }
          content={
            <LayoutContent>
              <div className="space-y-3">
                <div className="flex items-center gap-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2.5">
                  <span className="size-2.5 shrink-0 rounded-full bg-emerald-500" />
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                    {assistantName}
                  </span>
                  <Badge variant="success" label={t('phoneNumber.assistantActive')} />
                </div>
                <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                  {t('phoneNumber.assistantDialogDesc')}
                </p>
              </div>
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              <div className="flex justify-end">
                <Button
                  label={t('common.close')}
                  variant="ghost"
                  onClick={() => setAssistantOpen(false)}
                />
              </div>
            </LayoutFooter>
          }
        />
      </Dialog>

      {/* Disconnect — ketik DISCONNECT untuk lanjut. */}
      <ConfirmDialog
        isOpen={disconnectOpen}
        onOpenChange={(open) => {
          if (!open) {
            setDisconnectOpen(false);
            setError(null);
          }
        }}
        title={t('phoneNumber.disconnectConfirmTitle', { number: displayNumber(number) })}
        description={t('phoneNumber.disconnectConfirmDesc')}
        cancelLabel={t('common.cancel')}
        actionLabel={t('phoneNumber.disconnectCta')}
        actionVariant="destructive"
        isActionLoading={disconnecting}
        onAction={() => void disconnect()}
        confirmText="DISCONNECT"
        width={420}
      />
    </>
  );
}
