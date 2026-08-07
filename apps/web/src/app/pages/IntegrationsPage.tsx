import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Badge,
  Button,
  Dialog,
  DialogHeader,
  DropdownMenu,
  DropdownMenuItem,
  Layout,
  LayoutContent,
  LayoutFooter,
  Switch,
  TextArea,
  TextInput,
} from '@astryxdesign/core';
import { useTranslation } from 'react-i18next';

import { apiFetch } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { type ChannelListResponse, type WorkspaceChannel } from '../../lib/messaging';
import {
  type GoogleCalendarListResponse,
  type GoogleCalendarSyncResult,
  type GoogleFormPreviewResponse,
  type GoogleFormsSyncResult,
  type IntegrationListResponse,
  type NotionDatabaseOption,
  type NotionDatabasesResponse,
  type NotionSyncResult,
  type WebhookTestResult,
  type WorkspaceIntegration,
} from '../../lib/integrations';
import { useWorkspaceStore } from '../../stores/workspace';
import { formatDateTime } from '../../i18n/format';
import type { TranslationKey } from '../../i18n';
import {
  IconCheck,
  IconCopy,
  IconDotsVertical,
  IconMail,
  IconPlug,
  IconRefresh,
  IconSend,
  IconSettings,
  IconTrash,
  IconWebhook,
} from '../shell/icons';
import {
  clearObsidianConfig,
  fetchAllContacts,
  getObsidianLastSyncAt,
  loadObsidianConfig,
  type ObsidianConfig,
  ObsidianError,
  type ObsidianServerInfo,
  saveObsidianConfig,
  setObsidianLastSyncAt,
  syncContactsToObsidian,
  testObsidianConnection,
} from '../../lib/obsidian';
import { Card, PageHeader } from '../shell/ui';

const CHANNEL_DEFS: {
  type: string;
  label: string;
  descriptionKey: TranslationKey;
  /** Logo brand resmi dari svgl.app (aset SVG di-bundle lokal di /brands). */
  logo?: string;
  /** Ikon fallback untuk channel tanpa brand logo (email). */
  icon?: typeof IconPlug;
  accent?: string;
}[] = [
  {
    type: 'telegram',
    label: 'Telegram',
    descriptionKey: 'channels.telegramDesc',
    logo: '/brands/telegram.svg',
  },
  {
    type: 'whatsapp',
    label: 'WhatsApp',
    descriptionKey: 'channels.whatsappDesc',
    logo: '/brands/whatsapp.svg',
  },
  {
    type: 'email',
    label: 'Email',
    descriptionKey: 'channels.emailDesc',
    icon: IconMail,
    accent: 'bg-amber-500/10 text-amber-600',
  },
];

/** Chip logo brand (aset SVG dari svgl.app) — kartu putih dengan logo di dalamnya. */
function BrandLogo({ src, alt, chip = 'size-10 rounded-xl bg-white shadow-sm ring-1 ring-zinc-900/10', img = 'size-6' }: {
  src: string;
  alt: string;
  chip?: string;
  img?: string;
}) {
  return (
    <span className={`flex shrink-0 items-center justify-center ${chip}`}>
      <img src={src} alt={alt} className={img} />
    </span>
  );
}

function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  return Promise.reject(new Error('Clipboard tidak tersedia'));
}

