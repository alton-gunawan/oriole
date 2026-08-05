import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Button, TextInput } from '@astryxdesign/core';
import { useTranslation } from 'react-i18next';

import { apiFetch } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { RECOMMENDED_TEMPLATE_CATEGORIES, type Workspace } from '../../lib/workspace';
import { useWorkspaceStore } from '../../stores/workspace';
import { IconCheck } from '../shell/icons';
import { Card } from '../shell/ui';

export function OnboardingPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const addWorkspace = useWorkspaceStore((state) => state.addWorkspace);
  const [name, setName] = useState('');
  const [category, setCategory] = useState<string>(RECOMMENDED_TEMPLATE_CATEGORIES[0].id);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const response = await apiFetch<{ workspace: Workspace }>('/me/workspaces', {
        method: 'POST',
        body: JSON.stringify({ name, templateCategory: category }),
      });
      addWorkspace(response.workspace);
      navigate('/app/dashboard', { replace: true });
    } catch (err) {
      setError(errorMessage(err, t, 'errors.createProject'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen bg-zinc-50 px-4 py-10 sm:px-6">
      <div className="mx-auto max-w-3xl">
        <div className="mb-8 text-center">
          <span className="inline-flex size-12 items-center justify-center rounded-2xl bg-amber-500 text-xl font-bold text-zinc-950 shadow-sm">
            O
          </span>
          <p className="mt-6 text-xs font-semibold uppercase tracking-[0.24em] text-amber-600">{t('onboarding.kicker')}</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-zinc-950">{t('onboarding.title')}</h1>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-zinc-500">
            {t('onboarding.subtitle')}
          </p>
        </div>

        <Card className="p-5 shadow-md sm:p-8">
          <form onSubmit={onSubmit} className="space-y-7">
            <TextInput
              label={t('ws.projectName')}
              description={t('onboarding.nameDesc')}
              value={name}
              onChange={setName}
              placeholder={t('onboarding.namePlaceholder')}
              width="100%"
              hasAutoFocus
            />

            <fieldset>
              <legend className="text-sm font-semibold text-zinc-800">{t('onboarding.businessQuestion')}</legend>
              <p className="mt-1 text-xs text-zinc-500">
                {t('onboarding.businessDesc')}
              </p>
              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {RECOMMENDED_TEMPLATE_CATEGORIES.map((item) => {
                  const selected = category === item.id;
                  return (
                    <label
                      key={item.id}
                      className={`group relative cursor-pointer rounded-xl border p-4 transition hover:-translate-y-0.5 hover:border-amber-300 hover:shadow-sm ${
                        selected ? 'border-amber-400 bg-amber-50/70 ring-2 ring-amber-500/15' : 'border-zinc-200 bg-white'
                      }`}
                    >
                      <input
                        type="radio"
                        name="templateCategory"
                        value={item.id}
                        checked={selected}
                        onChange={() => setCategory(item.id)}
                        className="sr-only"
                      />
                      <span className="flex items-start gap-3">
                        <span className={`flex size-9 shrink-0 items-center justify-center rounded-lg text-base ${selected ? 'bg-amber-500 text-zinc-950' : 'bg-zinc-100 text-zinc-500 group-hover:bg-amber-100 group-hover:text-amber-700'}`}>
                          {item.emoji}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-semibold text-zinc-900">{t(item.labelKey)}</span>
                          <span className="mt-1 block text-xs leading-relaxed text-zinc-500">{t(item.descriptionKey)}</span>
                        </span>
                        <span className={`flex size-5 shrink-0 items-center justify-center rounded-full border ${selected ? 'border-amber-500 bg-amber-500 text-zinc-950' : 'border-zinc-300 text-transparent'}`}>
                          <IconCheck className="size-3" />
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

            <Button
              label={t('onboarding.submit')}
              variant="primary"
              isLoading={isSubmitting}
              isDisabled={isSubmitting || name.trim().length < 2}
              type="submit"
              width="100%"
            />
          </form>
        </Card>
      </div>
    </main>
  );
}
