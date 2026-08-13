import { useState } from 'react';
import { Button, Switch, TextArea, TextInput } from '@astryxdesign/core';
import { useTranslation } from 'react-i18next';

import { apiFetch } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import type { AiKnowledge, Workspace } from '../../lib/workspace';
import { useWorkspaceStore } from '../../stores/workspace';
import { IconChat, IconPlus, IconTrash } from './icons';

interface FaqItem {
  q: string;
  a: string;
}

/**
 * Pengaturan AI chat per project (workspace): toggle aktif/nonaktif +
 * knowledge base (layanan+harga, jam buka, lokasi, kebijakan, FAQ dinamis).
 * Knowledge base inilah sumber jawaban bot WhatsApp untuk pertanyaan umum —
 * disimpan di `workspaces.ai_knowledge` via PATCH /me/workspaces/:id.
 */
export function WorkspaceAiSettings({ workspace }: { workspace: Workspace }) {
  const { t } = useTranslation();
  const updateWorkspace = useWorkspaceStore((state) => state.updateWorkspace);

  const kb = workspace.aiKnowledge ?? {};
  const [enabled, setEnabled] = useState(workspace.aiEnabled ?? false);
  const [description, setDescription] = useState(kb.description ?? '');
  const [services, setServices] = useState(kb.services ?? '');
  const [hours, setHours] = useState(kb.hours ?? '');
  const [location, setLocation] = useState(kb.location ?? '');
  const [policy, setPolicy] = useState(kb.policy ?? '');
  const [faq, setFaq] = useState<FaqItem[]>(kb.faq ?? []);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    (workspace.aiEnabled ?? false) !== enabled ||
    (workspace.aiKnowledge?.description ?? '') !== description ||
    (workspace.aiKnowledge?.services ?? '') !== services ||
    (workspace.aiKnowledge?.hours ?? '') !== hours ||
    (workspace.aiKnowledge?.location ?? '') !== location ||
    (workspace.aiKnowledge?.policy ?? '') !== policy ||
    JSON.stringify(workspace.aiKnowledge?.faq ?? []) !== JSON.stringify(faq);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const aiKnowledge: AiKnowledge = {
        description,
        services,
        hours,
        location,
        policy,
        faq,
      };
      const response = await apiFetch<{ workspace: Workspace }>(
        `/me/workspaces/${workspace.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ aiEnabled: enabled, aiKnowledge }),
        },
      );
      updateWorkspace(response.workspace);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(errorMessage(err, t, 'ws.aiSettingsError'));
    } finally {
      setSaving(false);
    }
  };

  const updateFaq = (index: number, patch: Partial<FaqItem>) => {
    setFaq((items) => items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };

  const removeFaq = (index: number) => {
    setFaq((items) => items.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600">
          <IconChat className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-zinc-900">{t('ws.aiChatTitle')}</h3>
          <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">{t('ws.aiChatDesc')}</p>
        </div>
      </div>

      <div className="space-y-5">
        <Switch
          label={t('ws.aiEnabledLabel')}
          description={enabled ? t('ws.aiEnabledOnDesc') : t('ws.aiEnabledOffDesc')}
          value={enabled}
          onChange={(value) => setEnabled(Boolean(value))}
          labelPosition="start"
          labelSpacing="spread"
        />

        <div className="space-y-4">
          <TextArea
            label={t('ws.kbDescriptionLabel')}
            placeholder={t('ws.kbDescriptionPlaceholder')}
            value={description}
            onChange={setDescription}
            rows={2}
            isOptional
            width="100%"
          />
          <TextArea
            label={t('ws.kbServicesLabel')}
            placeholder={t('ws.kbServicesPlaceholder')}
            value={services}
            onChange={setServices}
            rows={4}
            isOptional
            width="100%"
          />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <TextInput
              label={t('ws.kbHoursLabel')}
              placeholder={t('ws.kbHoursPlaceholder')}
              value={hours}
              onChange={setHours}
              isOptional
              width="100%"
            />
            <TextInput
              label={t('ws.kbLocationLabel')}
              placeholder={t('ws.kbLocationPlaceholder')}
              value={location}
              onChange={setLocation}
              isOptional
              width="100%"
            />
          </div>
          <TextArea
            label={t('ws.kbPolicyLabel')}
            placeholder={t('ws.kbPolicyPlaceholder')}
            value={policy}
            onChange={setPolicy}
            rows={2}
            isOptional
            width="100%"
          />
        </div>

        <div className="rounded-lg border border-zinc-200 bg-white/70 p-3">
          <p className="text-xs font-semibold text-zinc-700">{t('ws.kbFaqLabel')}</p>
          <p className="mt-0.5 text-xs text-zinc-500">{t('ws.kbFaqDesc')}</p>

          <div className="mt-3 space-y-3">
            {faq.map((item, index) => (
              <div
                key={index}
                className="rounded-lg border border-zinc-200 bg-white p-3"
              >
                <div className="space-y-2">
                  <TextInput
                    label={t('ws.faqQuestionLabel')}
                    placeholder={t('ws.faqQuestionPlaceholder')}
                    value={item.q}
                    onChange={(value) => updateFaq(index, { q: value })}
                    width="100%"
                  />
                  <TextArea
                    label={t('ws.faqAnswerLabel')}
                    placeholder={t('ws.faqAnswerPlaceholder')}
                    value={item.a}
                    onChange={(value) => updateFaq(index, { a: value })}
                    rows={2}
                    width="100%"
                  />
                </div>
                <div className="mt-2 flex justify-end">
                  <Button
                    label={t('ws.faqRemove')}
                    variant="ghost"
                    size="sm"
                    icon={<IconTrash className="size-3.5" />}
                    onClick={() => removeFaq(index)}
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="mt-3">
            <Button
              label={t('ws.faqAdd')}
              variant="secondary"
              size="sm"
              icon={<IconPlus className="size-3.5" />}
              onClick={() => setFaq((items) => [...items, { q: '', a: '' }])}
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2">
          {error && (
            <p role="alert" className="text-xs text-red-600">
              {error}
            </p>
          )}
          <Button
            label={saved ? t('ws.aiSaved') : t('ws.saveAiSettings')}
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
