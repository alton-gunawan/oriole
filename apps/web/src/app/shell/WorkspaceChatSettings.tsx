import { useState } from 'react';
import { Button, Selector } from '@astryxdesign/core';
import { useTranslation } from 'react-i18next';

import { apiFetch } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import type { Workspace } from '../../lib/workspace';
import { useWorkspaceStore } from '../../stores/workspace';
import { IconChat } from './icons';

/**
 * Bahasa balasan bot chat per project (workspace): pilihan English (default)
 * atau Bahasa Indonesia. Berlaku untuk balasan otomatis di Telegram, WhatsApp,
 * dan email (reminder, konfirmasi, ubah jadwal, dll.) — disimpan di
 * `workspaces.chat_language` via PATCH /me/workspaces/:id. Terpisah dari
 * bahasa panggilan CALL-E (`callGoalLanguage`).
 */
export function WorkspaceChatSettings({ workspace }: { workspace: Workspace }) {
  const { t } = useTranslation();
  const updateWorkspace = useWorkspaceStore((state) => state.updateWorkspace);

  const [language, setLanguage] = useState(workspace.chatLanguage ?? 'en');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = (workspace.chatLanguage ?? 'en') !== language;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const response = await apiFetch<{ workspace: Workspace }>(
        `/me/workspaces/${workspace.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ chatLanguage: language }),
        },
      );
      updateWorkspace(response.workspace);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(errorMessage(err, t, 'ws.chatSettingsError'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600">
          <IconChat className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-zinc-900">{t('ws.chatTitle')}</h3>
          <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">{t('ws.chatDesc')}</p>
        </div>
      </div>

      <div className="mt-4 space-y-4">
        <Selector
          label={t('ws.chatLanguageLabel')}
          description={t('ws.chatLanguageDesc')}
          options={[
            { value: 'en', label: t('ws.chatLanguageEnglish') },
            { value: 'id', label: t('ws.chatLanguageIndonesian') },
          ]}
          value={language}
          onChange={(value) => setLanguage(value)}
          width="100%"
        />

        <div className="flex items-center justify-end gap-2">
          {error && (
            <p role="alert" className="text-xs text-red-600">
              {error}
            </p>
          )}
          <Button
            label={saved ? t('ws.chatSaved') : t('ws.saveChatSettings')}
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
