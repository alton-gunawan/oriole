import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button } from '@astryxdesign/core';
import { useTranslation } from 'react-i18next';

import { apiFetch } from '../../../lib/api';
import { errorMessage } from '../../../lib/errors';
import type {
  VapiHealthResponse,
  VapiVoiceStatusResponse,
} from '../../../lib/integrations';
import { ConfirmDialog } from '../ui';
import { IconAlertTriangle, IconPhone, IconRefresh, IconSettings, IconX } from '../icons';
import { providerLabel } from './phone';
import { PhoneNumberManageDialog } from './PhoneNumberManage';
import {
  PhoneNumberWizardDialog,
  type WizardInitialState,
} from './PhoneNumberWizard';

/**
 * Kartu "Phone Number" — entry point pengelolaan nomor di Settings → Voice AI.
 *
 * State machine (MVP Oriole):
 *   NOT_CONNECTED → (wizard) → CONNECTING (provisionPending) → ACTIVE
 * Error ditampilkan inline (CONNECTION_FAILED / PROVIDER_AUTH_FAILED /
 * OUTBOUND_NOT_READY / VAPI_CONNECTION_ERROR / WEBHOOK_UNHEALTHY).
 */
export function PhoneNumberPanel() {
  const { t } = useTranslation();
  const [voiceStatus, setVoiceStatus] = useState<VapiVoiceStatusResponse | null>(null);
  const [health, setHealth] = useState<VapiHealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ── Dialog wizard & manage ──
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardReplace, setWizardReplace] = useState(false);
  const [wizardInitial, setWizardInitial] = useState<WizardInitialState | null>(null);
  const [manageOpen, setManageOpen] = useState(false);

  // ── Batal setup pending (konfirmasi) ──
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [v, h] = await Promise.all([
        apiFetch<VapiVoiceStatusResponse>('/integrations/vapi'),
        apiFetch<VapiHealthResponse>('/integrations/vapi/health').catch(() => null),
      ]);
      setVoiceStatus(v);
      setHealth(h);
    } catch (err) {
      setError(errorMessage(err, t, 'phoneNumber.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  const loadedRef = useRef(false);
  useEffect(() => {
    if (!loadedRef.current) {
      loadedRef.current = true;
      void load();
    }
  }, [load]);

  const selected = voiceStatus?.selected ?? null;
  const number = selected?.identifier ?? selected?.config.phoneNumber ?? null;
  const pending = selected?.config.provisionPending === true;
  const outboundReady = health?.outboundReady ?? false;
  const serverConfigured = voiceStatus?.apiKeyConfigured ?? false;

  const openConnect = () => {
    setWizardReplace(false);
    setWizardInitial(null);
    setWizardOpen(true);
  };

  const openResume = () => {
    setWizardReplace(false);
    setWizardInitial({
      provisioned: {
        vapiPhoneNumberId: selected?.config.vapiPhoneNumberId ?? '',
        number: number,
      },
    });
    setWizardOpen(true);
  };

  const openManage = () => {
    setManageOpen(true);
  };

  const openChangeNumber = () => {
    setManageOpen(false);
    setWizardReplace(true);
    setWizardInitial(null);
    setWizardOpen(true);
  };

  const cancelPending = async () => {
    setCancelling(true);
    setError(null);
    try {
      await apiFetch('/integrations/vapi/cancel-provision', { method: 'POST' });
      setCancelConfirmOpen(false);
      await load();
    } catch (err) {
      setError(errorMessage(err, t, 'phoneNumber.cancelSetupFailed'));
    } finally {
      setCancelling(false);
    }
  };

  return (
    <>
      <section>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-base font-medium text-zinc-700 dark:text-zinc-300">
                {t('phoneNumber.sectionTitle')}
              </p>
              {selected && !pending && (
                <Badge variant="success" label={t('phoneNumber.active')} />
              )}
              {pending && <Badge variant="info" label={t('phoneNumber.setupInProgress')} />}
            </div>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              {t('phoneNumber.sectionDesc')}
            </p>
          </div>
          {!loading && (
            <Button
              label={t('phoneNumber.retry')}
              variant="ghost"
              size="sm"
              isIconOnly
              icon={<IconRefresh className="size-4" />}
              onClick={() => void load()}
            />
          )}
        </div>

        <div className="mt-4">
          {loading && !voiceStatus ? (
            <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
              <span className="size-2.5 animate-pulse rounded-full bg-amber-500" />
              {t('phoneNumber.connecting')}
            </div>
          ) : !serverConfigured ? (
            <div className="rounded-lg bg-amber-50 dark:bg-amber-950/40 px-3 py-2.5 text-xs leading-relaxed text-amber-700 dark:text-amber-400">
              {t('phoneNumber.serverNotConfigured')}
            </div>
          ) : error && !selected ? (
            <div className="space-y-2">
              <p role="alert" className="rounded-lg bg-red-50 dark:bg-red-950/40 px-3 py-2.5 text-xs leading-relaxed text-red-600 dark:text-red-400">
                {error}
              </p>
              <Button
                label={t('phoneNumber.retry')}
                variant="secondary"
                size="sm"
                onClick={() => void load()}
              />
            </div>
          ) : !selected ? (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-zinc-300 dark:border-zinc-600 px-4 py-8 text-center">
              <span className="flex size-10 items-center justify-center rounded-xl bg-zinc-100 dark:bg-zinc-800 text-zinc-400">
                <IconPhone className="size-5" />
              </span>
              <div>
                <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  {t('phoneNumber.notConnectedTitle')}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                  {t('phoneNumber.notConnectedDesc')}
                </p>
              </div>
              <Button
                label={t('phoneNumber.connectCta')}
                variant="primary"
                icon={<IconPhone className="size-3.5" />}
                onClick={openConnect}
              />
            </div>
          ) : pending ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 px-3 py-2.5">
                <span className="size-2.5 shrink-0 animate-pulse rounded-full bg-amber-500" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
                    {t('phoneNumber.setupInProgressDesc')}
                  </p>
                  <p className="truncate text-xs text-amber-700/80 dark:text-amber-400/80">
                    {number ?? t('phoneNumber.provisioning')}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  label={t('phoneNumber.continueSetup')}
                  variant="primary"
                  size="sm"
                  onClick={openResume}
                />
                <Button
                  label={t('phoneNumber.cancelSetup')}
                  variant="ghost"
                  size="sm"
                  icon={<IconX className="size-3.5" />}
                  onClick={() => setCancelConfirmOpen(true)}
                />
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2.5">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="size-2.5 shrink-0 rounded-full bg-emerald-500" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                      {number ?? t('phoneNumber.provisioning')}
                    </p>
                    <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                      {providerLabel(selected?.config.mode, selected?.config.provider, t)}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    label={t('phoneNumber.manage')}
                    variant="secondary"
                    size="sm"
                    icon={<IconSettings className="size-3.5" />}
                    onClick={openManage}
                  />
                </div>
              </div>

              {!outboundReady && (
                <div className="flex items-start gap-2 rounded-lg bg-amber-50 dark:bg-amber-950/40 px-3 py-2.5 text-xs leading-relaxed text-amber-700 dark:text-amber-400">
                  <IconAlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    <span className="font-semibold">{t('phoneNumber.notReady')}: </span>
                    {t('phoneNumber.notReadyDesc')}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      {/* Wizard connect / change number */}
      <PhoneNumberWizardDialog
        isOpen={wizardOpen}
        onOpenChange={setWizardOpen}
        replaceMode={wizardReplace}
        currentNumber={wizardReplace ? number : null}
        initialState={wizardInitial}
        existingNumbers={voiceStatus?.numbers ?? null}
        onComplete={() => void load()}
      />

      {/* Detail / kelola nomor */}
      <PhoneNumberManageDialog
        isOpen={manageOpen}
        onOpenChange={setManageOpen}
        onRefresh={() => void load()}
        onChangeNumber={openChangeNumber}
      />

      {/* Konfirmasi batal setup (lepas nomor pending) */}
      <ConfirmDialog
        isOpen={cancelConfirmOpen}
        onOpenChange={(open) => {
          if (!open) setCancelConfirmOpen(false);
        }}
        title={t('phoneNumber.cancelSetupTitle')}
        description={t('phoneNumber.cancelSetupDesc')}
        cancelLabel={t('common.cancel')}
        actionLabel={t('phoneNumber.cancelSetupConfirm')}
        actionVariant="destructive"
        isActionLoading={cancelling}
        onAction={() => void cancelPending()}
        width={420}
      />
    </>
  );
}
