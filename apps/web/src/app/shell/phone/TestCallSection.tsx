import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, TextInput } from '@astryxdesign/core';
import { useTranslation } from 'react-i18next';

import { apiFetch } from '../../../lib/api';
import { errorMessage } from '../../../lib/errors';
import type {
  VapiTestCallStartResponse,
  VapiTestCallStatusResponse,
} from '../../../lib/integrations';
import { IconAlertTriangle, IconCheck, IconPhone, IconRefresh } from '../icons';

/** Fase panggilan uji — mencerminkan checklist "Calling...". */
export type TestCallPhase = 'idle' | 'starting' | 'calling' | 'success' | 'failed';

/** Langkah checklist saat panggilan berjalan. */
const CALL_STEPS = ['starting', 'connecting', 'speaking', 'waiting'] as const;
type CallStep = (typeof CALL_STEPS)[number];

/** Status Vapi → langkah checklist aktif. */
function stepForStatus(status: string | null | undefined): CallStep {
  switch (status) {
    case 'queued':
    case 'scheduled':
      return 'starting';
    case 'ringing':
    case 'forwarding':
      return 'connecting';
    case 'in-progress':
      return 'speaking';
    default:
      return 'waiting';
  }
}

/** Key i18n untuk item sukses panggilan uji — statis agar type-safe. */
const SUCCESS_ITEM_KEYS = {
  connected: 'phoneNumber.testSuccess.connected',
  answered: 'phoneNumber.testSuccess.answered',
  responded: 'phoneNumber.testSuccess.responded',
  recorded: 'phoneNumber.testSuccess.recorded',
} as const;
const SUCCESS_ITEMS = ['connected', 'answered', 'responded', 'recorded'] as const;

/**
 * Panggilan uji (test call) — verifikasi bahwa nomor keluar workspace benar-benar
 * bisa melakukan panggilan AI. Menempatkan call via backend (POST
 * /integrations/vapi/test-call) lalu mem-poll status dari Vapi sampai terminal
 * (ended → outcome). Dipakai di wizard (step 4) dan dialog manage.
 */
