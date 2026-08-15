import { useMemo, useState } from 'react';
import { Badge, Button, Selector, TextInput } from '@astryxdesign/core';
import { useTranslation } from 'react-i18next';
import {
  composeCallGoal,
  determineCallGoal,
  GOAL_TYPES,
  type BookingGoalContext,
  type BusinessGoalContext,
  type GoalCustomization,
  type GoalDecision,
} from '@oriole/call-goals';

import { goalTypeKey, toneKey, voicemailKey } from '../../i18n/enums';
import { IconCheck, IconChevronDown, IconPhone } from './icons';

interface GoalCustomizerProps {
  booking: BookingGoalContext;
  business: BusinessGoalContext;
  value: GoalCustomization | null;
  onChange: (value: GoalCustomization | null) => void;
  autoDecision?: GoalDecision;
  disabled?: boolean;
}

function packCustomization(
  goalType: GoalTypeSelection,
  customInstruction: string,
): GoalCustomization | null {
  const trimmed = customInstruction.trim();
  if (goalType === 'auto' && !trimmed) return null;
  return {
    goalType: goalType === 'auto' ? undefined : goalType,
    customInstruction: trimmed || undefined,
  };
}

type GoalTypeSelection = (typeof GOAL_TYPES)[number] | 'auto';

/**
 * Progressive disclosure untuk goal CALL-E:
 * default fully automatic (badge + status), tombol "Customize Call" collapsed,
 * panel berisi override goal type + instruksi singkat + preview goal final.
 *
 * Catatan: file ini adalah versi ter-migrasi (astryx) dari
 * `components/GoalCustomizer.tsx` — file lama masih tersimpan karena root-owned
 * (tidak bisa ditulis/dihapus dari editor); aman dihapus setelah izin diperbaiki
 * via `sudo chmod -R 666 apps/web/src/app/components`.
 */
export function GoalCustomizer({
  booking,
  business,
  value,
  onChange,
  autoDecision = determineCallGoal(booking),
  disabled = false,
}: GoalCustomizerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const autoConfig = useMemo(
    () => composeCallGoal({ booking, business }, autoDecision),
    [booking, business, autoDecision],
  );
  const effectiveConfig = useMemo(
    () => composeCallGoal({ booking, business, customization: value }, autoDecision),
    [booking, business, value, autoDecision],
  );

  const isCustomized = Boolean(
    value?.goalType || value?.customInstruction?.trim(),
  );

  const goalType: GoalTypeSelection = value?.goalType ?? 'auto';
  const customInstruction = value?.customInstruction ?? '';

  if (!autoConfig) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-3 py-2.5 text-sm text-zinc-500 dark:text-zinc-400">
        <IconPhone className="size-4 text-zinc-400" />
        {autoDecision.reason}
      </div>
    );
  }

  const active = effectiveConfig ?? autoConfig;

  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50/40 p-4 dark:border-amber-900/60 dark:bg-amber-950/30">
      {/* Status otomatis — pengalaman default */}
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-amber-500 text-white">
          <IconPhone className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {isCustomized ? active.title : autoConfig.title}
            </p>
            {isCustomized && <Badge variant="neutral" label={t('goal.customized')} />}
          </div>
          <p className="mt-0.5 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
            {active.summary}. {autoDecision.reason}
          </p>
        </div>
        <Button
          label={isCustomized ? t('goal.editCustomCall') : t('goal.customizeCall')}
          variant="secondary"
          size="sm"
          icon={<IconChevronDown className={`size-3.5 transition ${open ? 'rotate-180' : ''}`} />}
          isDisabled={disabled}
          onClick={() => setOpen((valueOpen) => !valueOpen)}
        />
      </div>

      {/* Panel kustomisasi (collapsed default) */}
      {open && (
        <div className="mt-4 space-y-4 border-t border-amber-200/70 pt-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Selector
              label={t('goal.goalType')}
              description={t('goal.goalTypeDesc')}
              options={[
                { value: 'auto', label: t('goal.autoRecommended') },
                ...GOAL_TYPES.map((type) => ({ value: type, label: t(goalTypeKey(type)!) })),
              ]}
              value={goalType}
              onChange={(value) =>
                onChange(packCustomization(value as GoalTypeSelection, customInstruction))
              }
              width="100%"
            />

            <TextInput
              label={t('goal.extraInstructions')}
              description={t('goal.extraInstructionsDesc')}
              value={customInstruction}
              // TextInput astryx tidak punya maxLength — cap manual sama seperti aslinya.
              onChange={(value) => onChange(packCustomization(goalType, value.slice(0, 500)))}
              placeholder={t('goal.instructionsPlaceholder')}
              width="100%"
            />
          </div>

          {/* Preview goal final */}
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="neutral" label={t(goalTypeKey(active.goalType)!)} />
              <Badge
                variant="neutral"
                label={`${t('goal.toneLabel')} · ${t(toneKey(active.tone))}`}
              />
              <Badge variant="neutral" label={active.language} />
              <Badge
                variant="neutral"
                label={`${t('goal.voicemailLabel')} · ${t(voicemailKey(active.voicemailBehavior))}`}
              />
            </div>
            <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-zinc-950 p-3 text-xs leading-relaxed text-zinc-200">
              {active.prompt}
            </pre>
          </div>

          {isCustomized && (
            <Button
              label={t('goal.resetAutomatic')}
              variant="ghost"
              size="sm"
              icon={<IconCheck className="size-3.5" />}
              isDisabled={disabled}
              onClick={() => onChange(null)}
            />
          )}
        </div>
      )}
    </div>
  );
}
