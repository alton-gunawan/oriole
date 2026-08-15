import { useState } from 'react';
import { Collapsible } from '@astryxdesign/core';
import { useTranslation } from 'react-i18next';
import { Trans } from 'react-i18next';

import { IconChevronDown, IconHelp, IconMail } from '../shell/icons';
import { Card, PageHeader } from '../shell/ui';

const FAQS = [
  { qKey: 'help.faq1q', aKey: 'help.faq1a' },
  { qKey: 'help.faq2q', aKey: 'help.faq2a' },
  { qKey: 'help.faq3q', aKey: 'help.faq3a' },
  { qKey: 'help.faq4q', aKey: 'help.faq4a' },
  { qKey: 'help.faq5q', aKey: 'help.faq5a' },
] as const;

export function HelpPage() {
  const { t } = useTranslation();
  const [open, setOpen] = useState<number | null>(0);

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('help.title')}
        description={t('help.description')}
        icon={IconHelp}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* FAQ */}
        <Card className="p-2 lg:col-span-2">
          {FAQS.map((faq, i) => {
            const isOpen = open === i;
            return (
              <div key={faq.qKey} className="border-b border-zinc-100 dark:border-zinc-800 last:border-b-0">
                <Collapsible
                  isOpen={isOpen}
                  onOpenChange={(next) => setOpen(next ? i : null)}
                  trigger={
                    <span className="flex w-full items-center justify-between gap-4 px-4 py-4 text-left">
                      <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t(faq.qKey)}</span>
                      <IconChevronDown
                        className={`size-4 shrink-0 text-zinc-400 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
                      />
                    </span>
                  }
                >
                  <p className="px-4 pb-4 text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">{t(faq.aKey)}</p>
                </Collapsible>
              </div>
            );
          })}
        </Card>

        {/* Support card */}
        <div className="space-y-6">
          <Card className="p-6">
            <span className="flex size-10 items-center justify-center rounded-xl bg-amber-500/10 text-amber-600">
              <IconHelp className="size-5" />
            </span>
            <h3 className="mt-4 text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t('help.needMore')}</h3>
            <p className="mt-1.5 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400 [&_code]:rounded [&_code]:bg-zinc-100 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs">
              <Trans i18nKey="help.needMoreDesc">
                Full architecture & deployment docs live in this repo. Start with <code>docs/architecture.md</code>.
              </Trans>
            </p>
            <a
              href="mailto:support@oriole.dev"
              className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-4 py-2 text-sm font-semibold text-zinc-700 dark:text-zinc-300 transition hover:bg-zinc-50 dark:hover:bg-zinc-900 active:scale-[0.98]"
            >
              <IconMail className="size-4" />
              {t('help.contactSupport')}
            </a>
          </Card>

          <Card className="bg-zinc-950 p-6">
            <p className="text-xs font-semibold uppercase tracking-widest text-amber-400">
              {t('help.systemStatus')}
            </p>
            <ul className="mt-3 space-y-2 text-xs text-zinc-400">
              <li className="flex items-center justify-between">
                <span>{t('help.database')}</span>
                <span className="flex items-center gap-1.5 text-emerald-400">
                  <span className="size-1.5 rounded-full bg-emerald-400" /> {t('help.connected')}
                </span>
              </li>
              <li className="flex items-center justify-between">
                <span>{t('help.auth')}</span>
                <span className="flex items-center gap-1.5 text-emerald-400">
                  <span className="size-1.5 rounded-full bg-emerald-400" /> {t('help.active')}
                </span>
              </li>
              <li className="flex items-center justify-between">
                <span>{t('help.billing')}</span>
                <span className="text-zinc-500 dark:text-zinc-400">{t('help.waitingConfig')}</span>
              </li>
              <li className="flex items-center justify-between">
                <span>{t('help.email')}</span>
                <span className="text-zinc-500 dark:text-zinc-400">{t('help.waitingConfig')}</span>
              </li>
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
