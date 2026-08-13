import { useEffect, useState } from 'react';
import { Button, Selector, Switch } from '@astryxdesign/core';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

import { apiFetch } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import type { Workspace } from '../../lib/workspace';
import { useWorkspaceStore } from '../../stores/workspace';
import { formatDateTime } from '../../i18n/format';
import { IconAlertTriangle, IconPhone } from './icons';

interface AutoCallImpact {
  upcoming: number;
  missed: number;
  nearestScheduledAt: string | null;
  nearestCallAt: string | null;
}

/** Preset window auto-call (jam sebelum jadwal) — best practice reminder call. */
const LEAD_PRESETS = [6, 12, 24, 48, 72, 168];

function leadLabel(hours: number, t: TFunction): string {
  if (hours > 0 && hours % 24 === 0) {
    return t('ws.leadDays', { hours, days: hours / 24 });
  }
  return t('ws.leadHours', { hours });
}

/**
 * Pengaturan panggilan AI per project (workspace): bahasa panggilan (default
 * English), switch on/off auto-call, dan window reminder (jam sebelum jadwal).
 * Saat auto-call dinyalakan / window diubah, tampilkan peringatan dampak:
 * berapa booking mendatang yang terdampak + booking terdekat & jam panggilnya.
 */
export function WorkspaceCallSettings({ workspace }: { workspace: Workspace }) {
  const { t } = useTranslation();
  const updateWorkspace = useWorkspaceStore((state) => state.updateWorkspace);

  const [language, setLanguage] = useState(workspace.callGoalLanguage ?? 'en');
  const [enabled, setEnabled] = useState(workspace.autoCallEnabled ?? false);
  const [leadHours, setLeadHours] = useState(workspace.autoCallLeadHours ?? 24);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [impact, setImpact] = useState<AutoCallImpact | null>(null);
  const [impactLoading, setImpactLoading] = useState(false);
  const [impactError, setImpactError] = useState(false);

  const dirty =
    (workspace.callGoalLanguage ?? 'en') !== language ||
    (workspace.autoCallEnabled ?? false) !== enabled ||
    (workspace.autoCallLeadHours ?? 24) !== leadHours;

  // Hitung dampak setiap kali auto-call dinyalakan / window diubah (saat on).
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setImpactLoading(true);
    setImpactError(false);
    apiFetch<AutoCallImpact>(
      `/me/workspaces/${workspace.id}/auto-call-impact?leadHours=${leadHours}`,
    )
      .then((data) => {
        if (!cancelled) setImpact(data);
      })
      .catch(() => {
        // Gagal memuat dampak ≠ tidak ada booking — tampilkan baris error.
        if (!cancelled) {
          setImpact(null);
          setImpactError(true);
        }
      })
      .finally(() => {
        if (!cancelled) setImpactLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, leadHours, workspace.id]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const response = await apiFetch<{ workspace: Workspace }>(
        `/me/workspaces/${workspace.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            callGoalLanguage: language,
            autoCallEnabled: enabled,
            autoCallLeadHours: leadHours,
          }),
        },
      );
      updateWorkspace(response.workspace);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(errorMessage(err, t, 'ws.callSettingsError'));
    } finally {
      setSaving(false);
    }
  };

  const leadOptions = (() => {
    const options = LEAD_PRESETS.map((hours) => ({
      value: String(hours),
      label: leadLabel(hours, t),
    }));
    // Nilai kustom dari server (mis. 36) tetap tampil sebagai opsi aktif.
    if (!LEAD_PRESETS.includes(leadHours)) {
      options.unshift({ value: String(leadHours), label: leadLabel(leadHours, t) });
    }
    return options;
  })();

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600">
          <IconPhone className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-zinc-900">{t('ws.aiCallTitle')}</h3>
          <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">{t('ws.aiCallDesc')}</p>
        </div>
      </div>

      <div className="mt-4 space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Selector
            label={t('ws.languageLabel')}
            description={t('ws.languageDesc')}
            options={[{ value: 'en', label: t('ws.languageEnglish') }]}
            value={language}
            onChange={(value) => setLanguage(value)}
            width="100%"
          />

          <Selector
            label={t('ws.leadLabel')}
            description={t('ws.leadDesc')}
            options={leadOptions}
            value={String(leadHours)}
            onChange={(value) => setLeadHours(Number(value))}
            width="100%"
          />
        </div>

        <Switch
          label={t('ws.autoCallLabel')}
          description={enabled ? t('ws.autoCallOnDesc') : t('ws.autoCallOffDesc')}
          value={enabled}
          onChange={(value) => setEnabled(Boolean(value))}
          labelPosition="start"
          labelSpacing="spread"
        />

        {enabled && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-amber-800">
              <IconAlertTriangle className="size-3.5" />
              {t('ws.impactTitle')}
            </p>
            {impactLoading ? (
              <p className="mt-1 text-xs text-amber-700">
                <span className="inline-block size-3 animate-spin rounded-full border-2 border-amber-500/30 border-t-amber-600 align-middle" />
                <span className="ml-1.5">…</span>
              </p>
            ) : impactError ? (
              <p className="mt-1 text-xs leading-relaxed text-amber-800">{t('ws.impactError')}</p>
            ) : impact && impact.upcoming > 0 ? (
              <div className="mt-1 space-y-0.5 text-xs leading-relaxed text-amber-800">
                <p>{t('ws.impactCount', { count: impact.upcoming })}</p>
                {impact.nearestScheduledAt && impact.nearestCallAt && (
                  <p>
                    {t('ws.impactNearest', {
                      date: formatDateTime(impact.nearestScheduledAt),
                      time: formatDateTime(impact.nearestCallAt),
                    })}
                  </p>
                )}
                {impact.missed > 0 && (
                  <p className="font-medium">{t('ws.impactMissed', { count: impact.missed })}</p>
                )}
                {dirty && <p className="font-medium">{t('ws.impactUnapplied')}</p>}
              </div>
            ) : (
              <p className="mt-1 text-xs leading-relaxed text-amber-800">{t('ws.impactNone')}</p>
            )}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          {error && (
            <p role="alert" className="text-xs text-red-600">
              {error}
            </p>
          )}
          <Button
            label={saved ? t('ws.callSaved') : t('ws.saveCallSettings')}
            variant="primary"
            size="sm"
            isLoading={saving}
            isDisabled={saving || !dirty}
            onClick={() => void save()}
          />
        </div>
      </div>
    </div>
  );
}
