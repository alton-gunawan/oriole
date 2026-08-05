import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, Button, Switch, TextInput } from '@astryxdesign/core';
import { useTranslation } from 'react-i18next';

import { apiFetch } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { type ChannelListResponse, type WorkspaceChannel } from '../../lib/messaging';
import { useWorkspaceStore } from '../../stores/workspace';
import type { TranslationKey } from '../../i18n';
import {
  IconCheck,
  IconCopy,
  IconMail,
  IconPhone,
  IconPlug,
  IconRefresh,
  IconSend,
  IconTrash,
} from '../shell/icons';
import { Card, PageHeader } from '../shell/ui';

const CHANNEL_DEFS: {
  type: string;
  label: string;
  descriptionKey: TranslationKey;
  icon: typeof IconPlug;
  accent: string;
}[] = [
  {
    type: 'telegram',
    label: 'Telegram',
    descriptionKey: 'channels.telegramDesc',
    icon: IconSend,
    accent: 'bg-sky-500/10 text-sky-600',
  },
  {
    type: 'whatsapp',
    label: 'WhatsApp',
    descriptionKey: 'channels.whatsappDesc',
    icon: IconPhone,
    accent: 'bg-emerald-500/10 text-emerald-600',
  },
  {
    type: 'email',
    label: 'Email',
    descriptionKey: 'channels.emailDesc',
    icon: IconMail,
    accent: 'bg-amber-500/10 text-amber-600',
  },
];

function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  return Promise.reject(new Error('Clipboard tidak tersedia'));
}

