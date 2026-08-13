import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
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
  Selector,
  Switch,
  Tab,
  TabList,
  TextArea,
  TextInput,
} from '@astryxdesign/core';
import { useTranslation } from 'react-i18next';

import { apiFetch } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { formatDateTime } from '../../i18n/format';
import { type ContactRecord, type ContactsListResponse } from '../../lib/contacts';
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
  type TallyFormOption,
  type TallyPreviewResponse,
  type TelnyxByocConnectResponse,
  type TelnyxByocSearchResponse,
  type VapiInboundNumber,
  type VapiInboundStatusResponse,
  type VapiVoiceStatusResponse,
  type WebhookTestResult,
  type WorkspaceIntegration,
} from '../../lib/integrations';
import { useWorkspaceStore } from '../../stores/workspace';
import type { TranslationKey } from '../../i18n';
import { PaymentsDialog } from '../shell/PaymentsDialog';
import {
  IconCheck,
  IconCopy,
  IconCreditCard,
  IconDotsVertical,
  IconMail,
  IconPhone,
  IconPlug,
  IconRefresh,
  IconSend,
  IconSettings,
  IconTrash,
  IconVideo,
  IconWebhook,
} from '../shell/icons';
import {
  clearObsidianConfig,
  fetchAllContacts,
  loadObsidianConfig,
  type ObsidianConfig,
  ObsidianError,
  type ObsidianServerInfo,
  saveObsidianConfig,
  syncContactsToObsidian,
  testObsidianConnection,
} from '../../lib/obsidian';
import { Card, PageHeader } from '../shell/ui';

/** Identitas page Meta (respons POST /channels/meta/preview). */
interface MetaIdentity {
  id: string;
  name: string;
  instagramBusinessAccount: { id: string; username: string | null } | null;
}

/** Baris detail “konfigurasi saat ini” di dalam dialog — label kiri, nilai kanan. */
function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 text-xs">
      <span className="shrink-0 font-medium uppercase tracking-wider text-zinc-400">{label}</span>
      <span className="min-w-0 text-right font-medium text-zinc-700">{value}</span>
    </div>
  );
}

/** Blok ringkas konfigurasi terhubung — TIDAK di kartu, hanya di dalam dialog. */
function ConnectedDetails({ title, rows }: { title: string; rows: { label: string; value: ReactNode }[] }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2.5">
      <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">{title}</p>
      <div className="mt-2 space-y-1.5">
        {rows.map((row) => (
          <DetailRow key={row.label} label={row.label} value={row.value} />
        ))}
      </div>
    </div>
  );
}

/** Nilai yang bisa disalin (webhook URL) — dengan tombol copy kecil di dalam dialog. */
function CopyableValue({ value, copied, onCopy }: { value: string; copied: boolean; onCopy: () => void }) {
  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={copied ? undefined : 'Copy'}
      className="group inline-flex max-w-full items-center justify-end gap-1 font-medium text-zinc-700"
    >
      <span className="max-w-[260px] truncate font-mono text-xs text-zinc-600 group-hover:text-zinc-800">{value}</span>
      {copied ? (
        <IconCheck className="size-3.5 shrink-0 text-emerald-600" />
      ) : (
        <IconCopy className="size-3.5 shrink-0 text-zinc-400 group-hover:text-zinc-600" />
      )}
    </button>
  );
}

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
    type: 'email',
    label: 'Email',
    descriptionKey: 'channels.emailDesc',
    icon: IconMail,
    accent: 'bg-amber-500/10 text-amber-600',
  },
  {
    type: 'instagram',
    label: 'Instagram',
    descriptionKey: 'channels.instagramDesc',
    logo: '/brands/instagram.svg',
  },
  {
    type: 'facebook',
    label: 'Facebook',
    descriptionKey: 'channels.facebookDesc',
    logo: '/brands/facebook.svg',
  },
];

