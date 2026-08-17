import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Banner, Button } from '@astryxdesign/core';
import { useTranslation } from 'react-i18next';

import { apiFetch } from '../../../lib/api';
import { errorMessage } from '../../../lib/errors';
import type {
  InboundNumberInfo,
  VapiInboundListResponse,
  VapiPhoneNumberOption,
  VapiVoiceStatusResponse,
} from '../../../lib/integrations';
import { ConfirmDialog } from '../ui';
import { IconPhone, IconRefresh, IconTrash } from '../icons';
import { displayNumber } from './phone';

/**
 * Kartu "Inbound calls (AI receptionist)" — Settings → Voice AI.
 * Customer menelepon nomor ini → resepsionis AI menjawab, menjawab dari
 * knowledge base + katalog layanan, dan membuat booking (tool live).
 *
 * Jalur connect: pasang nomor yang SUDAH ada di akun Vapi (mis. nomor
 * gratis) — tanpa membeli nomor baru (POST /vapi/inbound/attach).
 */
export function InboundNumberPanel() {
  const { t } = useTranslation();
  const [inbound, setInbound] = useState<InboundNumberInfo[] | null>(null);
  const [available, setAvailable] = useState<VapiPhoneNumberOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attaching, setAttaching] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<InboundNumberInfo | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const [inb, v] = await Promise.all([
        apiFetch<VapiInboundListResponse>('/integrations/vapi/inbound'),
        apiFetch<VapiVoiceStatusResponse>('/integrations/vapi'),
      ]);
      setInbound(inb.numbers);
      // Hanya nomor yang belum terpasang inbound yang bisa dipilih.
      const registered = new Set(inb.numbers.map((n) => n.vapiPhoneNumberId));
      setAvailable(v.numbers.filter((n) => !registered.has(n.id)));
    } catch (err) {
      setError(errorMessage(err, t, 'phoneNumber.inboundLoadFailed'));
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

  const attach = async (vapiPhoneNumberId: string) => {
    setError(null);
    setAttaching(vapiPhoneNumberId);
    try {
      await apiFetch<{ number: InboundNumberInfo }>('/integrations/vapi/inbound/attach', {
        method: 'POST',
        body: JSON.stringify({ vapiPhoneNumberId }),
      });
      await load();
    } catch (err) {
      setError(errorMessage(err, t, 'phoneNumber.inboundAttachFailed'));
    } finally {
      setAttaching(null);
    }
  };

  const remove = async () => {
    if (!removeTarget) return;
    setRemoving(removeTarget.id);
    setError(null);
    try {
      await apiFetch(`/integrations/vapi/inbound/${removeTarget.id}`, { method: 'DELETE' });
      setRemoveTarget(null);
      await load();
    } catch (err) {
      setError(errorMessage(err, t, 'phoneNumber.inboundRemoveFailed'));
    } finally {
      setRemoving(null);
    }
  };

  const numbers = inbound ?? [];

  return (
    <>
      <section>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-base font-medium text-zinc-700 dark:text-zinc-300">
                {t('phoneNumber.inboundTitle')}
              </p>
              {numbers.length > 0 && (
                <Badge variant="success" label={String(numbers.length)} />
              )}
            </div>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              {t('phoneNumber.inboundDesc')}
            </p>
          </div>
          <Button
            label={t('phoneNumber.retry')}
            variant="ghost"
            size="sm"
            isIconOnly
            icon={<IconRefresh className="size-4" />}
            onClick={() => void load()}
          />
        </div>

        <div className="mt-4 space-y-4">
          {error && (
            <Banner
              status="error"
              title={error}
              isDismissable
              onDismiss={() => setError(null)}
            />
          )}

          {loading && !inbound ? (
            <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
              <span className="size-2.5 animate-pulse rounded-full bg-amber-500" />
              {t('phoneNumber.connecting')}
            </div>
          ) : numbers.length > 0 ? (
            <div className="space-y-1.5">
              {numbers.map((n) => (
                <div
                  key={n.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                      {displayNumber(n.number) ?? n.name ?? '—'}
                    </p>
                    <p className="truncate text-xs text-zinc-400">
                      {n.name ?? n.provider}
                    </p>
                  </div>
                  <Button
                    label={t('phoneNumber.inboundRemove')}
                    variant="ghost"
                    size="sm"
                    isIconOnly
                    icon={<IconTrash className="size-4" />}
                    onClick={() => setRemoveTarget(n)}
                  />
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-zinc-300 dark:border-zinc-600 px-4 py-6 text-center">
              <span className="flex size-10 items-center justify-center rounded-xl bg-zinc-100 dark:bg-zinc-800 text-zinc-400">
                <IconPhone className="size-5" />
              </span>
              <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                {t('phoneNumber.inboundEmpty')}
              </p>
            </div>
          )}

          {/* Connect nomor yang sudah ada di akun Vapi (mis. nomor gratis). */}
          {available.length > 0 && (
            <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50/60 dark:bg-zinc-800/40 p-4">
              <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                {t('phoneNumber.inboundConnectTitle')}
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                {t('phoneNumber.inboundConnectDesc')}
              </p>
              <div className="mt-3 space-y-1.5">
                {available.map((n) => (
                  <div
                    key={n.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                        {displayNumber(n.number) ?? n.name ?? '—'}
                      </p>
                      <p className="truncate text-xs text-zinc-400">{n.provider}</p>
                    </div>
                    <Button
                      label={
                        attaching === n.id
                          ? t('phoneNumber.inboundConnecting')
                          : t('phoneNumber.inboundConnectCta')
                      }
                      variant="secondary"
                      size="sm"
                      isLoading={attaching === n.id}
                      isDisabled={attaching !== null}
                      onClick={() => void attach(n.id)}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {!loading && available.length === 0 && numbers.length === 0 && (
            <p className="rounded-lg bg-zinc-50 dark:bg-zinc-900 px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400">
              {t('phoneNumber.inboundNoneAvailable')}
            </p>
          )}
        </div>
      </section>

      <ConfirmDialog
        isOpen={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
        title={t('phoneNumber.inboundRemoveConfirmTitle')}
        description={t('phoneNumber.inboundRemoveConfirmDesc')}
        cancelLabel={t('common.cancel')}
        actionLabel={t('phoneNumber.inboundRemove')}
        actionVariant="destructive"
        isActionLoading={removing !== null}
        onAction={() => void remove()}
        width={420}
      />
    </>
  );
}
