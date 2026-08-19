import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Selector, TextInput } from '@astryxdesign/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  composeCallGoal,
  GOAL_TYPES,
  type BookingGoalContext,
  type BusinessGoalContext,
  type GoalCustomization,
  type GoalDecision,
} from '@oriole/call-goals';

import { apiFetch } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { goalTypeKey, toneKey, voicemailKey } from '../../i18n/enums';
import { useWorkspaceStore } from '../../stores/workspace';
import { IconCheck, IconChevronDown, IconPhone } from './icons';

type GoalTypeSelection = (typeof GOAL_TYPES)[number] | 'auto';

interface AiBehaviorCardProps {
  booking: BookingGoalContext;
  business: BusinessGoalContext;
  /** Keputusan mesin goal (autoGoal dari respons detail booking). */
  autoDecision: GoalDecision;
  /** Kustomisasi tersimpan di booking (null = fully automatic). */
  value: GoalCustomization | null;
  /** Kontrol panel kustomisasi — dipakai juga tombol "Customize AI" di hero. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Kemas draft form → payload GoalCustomization (null = reset ke automatic). */
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

/**
 * Kartu "AI behavior" Booking Detail — business UI, bukan developer UI:
 * default menampilkan ringkasan apa yang ditangani AI secara otomatis, dan
 * panel kustomisasi (goal type + instruksi singkat) hanya muncul saat dibuka.
 * Prompt mentah TIDAK pernah ditampilkan di sini.
 */
export function AiBehaviorCard({
  booking,
  business,
  autoDecision,
  value,
  open,
  onOpenChange,
}: AiBehaviorCardProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);

  // Draft lokal — disimpan hanya saat tombol Save ditekan (bukan per keystroke).
  const [goalType, setGoalType] = useState<GoalTypeSelection>('auto');
  const [customInstruction, setCustomInstruction] = useState('');

  // Sinkronkan draft dengan nilai tersimpan saat booking dimuat ulang.
  useEffect(() => {
    setGoalType(value?.goalType ?? 'auto');
    setCustomInstruction(value?.customInstruction ?? '');
  }, [value]);

  const autoConfig = useMemo(
    () => composeCallGoal({ booking, business }, autoDecision),
    [booking, business, autoDecision],
  );
  const effectiveConfig = useMemo(
    () => composeCallGoal({ booking, business, customization: value }, autoDecision),
    [booking, business, value, autoDecision],
  );
  const active = effectiveConfig ?? autoConfig;

  const saveGoalMutation = useMutation({
    mutationFn: (goal: GoalCustomization | null) =>
      apiFetch(`/bookings/${booking.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ goal }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['booking', activeWorkspaceId, booking.id] });
      queryClient.invalidateQueries({ queryKey: ['bookings', activeWorkspaceId] });
      onOpenChange(false);
    },
  });

  const isCustomized = Boolean(value?.goalType || value?.customInstruction?.trim());

  return (
    <section className="border-t border-zinc-100 pt-4 dark:border-zinc-800">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-bold uppercase tracking-wider text-blue-600 dark:text-blue-400">
              {t('bookingDetail.aiBehavior')}
            </h2>
            {isCustomized && <Badge variant="neutral" label={t('goal.customized')} />}
          </div>
          {active ? (
            <p className="mt-1.5 text-base leading-relaxed text-zinc-700 dark:text-zinc-300">
              {t('bookingDetail.aiHandles')}{' '}
              <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 font-medium text-zinc-800 dark:text-zinc-200">
                <span className="inline-flex items-center gap-1">
                  <IconCheck className="size-3.5 text-emerald-600" aria-hidden="true" />
                  {t('bookingDetail.handlesConfirmation')}
                </span>
                <span className="inline-flex items-center gap-1">
                  <IconCheck className="size-3.5 text-emerald-600" aria-hidden="true" />
                  {t('bookingDetail.handlesRescheduling')}
                </span>
                <span className="inline-flex items-center gap-1">
                  <IconCheck className="size-3.5 text-emerald-600" aria-hidden="true" />
                  {t('bookingDetail.handlesCancellation')}
                </span>
              </span>
            </p>
          ) : (
            <p className="mt-1.5 flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
              <IconPhone className="size-4 text-zinc-400" aria-hidden="true" />
              {t('bookingDetail.noCallPlanned')}
            </p>
          )}
        </div>
        <Button
          label={open ? t('common.close') : t('bookingDetail.customizeAi')}
          variant="secondary"
          size="sm"
          icon={<IconChevronDown className={`size-3.5 transition ${open ? 'rotate-180' : ''}`} />}
          isDisabled={!active}
          onClick={() => onOpenChange(!open)}
        />
      </div>

      {open && active && (
        <div className="mt-4 space-y-4 border-t border-zinc-100 pt-4 dark:border-zinc-800">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Selector
              label={t('bookingDetail.goal')}
              description={t('goal.goalTypeDesc')}
              options={[
                { value: 'auto', label: t('goal.autoRecommended') },
                ...GOAL_TYPES.map((type) => ({
                  value: type,
                  label: t(goalTypeKey(type)!),
                })),
              ]}
              value={goalType}
              onChange={(value) => setGoalType(value as GoalTypeSelection)}
              width="100%"
            />

            <TextInput
              label={t('goal.extraInstructions')}
              description={t('goal.extraInstructionsDesc')}
              value={customInstruction}
              // TextInput astryx tidak punya maxLength — cap manual (sama dengan
              // backend z.string().max(500)).
              onChange={(value) => setCustomInstruction(value.slice(0, 500))}
              placeholder={t('goal.instructionsPlaceholder')}
              width="100%"
            />
          </div>

          {goalType === 'auto' && (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              {t('bookingDetail.goalAuto', { goal: active.title })}
            </p>
          )}

          <dl className="flex flex-wrap gap-x-8 gap-y-2">
            <div className="flex items-center gap-2">
              <dt className="text-sm font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                {t('bookingDetail.tone')}
              </dt>
              <dd className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
                {t(toneKey(active.tone))}
              </dd>
            </div>
            <div className="flex items-center gap-2">
              <dt className="text-sm font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                {t('bookingDetail.voicemail')}
              </dt>
              <dd className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
                {t(voicemailKey(active.voicemailBehavior))}
              </dd>
            </div>
          </dl>

          {saveGoalMutation.isError && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {errorMessage(saveGoalMutation.error, t, 'errors.saveBooking')}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button
              label={t('common.cancel')}
              variant="ghost"
              isDisabled={saveGoalMutation.isPending}
              onClick={() => onOpenChange(false)}
            />
            <Button
              label={t('common.save')}
              variant="primary"
              isLoading={saveGoalMutation.isPending}
              isDisabled={saveGoalMutation.isPending}
              onClick={() => saveGoalMutation.mutate(packCustomization(goalType, customInstruction))}
            />
          </div>
        </div>
      )}
    </section>
  );
}