/** Chip logo brand (aset SVG dari svgl.app) — kartu putih dengan logo di dalamnya. */
function BrandLogo({ src, alt, chip = 'size-10 rounded-xl bg-white', img = 'size-6' }: {
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
  const [setupDialog, setSetupDialog] = useState<'telegram' | null>(null);
  const [busyChannel, setBusyChannel] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<{ channel: string; message: string } | null>(null);
  // Nilai webhook URL yang baru saja disalin (tombol copy di dalam dialog).
  const [copiedValue, setCopiedValue] = useState<string | null>(null);

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

  // ── Kirim tautan form ke customer (Google Forms & Tally) ──
  const [sendFormOpen, setSendFormOpen] = useState(false);
  const [sendFormType, setSendFormType] = useState<'google-forms' | 'tally' | null>(null);
  const [sendFormQuery, setSendFormQuery] = useState('');
  const [sendFormResults, setSendFormResults] = useState<ContactRecord[] | null>(null);
  const [sendFormContactId, setSendFormContactId] = useState('');
  const [sendFormChannel, setSendFormChannel] = useState<'telegram' | 'email'>('email');
  const [sendFormSearching, setSendFormSearching] = useState(false);
  const [sendFormSending, setSendFormSending] = useState(false);
  const [sendFormMessage, setSendFormMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [formUrlCopied, setFormUrlCopied] = useState(false);

  // ── Tally integration ────────────────────────────────────
  const [tally, setTally] = useState<WorkspaceIntegration | null>(null);
  const [tallyDialogOpen, setTallyDialogOpen] = useState(false);
  const [tallyApiKey, setTallyApiKey] = useState('');
  const [tallyForms, setTallyForms] = useState<TallyFormOption[] | null>(null);
  const [tallyFormId, setTallyFormId] = useState('');
  const [tallyLoadingForms, setTallyLoadingForms] = useState(false);
  const [tallyConnecting, setTallyConnecting] = useState(false);
  const [tallyBusy, setTallyBusy] = useState<'rewebhook' | 'disconnect' | null>(null);
  const [tallyError, setTallyError] = useState<string | null>(null);

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

  // ── Payments integration (Global Payments — Paddle) ──────
  const [payments, setPayments] = useState<WorkspaceIntegration | null>(null);
  const [paymentsDialogOpen, setPaymentsDialogOpen] = useState(false);
  const [paymentsBusy, setPaymentsBusy] = useState<'connect' | 'disconnect' | null>(null);
  const [paymentsError, setPaymentsError] = useState<string | null>(null);

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

  // ── Slack integration (notifikasi booking ke channel tim) ─
  const [slack, setSlack] = useState<WorkspaceIntegration | null>(null);
  const [slackDialogOpen, setSlackDialogOpen] = useState(false);
  const [slackUrl, setSlackUrl] = useState('');
  const [slackChannel, setSlackChannel] = useState('');
  const [slackConnecting, setSlackConnecting] = useState(false);
  const [slackTesting, setSlackTesting] = useState(false);
  const [slackTestResult, setSlackTestResult] = useState<string | null>(null);
  const [slackBusy, setSlackBusy] = useState<'disconnect' | null>(null);
  const [slackError, setSlackError] = useState<string | null>(null);

  // ── Meta (Instagram / Facebook DMs) ────────────────────────
  const metaWebhookUrl = `${window.location.origin}/api/webhooks/meta`;
  const [metaDialogOpen, setMetaDialogOpen] = useState(false);
  const [metaDialogType, setMetaDialogType] = useState<'instagram' | 'facebook'>('instagram');
  const [metaToken, setMetaToken] = useState('');
  const [metaPreview, setMetaPreview] = useState<MetaIdentity | null>(null);
  const [metaLoadingPreview, setMetaLoadingPreview] = useState(false);
  const [metaConnecting, setMetaConnecting] = useState(false);
  const [metaError, setMetaError] = useState<string | null>(null);

  // ── Video calls (Zoom / Google Meet) ───────────────────────
  const [video, setVideo] = useState<WorkspaceIntegration | null>(null);
  const [videoDialogOpen, setVideoDialogOpen] = useState(false);
  const [videoProvider, setVideoProvider] = useState<'zoom' | 'meet'>('zoom');
  const [videoProviders, setVideoProviders] = useState<
    { provider: 'zoom' | 'meet'; ready: boolean; reason?: string }[] | null
  >(null);
  const [videoConnecting, setVideoConnecting] = useState(false);
  const [videoBusy, setVideoBusy] = useState<'disconnect' | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);

  // ── Voice AI (Vapi) — nomor keluar panggilan per workspace ──
  // Kredensial Vapi/Telnyx server-side (env) — card hanya memilih NOMOR.
  const [voice, setVoice] = useState<WorkspaceIntegration | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<VapiVoiceStatusResponse | null>(null);
  const [voiceDialogOpen, setVoiceDialogOpen] = useState(false);
  const [voiceTab, setVoiceTab] = useState<'operator' | 'byoc'>('operator');
  const [voiceNumberId, setVoiceNumberId] = useState('');
  const [voiceConnecting, setVoiceConnecting] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState<'disconnect' | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);

  // ── Voice AI — panggilan MASUK (inbound): customer menelepon nomor ini dan
  // dilayani resepsionis AI yang bisa membuat booking langsung. ──
  const [inboundStatus, setInboundStatus] = useState<VapiInboundStatusResponse | null>(null);
  const [inboundError, setInboundError] = useState<string | null>(null);
  const [inboundBusy, setInboundBusy] = useState<'register' | string | null>(null);
  const [inboundDialogOpen, setInboundDialogOpen] = useState(false);
  const [inboundName, setInboundName] = useState('');
  const [inboundArea, setInboundArea] = useState('');
  const [inboundRegistering, setInboundRegistering] = useState(false);

  // ── Voice AI BYOC (fase-2) — workspace menempel API key Telnyx SENDIRI ──
  // Key dipakai sekali (search/connect) — TIDAK pernah disimpan server.
  const [voiceByoKey, setVoiceByoKey] = useState('');
  const [voiceByoCountry, setVoiceByoCountry] = useState('ID');
  const [voiceByoArea, setVoiceByoArea] = useState('');
  const [voiceByoResult, setVoiceByoResult] = useState<TelnyxByocSearchResponse | null>(null);
  const [voiceByoSearching, setVoiceByoSearching] = useState(false);
  const [voiceByoNumber, setVoiceByoNumber] = useState('');
  const [voiceByoConnecting, setVoiceByoConnecting] = useState(false);

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
  const [obsidianError, setObsidianError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [channelRes, integrationRes, voiceRes, inboundRes] = await Promise.all([
        apiFetch<ChannelListResponse>('/channels'),
        apiFetch<IntegrationListResponse>('/integrations'),
        apiFetch<VapiVoiceStatusResponse>('/integrations/vapi'),
        apiFetch<VapiInboundStatusResponse>('/integrations/vapi/inbound'),
      ]);
      setChannels(channelRes.channels);
      setNotion(integrationRes.integrations.find((item) => item.integrationType === 'notion') ?? null);
      setGoogleForms(integrationRes.integrations.find((item) => item.integrationType === 'google-forms') ?? null);
      setTally(integrationRes.integrations.find((item) => item.integrationType === 'tally') ?? null);
      setGoogleCalendar(integrationRes.integrations.find((item) => item.integrationType === 'google-calendar') ?? null);
      setWebhook(integrationRes.integrations.find((item) => item.integrationType === 'webhook') ?? null);
      setSlack(integrationRes.integrations.find((item) => item.integrationType === 'slack') ?? null);
      setPayments(integrationRes.integrations.find((item) => item.integrationType === 'payments') ?? null);
      setVideo(integrationRes.integrations.find((item) => item.integrationType === 'video') ?? null);
      setVoice(integrationRes.integrations.find((item) => item.integrationType === 'vapi') ?? null);
      setVoiceStatus(voiceRes);
      setInboundStatus(inboundRes);
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

  const setupChannel = async (event: FormEvent<HTMLFormElement>, type: 'telegram') => {
    event.preventDefault();
    setSetupError(null);
    setBusyChannel(type);
    try {
      const response = await apiFetch<{ channel: WorkspaceChannel }>(
        `/channels/${type}/setup`,
        { method: 'POST', body: JSON.stringify({ token: telegramToken }) },
      );
      setChannels((prev) => {
        const rest = prev.filter((ch) => ch.channelType !== type);
        return [...rest, response.channel];
      });
      setTelegramToken('');
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

  /* ── Tally: preview / connect / rewebhook / toggle / disconnect ── */

  const openTallyDialog = () => {
    setTallyError(null);
    setTallyApiKey('');
    setTallyForms(null);
    setTallyFormId('');
    setTallyDialogOpen(true);
  };

  const closeTallyDialog = () => {
    setTallyDialogOpen(false);
    setTallyError(null);
  };

  const loadTallyForms = async () => {
    setTallyError(null);
    setTallyLoadingForms(true);
    try {
      const response = await apiFetch<TallyPreviewResponse>(
        '/integrations/tally/preview',
        { method: 'POST', body: JSON.stringify({ apiKey: tallyApiKey.trim() }) },
      );
      setTallyForms(response.forms);
    } catch (err) {
      setTallyError(errorMessage(err, t, 'tally.saveFailed'));
    } finally {
      setTallyLoadingForms(false);
    }
  };

  const connectTally = async () => {
    setTallyError(null);
    setTallyConnecting(true);
    try {
      const selected = tallyForms?.find((form) => form.id === tallyFormId);
      const response = await apiFetch<{ integration: WorkspaceIntegration }>(
        '/integrations/tally/connect',
        {
          method: 'POST',
          body: JSON.stringify({
            apiKey: tallyApiKey.trim(),
            formId: tallyFormId,
            formName: selected?.title,
          }),
        },
      );
      setTally(response.integration);
      setTallyDialogOpen(false);
    } catch (err) {
      setTallyError(errorMessage(err, t, 'tally.saveFailed'));
    } finally {
      setTallyConnecting(false);
    }
  };

  const toggleTallyActive = async () => {
    if (!tally) return;
    setTallyError(null);
    try {
      const response = await apiFetch<{ integration: WorkspaceIntegration }>(
        '/integrations/tally',
        { method: 'PATCH', body: JSON.stringify({ isActive: !tally.isActive }) },
      );
      setTally(response.integration);
    } catch (err) {
      setTallyError(errorMessage(err, t, 'tally.saveFailed'));
    }
  };

  const rewebhookTally = async () => {
    setTallyError(null);
    setTallyBusy('rewebhook');
    try {
      await apiFetch('/integrations/tally/rewebhook', { method: 'POST' });
      await load();
    } catch (err) {
      setTallyError(errorMessage(err, t, 'tally.rewebhookFailed'));
    } finally {
      setTallyBusy(null);
    }
  };

  const disconnectTally = async () => {
    setTallyError(null);
    setTallyBusy('disconnect');
    try {
      await apiFetch('/integrations/tally', { method: 'DELETE' });
      setTally(null);
    } catch (err) {
      setTallyError(errorMessage(err, t, 'tally.saveFailed'));
    } finally {
      setTallyBusy(null);
    }
  };

  /* ── Kirim form ke customer: buka dialog / cari kontak / kirim ── */

  const openSendForm = (type: 'google-forms' | 'tally') => {
    setSendFormType(type);
    setSendFormQuery('');
    setSendFormResults(null);
    setSendFormContactId('');
    setSendFormMessage(null);
    // Default channel: prioritas Telegram → Email.
    const telegramActive = channels.some((ch) => ch.channelType === 'telegram' && ch.isActive);
    setSendFormChannel(telegramActive ? 'telegram' : 'email');
    setSendFormOpen(true);
  };

  const closeSendForm = () => {
    setSendFormOpen(false);
    setSendFormMessage(null);
  };

  const searchSendFormContacts = async () => {
    const query = sendFormQuery.trim();
    if (!query) {
      setSendFormMessage({ ok: false, text: t('formSend.queryRequired') });
      return;
    }
    setSendFormSearching(true);
    setSendFormMessage(null);
    try {
      const params = new URLSearchParams({ q: query, limit: '8' });
      const response = await apiFetch<ContactsListResponse>(`/contacts?${params.toString()}`);
      setSendFormResults(response.contacts);
      if (response.contacts.length === 0) {
        setSendFormMessage({ ok: false, text: t('formSend.noContacts') });
      }
    } catch (err) {
      setSendFormMessage({ ok: false, text: errorMessage(err, t, 'formSend.searchFailed') });
    } finally {
      setSendFormSearching(false);
    }
  };

  const sendFormToContact = async () => {
    if (!sendFormType || !sendFormContactId) {
      setSendFormMessage({ ok: false, text: t('formSend.pickContact') });
      return;
    }
    setSendFormSending(true);
    setSendFormMessage(null);
    try {
      await apiFetch('/integrations/forms/send', {
        method: 'POST',
        body: JSON.stringify({
          integrationType: sendFormType,
          contactId: sendFormContactId,
          channel: sendFormChannel,
        }),
      });
      setSendFormMessage({
        ok: true,
        text: t('formSend.sent', { channel: t(`channels.${sendFormChannel}`) }),
      });
    } catch (err) {
      setSendFormMessage({ ok: false, text: errorMessage(err, t, 'formSend.sendFailed') });
    } finally {
      setSendFormSending(false);
    }
  };

  /** Salin nilai (webhook URL dsb.) — status "copied" di state dialog. */
  const copyValue = async (value: string) => {
    if (!value) return;
    try {
      await copyToClipboard(value);
      setCopiedValue(value);
      setTimeout(() => setCopiedValue(null), 1500);
    } catch {
      // Clipboard tidak tersedia — abaikan (nilai tetap terlihat di dialog).
    }
  };

  const copyFormUrl = async (formUrl: string, onError?: (message: string) => void) => {
    if (!formUrl) return;
    try {
      await copyToClipboard(formUrl);
      setFormUrlCopied(true);
      setTimeout(() => setFormUrlCopied(false), 1500);
    } catch {
      // Dialog dan kartu punya tempat error berbeda — pemanggil menentukan.
      if (onError) onError(t('channels.copyFailed'));
      else setSendFormMessage({ ok: false, text: t('channels.copyFailed') });
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

  /* ── Slack: connect / test / toggle / disconnect ─────────── */

  const openSlackDialog = () => {
    setSlackError(null);
    setSlackUrl('');
    setSlackChannel('');
    setSlackTestResult(null);
    setSlackDialogOpen(true);
  };

  const closeSlackDialog = () => {
    setSlackDialogOpen(false);
    setSlackError(null);
  };

  const connectSlack = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSlackError(null);
    setSlackConnecting(true);
    try {
      const response = await apiFetch<{ integration: WorkspaceIntegration }>(
        '/integrations/slack/connect',
        {
          method: 'POST',
          body: JSON.stringify({
            webhookUrl: slackUrl.trim(),
            channel: slackChannel.trim() || null,
          }),
        },
      );
      setSlack(response.integration);
      setSlackTestResult(null);
      setSlackDialogOpen(false);
    } catch (err) {
      setSlackError(errorMessage(err, t, 'slack.saveFailed'));
    } finally {
      setSlackConnecting(false);
    }
  };

  const testSlack = async () => {
    setSlackError(null);
    setSlackTestResult(null);
    setSlackTesting(true);
    try {
      const result = await apiFetch<{ delivered: boolean; status: number }>(
        '/integrations/slack/test',
        { method: 'POST' },
      );
      setSlackTestResult(t('slack.testSent', { status: result.status }));
    } catch (err) {
      setSlackError(errorMessage(err, t, 'slack.testFailed'));
    } finally {
      setSlackTesting(false);
    }
  };

  const toggleSlackActive = async () => {
    if (!slack) return;
    setSlackError(null);
    try {
      const response = await apiFetch<{ integration: WorkspaceIntegration }>(
        '/integrations/slack',
        { method: 'PATCH', body: JSON.stringify({ isActive: !slack.isActive }) },
      );
      setSlack(response.integration);
    } catch (err) {
      setSlackError(errorMessage(err, t, 'slack.saveFailed'));
    }
  };

  const disconnectSlack = async () => {
    setSlackError(null);
    setSlackBusy('disconnect');
    try {
      await apiFetch('/integrations/slack', { method: 'DELETE' });
      setSlack(null);
      setSlackTestResult(null);
    } catch (err) {
      setSlackError(errorMessage(err, t, 'slack.saveFailed'));
    } finally {
      setSlackBusy(null);
    }
  };

  /* ── Meta: preview / connect (Instagram & Facebook DMs) ──── */

  const openMetaDialog = (channelType: 'instagram' | 'facebook') => {
    setMetaError(null);
    setMetaToken('');
    setMetaPreview(null);
    setMetaDialogType(channelType);
    setMetaDialogOpen(true);
  };

  const closeMetaDialog = () => {
    setMetaDialogOpen(false);
    setMetaError(null);
  };

  const loadMetaPreview = async () => {
    setMetaError(null);
    setMetaLoadingPreview(true);
    try {
      const response = await apiFetch<{ identity: MetaIdentity }>('/channels/meta/preview', {
        method: 'POST',
        body: JSON.stringify({ accessToken: metaToken.trim() }),
      });
      setMetaPreview(response.identity);
    } catch (err) {
      setMetaError(errorMessage(err, t, 'channels.metaPreviewFailed'));
    } finally {
      setMetaLoadingPreview(false);
    }
  };

  const connectMeta = async () => {
    setMetaError(null);
    setMetaConnecting(true);
    try {
      const response = await apiFetch<{ channel: WorkspaceChannel }>('/channels/meta/setup', {
        method: 'POST',
        body: JSON.stringify({ channelType: metaDialogType, accessToken: metaToken.trim() }),
      });
      setChannels((prev) => [
        ...prev.filter((ch) => ch.channelType !== metaDialogType),
        response.channel,
      ]);
      setMetaDialogOpen(false);
    } catch (err) {
      setMetaError(errorMessage(err, t, 'channels.setupFailed'));
    } finally {
      setMetaConnecting(false);
    }
  };

  /* ── Video calls (Zoom / Google Meet) ────────────────────── */

  const openVideoDialog = async () => {
    setVideoError(null);
    setVideoProvider(video?.config.provider === 'meet' ? 'meet' : 'zoom');
    try {
      const response = await apiFetch<{ providers: { provider: 'zoom' | 'meet'; ready: boolean; reason?: string }[] }>(
        '/integrations/video/providers',
      );
      setVideoProviders(response.providers);
    } catch {
      setVideoProviders(null);
    }
    setVideoDialogOpen(true);
  };

  const closeVideoDialog = () => {
    setVideoDialogOpen(false);
    setVideoError(null);
  };

  const connectVideo = async () => {
    setVideoError(null);
    setVideoConnecting(true);
    try {
      const response = await apiFetch<{ integration: WorkspaceIntegration }>(
        '/integrations/video/connect',
        {
          method: 'POST',
          body: JSON.stringify({ provider: videoProvider }),
        },
      );
      setVideo(response.integration);
      setVideoDialogOpen(false);
    } catch (err) {
      setVideoError(errorMessage(err, t, 'video.saveFailed'));
    } finally {
      setVideoConnecting(false);
    }
  };

  const toggleVideoActive = async () => {
    if (!video) return;
    setVideoError(null);
    try {
      const response = await apiFetch<{ integration: WorkspaceIntegration }>(
        '/integrations/video',
        { method: 'PATCH', body: JSON.stringify({ isActive: !video.isActive }) },
      );
      setVideo(response.integration);
    } catch (err) {
      setVideoError(errorMessage(err, t, 'video.saveFailed'));
    }
  };

  const disconnectVideo = async () => {
    setVideoError(null);
    setVideoBusy('disconnect');
    try {
      await apiFetch('/integrations/video', { method: 'DELETE' });
      setVideo(null);
    } catch (err) {
      setVideoError(errorMessage(err, t, 'video.saveFailed'));
    } finally {
      setVideoBusy(null);
    }
  };

  /* ── Voice AI (Vapi): pilih nomor keluar / BYOC / kembali ke default ── */

  const openVoiceDialog = () => {
    setVoiceError(null);
    // Tab default mengikuti mode aktif: BYOC (akun Telnyx sendiri) atau operator.
    setVoiceTab(voice?.config.mode === 'byoc' ? 'byoc' : 'operator');
    // Pra-pilih nomor yang sedang aktif (integrasi atau default server).
    const current =
      voice?.config.vapiPhoneNumberId ?? voiceStatus?.defaultPhoneNumberId ?? '';
    setVoiceNumberId(current);
    // Reset state BYOC — key tidak diwarisi antar sesi; nomor pilihan diisi
    // dari nomor yang sedang dipakai bila mode BYOC aktif.
    setVoiceByoKey('');
    setVoiceByoResult(null);
    setVoiceByoNumber(voice?.config.mode === 'byoc' ? (voice.identifier ?? '') : '');
    setVoiceDialogOpen(true);
  };

  const closeVoiceDialog = () => {
    setVoiceDialogOpen(false);
    setVoiceError(null);
  };

  const switchVoiceTab = (tab: 'operator' | 'byoc') => {
    if (tab === voiceTab) return;
    setVoiceTab(tab);
    setVoiceError(null);
  };

  const connectVoice = async () => {
    setVoiceError(null);
    if (!voiceNumberId) {
      setVoiceError(t('vapi.numberRequired'));
      return;
    }
    setVoiceConnecting(true);
    try {
      const response = await apiFetch<{ integration: WorkspaceIntegration }>(
        '/integrations/vapi/connect',
        { method: 'POST', body: JSON.stringify({ vapiPhoneNumberId: voiceNumberId }) },
      );
      setVoice(response.integration);
      setVoiceStatus((prev) => (prev ? { ...prev, selected: response.integration } : prev));
      setVoiceDialogOpen(false);
    } catch (err) {
      setVoiceError(errorMessage(err, t, 'vapi.saveFailed'));
    } finally {
      setVoiceConnecting(false);
    }
  };

  const disconnectVoice = async () => {
    setVoiceError(null);
    setVoiceBusy('disconnect');
    try {
      await apiFetch('/integrations/vapi', { method: 'DELETE' });
      setVoice(null);
      setVoiceStatus((prev) => (prev ? { ...prev, selected: null } : prev));
    } catch (err) {
      setVoiceError(errorMessage(err, t, 'vapi.saveFailed'));
    } finally {
      setVoiceBusy(null);
    }
  };

  /** BYOC — cari nomor di akun Telnyx milik workspace (read-only, tanpa beli). */
  const searchVoiceByo = async () => {
    setVoiceError(null);
    if (!voiceByoKey.trim()) {
      setVoiceError(t('vapi.byoKeyRequired'));
      return;
    }
    setVoiceByoSearching(true);
    try {
      const response = await apiFetch<TelnyxByocSearchResponse>(
        '/integrations/vapi/byoc/search',
        {
          method: 'POST',
          body: JSON.stringify({
            apiKey: voiceByoKey.trim(),
            countryCode: voiceByoCountry.trim() || 'ID',
            areaCode: voiceByoArea.trim() || null,
          }),
        },
      );
      setVoiceByoResult(response);
      setVoiceByoNumber('');
    } catch (err) {
      setVoiceError(errorMessage(err, t, 'vapi.byoSearchFailed'));
    } finally {
      setVoiceByoSearching(false);
    }
  };

  /** BYOC — sambungkan nomor pilihan (buat credential Vapi + beli bila perlu). */
  const connectVoiceByo = async () => {
    setVoiceError(null);
    if (!voiceByoKey.trim()) {
      setVoiceError(t('vapi.byoKeyRequired'));
      return;
    }
    if (!voiceByoNumber.trim()) {
      setVoiceError(t('vapi.byoNumberRequired'));
      return;
    }
    setVoiceByoConnecting(true);
    try {
      const response = await apiFetch<TelnyxByocConnectResponse>(
        '/integrations/vapi/byoc/connect',
        {
          method: 'POST',
          body: JSON.stringify({
            apiKey: voiceByoKey.trim(),
            phoneNumber: voiceByoNumber.trim(),
          }),
        },
      );
      setVoice(response.integration);
      setVoiceStatus((prev) => (prev ? { ...prev, selected: response.integration } : prev));
      setVoiceDialogOpen(false);
    } catch (err) {
      setVoiceError(errorMessage(err, t, 'vapi.byoConnectFailed'));
    } finally {
      setVoiceByoConnecting(false);
    }
  };

  /* ── Voice AI — panggilan MASUK (inbound): register / unregister ── */

  const openInboundDialog = () => {
    setInboundError(null);
    setInboundName('');
    setInboundArea('');
    setInboundDialogOpen(true);
  };

  const registerInbound = async () => {
    setInboundError(null);
    if (!inboundStatus?.configured) {
      setInboundError(t('vapi.serverNotConfigured'));
      return;
    }
    setInboundRegistering(true);
    try {
      const response = await apiFetch<{ number: VapiInboundNumber }>(
        '/integrations/vapi/inbound/register',
        {
          method: 'POST',
          body: JSON.stringify({
            name: inboundName.trim() || null,
            areaCode: inboundArea.trim() || null,
          }),
        },
      );
      setInboundStatus((prev) => ({
        configured: prev?.configured ?? false,
        numbers: [...(prev?.numbers ?? []), response.number],
      }));
      setInboundDialogOpen(false);
    } catch (err) {
      setInboundError(errorMessage(err, t, 'vapiInbound.registerFailed'));
    } finally {
      setInboundRegistering(false);
    }
  };

  const unregisterInbound = async (id: string) => {
    setInboundError(null);
    setInboundBusy(id);
    try {
      await apiFetch(`/integrations/vapi/inbound/${id}`, { method: 'DELETE' });
      setInboundStatus((prev) =>
        prev ? { ...prev, numbers: prev.numbers.filter((item) => item.id !== id) } : prev,
      );
    } catch (err) {
      setInboundError(errorMessage(err, t, 'vapiInbound.unregisterFailed'));
    } finally {
      setInboundBusy(null);
    }
  };

  /* ── Payments: connect / toggle / disconnect ─────────────── */

  const connectPayments = async () => {
    setPaymentsError(null);
    setPaymentsBusy('connect');
    try {
      const response = await apiFetch<{ integration: WorkspaceIntegration }>(
        '/integrations/payments/connect',
        { method: 'POST' },
      );
      setPayments(response.integration);
    } catch (err) {
      setPaymentsError(errorMessage(err, t, 'payments.createFailed'));
    } finally {
      setPaymentsBusy(null);
    }
  };

  const togglePaymentsActive = async () => {
    if (!payments) return;
    setPaymentsError(null);
    try {
      const response = await apiFetch<{ integration: WorkspaceIntegration }>(
        '/integrations/payments',
        { method: 'PATCH', body: JSON.stringify({ isActive: !payments.isActive }) },
      );
      setPayments(response.integration);
    } catch (err) {
      setPaymentsError(errorMessage(err, t, 'payments.createFailed'));
    }
  };

  const disconnectPayments = async () => {
    setPaymentsError(null);
    setPaymentsBusy('disconnect');
    try {
      await apiFetch('/integrations/payments', { method: 'DELETE' });
      setPayments(null);
    } catch (err) {
      setPaymentsError(errorMessage(err, t, 'payments.createFailed'));
    } finally {
      setPaymentsBusy(null);
    }
  };

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('integrations.title')}
        description={t('integrations.description')}
        icon={IconPlug}
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

        {/* items-start: kartu ber-tinggi alami (tidak melar mengikuti kartu
            tertinggi di baris — default CSS Grid adalah align-items: stretch). */}
        <div className="mt-4 grid grid-cols-1 items-start gap-5 xl:grid-cols-3">
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
                    <div className="flex flex-wrap items-center gap-2">
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
                  <div className="mt-4">
                    <Button
                      label={
                        def.type === 'telegram'
                          ? t('channels.connectBot')
                          : t('channels.connectMeta')
                      }
                      variant="primary"
                      width="100%"
                      onClick={() => {
                        if (def.type === 'telegram') setSetupDialog('telegram');
                        else if (def.type === 'instagram' || def.type === 'facebook') openMetaDialog(def.type);
                      }}
                    />
                  </div>
                ) : configured && channel ? (
                  // Kartu Telegram RINGKAS — switch aktif, re-register webhook
                  // & disconnect dipindah ke dialog (blok status & management
                  // di dialog telegram). Di kartu hanya tombol Connected
                  // (membuka dialog).
                  def.type === 'telegram' ? (
                    <div className="mt-4 space-y-3">
                      <Button
                        label={t('channels.connected')}
                        variant="ghost"
                        size="sm"
                        width="100%"
                        icon={<IconCheck className="size-3.5 text-emerald-600" />}
                        onClick={() => setSetupDialog('telegram')}
                      />
                    </div>
                  ) : (
                    <div className="mt-4 space-y-3">
                      <Switch
                        label={t('channels.activeSwitch')}
                        description={active ? t('channels.activeDesc') : t('channels.inactiveDesc')}
                        value={active}
                        onChange={() => void toggleChannel(channel)}
                        isDisabled={busyChannel === channel.channelType}
                        labelPosition="start"
                        labelSpacing="spread"
                      />

                      <div className="flex flex-wrap items-center gap-2">
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
                  )
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

        {/* items-start: kartu ber-tinggi alami (tidak melar mengikuti kartu
            tertinggi di baris — default CSS Grid adalah align-items: stretch). */}
        <div className="mt-4 grid grid-cols-1 items-start gap-5 xl:grid-cols-3">
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

                {googleForms.config.formUrl && (
                  <Button
                    label={t('googleForms.sendForm')}
                    variant="secondary"
                    size="sm"
                    width="100%"
                    icon={<IconSend className="size-3.5" />}
                    isDisabled={!googleForms.isActive || formsBusy !== null}
                    onClick={() => openSendForm('google-forms')}
                  />
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

          {/* Tally — submission form → kontak (webhook real-time). */}
          <Card className="flex flex-col p-5">
            <div className="flex items-start gap-3">
              <BrandLogo src="/brands/tally.svg" alt={t('tally.name')} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-zinc-900">{t('tally.name')}</h3>
                  {tally ? (
                    <Badge variant={tally.isActive ? 'success' : 'neutral'} label={tally.isActive ? t('tally.connected') : t('channels.inactive')} />
                  ) : (
                    <Badge variant="neutral" label={t('channels.notSet')} />
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500">{t('tally.desc')}</p>
              </div>
            </div>

            {tallyError && (
              <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
                {tallyError}
              </p>
            )}

            {/* Migrasi Typeform → Tally: minta hubungkan ulang dengan API key. */}
            {tally?.config.migratedFrom === 'typeform' && (
              <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700">
                {t('tally.migratedNotice')}
              </p>
            )}

            {!tally ? (
              <Button
                label={t('tally.connect')}
                variant="primary"
                width="100%"
                className="mt-4"
                onClick={openTallyDialog}
              />
            ) : (
              <div className="mt-4 space-y-3">
                {tally.config.formUrl && (
                  <Button
                    label={t('tally.sendForm')}
                    variant="secondary"
                    size="sm"
                    width="100%"
                    icon={<IconSend className="size-3.5" />}
                    isDisabled={!tally.isActive || tallyBusy !== null}
                    onClick={() => openSendForm('tally')}
                  />
                )}

                {/* Terhubung tapi form belum dipilih → dorong ke dialog. */}
                {!tally.config.formId && (
                  <Button
                    label={t('tally.pickForm')}
                    variant="secondary"
                    size="sm"
                    width="100%"
                    icon={<IconSettings className="size-3.5" />}
                    isDisabled={tallyBusy !== null}
                    onClick={openTallyDialog}
                  />
                )}

                <Switch
                  label={t('tally.activeSwitch')}
                  description={tally.isActive ? t('tally.activeDesc') : t('tally.inactiveDesc')}
                  value={tally.isActive}
                  onChange={() => void toggleTallyActive()}
                  labelPosition="start"
                  labelSpacing="spread"
                />

                <div className="flex items-center gap-2">
                  <Button
                    label={t('tally.rewebhook')}
                    variant="ghost"
                    size="sm"
                    icon={<IconRefresh className="size-3.5" />}
                    isLoading={tallyBusy === 'rewebhook'}
                    isDisabled={tallyBusy !== null || !tally.isActive}
                    onClick={() => void rewebhookTally()}
                  />
                  <Button
                    label={t('tally.disconnect')}
                    variant="ghost"
                    size="sm"
                    icon={<IconTrash className="size-3.5" />}
                    isLoading={tallyBusy === 'disconnect'}
                    isDisabled={tallyBusy !== null}
                    onClick={() => void disconnectTally()}
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

          {/* Slack — notifikasi booking ke channel tim (Incoming Webhook). */}
          <Card className="flex flex-col p-5">
            <div className="flex items-start gap-3">
              <BrandLogo src="/brands/slack.svg" alt={t('slack.name')} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-zinc-900">{t('slack.name')}</h3>
                  {slack ? (
                    <Badge variant={slack.isActive ? 'success' : 'neutral'} label={slack.isActive ? t('slack.connected') : t('channels.inactive')} />
                  ) : (
                    <Badge variant="neutral" label={t('channels.notSet')} />
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500">{t('slack.desc')}</p>
              </div>
            </div>

            {slackError && (
              <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
                {slackError}
              </p>
            )}

            {!slack ? (
              <Button
                label={t('slack.connect')}
                variant="primary"
                width="100%"
                className="mt-4"
                onClick={openSlackDialog}
              />
            ) : (
              <div className="mt-4 space-y-3">
                {slackTestResult && (
                  <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700">
                    {slackTestResult}
                  </p>
                )}

                <Switch
                  label={t('slack.activeSwitch')}
                  description={slack.isActive ? t('slack.activeDesc') : t('slack.inactiveDesc')}
                  value={slack.isActive}
                  onChange={() => void toggleSlackActive()}
                  labelPosition="start"
                  labelSpacing="spread"
                />

                <div className="flex items-center gap-2">
                  <Button
                    label={t('slack.test')}
                    variant="primary"
                    size="sm"
                    icon={<IconSend className="size-3.5" />}
                    isLoading={slackTesting}
                    isDisabled={slackTesting || !slack.isActive}
                    onClick={() => void testSlack()}
                  />
                  <Button
                    label={t('slack.disconnect')}
                    variant="ghost"
                    size="sm"
                    icon={<IconTrash className="size-3.5" />}
                    isLoading={slackBusy === 'disconnect'}
                    isDisabled={slackBusy !== null}
                    onClick={() => void disconnectSlack()}
                  />
                </div>
              </div>
            )}
          </Card>

          {/* Video calls — link otomatis untuk setiap booking (Zoom / Meet). */}
          <Card className="flex flex-col p-5">
            <div className="flex items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-violet-500/10 text-violet-600">
                <IconVideo className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-zinc-900">{t('video.name')}</h3>
                  {video ? (
                    <Badge variant={video.isActive ? 'success' : 'neutral'} label={video.isActive ? t('video.connected') : t('channels.inactive')} />
                  ) : (
                    <Badge variant="neutral" label={t('channels.notSet')} />
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500">{t('video.desc')}</p>
              </div>
            </div>

            {videoError && (
              <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
                {videoError}
              </p>
            )}

            {!video ? (
              <Button
                label={t('video.connect')}
                variant="primary"
                width="100%"
                className="mt-4"
                onClick={() => void openVideoDialog()}
              />
            ) : (
              <div className="mt-4 space-y-3">
                <Switch
                  label={t('video.activeSwitch')}
                  description={video.isActive ? t('video.activeDesc') : t('video.inactiveDesc')}
                  value={video.isActive}
                  onChange={() => void toggleVideoActive()}
                  labelPosition="start"
                  labelSpacing="spread"
                />

                <Button
                  label={t('video.disconnect')}
                  variant="ghost"
                  size="sm"
                  width="100%"
                  icon={<IconTrash className="size-3.5" />}
                  isLoading={videoBusy === 'disconnect'}
                  isDisabled={videoBusy !== null}
                  onClick={() => void disconnectVideo()}
                />
              </div>
            )}
          </Card>

          {/* Voice AI (Vapi) — nomor keluar panggilan per workspace.
              Kredensial Vapi/Telnyx server-side (env VAPI_* / TELNYX_*) —
              user cukup memilih nomor mana yang dipakai panggilan keluar. */}
          <Card className="flex flex-col p-5">
            <div className="flex items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-sky-500/10 text-sky-600">
                <IconPhone className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-zinc-900">{t('vapi.name')}</h3>
                  {voice ? (
                    <Badge variant={voice.isActive ? 'success' : 'neutral'} label={t('vapi.connected')} />
                  ) : (
                    <Badge
                      variant="neutral"
                      label={voiceStatus?.configured ? t('channels.notSet') : t('channels.inactive')}
                    />
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500">{t('vapi.desc')}</p>
              </div>
            </div>

            {voiceError && (
              <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
                {voiceError}
              </p>
            )}

            {!voice ? (
              <div className="mt-4 space-y-3">
                {!voiceStatus?.apiKeyConfigured && (
                  <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700">
                    {t('vapi.serverNotConfigured')}
                  </p>
                )}
                {voiceStatus?.apiKeyConfigured && voiceStatus.numbers.length === 0 && (
                  <p className="rounded-lg bg-zinc-50 px-3 py-2 text-xs leading-relaxed text-zinc-500">
                    {t('vapi.noNumbers')}
                  </p>
                )}
                <Button
                  label={t('vapi.connect')}
                  variant="primary"
                  width="100%"
                  isDisabled={!voiceStatus?.apiKeyConfigured}
                  onClick={() => void openVoiceDialog()}
                />
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                <div className="flex items-center gap-2">
                  <Button
                    label={t('vapi.change')}
                    variant="primary"
                    size="sm"
                    icon={<IconSettings className="size-3.5" />}
                    onClick={() => void openVoiceDialog()}
                  />
                  <Button
                    label={t('vapi.disconnect')}
                    variant="ghost"
                    size="sm"
                    icon={<IconTrash className="size-3.5" />}
                    isLoading={voiceBusy === 'disconnect'}
                    isDisabled={voiceBusy !== null}
                    onClick={() => void disconnectVoice()}
                  />
                </div>
              </div>
            )}
          </Card>

          {/* Voice AI — panggilan MASUK (inbound): customer menelepon nomor ini
              dan dilayani resepsionis AI yang bisa membuat booking langsung.
              Nomor dibuat di Vapi (server-side env); tanpa API key → 503. */}
          <Card className="flex flex-col p-5">
            <div className="flex items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-violet-500/10 text-violet-600">
                <IconPhone className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-zinc-900">{t('vapiInbound.name')}</h3>
                  {(inboundStatus?.numbers.length ?? 0) > 0 ? (
                    <Badge
                      variant="success"
                      label={t('vapiInbound.active', { count: inboundStatus?.numbers.length ?? 0 })}
                    />
                  ) : (
                    <Badge variant="neutral" label={t('vapiInbound.inactive')} />
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500">{t('vapiInbound.desc')}</p>
              </div>
            </div>

            {inboundError && (
              <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
                {inboundError}
              </p>
            )}

            {!inboundStatus?.configured && (
              <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700">
                {t('vapi.serverNotConfigured')}
              </p>
            )}

            {(inboundStatus?.numbers.length ?? 0) > 0 && (
              <div className="mt-4 space-y-2">
                {inboundStatus!.numbers.map((number) => (
                  <div
                    key={number.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 px-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-zinc-800">
                        {number.number ?? t('vapiInbound.provisioning')}
                      </p>
                      {number.name && (
                        <p className="mt-0.5 truncate text-xs text-zinc-500">{number.name}</p>
                      )}
                    </div>
                    <Button
                      label={t('vapiInbound.unregister')}
                      variant="ghost"
                      size="sm"
                      icon={<IconTrash className="size-3.5" />}
                      isLoading={inboundBusy === number.id}
                      isDisabled={inboundBusy !== null}
                      onClick={() => void unregisterInbound(number.id)}
                    />
                  </div>
                ))}
              </div>
            )}

            <Button
              label={t('vapiInbound.register')}
              variant="primary"
              width="100%"
              className="mt-4"
              icon={<IconPhone className="size-3.5" />}
              isDisabled={!inboundStatus?.configured}
              onClick={() => void openInboundDialog()}
            />
          </Card>

          {/* Payments — Global Payments (Paddle, Merchant of Record).
              Kredensial server-side (env PADDLE_API_KEY) — one-click connect,
              lalu kelola payment link (checkout one-time untuk customer). */}
          <Card className="flex flex-col p-5">
            <div className="flex items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600">
                <IconCreditCard className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-zinc-900">{t('payments.name')}</h3>
                  {payments ? (
                    <Badge variant={payments.isActive ? 'success' : 'neutral'} label={payments.isActive ? t('payments.connected') : t('channels.inactive')} />
                  ) : (
                    <Badge variant="neutral" label={t('channels.notSet')} />
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500">{t('payments.desc')}</p>
              </div>
            </div>

            {paymentsError && (
              <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
                {paymentsError}
              </p>
            )}

            {!payments ? (
              <Button
                label={t('payments.connect')}
                variant="primary"
                width="100%"
                className="mt-4"
                isLoading={paymentsBusy === 'connect'}
                onClick={() => void connectPayments()}
              />
            ) : (
              <div className="mt-4 space-y-3">
                <Button
                  label={t('payments.manage')}
                  variant="primary"
                  size="sm"
                  width="100%"
                  icon={<IconCreditCard className="size-3.5" />}
                  isDisabled={!payments.isActive}
                  onClick={() => setPaymentsDialogOpen(true)}
                />

                <Switch
                  label={t('payments.activeSwitch')}
                  description={payments.isActive ? t('payments.activeDesc') : t('payments.inactiveDesc')}
                  value={payments.isActive}
                  onChange={() => void togglePaymentsActive()}
                  labelPosition="start"
                  labelSpacing="spread"
                />

                <Button
                  label={t('payments.disconnect')}
                  variant="ghost"
                  size="sm"
                  width="100%"
                  icon={<IconTrash className="size-3.5" />}
                  isLoading={paymentsBusy === 'disconnect'}
                  isDisabled={paymentsBusy !== null}
                  onClick={() => void disconnectPayments()}
                />
              </div>
            )}
          </Card>
        </div>
      </section>

      {/* Dialog kelola payment link — dibuka dari kartu Payments. */}
      <PaymentsDialog
        isOpen={paymentsDialogOpen}
        onOpenChange={setPaymentsDialogOpen}
      />

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
              title={
                channelRow('telegram')
                  ? t('channels.settingsTitle')
                  : t('channels.connectBot')
              }
              subtitle={
                channelRow('telegram')
                  ? t('channels.telegramDesc')
                  : t('channels.telegramSetupSubtitle')
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
              {(() => {
                const tel = channelRow('telegram');
                // Sudah terhubung → dialog berperan sebagai management:
                // konfigurasi, switch aktif, re-register webhook & lepas
                // koneksi (dipindah dari kartu, sama seperti WhatsApp).
                // Belum terhubung → form setup token.
                if (!tel) {
                  return (
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
                  );
                }
                return (
                  <div className="space-y-3">
                    <ConnectedDetails
                      title={t('channels.currentConfig')}
                      rows={[
                        { label: t('channels.botLabel'), value: tel.identifier ?? '—' },
                        {
                          label: t('channels.webhookUrl'),
                          value: (
                            <CopyableValue
                              value={tel.webhookUrl}
                              copied={copiedValue === tel.webhookUrl}
                              onCopy={() => void copyValue(tel.webhookUrl)}
                            />
                          ),
                        },
                      ]}
                    />

                    <Switch
                      label={t('channels.activeSwitch')}
                      description={tel.isActive ? t('channels.activeDesc') : t('channels.inactiveDesc')}
                      value={tel.isActive}
                      onChange={() => void toggleChannel(tel)}
                      isDisabled={busyChannel === 'telegram'}
                      labelPosition="start"
                      labelSpacing="spread"
                    />

                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        label={t('channels.rewebhook')}
                        variant="ghost"
                        size="sm"
                        icon={<IconRefresh className="size-3.5" />}
                        isDisabled={busyChannel === 'telegram'}
                        isLoading={busyChannel === 'telegram' && !tel.isActive}
                        onClick={() => void rewebhookTelegram()}
                      />
                      <Button
                        label={t('channels.disconnect')}
                        variant="ghost"
                        size="sm"
                        icon={<IconTrash className="size-3.5" />}
                        isDisabled={busyChannel === 'telegram'}
                        onClick={() => void removeChannel('telegram')}
                      />
                    </div>

                    {setupError?.channel === 'telegram' && (
                      <p role="alert" className="text-xs text-red-600">{setupError.message}</p>
                    )}
                  </div>
                );
              })()}
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              {channelRow('telegram') ? (
                <div className="flex justify-end gap-2">
                  <Button
                    label={t('common.close')}
                    variant="primary"
                    onClick={() => {
                      setSetupDialog(null);
                      setSetupError(null);
                    }}
                  />
                </div>
              ) : (
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
                    label={t('channels.connectBot')}
                    variant="primary"
                    type="submit"
                    form="telegram-setup-form"
                    isLoading={busyChannel === 'telegram'}
                    isDisabled={telegramToken.trim().length < 10}
                  />
                </div>
              )}
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
                {notion && (
                  <ConnectedDetails
                    title={t('channels.currentConfig')}
                    rows={[
                      {
                        label: t('notion.databaseLabel'),
                        value: notion.config.databaseName ?? notion.identifier ?? '—',
                      },
                      {
                        label: t('channels.lastSyncLabel'),
                        value: notion.lastSyncAt ? formatDateTime(notion.lastSyncAt) : t('notion.neverSynced'),
                      },
                    ]}
                  />
                )}
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
                {obsidian && (
                  <ConnectedDetails
                    title={t('channels.currentConfig')}
                    rows={[
                      { label: t('obsidian.vaultUrl'), value: obsidian.url },
                      { label: t('obsidian.folderPath'), value: obsidian.folderPath },
                    ]}
                  />
                )}
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
                {googleForms && (
                  <ConnectedDetails
                    title={t('channels.currentConfig')}
                    rows={[
                      {
                        label: t('googleForms.formLabel'),
                        value: googleForms.config.formName ?? googleForms.identifier ?? '—',
                      },
                      {
                        label: t('channels.lastSyncLabel'),
                        value: googleForms.lastSyncAt ? formatDateTime(googleForms.lastSyncAt) : t('googleForms.neverSynced'),
                      },
                    ]}
                  />
                )}
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

      {/* Dialog Tally — dua langkah: API key → pilih form. */}
      <Dialog
        isOpen={tallyDialogOpen}
        onOpenChange={(open) => {
          if (!open) closeTallyDialog();
        }}
        purpose="info"
        width={520}
      >
        <Layout
          header={
            <DialogHeader
              title={t('tally.dialogTitle')}
              subtitle={t('tally.dialogSubtitle')}
              onOpenChange={(open) => {
                if (!open) closeTallyDialog();
              }}
              hasDivider
            />
          }
          content={
            <LayoutContent>
              <div className="space-y-5">
                {tally && (
                  <ConnectedDetails
                    title={t('channels.currentConfig')}
                    rows={[
                      {
                        label: t('tally.formLabel'),
                        value: tally.config.formName ?? tally.identifier ?? '—',
                      },
                      {
                        label: t('channels.lastSyncLabel'),
                        value: tally.lastSyncAt ? formatDateTime(tally.lastSyncAt) : t('tally.neverSynced'),
                      },
                    ]}
                  />
                )}
                {tallyForms === null ? (
                  <div className="space-y-5">
                    {/* Migrasi Typeform → Tally: ingatkan hubungkan ulang. */}
                    {tally?.config.migratedFrom === 'typeform' && (
                      <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700">
                        {t('tally.migratedNotice')}
                      </p>
                    )}
                    <form
                      id="tally-key-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void loadTallyForms();
                      }}
                      className="space-y-3"
                    >
                      <TextInput
                        label={t('tally.tokenLabel')}
                        value={tallyApiKey}
                        onChange={setTallyApiKey}
                        placeholder={t('tally.tokenPlaceholder')}
                        width="100%"
                      />
                      {/* Pintasan: buka halaman API key Tally — user tidak perlu
                          mencari sendiri di mana membuat token. */}
                      <a
                        href="https://tally.so/settings/api-keys"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs font-medium text-amber-600 transition hover:text-amber-500"
                      >
                        <IconPlug className="size-3.5" />
                        {t('tally.getKey')}
                      </a>
                      <p className="rounded-lg bg-zinc-50 px-3 py-2 text-xs leading-relaxed text-zinc-500">
                        {t('tally.howTo')}
                      </p>
                    </form>
                    {tallyError && (
                      <p role="alert" className="text-xs text-red-600">{tallyError}</p>
                    )}
                  </div>
                ) : tallyForms.length === 0 ? (
                  <div>
                    <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700">
                      {t('tally.noForms')}
                    </p>
                    {tallyError && (
                      <p role="alert" className="mt-2 text-xs text-red-600">{tallyError}</p>
                    )}
                  </div>
                ) : (
                  <div>
                    <p className="mb-2 text-sm font-semibold text-zinc-800">{t('tally.stepForms')}</p>
                    <div className="max-h-72 space-y-2 overflow-y-auto pr-1" role="radiogroup" aria-label={t('tally.stepForms')}>
                      {tallyForms.map((form) => {
                        const selected = form.id === tallyFormId;
                        return (
                          <button
                            key={form.id}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            onClick={() => setTallyFormId(form.id)}
                            className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition ${
                              selected
                                ? 'border-amber-400 bg-amber-50/70 ring-2 ring-amber-500/15'
                                : 'border-zinc-200 bg-white hover:border-zinc-300'
                            }`}
                          >
                            <BrandLogo
                              src="/brands/tally.svg"
                              alt=""
                              chip={`size-8 rounded-lg shadow-none ${selected ? 'bg-amber-50 ring-1 ring-amber-400' : 'bg-white ring-1 ring-zinc-200'}`}
                              img="size-5"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-semibold text-zinc-900">{form.title}</span>
                              <span className="block truncate text-xs text-zinc-400">{form.id}</span>
                            </span>
                            <IconCheck className={`size-4 shrink-0 ${selected ? 'text-amber-600' : 'text-transparent'}`} />
                          </button>
                        );
                      })}
                    </div>
                    {tallyError && (
                      <p role="alert" className="mt-2 text-xs text-red-600">{tallyError}</p>
                    )}
                  </div>
                )}
              </div>
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              <div className="flex justify-end gap-2">
                <Button label={t('common.cancel')} variant="ghost" onClick={closeTallyDialog} />
                {tallyForms === null ? (
                  <Button
                    label={t('tally.loadForms')}
                    variant="primary"
                    type="submit"
                    form="tally-key-form"
                    isLoading={tallyLoadingForms}
                    isDisabled={tallyApiKey.trim().length < 10 || tallyLoadingForms}
                  />
                ) : (
                  <Button
                    label={t('tally.connectForm')}
                    variant="primary"
                    isLoading={tallyConnecting}
                    isDisabled={!tallyFormId || tallyConnecting}
                    onClick={() => void connectTally()}
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
                {googleCalendar && (
                  <ConnectedDetails
                    title={t('channels.currentConfig')}
                    rows={[
                      {
                        label: t('googleCalendar.calendarLabel'),
                        value: googleCalendar.config.calendarName ?? googleCalendar.identifier ?? '—',
                      },
                      {
                        label: t('channels.lastSyncLabel'),
                        value: googleCalendar.lastSyncAt ? formatDateTime(googleCalendar.lastSyncAt) : t('googleCalendar.neverSynced'),
                      },
                    ]}
                  />
                )}
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
              <div className="space-y-3">
                {webhook && (
                  <ConnectedDetails
                    title={t('channels.currentConfig')}
                    rows={[
                      {
                        label: t('webhook.urlLabel'),
                        value: webhook.config.url ? (
                          <CopyableValue
                            value={webhook.config.url}
                            copied={copiedValue === webhook.config.url}
                            onCopy={() => void copyValue(webhook.config.url ?? '')}
                          />
                        ) : (
                          '—'
                        ),
                      },
                      {
                        label: t('webhook.signatureLabel'),
                        value: webhook.config.hasSecret ? t('webhook.signed') : t('webhook.unsigned'),
                      },
                    ]}
                  />
                )}
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
              </div>
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

      {/* Dialog Meta — Page access token (Instagram / Facebook DMs). */}
      <Dialog
        isOpen={metaDialogOpen}
        onOpenChange={(open) => {
          if (!open) closeMetaDialog();
        }}
        purpose="info"
        width={520}
      >
        <Layout
          header={
            <DialogHeader
              title={
                metaDialogType === 'instagram'
                  ? t('channels.instagramTitle')
                  : t('channels.facebookTitle')
              }
              subtitle={t('channels.metaDesc')}
              onOpenChange={(open) => {
                if (!open) closeMetaDialog();
              }}
              hasDivider
            />
          }
          content={
            <LayoutContent>
              <div className="space-y-3">
                {(() => {
                  const meta = channelRow(metaDialogType);
                  if (!meta) return null;
                  return (
                    <ConnectedDetails
                      title={t('channels.currentConfig')}
                      rows={[
                        { label: t('channels.pageLabel'), value: meta.identifier ?? '—' },
                        {
                          label: t('channels.webhookUrl'),
                          value: (
                            <CopyableValue
                              value={meta.webhookUrl}
                              copied={copiedValue === meta.webhookUrl}
                              onCopy={() => void copyValue(meta.webhookUrl)}
                            />
                          ),
                        },
                      ]}
                    />
                  );
                })()}
                <div className="flex items-center gap-2">
                  <Button
                    label={t('channels.instagramTitle')}
                    variant={metaDialogType === 'instagram' ? 'primary' : 'ghost'}
                    size="sm"
                    onClick={() => {
                      setMetaDialogType('instagram');
                      setMetaPreview(null);
                      setMetaError(null);
                    }}
                  />
                  <Button
                    label={t('channels.facebookTitle')}
                    variant={metaDialogType === 'facebook' ? 'primary' : 'ghost'}
                    size="sm"
                    onClick={() => {
                      setMetaDialogType('facebook');
                      setMetaPreview(null);
                      setMetaError(null);
                    }}
                  />
                </div>

                <TextInput
                  label={t('channels.metaTokenLabel')}
                  value={metaToken}
                  onChange={(value) => {
                    setMetaToken(value);
                    setMetaPreview(null);
                    setMetaError(null);
                  }}
                  placeholder={t('channels.metaTokenPlaceholder')}
                  width="100%"
                />

                <Button
                  label={t('channels.metaPreviewCta')}
                  variant="secondary"
                  size="sm"
                  isLoading={metaLoadingPreview}
                  isDisabled={metaLoadingPreview || metaToken.trim().length < 20}
                  onClick={() => void loadMetaPreview()}
                />

                {metaPreview && (
                  <div className="rounded-lg bg-emerald-50 px-3 py-2">
                    <p className="text-sm font-medium text-emerald-800">{metaPreview.name}</p>
                    <p className="mt-0.5 text-xs text-emerald-700">
                      {metaDialogType === 'instagram'
                        ? (metaPreview.instagramBusinessAccount
                            ? `@${metaPreview.instagramBusinessAccount.username ?? '…'}`
                            : t('channels.metaNoIg'))
                        : metaPreview.id}
                    </p>
                  </div>
                )}

                <p className="rounded-lg bg-zinc-50 px-3 py-2 text-xs leading-relaxed text-zinc-500">
                  {t('channels.metaHint', {
                    webhookUrl: metaWebhookUrl,
                  })}
                </p>

                {metaError && (
                  <p role="alert" className="text-xs text-red-600">{metaError}</p>
                )}
              </div>
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              <div className="flex justify-end gap-2">
                <Button label={t('common.cancel')} variant="ghost" onClick={closeMetaDialog} />
                <Button
                  label={t('channels.metaConnectCta')}
                  variant="primary"
                  isLoading={metaConnecting}
                  isDisabled={
                    metaConnecting ||
                    metaToken.trim().length < 20 ||
                    (metaDialogType === 'instagram' && !metaPreview?.instagramBusinessAccount)
                  }
                  onClick={() => void connectMeta()}
                />
              </div>
            </LayoutFooter>
          }
        />
      </Dialog>

      {/* Dialog Video calls — pilih provider (Zoom / Google Meet). */}
      <Dialog
        isOpen={videoDialogOpen}
        onOpenChange={(open) => {
          if (!open) closeVideoDialog();
        }}
        purpose="info"
        width={480}
      >
        <Layout
          header={
            <DialogHeader
              title={t('video.connect')}
              subtitle={t('video.desc')}
              onOpenChange={(open) => {
                if (!open) closeVideoDialog();
              }}
              hasDivider
            />
          }
          content={
            <LayoutContent>
              <div className="space-y-3">
                {video && (
                  <ConnectedDetails
                    title={t('channels.currentConfig')}
                    rows={[
                      {
                        label: t('video.providerLabel'),
                        value: video.config.provider === 'zoom' ? 'Zoom' : 'Google Meet',
                      },
                    ]}
                  />
                )}
                <Selector
                  label={t('video.providerLabel')}
                  options={[
                    { value: 'zoom', label: 'Zoom' },
                    { value: 'meet', label: 'Google Meet' },
                  ]}
                  value={videoProvider}
                  onChange={(value: string) => {
                    setVideoProvider(value as 'zoom' | 'meet');
                    setVideoError(null);
                  }}
                  width="100%"
                />

                {videoProviders && (
                  <p className="rounded-lg bg-zinc-50 px-3 py-2 text-xs leading-relaxed text-zinc-500">
                    {videoProvider === 'zoom'
                      ? (videoProviders.find((p) => p.provider === 'zoom')?.ready
                          ? t('video.zoomReady')
                          : (videoProviders.find((p) => p.provider === 'zoom')?.reason ?? t('video.zoomNotReady')))
                      : t('video.meetHint')}
                  </p>
                )}

                {videoError && (
                  <p role="alert" className="text-xs text-red-600">{videoError}</p>
                )}
              </div>
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              <div className="flex justify-end gap-2">
                <Button label={t('common.cancel')} variant="ghost" onClick={closeVideoDialog} />
                <Button
                  label={t('video.connectCta')}
                  variant="primary"
                  isLoading={videoConnecting}
                  isDisabled={videoConnecting}
                  onClick={() => void connectVideo()}
                />
              </div>
            </LayoutFooter>
          }
        />
      </Dialog>

      {/* Dialog Voice AI — pilih nomor keluar: nomor server (operator) atau
          Bring your own carrier (workspace menempel API key Telnyx sendiri). */}
      <Dialog
        isOpen={voiceDialogOpen}
        onOpenChange={(open) => {
          if (!open) closeVoiceDialog();
        }}
        purpose="info"
        width={480}
      >
        <Layout
          header={
            <DialogHeader
              title={t('vapi.connect')}
              subtitle={t('vapi.desc')}
              onOpenChange={(open) => {
                if (!open) closeVoiceDialog();
              }}
              hasDivider
            />
          }
          content={
            <LayoutContent>
              {voice && (
                <div className="mb-3">
                  <ConnectedDetails
                    title={t('channels.currentConfig')}
                    rows={[
                      {
                        label: t('vapi.selectedNumberLabel'),
                        value: voice.config.phoneNumber ?? voice.identifier ?? '—',
                      },
                      {
                        label: t('vapi.modeLabel'),
                        value: voice.config.mode === 'byoc' ? t('vapi.byoTabLabel') : t('vapi.operatorTabLabel'),
                      },
                    ]}
                  />
                </div>
              )}
              <TabList
                className="mb-3"
                value={voiceTab}
                onChange={(value) => switchVoiceTab(value as 'operator' | 'byoc')}
                layout="fill"
              >
                <Tab value="operator" label={t('vapi.operatorTabLabel')} />
                <Tab value="byoc" label={t('vapi.byoTabLabel')} />
              </TabList>

              {voiceTab === 'operator' ? (
                <div className="space-y-3">
                  <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                    {t('vapi.pickerLabel')}
                  </p>
                  <div className="space-y-2">
                    {(voiceStatus?.numbers ?? []).map((n) => (
                      <button
                        key={n.id}
                        type="button"
                        onClick={() => {
                          setVoiceNumberId(n.id);
                          setVoiceError(null);
                        }}
                        className={`flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-left text-sm transition ${
                          voiceNumberId === n.id
                            ? 'border-sky-500 bg-sky-50 text-sky-700'
                            : 'border-zinc-200 bg-white text-zinc-800 hover:border-zinc-300'
                        }`}
                      >
                        <span className="truncate font-medium">{n.number ?? n.name ?? n.id}</span>
                        <IconCheck
                          className={`size-4 shrink-0 ${voiceNumberId === n.id ? 'opacity-100' : 'opacity-0'}`}
                        />
                      </button>
                    ))}
                    {voiceStatus && voiceStatus.numbers.length === 0 && (
                      <p className="rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-500">
                        {t('vapi.noNumbers')}
                      </p>
                    )}
                  </div>

                  {voiceError && (
                    <p role="alert" className="text-xs text-red-600">{voiceError}</p>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  <form
                    id="vapi-byo-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void searchVoiceByo();
                    }}
                    className="space-y-3"
                  >
                    <TextInput
                      label={t('vapi.byoKeyLabel')}
                      value={voiceByoKey}
                      onChange={(value) => {
                        setVoiceByoKey(value);
                        setVoiceByoResult(null);
                      }}
                      placeholder="KEY01…"
                      type="password"
                      width="100%"
                    />
                    <div className="grid grid-cols-[110px_1fr] gap-2">
                      <TextInput
                        label={t('vapi.byoCountryLabel')}
                        value={voiceByoCountry}
                        onChange={(value) => {
                          setVoiceByoCountry(value.toUpperCase().slice(0, 2));
                          setVoiceByoResult(null);
                        }}
                        placeholder="ID"
                        width="100%"
                      />
                      <TextInput
                        label={t('vapi.byoAreaLabel')}
                        value={voiceByoArea}
                        onChange={(value) => {
                          setVoiceByoArea(value.replace(/[^0-9]/g, '').slice(0, 10));
                          setVoiceByoResult(null);
                        }}
                        placeholder={t('vapi.byoAreaPlaceholder')}
                        width="100%"
                      />
                    </div>
                    <p className="text-xs leading-relaxed text-zinc-400">
                      {t('vapi.byoHint')}
                    </p>
                    <Button
                      label={t('vapi.byoSearchCta')}
                      variant="primary"
                      width="100%"
                      isLoading={voiceByoSearching}
                      isDisabled={voiceByoSearching || !voiceByoKey.trim()}
                      onClick={() => void searchVoiceByo()}
                    />
                  </form>

                  {voiceByoResult && (
                    <div className="space-y-3">
                      {voiceByoResult.owned.length > 0 && (
                        <div>
                          <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                            {t('vapi.byoOwnedLabel')}
                          </p>
                          <div className="mt-1.5 space-y-1.5">
                            {voiceByoResult.owned.map((n) => (
                              <button
                                key={n.phoneNumber}
                                type="button"
                                onClick={() => {
                                  setVoiceByoNumber(n.phoneNumber);
                                  setVoiceError(null);
                                }}
                                className={`flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-left text-sm transition ${
                                  voiceByoNumber === n.phoneNumber
                                    ? 'border-sky-500 bg-sky-50 text-sky-700'
                                    : 'border-zinc-200 bg-white text-zinc-800 hover:border-zinc-300'
                                }`}
                              >
                                <span className="truncate font-medium">
                                  {n.phoneNumber}
                                  {n.locality ? (
                                    <span className="ml-1.5 text-xs font-normal text-zinc-400">
                                      · {n.locality}
                                    </span>
                                  ) : null}
                                </span>
                                <IconCheck
                                  className={`size-4 shrink-0 ${voiceByoNumber === n.phoneNumber ? 'opacity-100' : 'opacity-0'}`}
                                />
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      {voiceByoResult.available.length > 0 && (
                        <div>
                          <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                            {t('vapi.byoAvailableLabel')}
                          </p>
                          <div className="mt-1.5 space-y-1.5">
                            {voiceByoResult.available.map((n) => (
                              <button
                                key={n.phoneNumber}
                                type="button"
                                onClick={() => {
                                  setVoiceByoNumber(n.phoneNumber);
                                  setVoiceError(null);
                                }}
                                className={`flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-left text-sm transition ${
                                  voiceByoNumber === n.phoneNumber
                                    ? 'border-sky-500 bg-sky-50 text-sky-700'
                                    : 'border-zinc-200 bg-white text-zinc-800 hover:border-zinc-300'
                                }`}
                              >
                                <span className="truncate font-medium">
                                  {n.phoneNumber}
                                  {n.locality ? (
                                    <span className="ml-1.5 text-xs font-normal text-zinc-400">
                                      · {n.locality}
                                    </span>
                                  ) : null}
                                </span>
                                <IconCheck
                                  className={`size-4 shrink-0 ${voiceByoNumber === n.phoneNumber ? 'opacity-100' : 'opacity-0'}`}
                                />
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      {voiceByoResult.owned.length === 0 && voiceByoResult.available.length === 0 && (
                        <p className="rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-500">
                          {t('vapi.byoEmpty')}
                        </p>
                      )}
                    </div>
                  )}

                  {voiceError && (
                    <p role="alert" className="text-xs text-red-600">{voiceError}</p>
                  )}
                </div>
              )}
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              <div className="flex justify-end gap-2">
                <Button label={t('common.cancel')} variant="ghost" onClick={closeVoiceDialog} />
                {voiceTab === 'operator' ? (
                  <Button
                    label={t('vapi.connectCta')}
                    variant="primary"
                    isLoading={voiceConnecting}
                    isDisabled={voiceConnecting || (voiceStatus?.numbers.length ?? 0) === 0}
                    onClick={() => void connectVoice()}
                  />
                ) : (
                  <Button
                    label={t('vapi.byoConnectCta')}
                    variant="primary"
                    isLoading={voiceByoConnecting}
                    isDisabled={voiceByoConnecting || !voiceByoNumber.trim()}
                    onClick={() => void connectVoiceByo()}
                  />
                )}
              </div>
            </LayoutFooter>
          }
        />
      </Dialog>

      {/* Dialog Voice AI inbound — daftarkan nomor masuk baru (Vapi menyediakan
          nomor; label + kode area opsional). */}
      <Dialog
        isOpen={inboundDialogOpen}
        onOpenChange={(open) => {
          if (!open) setInboundDialogOpen(false);
        }}
        purpose="info"
        width={480}
      >
        <Layout
          header={
            <DialogHeader
              title={t('vapiInbound.register')}
              subtitle={t('vapiInbound.registerDesc')}
              onOpenChange={(open) => {
                if (!open) setInboundDialogOpen(false);
              }}
              hasDivider
            />
          }
          content={
            <LayoutContent>
              <form
                id="vapi-inbound-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void registerInbound();
                }}
                className="space-y-3"
              >
                <TextInput
                  label={t('vapiInbound.nameLabel')}
                  value={inboundName}
                  onChange={setInboundName}
                  placeholder={t('vapiInbound.namePlaceholder')}
                  width="100%"
                />
                <TextInput
                  label={t('vapiInbound.areaLabel')}
                  value={inboundArea}
                  onChange={setInboundArea}
                  placeholder={t('vapiInbound.areaPlaceholder')}
                  width="100%"
                />
                {inboundError && (
                  <p role="alert" className="text-xs text-red-600">{inboundError}</p>
                )}
              </form>
            </LayoutContent>
          }
          footer={
            <LayoutFooter>
              <div className="flex justify-end gap-2">
                <Button
                  label={t('common.cancel')}
                  variant="ghost"
                  onClick={() => setInboundDialogOpen(false)}
                />
                <Button
                  label={t('vapiInbound.register')}
                  variant="primary"
                  type="submit"
                  form="vapi-inbound-form"
                  isLoading={inboundRegistering}
                  onClick={() => void registerInbound()}
                />
              </div>
            </LayoutFooter>
          }
        />
      </Dialog>

      {/* Dialog Slack — Incoming Webhook URL + label channel opsional. */}
      <Dialog
        isOpen={slackDialogOpen}
        onOpenChange={(open) => {
          if (!open) closeSlackDialog();
        }}
        purpose="info"
        width={480}
      >
        <Layout
          header={
            <DialogHeader
              title={t('slack.connect')}
              subtitle={t('slack.desc')}
              onOpenChange={(open) => {
                if (!open) closeSlackDialog();
              }}
              hasDivider
            />
          }
          content={
            <LayoutContent>
              <div className="space-y-3">
                {slack && (
                  <ConnectedDetails
                    title={t('channels.currentConfig')}
                    rows={[
                      {
                        label: t('slack.targetLabel'),
                        value: slack.config.webhookUrlHost ?? slack.identifier ?? '—',
                      },
                      {
                        label: t('slack.channelLabel'),
                        value: slack.config.channel ?? '—',
                      },
                    ]}
                  />
                )}
                <form id="slack-connect-form" onSubmit={connectSlack} className="space-y-3">
                  <TextInput
                    label={t('slack.urlLabel')}
                    value={slackUrl}
                    onChange={(value) => {
                      setSlackUrl(value);
                      setSlackTestResult(null);
                    }}
                    placeholder={t('slack.urlPlaceholder')}
                    width="100%"
                  />
                  <TextInput
                    label={t('slack.channelLabel')}
                    value={slackChannel}
                    onChange={(value) => {
                      setSlackChannel(value);
                      setSlackTestResult(null);
                    }}
                    placeholder={t('slack.channelPlaceholder')}
                    width="100%"
                  />
                  <p className="rounded-lg bg-zinc-50 px-3 py-2 text-xs leading-relaxed text-zinc-500">
                    {t('slack.hint')}
                  </p>
                  {slackError && (
                    <p role="alert" className="text-xs text-red-600">{slackError}</p>
                  )}
                </form>
              </div>
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              <div className="flex justify-end gap-2">
                <Button label={t('common.cancel')} variant="ghost" onClick={closeSlackDialog} />
                <Button
                  label={t('slack.connectSlack')}
                  variant="primary"
                  type="submit"
                  form="slack-connect-form"
                  isLoading={slackConnecting}
                  isDisabled={
                    slackConnecting ||
                    !slackUrl.trim().startsWith('https://hooks.slack.com/services/')
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

      {/* Dialog kirim form — pilih kontak + channel, lalu kirim tautan. */}
      <Dialog
        isOpen={sendFormOpen}
        onOpenChange={(open) => {
          if (!open) closeSendForm();
        }}
        purpose="info"
        width={520}
      >
        <Layout
          header={
            <DialogHeader
              title={t('formSend.dialogTitle')}
              subtitle={t('formSend.dialogSubtitle', {
                form:
                  sendFormType === 'tally'
                    ? (tally?.identifier ?? t('tally.name'))
                    : (googleForms?.identifier ?? t('googleForms.name')),
              })}
              onOpenChange={(open) => {
                if (!open) closeSendForm();
              }}
              hasDivider
            />
          }
          content={
            <LayoutContent>
              <div className="space-y-4">
                {/* Tautan form — copyable, bisa juga ditempel manual. */}
                <div>
                  <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                    {t('formSend.formLinkLabel')}
                  </p>
                  <div className="mt-1 flex items-center gap-1.5 rounded-lg bg-zinc-50 p-2">
                    <p className="min-w-0 flex-1 break-all font-mono text-xs leading-relaxed text-zinc-500">
                      {sendFormType === 'tally'
                        ? (tally?.config.formUrl ?? '—')
                        : (googleForms?.config.formUrl ?? '—')}
                    </p>
                    <button
                      type="button"
                      onClick={() =>
                        void copyFormUrl(
                          (sendFormType === 'tally' ? tally?.config.formUrl : googleForms?.config.formUrl) ?? '',
                        )
                      }
                      aria-label={t('channels.copy')}
                      className="flex shrink-0 items-center gap-1 text-xs font-medium text-amber-600 transition hover:text-amber-500"
                    >
                      {formUrlCopied ? <IconCheck className="size-3.5" /> : <IconCopy className="size-3.5" />}
                      {formUrlCopied ? t('channels.copied') : t('channels.copy')}
                    </button>
                  </div>
                </div>

                {/* Cari kontak. */}
                <div>
                  <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                    {t('formSend.contactLabel')}
                  </p>
                  <div className="mt-1 flex items-center gap-2">
                    <div className="flex-1">
                      <TextInput
                        label={t('formSend.contactLabel')}
                        value={sendFormQuery}
                        onChange={setSendFormQuery}
                        placeholder={t('formSend.contactPlaceholder')}
                        width="100%"
                      />
                    </div>
                    <Button
                      label={t('formSend.search')}
                      variant="secondary"
                      isLoading={sendFormSearching}
                      isDisabled={sendFormSearching}
                      onClick={() => void searchSendFormContacts()}
                    />
                  </div>

                  {sendFormResults && sendFormResults.length > 0 && (
                    <div className="mt-2 space-y-1.5">
                      {sendFormResults.map((contact) => (
                        <button
                          key={contact.id}
                          type="button"
                          onClick={() => setSendFormContactId(contact.id)}
                          className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left transition ${
                            sendFormContactId === contact.id
                              ? 'border-amber-500 bg-amber-50/60'
                              : 'border-zinc-200 bg-white hover:bg-zinc-50'
                          }`}
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium text-zinc-800">
                              {contact.name}
                            </span>
                            <span className="block truncate text-xs text-zinc-400">
                              {contact.phone}
                              {contact.email ? ` · ${contact.email}` : ''}
                            </span>
                          </span>
                          {sendFormContactId === contact.id && (
                            <IconCheck className="size-4 shrink-0 text-amber-600" />
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Pilih channel pengiriman. */}
                <div>
                  <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                    {t('formSend.channelLabel')}
                  </p>
                  <DropdownMenu
                    placement="below"
                    menuWidth="100%"
                    button={{
                      label: t(`channels.${sendFormChannel}`),
                      variant: 'secondary',
                      width: '100%',
                    }}
                  >
                    <DropdownMenuItem
                      label={t('channels.email')}
                      onClick={() => setSendFormChannel('email')}
                    />
                    {channels.some((ch) => ch.channelType === 'telegram' && ch.isActive) && (
                      <DropdownMenuItem
                        label={t('channels.telegram')}
                        onClick={() => setSendFormChannel('telegram')}
                      />
                    )}
                  </DropdownMenu>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-400">
                    {t('formSend.channelHint')}
                  </p>
                </div>

                {sendFormMessage && (
                  <p
                    role="alert"
                    className={`rounded-lg px-3 py-2 text-xs font-medium ${
                      sendFormMessage.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'
                    }`}
                  >
                    {sendFormMessage.text}
                  </p>
                )}
              </div>
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              <div className="flex justify-end gap-2">
                <Button label={t('common.cancel')} variant="ghost" onClick={closeSendForm} />
                <Button
                  label={t('formSend.send')}
                  variant="primary"
                  icon={<IconSend className="size-4" />}
                  isLoading={sendFormSending}
                  isDisabled={sendFormSending || !sendFormContactId}
                  onClick={() => void sendFormToContact()}
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