export function TestCallSection() {
  const { t } = useTranslation();
  const [phone, setPhone] = useState('');
  const [phase, setPhase] = useState<TestCallPhase>('idle');
  const [status, setStatus] = useState<string | null>(null);
  const [result, setResult] = useState<VapiTestCallStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Bersihkan polling saat komponen dilepas (wizard pindah langkah / dialog tutup).
  useEffect(() => stopPolling, [stopPolling]);

  const pollStatus = useCallback(
    (callId: string) => {
      stopPolling();
      const tick = async () => {
        try {
          const info = await apiFetch<VapiTestCallStatusResponse>(
            `/integrations/vapi/test-call/${callId}`,
          );
          if (info.status === 'ended' || info.outcome) {
            setStatus(info.status);
            setResult(info);
            setPhase(info.outcome === 'completed' ? 'success' : 'failed');
          } else {
            setStatus(info.status);
            timerRef.current = window.setTimeout(tick, 2500);
          }
        } catch (err) {
          setPhase('failed');
          setError(errorMessage(err, t, 'phoneNumber.testStatusFailed'));
        }
      };
      // Tunda jeda singkat pertama — Vapi butuh waktu mencatat status awal.
      timerRef.current = window.setTimeout(tick, 1200);
    },
    [stopPolling, t],
  );

  const runTest = async () => {
    const clean = phone.trim();
    if (!clean) {
      setError(t('phoneNumber.testPhoneRequired'));
      return;
    }
    setError(null);
    setResult(null);
    setStatus(null);
    setPhase('starting');
    try {
      const response = await apiFetch<VapiTestCallStartResponse>(
        '/integrations/vapi/test-call',
        { method: 'POST', body: JSON.stringify({ phone: clean }) },
      );
      setStatus(response.status);
      setPhase('calling');
      pollStatus(response.callId);
    } catch (err) {
      setPhase('failed');
      setError(errorMessage(err, t, 'phoneNumber.testFailed'));
    }
  };

  const reset = () => {
    stopPolling();
    setPhone('');
    setPhase('idle');
    setStatus(null);
    setResult(null);
    setError(null);
  };

  const activeStep: CallStep | null =
    phase === 'calling' ? stepForStatus(status) : phase === 'starting' ? 'starting' : null;

  return (
    <div className="space-y-4">
      <form
        id="test-call-form"
        onSubmit={(event) => {
          event.preventDefault();
          void runTest();
        }}
        className="space-y-3"
      >
        <div>
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            {t('phoneNumber.testPhoneLabel')}
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-zinc-400">
            {t('phoneNumber.testPhoneDesc')}
          </p>
        </div>
        <div className="flex items-end gap-2">
          <TextInput
            label={t('phoneNumber.testPhoneLabel')}
            isLabelHidden
            value={phone}
            onChange={(value) => {
              setPhone(value);
              setError(null);
            }}
            placeholder="+62 812 3456 7890"
            isDisabled={phase === 'starting' || phase === 'calling'}
            isRequired
            width="100%"
          />
          <Button
            label={t('phoneNumber.startTestCall')}
            variant="primary"
            icon={<IconPhone className="size-3.5" />}
            isLoading={phase === 'starting'}
            isDisabled={phase === 'calling' || !phone.trim()}
            onClick={() => void runTest()}
          />
        </div>
      </form>

      {error && (
        <p role="alert" className="text-xs font-medium text-red-600">{error}</p>
      )}

      {phase === 'calling' && (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4">
          <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {t('phoneNumber.testCalling')}
          </p>
          <ul className="mt-3 space-y-2">
            {CALL_STEPS.map((step) => {
              const done = CALL_STEPS.indexOf(activeStep ?? 'waiting') > CALL_STEPS.indexOf(step);
              const current = activeStep === step;
              return (
                <li key={step} className="flex items-center gap-2 text-sm">
                  {done ? (
                    <IconCheck className="size-4 shrink-0 text-emerald-500" />
                  ) : current ? (
                    <span className="size-4 shrink-0 animate-pulse rounded-full border-2 border-amber-500" />
                  ) : (
                    <span className="size-4 shrink-0 rounded-full border-2 border-zinc-200 dark:border-zinc-700" />
                  )}
                  <span
                    className={
                      done
                        ? 'text-zinc-500 dark:text-zinc-400'
                        : current
                          ? 'font-medium text-zinc-900 dark:text-zinc-100'
                          : 'text-zinc-400 dark:text-zinc-500'
                    }
                  >
                    {t(`phoneNumber.testStep.${step}`)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {phase === 'success' && result && (
        <div className="rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-emerald-700 dark:text-emerald-400">
            <IconCheck className="size-4" />
            {t('phoneNumber.testSuccessTitle')}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-emerald-700/80 dark:text-emerald-400/80">
            {t('phoneNumber.testSuccessDesc')}
          </p>
          <ul className="mt-3 space-y-1.5">
            {SUCCESS_ITEMS.map((item) => (
              <li key={item} className="flex items-center gap-2 text-xs text-emerald-700/90 dark:text-emerald-400/90">
                <IconCheck className="size-3.5 shrink-0" />
                {t(SUCCESS_ITEM_KEYS[item])}
              </li>
            ))}
          </ul>
          {result.durationSeconds != null && (
            <p className="mt-3 text-xs text-emerald-700/80 dark:text-emerald-400/80">
              {t('phoneNumber.testDuration', { seconds: result.durationSeconds })}
            </p>
          )}
        </div>
      )}

      {phase === 'failed' && (
        <div className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-red-700 dark:text-red-400">
            <IconAlertTriangle className="size-4" />
            {t('phoneNumber.testFailedTitle')}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-red-700/80 dark:text-red-400/80">
            {t('phoneNumber.testFailedDesc')}
          </p>
          <div className="mt-3 flex gap-2">
            <Button
              label={t('phoneNumber.tryAgain')}
              variant="secondary"
              size="sm"
              icon={<IconRefresh className="size-3.5" />}
              onClick={reset}
            />
          </div>
        </div>
      )}

      {(phase === 'success' || phase === 'failed') && (
        <button
          type="button"
          onClick={reset}
          className="text-xs font-medium text-zinc-400 underline-offset-2 hover:text-zinc-600 dark:hover:text-zinc-300 hover:underline"
        >
          {t('phoneNumber.testAnother')}
        </button>
      )}
    </div>
  );
}