export function ChannelsPage() {
  const { t } = useTranslation();
  const workspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const [channels, setChannels] = useState<WorkspaceChannel[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form kredensial per channel.
  const [telegramToken, setTelegramToken] = useState('');
  const [whatsappKey, setWhatsappKey] = useState('');
  const [busyChannel, setBusyChannel] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<{ channel: string; message: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Pengaturan reminder.
  const [leadMinutes, setLeadMinutes] = useState(120);
  const [leadSaved, setLeadSaved] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await apiFetch<ChannelListResponse>('/channels');
      setChannels(response.channels);
    } catch (err) {
      setError(errorMessage(err, t, 'channels.loadFailed'));
    } finally {
      setLoaded(true);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Load reminder lead dari workspace aktif.
  useEffect(() => {
    const workspace = useWorkspaceStore.getState().workspaces.find(
      (w) => w.id === workspaceId,
    );
    if (workspace?.reminderLeadMinutes) setLeadMinutes(workspace.reminderLeadMinutes);
  }, [workspaceId]);

  const channelRow = (type: string) => channels.find((ch) => ch.channelType === type);

  const setupChannel = async (event: FormEvent<HTMLFormElement>, type: 'telegram' | 'whatsapp') => {
    event.preventDefault();
    setSetupError(null);
    setBusyChannel(type);
    try {
      const body =
        type === 'telegram' ? { token: telegramToken } : { apiKey: whatsappKey };
      const response = await apiFetch<{ channel: WorkspaceChannel }>(
        `/channels/${type}/setup`,
        { method: 'POST', body: JSON.stringify(body) },
      );
      setChannels((prev) => {
        const rest = prev.filter((ch) => ch.channelType !== type);
        return [...rest, response.channel];
      });
      if (type === 'telegram') setTelegramToken('');
      if (type === 'whatsapp') setWhatsappKey('');
    } catch (err) {
      setSetupError({ channel: type, message: errorMessage(err, t, 'channels.setupFailed') });
    } finally {
      setBusyChannel(null);
    }
  };

  const toggleChannel = async (channel: WorkspaceChannel) => {
    setBusyChannel(channel.channelType);
    setSetupError(null);
    try {
      const response = await apiFetch<{ channel: WorkspaceChannel }>(
        `/channels/${channel.channelType}`,
        { method: 'PATCH', body: JSON.stringify({ isActive: !channel.isActive }) },
      );
      setChannels((prev) =>
        prev.map((ch) => (ch.channelType === channel.channelType ? response.channel : ch)),
      );
    } catch (err) {
      setSetupError({
        channel: channel.channelType,
        message: errorMessage(err, t, 'channels.toggleFailed'),
      });
    } finally {
      setBusyChannel(null);
    }
  };

  const rewebhookTelegram = async () => {
    setBusyChannel('telegram');
    setSetupError(null);
    try {
      await apiFetch('/channels/telegram/rewebhook', { method: 'POST' });
      await load();
    } catch (err) {
      setSetupError({
        channel: 'telegram',
        message: errorMessage(err, t, 'channels.rewebhookFailed'),
      });
    } finally {
      setBusyChannel(null);
    }
  };

  const removeChannel = async (type: string) => {
    setBusyChannel(type);
    setSetupError(null);
    try {
      await apiFetch(`/channels/${type}`, { method: 'DELETE' });
      setChannels((prev) => prev.filter((ch) => ch.channelType !== type));
    } catch (err) {
      setSetupError({
        channel: type,
        message: errorMessage(err, t, 'channels.removeFailed'),
      });
    } finally {
      setBusyChannel(null);
    }
  };

  const copyWebhook = async (channel: WorkspaceChannel) => {
    try {
      await copyToClipboard(channel.webhookUrl);
      setCopied(channel.channelType);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setSetupError({
        channel: channel.channelType,
        message: t('channels.copyFailed'),
      });
    }
  };

  const saveLeadMinutes = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSetupError(null);
    try {
      await apiFetch(`/me/workspaces/${workspaceId}`, {
        method: 'PATCH',
        body: JSON.stringify({ reminderLeadMinutes: leadMinutes }),
      });
      setLeadSaved(true);
      setTimeout(() => setLeadSaved(false), 2000);
    } catch (err) {
      setSetupError({
        channel: 'reminder',
        message: errorMessage(err, t, 'channels.reminderSaveFailed'),
      });
    }
  };

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('channels.title')}
        description={t('channels.description')}
      />

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        {CHANNEL_DEFS.map((def) => {
          const channel = channelRow(def.type);
          const configured = Boolean(channel);
          const active = channel?.isActive ?? false;

          return (
            <Card key={def.type} className="flex flex-col p-5">
              <div className="flex items-start gap-3">
                <span className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${def.accent}`}>
                  <def.icon className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-zinc-900">{def.label}</h3>
                    {configured ? (
                      <Badge variant={active ? 'success' : 'neutral'} label={active ? t('channels.active') : t('channels.inactive')} />
                    ) : (
                      <Badge variant="neutral" label={t('channels.notSet')} />
                    )}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-zinc-500">{t(def.descriptionKey)}</p>
                </div>
              </div>

              {setupError?.channel === def.type && (
                <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
                  {setupError.message}
                </p>
              )}

              {/* Email selalu tersedia — tidak butuh konfigurasi. */}
              {def.type === 'email' && (
                <div className="mt-4">
                  <p className="text-xs text-zinc-500">
                    {t('channels.emailNote')}
                  </p>
                </div>
              )}

              {def.type === 'telegram' && !configured && (
                <form onSubmit={(e) => setupChannel(e, 'telegram')} className="mt-4 space-y-3">
                  <TextInput
                    label={t('channels.botToken')}
                    value={telegramToken}
                    onChange={setTelegramToken}
                    placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
                    width="100%"
                  />
                  <Button
                    label={t('channels.connectBot')}
                    variant="primary"
                    width="100%"
                    type="submit"
                    isDisabled={telegramToken.trim().length < 10}
                    isLoading={busyChannel === 'telegram'}
                  />
                </form>
              )}

              {def.type === 'whatsapp' && !configured && (
                <form onSubmit={(e) => setupChannel(e, 'whatsapp')} className="mt-4 space-y-3">
                  <TextInput
                    label={t('channels.apiKey')}
                    value={whatsappKey}
                    onChange={setWhatsappKey}
                    placeholder="0c5a8f…"
                    width="100%"
                  />
                  <Button
                    label={t('channels.connectWhatsapp')}
                    variant="primary"
                    width="100%"
                    type="submit"
                    isDisabled={whatsappKey.trim().length < 10}
                    isLoading={busyChannel === 'whatsapp'}
                  />
                  <p className="text-[11px] leading-relaxed text-zinc-400">
                    {t('channels.whatsappHint')}
                  </p>
                </form>
              )}

              {configured && channel && (
                <div className="mt-4 space-y-3">
                  <div className="rounded-lg bg-zinc-50 p-3">
                    <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-400">
                      {def.type === 'telegram' ? t('channels.botLabel') : t('channels.wabaLabel')}
                    </p>
                    <p className="mt-0.5 truncate text-sm font-medium text-zinc-800">
                      {channel.identifier ?? '—'}
                    </p>
                  </div>

                  <div>
                    <div className="flex items-center justify-between">
                      <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-400">{t('channels.webhookUrl')}</p>
                      <button
                        type="button"
                        onClick={() => void copyWebhook(channel)}
                        className="flex items-center gap-1 text-[11px] font-medium text-amber-600 transition hover:text-amber-500"
                      >
                        {copied === channel.channelType ? (
                          <IconCheck className="size-3.5" />
                        ) : (
                          <IconCopy className="size-3.5" />
                        )}
                        {copied === channel.channelType ? t('channels.copied') : t('channels.copy')}
                      </button>
                    </div>
                    <p className="mt-1 break-all rounded-lg bg-zinc-50 p-2 font-mono text-[11px] leading-relaxed text-zinc-500">
                      {channel.webhookUrl}
                    </p>
                  </div>

                  <Switch
                    label={t('channels.activeSwitch')}
                    description={active ? t('channels.activeDesc') : t('channels.inactiveDesc')}
                    value={active}
                    onChange={() => void toggleChannel(channel)}
                    isDisabled={busyChannel === channel.channelType}
                    labelPosition="start"
                    labelSpacing="spread"
                  />

                  <div className="flex items-center gap-2">
                    {def.type === 'telegram' && (
                      <Button
                        label={t('channels.rewebhook')}
                        variant="ghost"
                        size="sm"
                        icon={<IconRefresh className="size-3.5" />}
                        isDisabled={busyChannel === 'telegram'}
                        isLoading={busyChannel === 'telegram' && !active}
                        onClick={() => void rewebhookTelegram()}
                      />
                    )}
                    <Button
                      label={t('channels.disconnect')}
                      variant="ghost"
                      size="sm"
                      icon={<IconTrash className="size-3.5" />}
                      isDisabled={busyChannel === channel.channelType}
                      onClick={() => void removeChannel(channel.channelType)}
                    />
                  </div>
                </div>
              )}
            </Card>
          );
        })}
      </div>

      {/* Pengaturan reminder */}
      <Card className="p-5">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600">
            <IconPlug className="size-4" />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-zinc-900">{t('channels.reminderTitle')}</h3>
            <p className="text-xs text-zinc-500">
              {t('channels.reminderDesc')}
            </p>
          </div>
        </div>
        <form onSubmit={saveLeadMinutes} className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="w-full sm:w-56">
            <TextInput
              label={t('channels.reminderLeadLabel')}
              value={String(leadMinutes)}
              onChange={(value) => {
                const numeric = Number(value.replace(/\D/g, ''));
                setLeadMinutes(Number.isFinite(numeric) ? numeric : 0);
                setLeadSaved(false);
              }}
              width="100%"
            />
          </div>
          <Button
            label={leadSaved ? t('channels.saved') : t('common.save')}
            variant="secondary"
            type="submit"
            isDisabled={!Number.isFinite(leadMinutes) || leadMinutes < 5}
          />
        </form>
        {setupError?.channel === 'reminder' && (
          <p role="alert" className="mt-2 text-xs text-red-600">
            {setupError.message}
          </p>
        )}
      </Card>

      {error && !loaded && (
        <p role="alert" className="text-sm text-red-600">{error}</p>
      )}
    </div>
  );
}
