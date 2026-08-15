import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Button, Skeleton } from '@astryxdesign/core';

import { ApiError, apiFetch } from '../../lib/api';
import type { ContactDetailResponse } from '../../lib/contacts';
import { useWorkspaceStore } from '../../stores/workspace';
import { formatDateTime } from '../../i18n/format';
import { IconAlertTriangle, IconChevronLeft, IconMail, IconPhone, IconUsers } from '../shell/icons';
import { Card, PageHeader } from '../shell/ui';

export function ContactDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);

  const { data, isPending, isError, error } = useQuery({
    queryKey: ['contact', activeWorkspaceId, id],
    queryFn: () => apiFetch<ContactDetailResponse>(`/contacts/${id}`),
    enabled: Boolean(id),
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 1,
  });

  const contact = data?.contact;

  return (
    <div className="space-y-8">
      <PageHeader
        title={contact?.name ?? t('contactDetail.title')}
        description={contact ? t('contactDetail.description', { name: contact.name }) : undefined}
        icon={IconUsers}
      >
        <Link
          to="/app/contacts"
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm font-medium text-zinc-600 dark:text-zinc-400 transition hover:bg-zinc-50 dark:hover:bg-zinc-900"
        >
          <IconChevronLeft className="size-4" />
          {t('contactDetail.backToList')}
        </Link>
      </PageHeader>

      {isPending && (
        <Card className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3 p-4">
              <Skeleton width={40} height={40} radius={4} />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton width="40%" height={14} />
                <Skeleton width="66%" height={12} />
              </div>
            </div>
          ))}
        </Card>
      )}

      {isError && (
        <Card className="flex flex-col items-center gap-4 p-10 text-center">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-red-50 text-red-500 dark:bg-red-950/50 dark:text-red-400">
            <IconAlertTriangle className="size-6" />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {error instanceof ApiError && error.status === 404
                ? t('errors.notFoundTitle')
                : t('errors.contactsLoadTitle')}
            </h3>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              {error instanceof ApiError && error.status === 404
                ? t('contactDetail.notFound')
                : error instanceof ApiError
                  ? t('errors.apiStatus', { status: error.status })
                  : t('errors.apiConnection')}
            </p>
          </div>
          <Button label={t('common.retry')} variant="primary" onClick={() => window.location.reload()} />
        </Card>
      )}

      {!isPending && !isError && contact && (
        <Card className="divide-y divide-zinc-100 dark:divide-zinc-800">
          <div className="flex items-center gap-4 p-5">
            <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-amber-100 text-lg font-bold text-amber-700">
              {contact.name.slice(0, 1).toUpperCase()}
            </span>
            <div className="min-w-0">
              <p className="truncate text-lg font-semibold text-zinc-900 dark:text-zinc-100">{contact.name}</p>
              <p className="text-xs text-zinc-400">{t('contactDetail.createdAt', { date: formatDateTime(contact.createdAt) })}</p>
            </div>
          </div>

          <div className="space-y-4 p-5">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">{t('common.phone')}</p>
              <p className="mt-1 flex items-center gap-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">
                <IconPhone className="size-4 text-zinc-400" aria-hidden="true" />
                {contact.phone || '—'}
              </p>
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">{t('common.email')}</p>
              <p className="mt-1 flex items-center gap-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">
                <IconMail className="size-4 text-zinc-400" aria-hidden="true" />
                {contact.email || '—'}
              </p>
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">{t('common.notes')}</p>
              {contact.notes ? (
                <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">{contact.notes}</p>
              ) : (
                <p className="mt-1 text-sm text-zinc-300">—</p>
              )}
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
