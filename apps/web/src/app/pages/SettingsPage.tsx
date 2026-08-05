import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Button, Switch, TextInput } from '@astryxdesign/core';
import { useTranslation } from 'react-i18next';

import { signOut } from '../../lib/session';
import { useSessionStore } from '../../stores/session';
import { IconBell, IconPlug, IconShield } from '../shell/icons';
import { Card, PageHeader } from '../shell/ui';

export function SettingsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const user = useSessionStore((s) => s.user);
  const [name, setName] = useState(user?.name ?? '');
  const [notif, setNotif] = useState({ email: true, call: false, weekly: true });

  return (
    <div className="space-y-8">
      <PageHeader title={t('settings.title')} description={t('settings.description')} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Profile */}
        <Card className="p-6 lg:col-span-2">
          <div className="mb-5 flex items-center gap-3">
            <span className="flex size-12 items-center justify-center rounded-full bg-zinc-900 text-lg font-bold text-amber-400">
              {(user?.name ?? user?.email ?? 'U').slice(0, 1).toUpperCase()}
            </span>
            <div>
              <h3 className="text-sm font-semibold text-zinc-900">{t('settings.profile')}</h3>
              <p className="text-xs text-zinc-500">{t('settings.profileDesc')}</p>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <TextInput
              label={t('common.name')}
              value={name}
              onChange={setName}
              width="100%"
            />
            <TextInput
              label={t('common.email')}
              value={user?.email ?? ''}
              isDisabled
              width="100%"
            />
          </div>
          <p className="mt-3 text-xs text-zinc-400">
            {t('settings.emailManaged')}
          </p>
        </Card>

        {/* Notifications */}
        <Card className="p-6">
          <div className="mb-2 flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600">
              <IconBell className="size-4" />
            </span>
            <h3 className="text-sm font-semibold text-zinc-900">{t('settings.notifications')}</h3>
          </div>
          <div className="divide-y divide-zinc-100">
            <Switch
              label={t('settings.transactionalEmail')}
              description={t('settings.transactionalEmailDesc')}
              value={notif.email}
              onChange={(v) => setNotif((s) => ({ ...s, email: v }))}
              labelPosition="start"
              labelSpacing="spread"
            />
            <Switch
              label={t('settings.aiCalls')}
              description={t('settings.aiCallsDesc')}
              value={notif.call}
              onChange={(v) => setNotif((s) => ({ ...s, call: v }))}
              labelPosition="start"
              labelSpacing="spread"
            />
            <Switch
              label={t('settings.weeklySummary')}
              description={t('settings.weeklySummaryDesc')}
              value={notif.weekly}
              onChange={(v) => setNotif((s) => ({ ...s, weekly: v }))}
              labelPosition="start"
              labelSpacing="spread"
            />
          </div>
        </Card>
      </div>

      {/* Channels & automatic reminders */}
      <Card className="p-6">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600">
            <IconPlug className="size-4" />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-zinc-900">{t('settings.channelsTitle')}</h3>
            <p className="text-xs text-zinc-500">{t('settings.channelsDesc')}</p>
          </div>
        </div>
        <div className="mt-4">
          <Button
            label={t('settings.channelsCta')}
            variant="secondary"
            icon={<IconPlug className="size-4" />}
            onClick={() => navigate('/app/channels')}
          />
        </div>
      </Card>

      {/* Danger zone */}
      <Card className="border-red-100 p-6">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-red-50 text-red-500">
            <IconShield className="size-4" />
          </span>
          <h3 className="text-sm font-semibold text-zinc-900">{t('settings.dangerZone')}</h3>
        </div>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs leading-relaxed text-zinc-500">
            {t('settings.dangerDesc')}
          </p>
          <Button
            label={t('common.logout')}
            variant="destructive"
            onClick={() => void signOut().then(() => navigate('/auth/sign-in', { replace: true }))}
          />
        </div>
      </Card>
    </div>
  );
}