export function IntegrationsPage() {
  const { t } = useTranslation();
  const workspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const [channels, setChannels] = useState<WorkspaceChannel[]>([]);
  const [notion, setNotion] = useState<WorkspaceIntegration | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form kredensial per channel — di dalam dialog setup (tidak inline di kartu).
  const [telegramToken, setTelegramToken] = useState('');
  const [whatsappKey, setWhatsappKey] = useState('');
  const [setupDialog, setSetupDialog] = useState<'telegram' | 'whatsapp' | null>(null);
  const [busyChannel, setBusyChannel] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<{ channel: string; message: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Pengaturan reminder — sekarang di dalam dialog settings.
  const [leadMinutes, setLeadMinutes] = useState(120);
  const [leadSaved, setLeadSaved] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // ── Notion integration ─────────────────────────────────────
  const [notionDialogOpen, setNotionDialogOpen] = useState(false);
  const [notionToken, setNotionToken] = useState('');
  const [notionDatabases, setNotionDatabases] = useState<NotionDatabaseOption[] | null>(null);
  const [notionDatabaseId, setNotionDatabaseId] = useState('');
  const [notionLoadingDatabases, setNotionLoadingDatabases] = useState(false);
  const [notionConnecting, setNotionConnecting] = useState(false);
  const [notionBusy, setNotionBusy] = useState<'sync' | 'disconnect' | null>(null);
  const [notionSyncResult, setNotionSyncResult] = useState<NotionSyncResult | null>(null);
  const [integrationError, setIntegrationError] = useState<string | null>(null);

  // ── Google Forms integration ──────────────────────────────
  const [googleForms, setGoogleForms] = useState<WorkspaceIntegration | null>(null);
  const [formsDialogOpen, setFormsDialogOpen] = useState(false);
  const [formsKey, setFormsKey] = useState('');
  const [formsFormId, setFormsFormId] = useState('');
  const [formsPreview, setFormsPreview] = useState<GoogleFormPreviewResponse | null>(null);
  const [formsLoadingPreview, setFormsLoadingPreview] = useState(false);
  const [formsConnecting, setFormsConnecting] = useState(false);
  const [formsBusy, setFormsBusy] = useState<'sync' | 'disconnect' | null>(null);
  const [formsSyncResult, setFormsSyncResult] = useState<GoogleFormsSyncResult | null>(null);
  const [formsError, setFormsError] = useState<string | null>(null);

  // ── Google Calendar integration ───────────────────────────
  const [googleCalendar, setGoogleCalendar] = useState<WorkspaceIntegration | null>(null);
  const [calendarDialogOpen, setCalendarDialogOpen] = useState(false);
  const [calendarKey, setCalendarKey] = useState('');
  const [calendars, setCalendars] = useState<GoogleCalendarListResponse['calendars'] | null>(null);
  const [calendarId, setCalendarId] = useState('');
  const [calendarLoading, setCalendarLoading] = useState(false);
  const [calendarConnecting, setCalendarConnecting] = useState(false);
  const [calendarBusy, setCalendarBusy] = useState<'sync' | 'disconnect' | null>(null);
  const [calendarSyncResult, setCalendarSyncResult] = useState<GoogleCalendarSyncResult | null>(null);
  const [calendarError, setCalendarError] = useState<string | null>(null);

  // ── Outgoing webhook integration ──────────────────────────
  const [webhook, setWebhook] = useState<WorkspaceIntegration | null>(null);
  const [webhookDialogOpen, setWebhookDialogOpen] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [webhookConnecting, setWebhookConnecting] = useState(false);
  const [webhookTesting, setWebhookTesting] = useState(false);
  const [webhookTestResult, setWebhookTestResult] = useState<string | null>(null);
  const [webhookBusy, setWebhookBusy] = useState<'disconnect' | null>(null);
  const [webhookError, setWebhookError] = useState<string | null>(null);

  // ── Obsidian (lokal per perangkat — sync dari browser) ────
  const [obsidian, setObsidian] = useState<ObsidianConfig | null>(() => loadObsidianConfig());
  const [obsidianDialogOpen, setObsidianDialogOpen] = useState(false);
  const [obsidianUrl, setObsidianUrl] = useState('http://127.0.0.1:27123');
  const [obsidianKey, setObsidianKey] = useState('');
  const [obsidianFolder, setObsidianFolder] = useState('Oriole');
  const [obsidianTesting, setObsidianTesting] = useState(false);
  const [obsidianTested, setObsidianTested] = useState<ObsidianServerInfo | null>(null);
  const [obsidianSyncing, setObsidianSyncing] = useState(false);
  const [obsidianSyncResult, setObsidianSyncResult] = useState<string | null>(null);
  const [obsidianLastSync, setObsidianLastSync] = useState<string | null>(() => getObsidianLastSyncAt());
  const [obsidianError, setObsidianError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [channelRes, integrationRes] = await Promise.all([
        apiFetch<ChannelListResponse>('/channels'),
        apiFetch<IntegrationListResponse>('/integrations'),
      ]);
      setChannels(channelRes.channels);
      setNotion(integrationRes.integrations.find((item) => item.integrationType === 'notion') ?? null);
      setGoogleForms(integrationRes.integrations.find((item) => item.integrationType === 'google-forms') ?? null);
      setGoogleCalendar(integrationRes.integrations.find((item) => item.integrationType === 'google-calendar') ?? null);
      setWebhook(integrationRes.integrations.find((item) => item.integrationType === 'webhook') ?? null);
    } catch (err) {
      setError(errorMessage(err, t, 'integrations.loadFailed'));
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
      setSetupDialog(null);
    } catch (err) {
      setSetupError({ channel: type, message: errorMessage(err, t, 'channels.setupFailed') });
    } finally {
      setBusyChannel(null);
    }
  };

  /** One-click connect — hubungkan bot bersama dari server (env TELEGRAM_BOT_TOKEN), tanpa input token. */
  const connectEnvTelegram = async () => {
    setBusyChannel('telegram');
    setSetupError(null);
    try {
      const response = await apiFetch<{ channel: WorkspaceChannel }>(
        '/channels/telegram/connect',
        { method: 'POST' },
      );
      setChannels((prev) => {
        const rest = prev.filter((ch) => ch.channelType !== 'telegram');
        return [...rest, response.channel];
      });
    } catch (err) {
      setSetupError({
        channel: 'telegram',
        message: errorMessage(err, t, 'channels.setupFailed'),
      });
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

  // Dialog settings — ambil nilai terbaru dari workspace aktif saat dibuka.
  const openReminderSettings = () => {
    const workspace = useWorkspaceStore.getState().workspaces.find(
      (w) => w.id === workspaceId,
    );
    if (workspace?.reminderLeadMinutes) setLeadMinutes(workspace.reminderLeadMinutes);
    setLeadSaved(false);
    setSetupError((prev) => (prev?.channel === 'reminder' ? null : prev));
    setSettingsOpen(true);
  };

  const closeReminderSettings = () => {
    setSettingsOpen(false);
    setSetupError((prev) => (prev?.channel === 'reminder' ? null : prev));
  };

  /* ── Obsidian: connect / sync / disconnect ────────────────── */

  const obsidianErrorText = (err: unknown, fallbackKey: TranslationKey): string => {
    if (err instanceof ObsidianError) return err.message;
    return errorMessage(err, t, fallbackKey);
  };

  const openObsidianDialog = () => {
    setObsidianError(null);
    setObsidianTested(null);
    setObsidianUrl(obsidian?.url ?? 'http://127.0.0.1:27123');
    setObsidianKey(obsidian?.apiKey ?? '');
    setObsidianFolder(obsidian?.folderPath ?? 'Oriole');
    setObsidianDialogOpen(true);
  };

  const closeObsidianDialog = () => {
    setObsidianDialogOpen(false);
    setObsidianError(null);
    setObsidianTested(null);
  };

  const testObsidian = async () => {
    setObsidianError(null);
    setObsidianTested(null);
    setObsidianTesting(true);
    try {
      const info = await testObsidianConnection({
        url: obsidianUrl,
        apiKey: obsidianKey,
        folderPath: obsidianFolder,
      });
      setObsidianTested(info);
    } catch (err) {
      setObsidianError(obsidianErrorText(err, 'obsidian.testFailed'));
    } finally {
      setObsidianTesting(false);
    }
  };

  const connectObsidian = () => {
    setObsidianError(null);
    const config = { url: obsidianUrl, apiKey: obsidianKey, folderPath: obsidianFolder };
    saveObsidianConfig(config);
    setObsidian(config);
    setObsidianSyncResult(null);
    setObsidianDialogOpen(false);
  };

  const syncObsidian = async () => {
    if (!obsidian) return;
    setObsidianError(null);
    setObsidianSyncResult(null);
    setObsidianSyncing(true);
    try {
      const contacts = await fetchAllContacts();
      const result = await syncContactsToObsidian(obsidian, contacts);
      const syncedAt = new Date().toISOString();
      setObsidianLastSync(syncedAt);
      setObsidianLastSyncAt(syncedAt);
      setObsidianSyncResult(
        result.total === 0 ? t('obsidian.syncEmpty') : t('obsidian.syncResult', { count: result.written, folder: obsidian.folderPath }),
      );
    } catch (err) {
      setObsidianError(obsidianErrorText(err, 'obsidian.syncFailed'));
    } finally {
      setObsidianSyncing(false);
    }
  };

  const disconnectObsidian = () => {
    clearObsidianConfig();
    setObsidian(null);
    setObsidianSyncResult(null);
    setObsidianLastSync(null);
    setObsidianError(null);
  };

  /* ── Notion: connect / sync / disconnect ─────────────────── */

  const openNotionDialog = () => {
    setIntegrationError(null);
    setNotionToken('');
    setNotionDatabases(null);
    setNotionDatabaseId('');
    setNotionDialogOpen(true);
  };

  const closeNotionDialog = () => {
    setNotionDialogOpen(false);
    setIntegrationError(null);
  };

  const loadNotionDatabases = async () => {
    setIntegrationError(null);
    setNotionLoadingDatabases(true);
    try {
      const response = await apiFetch<NotionDatabasesResponse>(
        '/integrations/notion/databases',
        { method: 'POST', body: JSON.stringify({ token: notionToken }) },
      );
      setNotionDatabases(response.databases);
    } catch (err) {
      setIntegrationError(errorMessage(err, t, 'notion.tokenError'));
    } finally {
      setNotionLoadingDatabases(false);
    }
  };

  const connectNotion = async () => {
    setIntegrationError(null);
    setNotionConnecting(true);
    try {
      const selected = notionDatabases?.find((db) => db.id === notionDatabaseId);
      const response = await apiFetch<{ integration: WorkspaceIntegration }>(
        '/integrations/notion/connect',
        {
          method: 'POST',
          body: JSON.stringify({
            token: notionToken,
            databaseId: notionDatabaseId,
            databaseName: selected?.title,
          }),
        },
      );
      setNotion(response.integration);
      setNotionSyncResult(null);
      setNotionDialogOpen(false);
    } catch (err) {
      setIntegrationError(errorMessage(err, t, 'notion.saveFailed'));
    } finally {
      setNotionConnecting(false);
    }
  };

  const toggleNotionActive = async () => {
    if (!notion) return;
    setIntegrationError(null);
    try {
      const response = await apiFetch<{ integration: WorkspaceIntegration }>(
        '/integrations/notion',
        { method: 'PATCH', body: JSON.stringify({ isActive: !notion.isActive }) },
      );
      setNotion(response.integration);
    } catch (err) {
      setIntegrationError(errorMessage(err, t, 'notion.saveFailed'));
    }
  };

  const syncNotion = async () => {
    setIntegrationError(null);
    setNotionSyncResult(null);
    setNotionBusy('sync');
    try {
      const result = await apiFetch<NotionSyncResult>('/integrations/notion/sync', {
        method: 'POST',
      });
      setNotionSyncResult(result);
      setNotion((prev) => (prev ? { ...prev, lastSyncAt: result.lastSyncAt } : prev));
    } catch (err) {
      setIntegrationError(errorMessage(err, t, 'notion.syncFailed'));
    } finally {
      setNotionBusy(null);
    }
  };

  const disconnectNotion = async () => {
    setIntegrationError(null);
    setNotionBusy('disconnect');
    try {
      await apiFetch('/integrations/notion', { method: 'DELETE' });
      setNotion(null);
      setNotionSyncResult(null);
    } catch (err) {
      setIntegrationError(errorMessage(err, t, 'notion.saveFailed'));
    } finally {
      setNotionBusy(null);
    }
  };

  /* ── Google Forms: preview / connect / sync / toggle / disconnect ── */

  const openFormsDialog = () => {
    setFormsError(null);
    setFormsKey('');
    setFormsFormId('');
    setFormsPreview(null);
    setFormsDialogOpen(true);
  };

  const closeFormsDialog = () => {
    setFormsDialogOpen(false);
    setFormsError(null);
  };

  const checkForm = async () => {
    setFormsError(null);
    setFormsLoadingPreview(true);
    try {
      const response = await apiFetch<GoogleFormPreviewResponse>('/integrations/forms/preview', {
        method: 'POST',
        body: JSON.stringify({ serviceAccountJson: formsKey, formId: formsFormId }),
      });
      setFormsPreview(response);
    } catch (err) {
      setFormsError(errorMessage(err, t, 'googleForms.saveFailed'));
    } finally {
      setFormsLoadingPreview(false);
    }
  };

  const connectForms = async () => {
    setFormsError(null);
    setFormsConnecting(true);
    try {
      const response = await apiFetch<{ integration: WorkspaceIntegration }>(
        '/integrations/forms/connect',
        {
          method: 'POST',
          body: JSON.stringify({ serviceAccountJson: formsKey, formId: formsFormId }),
        },
      );
      setGoogleForms(response.integration);
      setFormsSyncResult(null);
      setFormsDialogOpen(false);
    } catch (err) {
      setFormsError(errorMessage(err, t, 'googleForms.saveFailed'));
    } finally {
      setFormsConnecting(false);
    }
  };

  const toggleFormsActive = async () => {
    if (!googleForms) return;
    setFormsError(null);
    try {
      const response = await apiFetch<{ integration: WorkspaceIntegration }>(
        '/integrations/forms',
        { method: 'PATCH', body: JSON.stringify({ isActive: !googleForms.isActive }) },
      );
      setGoogleForms(response.integration);
    } catch (err) {
      setFormsError(errorMessage(err, t, 'googleForms.saveFailed'));
    }
  };

  const syncForms = async () => {
    setFormsError(null);
    setFormsSyncResult(null);
    setFormsBusy('sync');
    try {
      const result = await apiFetch<GoogleFormsSyncResult>('/integrations/forms/sync', {
        method: 'POST',
      });
      setFormsSyncResult(result);
      setGoogleForms((prev) => (prev ? { ...prev, lastSyncAt: result.lastSyncAt } : prev));
    } catch (err) {
      setFormsError(errorMessage(err, t, 'googleForms.syncFailed'));
    } finally {
      setFormsBusy(null);
    }
  };

  const disconnectForms = async () => {
    setFormsError(null);
    setFormsBusy('disconnect');
    try {
      await apiFetch('/integrations/forms', { method: 'DELETE' });
      setGoogleForms(null);
      setFormsSyncResult(null);
    } catch (err) {
      setFormsError(errorMessage(err, t, 'googleForms.saveFailed'));
    } finally {
      setFormsBusy(null);
    }
  };

  /* ── Google Calendar: list / connect / sync / toggle / disconnect ── */

  const openCalendarDialog = () => {
    setCalendarError(null);
    setCalendarKey('');
    setCalendars(null);
    setCalendarId('');
    setCalendarDialogOpen(true);
  };

  const closeCalendarDialog = () => {
    setCalendarDialogOpen(false);
    setCalendarError(null);
  };

  const loadCalendars = async () => {
    setCalendarError(null);
    setCalendarLoading(true);
    try {
      const response = await apiFetch<GoogleCalendarListResponse>('/integrations/calendar/calendars', {
        method: 'POST',
        body: JSON.stringify({ serviceAccountJson: calendarKey }),
      });
      setCalendars(response.calendars);
    } catch (err) {
      setCalendarError(errorMessage(err, t, 'googleCalendar.saveFailed'));
    } finally {
      setCalendarLoading(false);
    }
  };

  const connectCalendar = async () => {
    setCalendarError(null);
    setCalendarConnecting(true);
    try {
      const selected = calendars?.find((calendar) => calendar.id === calendarId);
      const response = await apiFetch<{ integration: WorkspaceIntegration }>(
        '/integrations/calendar/connect',
        {
          method: 'POST',
          body: JSON.stringify({
            serviceAccountJson: calendarKey,
            calendarId,
            calendarName: selected?.summary,
          }),
        },
      );
      setGoogleCalendar(response.integration);
      setCalendarSyncResult(null);
      setCalendarDialogOpen(false);
    } catch (err) {
      setCalendarError(errorMessage(err, t, 'googleCalendar.saveFailed'));
    } finally {
      setCalendarConnecting(false);
    }
  };

  const toggleCalendarActive = async () => {
    if (!googleCalendar) return;
    setCalendarError(null);
    try {
      const response = await apiFetch<{ integration: WorkspaceIntegration }>(
        '/integrations/calendar',
        { method: 'PATCH', body: JSON.stringify({ isActive: !googleCalendar.isActive }) },
      );
      setGoogleCalendar(response.integration);
    } catch (err) {
      setCalendarError(errorMessage(err, t, 'googleCalendar.saveFailed'));
    }
  };

  const syncCalendar = async () => {
    setCalendarError(null);
    setCalendarSyncResult(null);
    setCalendarBusy('sync');
    try {
      const result = await apiFetch<GoogleCalendarSyncResult>('/integrations/calendar/sync', {
        method: 'POST',
      });
      setCalendarSyncResult(result);
      setGoogleCalendar((prev) => (prev ? { ...prev, lastSyncAt: result.lastSyncAt } : prev));
    } catch (err) {
      setCalendarError(errorMessage(err, t, 'googleCalendar.syncFailed'));
    } finally {
      setCalendarBusy(null);
    }
  };

  const disconnectCalendar = async () => {
    setCalendarError(null);
    setCalendarBusy('disconnect');
    try {
      await apiFetch('/integrations/calendar', { method: 'DELETE' });
      setGoogleCalendar(null);
      setCalendarSyncResult(null);
    } catch (err) {
      setCalendarError(errorMessage(err, t, 'googleCalendar.saveFailed'));
    } finally {
      setCalendarBusy(null);
    }
  };

  /* ── Outgoing webhook: connect / test / toggle / disconnect ── */

  const openWebhookDialog = () => {
    setWebhookError(null);
    setWebhookUrl(webhook?.config.url ?? '');
    setWebhookSecret('');
    setWebhookTestResult(null);
    setWebhookDialogOpen(true);
  };

  const closeWebhookDialog = () => {
    setWebhookDialogOpen(false);
    setWebhookError(null);
  };

  const connectWebhook = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setWebhookError(null);
    setWebhookConnecting(true);
    try {
      const response = await apiFetch<{ integration: WorkspaceIntegration }>(
        '/integrations/webhook/connect',
        {
          method: 'POST',
          body: JSON.stringify({ url: webhookUrl, secret: webhookSecret || null }),
        },
      );
      setWebhook(response.integration);
      setWebhookTestResult(null);
      setWebhookDialogOpen(false);
    } catch (err) {
      setWebhookError(errorMessage(err, t, 'webhook.saveFailed'));
    } finally {
      setWebhookConnecting(false);
    }
  };

  const testWebhook = async () => {
    setWebhookError(null);
    setWebhookTestResult(null);
    setWebhookTesting(true);
    try {
      const result = await apiFetch<WebhookTestResult>('/integrations/webhook/test', {
        method: 'POST',
      });
      setWebhookTestResult(t('webhook.testSent', { status: result.status }));
    } catch (err) {
      setWebhookError(errorMessage(err, t, 'webhook.testFailed'));
    } finally {
      setWebhookTesting(false);
    }
  };

  const toggleWebhookActive = async () => {
    if (!webhook) return;
    setWebhookError(null);
    try {
      const response = await apiFetch<{ integration: WorkspaceIntegration }>(
        '/integrations/webhook',
        { method: 'PATCH', body: JSON.stringify({ isActive: !webhook.isActive }) },
      );
      setWebhook(response.integration);
    } catch (err) {
      setWebhookError(errorMessage(err, t, 'webhook.saveFailed'));
    }
  };

  const disconnectWebhook = async () => {
    setWebhookError(null);
    setWebhookBusy('disconnect');
    try {
      await apiFetch('/integrations/webhook', { method: 'DELETE' });
      setWebhook(null);
      setWebhookTestResult(null);
    } catch (err) {
      setWebhookError(errorMessage(err, t, 'webhook.saveFailed'));
    } finally {
      setWebhookBusy(null);
    }
  };

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('integrations.title')}
        description={t('integrations.description')}
      >
        {/* Dropdown settings — tombol ikon tiga titik (border tanpa bg, seukuran
            tombol aksi header lain). */}
        <DropdownMenu
          placement="below"
          menuWidth={220}
          className="menu-open-left"
          button={{
            label: t('channels.settingsAria'),
            isIconOnly: true,
            icon: <IconDotsVertical className="size-4" />,
            variant: 'ghost',
            size: 'md',
            style: { border: '1px solid var(--color-border-emphasized)' },
          }}
        >
          <DropdownMenuItem
            icon={<IconSettings className="size-4" />}
            label={t('channels.settings')}
            onClick={openReminderSettings}
          />
        </DropdownMenu>
      </PageHeader>

      {/* ── Messaging channels ─────────────────────────────── */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
          {t('integrations.channelsSection')}
        </h2>
        <p className="mt-1 text-xs text-zinc-400">{t('integrations.channelsSectionDesc')}</p>

        <div className="mt-4 grid grid-cols-1 gap-5 xl:grid-cols-3">
          {CHANNEL_DEFS.map((def) => {
            const channel = channelRow(def.type);
            const configured = Boolean(channel);
            const active = channel?.isActive ?? false;

            return (
              <Card key={def.type} className="flex flex-col p-5">
                <div className="flex items-start gap-3">
                  {def.logo ? (
                    <BrandLogo src={def.logo} alt={def.label} />
                  ) : (
                    <span className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${def.accent}`}>
                      {def.icon ? <def.icon className="size-5" /> : null}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-zinc-900">{def.label}</h3>
                      {channel?.isEnvShared ? (
                        <Badge variant="neutral" label={t('channels.sharedEnvBadge')} />
                      ) : configured ? (
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

                {channel?.isEnvShared ? (
                  <div className="mt-4 space-y-3">
                    <div className="rounded-lg bg-zinc-50 p-3">
                      <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                        {t('channels.botLabel')}
                      </p>
                      <p className="mt-0.5 truncate text-sm font-medium text-zinc-800">
                        {channel.identifier ?? t('channels.sharedEnvBot')}
                      </p>
                    </div>
                    <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700">
                      {t('channels.sharedEnvNote')}
                    </p>
                    <Button
                      label={t('channels.connectOneClick')}
                      variant="primary"
                      width="100%"
                      isLoading={busyChannel === 'telegram'}
                      isDisabled={busyChannel === 'telegram'}
                      onClick={() => void connectEnvTelegram()}
                    />
                  </div>
                ) : !configured && def.type !== 'email' ? (
                  <Button
                    label={def.type === 'telegram' ? t('channels.connectBot') : t('channels.connectWhatsapp')}
                    variant="primary"
                    width="100%"
                    className="mt-4"
                    onClick={() => {
                      setSetupError(null);
                      setSetupDialog(def.type as 'telegram' | 'whatsapp');
                    }}
                  />
                ) : configured && channel ? (
                  <div className="mt-4 space-y-3">
                    <div className="rounded-lg bg-zinc-50 p-3">
                      <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                        {def.type === 'telegram' ? t('channels.botLabel') : t('channels.wabaLabel')}
                      </p>
                      <p className="mt-0.5 truncate text-sm font-medium text-zinc-800">
                        {channel.identifier ?? '—'}
                      </p>
                    </div>

                    <div>
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">{t('channels.webhookUrl')}</p>
                        <button
                          type="button"
                          onClick={() => void copyWebhook(channel)}
                          className="flex items-center gap-1 text-xs font-medium text-amber-600 transition hover:text-amber-500"
                        >
                          {copied === channel.channelType ? (
                            <IconCheck className="size-3.5" />
                          ) : (
                            <IconCopy className="size-3.5" />
                          )}
                          {copied === channel.channelType ? t('channels.copied') : t('channels.copy')}
                        </button>
                      </div>
                      <p className="mt-1 break-all rounded-lg bg-zinc-50 p-2 font-mono text-xs leading-relaxed text-zinc-500">
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
                ) : null}
              </Card>
            );
          })}
        </div>
      </section>

      {/* ── App integrations ───────────────────────────────── */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
          {t('integrations.appsSection')}
        </h2>
        <p className="mt-1 text-xs text-zinc-400">{t('integrations.appsSectionDesc')}</p>

        <div className="mt-4 grid grid-cols-1 gap-5 xl:grid-cols-3">
          <Card className="flex flex-col p-5">
            <div className="flex items-start gap-3">
              <BrandLogo src="/brands/notion.svg" alt={t('notion.name')} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-zinc-900">{t('notion.name')}</h3>
                  {notion ? (
                    <Badge variant={notion.isActive ? 'success' : 'neutral'} label={notion.isActive ? t('notion.connected') : t('notion.notConnected')} />
                  ) : (
                    <Badge variant="neutral" label={t('channels.notSet')} />
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500">{t('notion.desc')}</p>
              </div>
            </div>

            {integrationError && (
              <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
                {integrationError}
              </p>
            )}

            {!notion ? (
              <Button
                label={t('notion.connect')}
                variant="primary"
                width="100%"
                className="mt-4"
                onClick={openNotionDialog}
              />
            ) : (
              <div className="mt-4 space-y-3">
                <div className="rounded-lg bg-zinc-50 p-3">
                  <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                    {t('notion.databaseLabel')}
                  </p>
                  <p className="mt-0.5 truncate text-sm font-medium text-zinc-800">
                    {notion.identifier ?? notion.config.databaseName ?? '—'}
                  </p>
                  <p className="mt-1 text-xs text-zinc-400">
                    {notion.lastSyncAt
                      ? t('notion.lastSync', { time: formatDateTime(notion.lastSyncAt) })
                      : t('notion.neverSynced')}
                  </p>
                </div>

                {notionSyncResult && (
                  <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700">
                    {notionSyncResult.total === 0
                      ? t('notion.syncEmpty')
                      : t('notion.syncResult', {
                          created: notionSyncResult.created,
                          updated: notionSyncResult.updated,
                        })}
                  </p>
                )}

                <Switch
                  label={t('notion.activeSwitch')}
                  description={notion.isActive ? t('notion.activeDesc') : t('notion.inactiveDesc')}
                  value={notion.isActive}
                  onChange={() => void toggleNotionActive()}
                  labelPosition="start"
                  labelSpacing="spread"
                />

                <div className="flex items-center gap-2">
                  <Button
                    label={t('notion.syncNow')}
                    variant="primary"
                    size="sm"
                    icon={<IconRefresh className="size-3.5" />}
                    isLoading={notionBusy === 'sync'}
                    isDisabled={notionBusy !== null || !notion.isActive}
                    onClick={() => void syncNotion()}
                  />
                  <Button
                    label={t('notion.disconnect')}
                    variant="ghost"
                    size="sm"
                    icon={<IconTrash className="size-3.5" />}
                    isLoading={notionBusy === 'disconnect'}
                    isDisabled={notionBusy !== null}
                    onClick={() => void disconnectNotion()}
                  />
                </div>
              </div>
            )}
          </Card>

          {/* Obsidian — sinkronisasi dari browser ke vault lokal (per perangkat). */}
          <Card className="flex flex-col p-5">
            <div className="flex items-start gap-3">
              <BrandLogo src="/brands/obsidian.svg" alt={t('obsidian.name')} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-zinc-900">{t('obsidian.name')}</h3>
                  {obsidian ? (
                    <Badge variant="success" label={t('obsidian.connected')} />
                  ) : (
                    <Badge variant="neutral" label={t('channels.notSet')} />
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500">{t('obsidian.desc')}</p>
              </div>
            </div>

            {obsidianError && (
              <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
                {obsidianError}
              </p>
            )}

            {!obsidian ? (
              <Button
                label={t('obsidian.connect')}
                variant="primary"
                width="100%"
                className="mt-4"
                onClick={openObsidianDialog}
              />
            ) : (
              <div className="mt-4 space-y-3">
                <div className="rounded-lg bg-zinc-50 p-3">
                  <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                    {t('obsidian.vaultUrl')} · {t('obsidian.folderPath')}
                  </p>
                  <p className="mt-0.5 truncate text-sm font-medium text-zinc-800">
                    {obsidian.url} / {obsidian.folderPath}
                  </p>
                  <p className="mt-1 text-xs text-zinc-400">
                    {obsidianLastSync
                      ? t('obsidian.lastSync', { time: formatDateTime(obsidianLastSync) })
                      : t('obsidian.neverSynced')}
                  </p>
                </div>

                {obsidianSyncResult && (
                  <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700">
                    {obsidianSyncResult}
                  </p>
                )}

                <div className="flex items-center gap-2">
                  <Button
                    label={t('obsidian.syncNow')}
                    variant="primary"
                    size="sm"
                    icon={<IconRefresh className="size-3.5" />}
                    isLoading={obsidianSyncing}
                    isDisabled={obsidianSyncing}
                    onClick={() => void syncObsidian()}
                  />
                  <Button
                    label={t('obsidian.disconnect')}
                    variant="ghost"
                    size="sm"
                    icon={<IconTrash className="size-3.5" />}
                    isDisabled={obsidianSyncing}
                    onClick={disconnectObsidian}
                  />
                </div>
              </div>
            )}
          </Card>

          {/* Google Forms — submission form → kontak (polling otomatis). */}
          <Card className="flex flex-col p-5">
            <div className="flex items-start gap-3">
              <BrandLogo src="/brands/google-forms.svg" alt={t('googleForms.name')} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-zinc-900">{t('googleForms.name')}</h3>
                  {googleForms ? (
                    <Badge variant={googleForms.isActive ? 'success' : 'neutral'} label={googleForms.isActive ? t('googleForms.connected') : t('channels.inactive')} />
                  ) : (
                    <Badge variant="neutral" label={t('channels.notSet')} />
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500">{t('googleForms.desc')}</p>
              </div>
            </div>

            {formsError && (
              <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
                {formsError}
              </p>
            )}

            {!googleForms ? (
              <Button
                label={t('googleForms.connect')}
                variant="primary"
                width="100%"
                className="mt-4"
                onClick={openFormsDialog}
              />
            ) : (
              <div className="mt-4 space-y-3">
                <div className="rounded-lg bg-zinc-50 p-3">
                  <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                    {t('googleForms.formLabel')}
                  </p>
                  <p className="mt-0.5 truncate text-sm font-medium text-zinc-800">
                    {googleForms.identifier ?? googleForms.config.formName ?? '—'}
                  </p>
                  <p className="mt-1 text-xs text-zinc-400">
                    {googleForms.lastSyncAt
                      ? t('googleForms.lastSync', { time: formatDateTime(googleForms.lastSyncAt) })
                      : t('googleForms.neverSynced')}
                  </p>
                </div>

                {formsSyncResult && (
                  <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700">
                    {formsSyncResult.total === 0
                      ? t('googleForms.syncEmpty')
                      : t('googleForms.syncResult', {
                          imported: formsSyncResult.imported,
                          skipped: formsSyncResult.skipped,
                        })}
                  </p>
                )}

                <Switch
                  label={t('googleForms.activeSwitch')}
                  description={googleForms.isActive ? t('googleForms.activeDesc') : t('googleForms.inactiveDesc')}
                  value={googleForms.isActive}
                  onChange={() => void toggleFormsActive()}
                  labelPosition="start"
                  labelSpacing="spread"
                />

                <div className="flex items-center gap-2">
                  <Button
                    label={t('googleForms.syncNow')}
                    variant="primary"
                    size="sm"
                    icon={<IconRefresh className="size-3.5" />}
                    isLoading={formsBusy === 'sync'}
                    isDisabled={formsBusy !== null || !googleForms.isActive}
                    onClick={() => void syncForms()}
                  />
                  <Button
                    label={t('googleForms.disconnect')}
                    variant="ghost"
                    size="sm"
                    icon={<IconTrash className="size-3.5" />}
                    isLoading={formsBusy === 'disconnect'}
                    isDisabled={formsBusy !== null}
                    onClick={() => void disconnectForms()}
                  />
                </div>
              </div>
            )}
          </Card>

          {/* Google Calendar — booking → event kalender. */}
          <Card className="flex flex-col p-5">
            <div className="flex items-start gap-3">
              <BrandLogo src="/brands/google-calendar.svg" alt={t('googleCalendar.name')} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-zinc-900">{t('googleCalendar.name')}</h3>
                  {googleCalendar ? (
                    <Badge variant={googleCalendar.isActive ? 'success' : 'neutral'} label={googleCalendar.isActive ? t('googleCalendar.connected') : t('channels.inactive')} />
                  ) : (
                    <Badge variant="neutral" label={t('channels.notSet')} />
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500">{t('googleCalendar.desc')}</p>
              </div>
            </div>

            {calendarError && (
              <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
                {calendarError}
              </p>
            )}

            {!googleCalendar ? (
              <Button
                label={t('googleCalendar.connect')}
                variant="primary"
                width="100%"
                className="mt-4"
                onClick={openCalendarDialog}
              />
            ) : (
              <div className="mt-4 space-y-3">
                <div className="rounded-lg bg-zinc-50 p-3">
                  <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                    {t('googleCalendar.calendarLabel')}
                  </p>
                  <p className="mt-0.5 truncate text-sm font-medium text-zinc-800">
                    {googleCalendar.identifier ?? googleCalendar.config.calendarName ?? '—'}
                  </p>
                  <p className="mt-1 text-xs text-zinc-400">
                    {googleCalendar.lastSyncAt
                      ? t('googleCalendar.lastSync', { time: formatDateTime(googleCalendar.lastSyncAt) })
                      : t('googleCalendar.neverSynced')}
                  </p>
                </div>

                {calendarSyncResult && (
                  <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700">
                    {calendarSyncResult.created === 0 && calendarSyncResult.updated === 0
                      ? t('googleCalendar.syncEmpty')
                      : t('googleCalendar.syncResult', {
                          created: calendarSyncResult.created,
                          updated: calendarSyncResult.updated,
                        })}
                  </p>
                )}

                <Switch
                  label={t('googleCalendar.activeSwitch')}
                  description={googleCalendar.isActive ? t('googleCalendar.activeDesc') : t('googleCalendar.inactiveDesc')}
                  value={googleCalendar.isActive}
                  onChange={() => void toggleCalendarActive()}
                  labelPosition="start"
                  labelSpacing="spread"
                />

                <div className="flex items-center gap-2">
                  <Button
                    label={t('googleCalendar.syncNow')}
                    variant="primary"
                    size="sm"
                    icon={<IconRefresh className="size-3.5" />}
                    isLoading={calendarBusy === 'sync'}
                    isDisabled={calendarBusy !== null || !googleCalendar.isActive}
                    onClick={() => void syncCalendar()}
                  />
                  <Button
                    label={t('googleCalendar.disconnect')}
                    variant="ghost"
                    size="sm"
                    icon={<IconTrash className="size-3.5" />}
                    isLoading={calendarBusy === 'disconnect'}
                    isDisabled={calendarBusy !== null}
                    onClick={() => void disconnectCalendar()}
                  />
                </div>
              </div>
            )}
          </Card>

          {/* Outgoing webhook — notifikasi event booking ke endpoint user. */}
          <Card className="flex flex-col p-5">
            <div className="flex items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-600">
                <IconWebhook className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-zinc-900">{t('webhook.name')}</h3>
                  {webhook ? (
                    <Badge variant={webhook.isActive ? 'success' : 'neutral'} label={webhook.isActive ? t('webhook.connected') : t('channels.inactive')} />
                  ) : (
                    <Badge variant="neutral" label={t('channels.notSet')} />
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500">{t('webhook.desc')}</p>
              </div>
            </div>

            {webhookError && (
              <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
                {webhookError}
              </p>
            )}

            {!webhook ? (
              <Button
                label={t('webhook.connect')}
                variant="primary"
                width="100%"
                className="mt-4"
                onClick={openWebhookDialog}
              />
            ) : (
              <div className="mt-4 space-y-3">
                <div className="rounded-lg bg-zinc-50 p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">{t('channels.webhookUrl')}</p>
                    {webhook.config.hasSecret ? (
                      <Badge variant="success" label={t('webhook.signed')} />
                    ) : (
                      <Badge variant="neutral" label={t('webhook.unsigned')} />
                    )}
                  </div>
                  <p className="mt-1 break-all font-mono text-xs leading-relaxed text-zinc-500">
                    {webhook.config.url ?? '—'}
                  </p>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-400">{t('webhook.events')}</p>
                </div>

                {webhookTestResult && (
                  <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700">
                    {webhookTestResult}
                  </p>
                )}

                <Switch
                  label={t('webhook.activeSwitch')}
                  description={webhook.isActive ? t('webhook.activeDesc') : t('webhook.inactiveDesc')}
                  value={webhook.isActive}
                  onChange={() => void toggleWebhookActive()}
                  labelPosition="start"
                  labelSpacing="spread"
                />

                <div className="flex items-center gap-2">
                  <Button
                    label={t('webhook.test')}
                    variant="primary"
                    size="sm"
                    icon={<IconSend className="size-3.5" />}
                    isLoading={webhookTesting}
                    isDisabled={webhookTesting || !webhook.isActive}
                    onClick={() => void testWebhook()}
                  />
                  <Button
                    label={t('webhook.disconnect')}
                    variant="ghost"
                    size="sm"
                    icon={<IconTrash className="size-3.5" />}
                    isLoading={webhookBusy === 'disconnect'}
                    isDisabled={webhookBusy !== null}
                    onClick={() => void disconnectWebhook()}
                  />
                </div>
              </div>
            )}
          </Card>
        </div>
      </section>

      {/* Dialog setup channel — input kredensial (token/API key) tidak tampil
          inline di kartu, hanya di dalam dialog ini. */}
      <Dialog
        isOpen={setupDialog !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSetupDialog(null);
            setSetupError(null);
          }
        }}
        purpose="info"
        width={480}
      >
        <Layout
          header={
            <DialogHeader
              title={setupDialog === 'telegram' ? t('channels.connectBot') : t('channels.connectWhatsapp')}
              subtitle={
                setupDialog === 'telegram'
                  ? t('channels.telegramSetupSubtitle')
                  : t('channels.whatsappSetupSubtitle')
              }
              onOpenChange={(open) => {
                if (!open) {
                  setSetupDialog(null);
                  setSetupError(null);
                }
              }}
              hasDivider
            />
          }
          content={
            <LayoutContent>
              {setupDialog === 'telegram' ? (
                <form id="telegram-setup-form" onSubmit={(e) => setupChannel(e, 'telegram')} className="space-y-3">
                  <TextInput
                    label={t('channels.botToken')}
                    value={telegramToken}
                    onChange={setTelegramToken}
                    placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
                    width="100%"
                  />
                  {setupError?.channel === 'telegram' && (
                    <p role="alert" className="text-xs text-red-600">{setupError.message}</p>
                  )}
                </form>
              ) : (
                <form id="whatsapp-setup-form" onSubmit={(e) => setupChannel(e, 'whatsapp')} className="space-y-3">
                  <TextInput
                    label={t('channels.apiKey')}
                    value={whatsappKey}
                    onChange={setWhatsappKey}
                    placeholder="0c5a8f…"
                    width="100%"
                  />
                  <p className="text-xs leading-relaxed text-zinc-400">
                    {t('channels.whatsappHint')}
                  </p>
                  {setupError?.channel === 'whatsapp' && (
                    <p role="alert" className="text-xs text-red-600">{setupError.message}</p>
                  )}
                </form>
              )}
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              <div className="flex justify-end gap-2">
                <Button
                  label={t('common.cancel')}
                  variant="ghost"
                  onClick={() => {
                    setSetupDialog(null);
                    setSetupError(null);
                  }}
                />
                <Button
                  label={
                    setupDialog === 'telegram'
                      ? t('channels.connectBot')
                      : t('channels.connectWhatsapp')
                  }
                  variant="primary"
                  type="submit"
                  form={setupDialog === 'telegram' ? 'telegram-setup-form' : 'whatsapp-setup-form'}
                  isLoading={busyChannel === setupDialog}
                  isDisabled={
                    setupDialog === 'telegram'
                      ? telegramToken.trim().length < 10
                      : whatsappKey.trim().length < 10
                  }
                />
              </div>
            </LayoutFooter>
          }
        />
      </Dialog>

      {/* Dialog Notion — dua langkah: token → pilih database. */}
      <Dialog
        isOpen={notionDialogOpen}
        onOpenChange={(open) => {
          if (!open) closeNotionDialog();
        }}
        purpose="info"
        width={520}
      >
        <Layout
          header={
            <DialogHeader
              title={t('notion.dialogTitle')}
              subtitle={t('notion.dialogSubtitle')}
              onOpenChange={(open) => {
                if (!open) closeNotionDialog();
              }}
              hasDivider
            />
          }
          content={
            <LayoutContent>
              <div className="space-y-5">
                {notionDatabases === null ? (
                  <form
                    id="notion-token-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void loadNotionDatabases();
                    }}
                    className="space-y-3"
                  >
                    <TextInput
                      label={t('notion.tokenLabel')}
                      value={notionToken}
                      onChange={setNotionToken}
                      placeholder={t('notion.tokenPlaceholder')}
                      width="100%"
                    />
                    <p className="rounded-lg bg-zinc-50 px-3 py-2 text-xs leading-relaxed text-zinc-500">
                      {t('notion.howTo')}
                    </p>
                    {integrationError && (
                      <p role="alert" className="text-xs text-red-600">{integrationError}</p>
                    )}
                  </form>
                ) : notionDatabases.length === 0 ? (
                  <div>
                    <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700">
                      {t('notion.noDatabases')}
                    </p>
                    {integrationError && (
                      <p role="alert" className="mt-2 text-xs text-red-600">{integrationError}</p>
                    )}
                  </div>
                ) : (
                  <div>
                    <p className="mb-2 text-sm font-semibold text-zinc-800">{t('notion.stepDatabases')}</p>
                    <div className="max-h-72 space-y-2 overflow-y-auto pr-1" role="radiogroup" aria-label={t('notion.stepDatabases')}>
                      {notionDatabases.map((db) => {
                        const selected = db.id === notionDatabaseId;
                        return (
                          <button
                            key={db.id}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            onClick={() => setNotionDatabaseId(db.id)}
                            className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition ${
                              selected
                                ? 'border-amber-400 bg-amber-50/70 ring-2 ring-amber-500/15'
                                : 'border-zinc-200 bg-white hover:border-zinc-300'
                            }`}
                          >
                            <BrandLogo
                              src="/brands/notion.svg"
                              alt=""
                              chip={`size-8 rounded-lg shadow-none ${selected ? 'bg-amber-50 ring-1 ring-amber-400' : 'bg-white ring-1 ring-zinc-200'}`}
                              img="size-5"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-semibold text-zinc-900">{db.title}</span>
                              <span className="block truncate text-xs text-zinc-400">{db.id}</span>
                            </span>
                            <IconCheck className={`size-4 shrink-0 ${selected ? 'text-amber-600' : 'text-transparent'}`} />
                          </button>
                        );
                      })}
                    </div>
                    {integrationError && (
                      <p role="alert" className="mt-2 text-xs text-red-600">{integrationError}</p>
                    )}
                  </div>
                )}
              </div>
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              <div className="flex justify-end gap-2">
                <Button label={t('common.cancel')} variant="ghost" onClick={closeNotionDialog} />
                {notionDatabases === null ? (
                  <Button
                    label={t('notion.loadDatabases')}
                    variant="primary"
                    type="submit"
                    form="notion-token-form"
                    isLoading={notionLoadingDatabases}
                    isDisabled={notionToken.trim().length < 10 || notionLoadingDatabases}
                  />
                ) : (
                  <Button
                    label={t('notion.connectDatabase')}
                    variant="primary"
                    isLoading={notionConnecting}
                    isDisabled={!notionDatabaseId || notionConnecting}
                    onClick={() => void connectNotion()}
                  />
                )}
              </div>
            </LayoutFooter>
          }
        />
      </Dialog>

      {/* Dialog Obsidian — konfigurasi lokal per perangkat (vault di mesin user). */}
      <Dialog
        isOpen={obsidianDialogOpen}
        onOpenChange={(open) => {
          if (!open) closeObsidianDialog();
        }}
        purpose="info"
        width={520}
      >
        <Layout
          header={
            <DialogHeader
              title={t('obsidian.dialogTitle')}
              subtitle={t('obsidian.dialogSubtitle')}
              onOpenChange={(open) => {
                if (!open) closeObsidianDialog();
              }}
              hasDivider
            />
          }
          content={
            <LayoutContent>
              <div className="space-y-3">
                <TextInput
                  label={t('obsidian.vaultUrl')}
                  value={obsidianUrl}
                  onChange={(value) => {
                    setObsidianUrl(value);
                    setObsidianTested(null);
                  }}
                  placeholder={t('obsidian.vaultUrlPlaceholder')}
                  width="100%"
                />
                <TextInput
                  label={t('obsidian.apiKey')}
                  value={obsidianKey}
                  onChange={(value) => {
                    setObsidianKey(value);
                    setObsidianTested(null);
                  }}
                  placeholder={t('obsidian.apiKeyPlaceholder')}
                  width="100%"
                />
                <TextInput
                  label={t('obsidian.folderPath')}
                  value={obsidianFolder}
                  onChange={(value) => {
                    setObsidianFolder(value);
                    setObsidianTested(null);
                  }}
                  placeholder={t('obsidian.folderPathPlaceholder')}
                  width="100%"
                />
                <p className="rounded-lg bg-zinc-50 px-3 py-2 text-xs leading-relaxed text-zinc-500">
                  {t('obsidian.howTo')}
                </p>
                {obsidianTested && (
                  <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700">
                    {t('obsidian.testOk', {
                      version: obsidianTested.obsidianVersion ?? '?',
                      author: obsidianTested.author ?? 'Obsidian',
                    })}
                  </p>
                )}
                {obsidianError && (
                  <p role="alert" className="text-xs text-red-600">{obsidianError}</p>
                )}
              </div>
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              <div className="flex justify-end gap-2">
                <Button label={t('common.cancel')} variant="ghost" onClick={closeObsidianDialog} />
                <Button
                  label={t('obsidian.testConnection')}
                  variant="secondary"
                  isLoading={obsidianTesting}
                  isDisabled={obsidianTesting || obsidianKey.trim().length < 8}
                  onClick={() => void testObsidian()}
                />
                <Button
                  label={t('obsidian.connectDone')}
                  variant="primary"
                  isDisabled={!obsidianTested}
                  onClick={connectObsidian}
                />
              </div>
            </LayoutFooter>
          }
        />
      </Dialog>

      {/* Dialog Google Forms — dua langkah: kredensial → konfirmasi form. */}
      <Dialog
        isOpen={formsDialogOpen}
        onOpenChange={(open) => {
          if (!open) closeFormsDialog();
        }}
        purpose="info"
        width={520}
      >
        <Layout
          header={
            <DialogHeader
              title={t('googleForms.dialogTitle')}
              subtitle={t('googleForms.dialogSubtitle')}
              onOpenChange={(open) => {
                if (!open) closeFormsDialog();
              }}
              hasDivider
            />
          }
          content={
            <LayoutContent>
              <div className="space-y-5">
                {formsPreview === null ? (
                  <form
                    id="google-forms-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void checkForm();
                    }}
                    className="space-y-3"
                  >
                    <TextArea
                      label={t('googleForms.serviceAccountLabel')}
                      value={formsKey}
                      onChange={setFormsKey}
                      placeholder={t('googleForms.serviceAccountPlaceholder')}
                      rows={5}
                      width="100%"
                    />
                    <TextInput
                      label={t('googleForms.formIdLabel')}
                      value={formsFormId}
                      onChange={setFormsFormId}
                      placeholder={t('googleForms.formIdPlaceholder')}
                      width="100%"
                    />
                    <p className="rounded-lg bg-zinc-50 px-3 py-2 text-xs leading-relaxed text-zinc-500">
                      {t('googleForms.howTo')}
                    </p>
                    {formsError && (
                      <p role="alert" className="text-xs text-red-600">{formsError}</p>
                    )}
                  </form>
                ) : (
                  <div className="space-y-3">
                    <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-medium leading-relaxed text-emerald-700">
                      {t('googleForms.formFound', { title: formsPreview.form.title })}
                    </p>
                    <div>
                      <p className="mb-2 text-sm font-semibold text-zinc-800">{t('googleForms.questionsLabel')}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {formsPreview.form.questions.map((question) => (
                          <span key={question.id} className="rounded-md bg-zinc-100 px-2 py-1 text-xs font-medium text-zinc-600">
                            {question.title}
                          </span>
                        ))}
                      </div>
                    </div>
                    {formsError && (
                      <p role="alert" className="text-xs text-red-600">{formsError}</p>
                    )}
                  </div>
                )}
              </div>
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              <div className="flex justify-end gap-2">
                <Button label={t('common.cancel')} variant="ghost" onClick={closeFormsDialog} />
                {formsPreview === null ? (
                  <Button
                    label={t('googleForms.checkForm')}
                    variant="primary"
                    type="submit"
                    form="google-forms-form"
                    isLoading={formsLoadingPreview}
                    isDisabled={
                      formsKey.trim().length < 50 || formsFormId.trim().length < 1 || formsLoadingPreview
                    }
                  />
                ) : (
                  <Button
                    label={t('googleForms.connectForm')}
                    variant="primary"
                    isLoading={formsConnecting}
                    isDisabled={formsConnecting}
                    onClick={() => void connectForms()}
                  />
                )}
              </div>
            </LayoutFooter>
          }
        />
      </Dialog>

      {/* Dialog Google Calendar — dua langkah: kredensial → pilih kalender. */}
      <Dialog
        isOpen={calendarDialogOpen}
        onOpenChange={(open) => {
          if (!open) closeCalendarDialog();
        }}
        purpose="info"
        width={520}
      >
        <Layout
          header={
            <DialogHeader
              title={t('googleCalendar.dialogTitle')}
              subtitle={t('googleCalendar.dialogSubtitle')}
              onOpenChange={(open) => {
                if (!open) closeCalendarDialog();
              }}
              hasDivider
            />
          }
          content={
            <LayoutContent>
              <div className="space-y-5">
                {calendars === null ? (
                  <form
                    id="google-calendar-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void loadCalendars();
                    }}
                    className="space-y-3"
                  >
                    <TextArea
                      label={t('googleCalendar.serviceAccountLabel')}
                      value={calendarKey}
                      onChange={setCalendarKey}
                      placeholder={t('googleCalendar.serviceAccountPlaceholder')}
                      rows={5}
                      width="100%"
                    />
                    <p className="rounded-lg bg-zinc-50 px-3 py-2 text-xs leading-relaxed text-zinc-500">
                      {t('googleCalendar.howTo')}
                    </p>
                    {calendarError && (
                      <p role="alert" className="text-xs text-red-600">{calendarError}</p>
                    )}
                  </form>
                ) : calendars.length === 0 ? (
                  <div>
                    <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700">
                      {t('googleCalendar.noCalendars')}
                    </p>
                    {calendarError && (
                      <p role="alert" className="mt-2 text-xs text-red-600">{calendarError}</p>
                    )}
                  </div>
                ) : (
                  <div>
                    <p className="mb-2 text-sm font-semibold text-zinc-800">{t('googleCalendar.stepCalendars')}</p>
                    <div className="max-h-72 space-y-2 overflow-y-auto pr-1" role="radiogroup" aria-label={t('googleCalendar.stepCalendars')}>
                      {calendars.map((calendar) => {
                        const selected = calendar.id === calendarId;
                        return (
                          <button
                            key={calendar.id}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            onClick={() => setCalendarId(calendar.id)}
                            className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition ${
                              selected
                                ? 'border-amber-400 bg-amber-50/70 ring-2 ring-amber-500/15'
                                : 'border-zinc-200 bg-white hover:border-zinc-300'
                            }`}
                          >
                            <BrandLogo
                              src="/brands/google-calendar.svg"
                              alt=""
                              chip={`size-8 rounded-lg shadow-none ${selected ? 'bg-amber-50 ring-1 ring-amber-400' : 'bg-white ring-1 ring-zinc-200'}`}
                              img="size-5"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-semibold text-zinc-900">{calendar.summary}</span>
                              <span className="block truncate text-xs text-zinc-400">{calendar.id}</span>
                            </span>
                            <IconCheck className={`size-4 shrink-0 ${selected ? 'text-amber-600' : 'text-transparent'}`} />
                          </button>
                        );
                      })}
                    </div>
                    {calendarError && (
                      <p role="alert" className="mt-2 text-xs text-red-600">{calendarError}</p>
                    )}
                  </div>
                )}
              </div>
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              <div className="flex justify-end gap-2">
                <Button label={t('common.cancel')} variant="ghost" onClick={closeCalendarDialog} />
                {calendars === null ? (
                  <Button
                    label={t('googleCalendar.loadCalendars')}
                    variant="primary"
                    type="submit"
                    form="google-calendar-form"
                    isLoading={calendarLoading}
                    isDisabled={calendarKey.trim().length < 50 || calendarLoading}
                  />
                ) : (
                  <Button
                    label={t('googleCalendar.connectCalendar')}
                    variant="primary"
                    isLoading={calendarConnecting}
                    isDisabled={!calendarId || calendarConnecting}
                    onClick={() => void connectCalendar()}
                  />
                )}
              </div>
            </LayoutFooter>
          }
        />
      </Dialog>

      {/* Dialog webhook — URL endpoint + secret pengaman opsional. */}
      <Dialog
        isOpen={webhookDialogOpen}
        onOpenChange={(open) => {
          if (!open) closeWebhookDialog();
        }}
        purpose="info"
        width={480}
      >
        <Layout
          header={
            <DialogHeader
              title={t('webhook.connect')}
              subtitle={t('webhook.desc')}
              onOpenChange={(open) => {
                if (!open) closeWebhookDialog();
              }}
              hasDivider
            />
          }
          content={
            <LayoutContent>
              <form id="webhook-connect-form" onSubmit={connectWebhook} className="space-y-3">
                <TextInput
                  label={t('webhook.urlLabel')}
                  value={webhookUrl}
                  onChange={(value) => {
                    setWebhookUrl(value);
                    setWebhookTestResult(null);
                  }}
                  placeholder={t('webhook.urlPlaceholder')}
                  width="100%"
                />
                <TextInput
                  label={t('webhook.secretLabel')}
                  value={webhookSecret}
                  onChange={(value) => {
                    setWebhookSecret(value);
                    setWebhookTestResult(null);
                  }}
                  placeholder={t('webhook.secretPlaceholder')}
                  width="100%"
                />
                <p className="rounded-lg bg-zinc-50 px-3 py-2 text-xs leading-relaxed text-zinc-500">
                  {t('webhook.secretHint')}
                </p>
                {webhookError && (
                  <p role="alert" className="text-xs text-red-600">{webhookError}</p>
                )}
              </form>
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              <div className="flex justify-end gap-2">
                <Button label={t('common.cancel')} variant="ghost" onClick={closeWebhookDialog} />
                <Button
                  label={t('webhook.connectWebhook')}
                  variant="primary"
                  type="submit"
                  form="webhook-connect-form"
                  isLoading={webhookConnecting}
                  isDisabled={
                    webhookConnecting ||
                    !/^https?:\/\//.test(webhookUrl.trim()) ||
                    (webhookSecret.trim().length > 0 && webhookSecret.trim().length < 8)
                  }
                />
              </div>
            </LayoutFooter>
          }
        />
      </Dialog>

      {/* Dialog settings — berisi form Automatic reminders. */}
      <Dialog
        isOpen={settingsOpen}
        onOpenChange={(open) => {
          if (!open) closeReminderSettings();
        }}
        purpose="info"
        width={480}
      >
        <Layout
          header={
            <DialogHeader
              title={t('channels.settingsTitle')}
              subtitle={t('channels.reminderDesc')}
              onOpenChange={(open) => {
                if (!open) closeReminderSettings();
              }}
              hasDivider
            />
          }
          content={
            <LayoutContent>
              <form id="reminder-settings-form" onSubmit={saveLeadMinutes} className="space-y-3">
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
                {setupError?.channel === 'reminder' && (
                  <p role="alert" className="text-xs text-red-600">
                    {setupError.message}
                  </p>
                )}
              </form>
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              <div className="flex justify-end gap-2">
                <Button label={t('common.cancel')} variant="ghost" onClick={closeReminderSettings} />
                <Button
                  label={leadSaved ? t('channels.saved') : t('common.save')}
                  variant="primary"
                  type="submit"
                  form="reminder-settings-form"
                  isDisabled={!Number.isFinite(leadMinutes) || leadMinutes < 5}
                />
              </div>
            </LayoutFooter>
          }
        />
      </Dialog>

      {error && !loaded && (
        <p role="alert" className="text-sm text-red-600">{error}</p>
      )}
    </div>
  );
}
