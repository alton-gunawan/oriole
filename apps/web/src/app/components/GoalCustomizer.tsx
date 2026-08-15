import { useMemo, useState } from 'react';
import {
  composeCallGoal,
  determineCallGoal,
  GOAL_TYPES,
  goalTypeLabel,
  GOAL_TYPE_LABELS,
  type BookingGoalContext,
  type BusinessGoalContext,
  type GoalCustomization,
  type GoalDecision,
} from '@oriole/call-goals';

import { IconCheck, IconChevronDown, IconPhone } from '../shell/icons';

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
 */
export function GoalCustomizer({
  booking,
  business,
  value,
  onChange,
  autoDecision = determineCallGoal(booking),
  disabled = false,
}: GoalCustomizerProps) {
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
            {isCustomized && (
              <span className="rounded-full bg-zinc-900 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-amber-400">
                Customized
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
            {active.summary}. {autoDecision.reason}
          </p>
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((valueOpen) => !valueOpen)}
          aria-expanded={open}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-amber-300 bg-white dark:bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-amber-700 transition hover:bg-amber-100 active:scale-[0.98] disabled:opacity-50"
        >
          {isCustomized ? 'Edit custom call' : 'Customize Call'}
          <IconChevronDown className={`size-3.5 transition ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>

      {/* Panel kustomisasi (collapsed default) */}
      {open && (
        <div className="mt-4 space-y-4 border-t border-amber-200/70 pt-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold text-zinc-700 dark:text-zinc-300">Goal type</span>
              <select
                value={goalType}
                onChange={(event) =>
                  onChange(packCustomization(event.target.value as GoalTypeSelection, customInstruction))
                }
                className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2.5 text-sm outline-none transition focus:border-amber-400 focus:ring-4 focus:ring-amber-500/10"
              >
                <option value="auto">Auto (recommended)</option>
                {GOAL_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {goalTypeLabel(type)}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-xs text-zinc-500 dark:text-zinc-400">
                Override pilihan otomatis bila diperlukan.
              </span>
            </label>

            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                Extra instructions
              </span>
              <input
                type="text"
                maxLength={500}
                value={customInstruction}
                onChange={(event) => onChange(packCustomization(goalType, event.target.value))}
                placeholder="e.g. Mention the first-visit discount"
                className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2.5 text-sm outline-none transition placeholder:text-zinc-400 focus:border-amber-400 focus:ring-4 focus:ring-amber-500/10"
              />
              <span className="mt-1 block text-xs text-zinc-500 dark:text-zinc-400">
                Instruksi singkat disisipkan ke prompt CALL-E.
              </span>
            </label>
          </div>

          {/* Preview goal final */}
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="rounded-full bg-zinc-100 dark:bg-zinc-800 px-2.5 py-1 text-xs font-semibold text-zinc-600 dark:text-zinc-400">
                {GOAL_TYPE_LABELS[active.goalType]}
              </span>
              <span className="rounded-full bg-zinc-100 dark:bg-zinc-800 px-2.5 py-1 text-xs font-semibold text-zinc-600 dark:text-zinc-400 capitalize">
                tone · {active.tone}
              </span>
              <span className="rounded-full bg-zinc-100 dark:bg-zinc-800 px-2.5 py-1 text-xs font-semibold text-zinc-600 dark:text-zinc-400 uppercase">
                {active.language}
              </span>
              <span className="rounded-full bg-zinc-100 dark:bg-zinc-800 px-2.5 py-1 text-xs font-semibold text-zinc-600 dark:text-zinc-400">
                voicemail · {active.voicemailBehavior.replace('-', ' ')}
              </span>
            </div>
            <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-zinc-950 p-3 text-xs leading-relaxed text-zinc-200">
              {active.prompt}
            </pre>
          </div>

          {isCustomized && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange(null)}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-zinc-600 dark:text-zinc-400 transition hover:bg-white dark:hover:bg-zinc-900 hover:text-zinc-900 dark:hover:text-zinc-100 disabled:opacity-50"
            >
              <IconCheck className="size-3.5" />
              Reset to automatic
            </button>
          )}
        </div>
      )}
    </div>
  );
}
