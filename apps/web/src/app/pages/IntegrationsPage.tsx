import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import {
  Badge,
  Banner,
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
  type TelegramAlertsConnectResponse,
  type WebhookTestResult,
  type WhatsAppBusinessConnection,
  type WhatsAppBusinessConnectResponse,
  type WhatsAppBusinessStatusResponse,
  type WorkspaceIntegration,
} from '../../lib/integrations';
import { useWorkspaceStore } from '../../stores/workspace';
import type { TranslationKey } from '../../i18n';
import { PaymentsDialog } from '../shell/PaymentsDialog';
import {
  IconChat,
  IconCheck,
  IconCopy,
  IconCreditCard,
  IconDotsVertical,
  IconExternalLink,
  IconMail,
  IconSignal,
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
      <span className="min-w-0 text-right font-medium text-zinc-700 dark:text-zinc-300">{value}</span>
    </div>
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
  {
    type: 'line',
    label: 'Line',
    descriptionKey: 'channels.lineDesc',
    // Belum ada aset logo resmi — ikon chat dengan warna brand Line (#06C755).
    icon: IconChat,
    accent: 'bg-[#06C755]/10 text-[#06C755]',
  },
];

/**
 * Channel yang BELUM tersedia — masing-masing butuh persetujuan / akun
 * bisnis di platformnya dulu (bukan sekadar API key). Kartu ini informatif:
 * menampilkan syarat dengan jujur, tanpa tombol connect palsu.
 */
const CHANNEL_COMING_SOON: {
  type: string;
  label: string;
  descriptionKey: TranslationKey;
  requirementKey: TranslationKey;
  icon: typeof IconChat;
  accent: string;
}[] = [
  {
    type: 'signal',
    label: 'Signal',
    descriptionKey: 'channels.signalDesc',
    requirementKey: 'channels.signalRequirement',
    icon: IconSignal,
    accent: 'bg-[#3A76F0]/10 text-[#3A76F0]',
  },
  {
    type: 'wechat',
    label: 'WeChat',
    descriptionKey: 'channels.wechatDesc',
    requirementKey: 'channels.wechatRequirement',
    icon: IconChat,
    accent: 'bg-[#07C160]/10 text-[#07C160]',
  },
  {
    type: 'imessage',
    label: 'iMessage',
    descriptionKey: 'channels.imessageDesc',
    requirementKey: 'channels.imessageRequirement',
    icon: IconMail,
    accent: 'bg-[#34C759]/10 text-[#34C759]',
  },
];

/** Chip logo brand (aset SVG dari svgl.app) — kartu putih dengan logo di dalamnya. */
function BrandLogo({ src, alt, chip = 'size-10 rounded-xl bg-white dark:bg-zinc-900', img = 'size-6' }: {
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
  // Banner sukses — konfirmasi integrasi/channel berhasil terhubung di halaman
  // ini. Dismissable; tidak timeout (sukses connect layak terlihat jelas).
  const [integrationNotice, setIntegrationNotice] = useState<string | null>(null);
  const showConnectedNotice = (name: string) => {
    setIntegrationNotice(t('integrations.connectedSuccess', { name }));
  };

  // Form kredensial per channel — di dalam dialog setup (tidak inline di kartu).
  const [telegramToken, setTelegramToken] = useState('');
  const [lineAccessToken, setLineAccessToken] = useState('');
  const [lineChannelSecret, setLineChannelSecret] = useState('');
  const [setupDialog, setSetupDialog] = useState<'telegram' | 'line' | null>(null);
  const [busyChannel, setBusyChannel] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<{ channel: string; message: string } | null>(null);

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

  // ── Kirim tautan form ke customer (Google Forms) ──
  const [sendFormOpen, setSendFormOpen] = useState(false);
  const [sendFormType, setSendFormType] = useState<'google-forms' | null>(null);
  const [sendFormQuery, setSendFormQuery] = useState('');
  const [sendFormResults, setSendFormResults] = useState<ContactRecord[] | null>(null);
  const [sendFormContactId, setSendFormContactId] = useState('');
  const [sendFormChannel, setSendFormChannel] = useState<'telegram' | 'email' | 'line'>('email');
  const [sendFormSearching, setSendFormSearching] = useState(false);
  const [sendFormSending, setSendFormSending] = useState(false);
  const [sendFormMessage, setSendFormMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [formUrlCopied, setFormUrlCopied] = useState(false);

  // ── Tally integration ────────────────────────────────────
  const [tally, setTally] = useState<WorkspaceIntegration | null>(null);
  const [tallyDialogOpen, setTallyDialogOpen] = useState(false);
  const [tallyApiKey, setTallyApiKey] = useState('');
  const [tallyConnecting, setTallyConnecting] = useState(false);
  const [tallyBusy, setTallyBusy] = useState<'rewebhook' | 'update-content' | 'disconnect' | null>(null);
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

  // ── Telegram booking alerts (notifikasi booking ke chat bisnis) ─
  const [telegramAlerts, setTelegramAlerts] = useState<WorkspaceIntegration | null>(null);
  const [telegramAlertsConnecting, setTelegramAlertsConnecting] = useState(false);
  const [telegramAlertsTesting, setTelegramAlertsTesting] = useState(false);
  const [telegramAlertsBusy, setTelegramAlertsBusy] = useState<'disconnect' | null>(null);
  const [telegramAlertsError, setTelegramAlertsError] = useState<string | null>(null);
  const [telegramAlertsBindHint, setTelegramAlertsBindHint] = useState(false);

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

  // ── WhatsApp Business (Meta Embedded Signup — Tech Provider) ──
  // Kredensial/TIDAK pernah sampai ke frontend — hanya metadata publik.
  const [whatsappBusiness, setWhatsappBusiness] = useState<WhatsAppBusinessConnection | null>(null);
  const [whatsappBusy, setWhatsappBusy] = useState<'connect' | 'refresh' | 'check' | 'disconnect' | null>(null);
  const [whatsappError, setWhatsappError] = useState<string | null>(null);
  // Notice dari redirect callback (whatsapp=connected|error|already di URL).
  const [whatsappNotice, setWhatsappNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();

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
      setTally(integrationRes.integrations.find((item) => item.integrationType === 'tally') ?? null);
      setGoogleCalendar(integrationRes.integrations.find((item) => item.integrationType === 'google-calendar') ?? null);
      setWebhook(integrationRes.integrations.find((item) => item.integrationType === 'webhook') ?? null);
      setSlack(integrationRes.integrations.find((item) => item.integrationType === 'slack') ?? null);
      setTelegramAlerts(integrationRes.integrations.find((item) => item.integrationType === 'telegram-alerts') ?? null);
      setPayments(integrationRes.integrations.find((item) => item.integrationType === 'payments') ?? null);
      setVideo(integrationRes.integrations.find((item) => item.integrationType === 'video') ?? null);
      // WhatsApp Business dimuat terpisah — endpoint baru tidak boleh
      // menggagalkan seluruh halaman bila platform Meta belum disetel.
      try {
        const wa = await apiFetch<WhatsAppBusinessStatusResponse>('/whatsapp-business');
        setWhatsappBusiness(wa.connection);
      } catch (err) {
        setWhatsappError(errorMessage(err, t, 'integrations.loadFailed'));
      }
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
      showConnectedNotice(t('channels.telegram'));
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
      showConnectedNotice(t('channels.telegram'));
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

  const setupLineChannel = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSetupError(null);
    setBusyChannel('line');
    try {
      const response = await apiFetch<{ channel: WorkspaceChannel }>(
        '/channels/line/setup',
        {
          method: 'POST',
          body: JSON.stringify({
            channelAccessToken: lineAccessToken.trim(),
            channelSecret: lineChannelSecret.trim(),
          }),
        },
      );
      setChannels((prev) => {
        const rest = prev.filter((ch) => ch.channelType !== 'line');
        return [...rest, response.channel];
      });
      setLineAccessToken('');
      setLineChannelSecret('');
      setSetupDialog(null);
      showConnectedNotice(t('channels.line'));
    } catch (err) {
      setSetupError({ channel: 'line', message: errorMessage(err, t, 'channels.setupFailed') });
    } finally {
      setBusyChannel(null);
    }
  };

  const rewebhookLine = async () => {
    setBusyChannel('line');
    setSetupError(null);
    try {
      await apiFetch('/channels/line/rewebhook', { method: 'POST' });
      await load();
    } catch (err) {
      setSetupError({
        channel: 'line',
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

  /* ── WhatsApp Business (Meta Embedded Signup) ── */
  const connectWhatsAppBusiness = async () => {
    setWhatsappError(null);
    setWhatsappNotice(null);
    setWhatsappBusy('connect');
    try {
      const response = await apiFetch<WhatsAppBusinessConnectResponse>(
        '/whatsapp-business/connect',
        { method: 'POST' },
      );
      // Official Embedded Signup: arahkan browser ke dialog Meta (login,
      // pilih/buat Business Portfolio + WABA, verifikasi nomor, izin) — Meta
      // lalu mengarahkan kembali ke callback yang menyelesaikan onboarding.
      window.location.assign(response.signupUrl);
    } catch (err) {
      setWhatsappError(errorMessage(err, t, 'whatsappBusiness.connectError'));
    } finally {
      setWhatsappBusy(null);
    }
  };

  const refreshWhatsAppBusiness = async () => {
    setWhatsappError(null);
    setWhatsappBusy('refresh');
    try {
      const response = await apiFetch<WhatsAppBusinessStatusResponse>(
        '/whatsapp-business/refresh',
        { method: 'POST' },
      );
      setWhatsappBusiness(response.connection);
    } catch (err) {
      setWhatsappError(errorMessage(err, t, 'whatsappBusiness.refreshFailed'));
    } finally {
      setWhatsappBusy(null);
    }
  };

  const checkWhatsAppBusiness = async () => {
    setWhatsappError(null);
    setWhatsappBusy('check');
    try {
      const response = await apiFetch<WhatsAppBusinessStatusResponse>(
        '/whatsapp-business/check',
        { method: 'POST' },
      );
      setWhatsappBusiness(response.connection);
    } catch (err) {
      setWhatsappError(errorMessage(err, t, 'whatsappBusiness.checkFailed'));
    } finally {
      setWhatsappBusy(null);
    }
  };

  const disconnectWhatsAppBusiness = async () => {
    setWhatsappError(null);
    setWhatsappBusy('disconnect');
    try {
      await apiFetch('/whatsapp-business/disconnect', { method: 'POST' });
      const response = await apiFetch<WhatsAppBusinessStatusResponse>('/whatsapp-business');
      setWhatsappBusiness(response.connection);
    } catch (err) {
      setWhatsappError(errorMessage(err, t, 'whatsappBusiness.disconnectFailed'));
    } finally {
      setWhatsappBusy(null);
    }
  };

  // Callback Meta kembali ke /integrations?whatsapp=… — tampilkan notice lalu
  // bersihkan query string agar refresh tidak menampilkannya lagi.
  useEffect(() => {
    const result = searchParams.get('whatsapp');
    if (!result) return;
    let notice: { ok: boolean; text: string } | null = null;
    if (result === 'connected') notice = { ok: true, text: t('whatsappBusiness.connectSuccess') };
    else if (result === 'already') notice = { ok: true, text: t('whatsappBusiness.connectAlready') };
    else if (result === 'error') notice = { ok: false, text: t('whatsappBusiness.connectError') };
    if (notice) {
      setWhatsappNotice(notice);
      void load();
      // Banner sukses halaman — konsisten dengan alur connect lainnya.
      if (result === 'connected' || result === 'already') {
        showConnectedNotice(t('whatsappBusiness.name'));
      }
    }
    setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams, t, load]);

  /** Badge status WhatsApp Business (variant + label) — kartu Integrations. */
  const whatsappStatusBadge = () => {
    switch (whatsappBusiness?.status ?? 'not_connected') {
      case 'connected':
        return { variant: 'success' as const, label: t('whatsappBusiness.statusConnected') };
      case 'connecting':
        return { variant: 'info' as const, label: t('whatsappBusiness.statusConnecting') };
      case 'error':
        return { variant: 'error' as const, label: t('whatsappBusiness.statusError') };
      case 'disconnected':
        return { variant: 'neutral' as const, label: t('whatsappBusiness.statusDisconnected') };
      default:
        return { variant: 'neutral' as const, label: t('whatsappBusiness.statusNotConnected') };
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
    showConnectedNotice(t('obsidian.name'));
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
      showConnectedNotice(t('notion.name'));
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
      showConnectedNotice(t('googleForms.name'));
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
    setTallyDialogOpen(true);
  };

  const closeTallyDialog = () => {
    setTallyDialogOpen(false);
    setTallyError(null);
  };

  /**
   * Connect: form booking Tally DI-GENERATE otomatis (sesuai industri
   * workspace) + webhook didaftarkan + integrasi terhubung — tanpa memilih
   * form. Satu langkah setelah API key ditempel.
   */
  const connectTally = async () => {
    setTallyError(null);
    setTallyConnecting(true);
    try {
      const workspace = useWorkspaceStore.getState().workspaces.find(
        (w) => w.id === workspaceId,
      );
      const response = await apiFetch<{ integration: WorkspaceIntegration }>(
        '/integrations/tally/generate',
        {
          method: 'POST',
          body: JSON.stringify({ apiKey: tallyApiKey.trim(), businessName: workspace?.name ?? null }),
          // Tally API lambat saat membuat form + mendaftarkan webhook —
          // default 10s terlalu sempit dan memicu abort ("Fetch is aborted").
          timeoutMs: 45_000,
        },
      );
      setTally(response.integration);
      setTallyDialogOpen(false);
      showConnectedNotice(t('tally.name'));
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

  /** Sinkronkan ulang konten form Tally — dropdown layanan ikut layanan terbaru. */
  const updateTallyContent = async () => {
    setTallyError(null);
    setTallyBusy('update-content');
    try {
      const response = await apiFetch<{ integration: WorkspaceIntegration }>(
        '/integrations/tally/update-content',
        { method: 'POST' },
      );
      setTally(response.integration);
      showConnectedNotice(t('tally.contentSynced'));
    } catch (err) {
      setTallyError(errorMessage(err, t, 'tally.syncServicesFailed'));
    } finally {
      setTallyBusy(null);
    }
  };

  // ── Auto-sync form Tally yang masih polos (sebelum fitur prefill/dropdown) ──
  // Saat halaman Integrations dibuka, form yang sudah terhubung tapi belum punya
  // hidden field `phone` / dropdown layanan (flags false, mis. terhubung sebelum
  // fitur ini ada) di-PATCH ulang otomatis agar ?phone= dan dropdown berfungsi.
  // Guard: maksimal sekali per kunjungan + 24 jam sejak percobaan terakhir, agar
  // Tally yang menolak payload tidak ditekan API setiap halaman dimuat.
  const tallyAutoSyncRan = useRef(false);
  useEffect(() => {
    if (tallyAutoSyncRan.current) return;
    const config = tally?.config;
    if (!tally || !config?.formId || !tally.isActive) return;
    if (config.prefillPhone && config.serviceDropdown) return; // form sudah lengkap
    const lastAttempt = config.lastContentSyncAt ? Date.parse(config.lastContentSyncAt) : 0;
    if (Number.isFinite(lastAttempt) && Date.now() - lastAttempt < 24 * 60 * 60 * 1000) return;
    tallyAutoSyncRan.current = true;
    void updateTallyContent();
  }, [tally, updateTallyContent]);

  /* ── Kirim form ke customer: buka dialog / cari kontak / kirim ── */

  const openSendForm = (type: 'google-forms') => {
    setSendFormType(type);
    setSendFormQuery('');
    setSendFormResults(null);
    setSendFormContactId('');
    setSendFormMessage(null);
    // Default channel: prioritas Telegram → Line → Email (chat dulu, email terakhir).
    const telegramActive = channels.some((ch) => ch.channelType === 'telegram' && ch.isActive);
    const lineActive = channels.some((ch) => ch.channelType === 'line' && ch.isActive);
    setSendFormChannel(telegramActive ? 'telegram' : lineActive ? 'line' : 'email');
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
      showConnectedNotice(t('googleCalendar.name'));
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
      showConnectedNotice(t('webhook.name'));
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
      showConnectedNotice(t('slack.name'));
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

  /* ── Telegram alerts: connect (bind link) / test / toggle / disconnect ── */

  const connectTelegramAlerts = async () => {
    setTelegramAlertsError(null);
    setTelegramAlertsConnecting(true);
    try {
      const response = await apiFetch<TelegramAlertsConnectResponse>(
        '/integrations/telegram-alerts/connect',
        { method: 'POST' },
      );
      setTelegramAlerts(response.integration);
      if (response.bindUrl) {
        // Buka tautan bind — user menekan Start pada bot lalu Refresh status.
        setTelegramAlertsBindHint(true);
        window.open(response.bindUrl, '_blank');
      }
    } catch (err) {
      setTelegramAlertsError(errorMessage(err, t, 'telegramAlerts.saveFailed'));
    } finally {
      setTelegramAlertsConnecting(false);
    }
  };

  const refreshTelegramAlerts = async () => {
    setTelegramAlertsError(null);
    try {
      const integrationRes = await apiFetch<IntegrationListResponse>('/integrations');
      setTelegramAlerts(
        integrationRes.integrations.find((item) => item.integrationType === 'telegram-alerts') ?? null,
      );
      setTelegramAlertsBindHint(false);
    } catch (err) {
      setTelegramAlertsError(errorMessage(err, t, 'telegramAlerts.saveFailed'));
    }
  };

  const testTelegramAlerts = async () => {
    setTelegramAlertsError(null);
    setTelegramAlertsTesting(true);
    try {
      await apiFetch('/integrations/telegram-alerts/test', { method: 'POST' });
      showConnectedNotice(t('telegramAlerts.testSent'));
    } catch (err) {
      setTelegramAlertsError(errorMessage(err, t, 'telegramAlerts.testFailed'));
    } finally {
      setTelegramAlertsTesting(false);
    }
  };

  const toggleTelegramAlertsActive = async () => {
    if (!telegramAlerts) return;
    setTelegramAlertsError(null);
    try {
      const response = await apiFetch<{ integration: WorkspaceIntegration }>(
        '/integrations/telegram-alerts',
        { method: 'PATCH', body: JSON.stringify({ isActive: !telegramAlerts.isActive }) },
      );
      setTelegramAlerts(response.integration);
    } catch (err) {
      setTelegramAlertsError(errorMessage(err, t, 'telegramAlerts.saveFailed'));
    }
  };

  const disconnectTelegramAlerts = async () => {
    setTelegramAlertsError(null);
    setTelegramAlertsBusy('disconnect');
    try {
      await apiFetch('/integrations/telegram-alerts', { method: 'DELETE' });
      setTelegramAlerts(null);
      setTelegramAlertsBindHint(false);
    } catch (err) {
      setTelegramAlertsError(errorMessage(err, t, 'telegramAlerts.saveFailed'));
    } finally {
      setTelegramAlertsBusy(null);
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
      // Label kartu Meta di-hardcode di CHANNEL_DEFS (belum ada kunci i18n).
      showConnectedNotice(metaDialogType === 'instagram' ? 'Instagram' : 'Facebook');
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
      showConnectedNotice(t('video.name'));
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
      showConnectedNotice(t('payments.name'));
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

      {/* Banner sukses — konfirmasi integrasi/channel terhubung. Dismissable,
          tanpa timeout: sukses connect layak terlihat sampai ditutup user. */}
      {integrationNotice && (
        <Banner
          status="success"
          title={integrationNotice}
          isDismissable
          onDismiss={() => setIntegrationNotice(null)}
        />
      )}

      {/* ── Messaging channels ─────────────────────────────── */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
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
                      <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{def.label}</h3>
                      {channel?.isEnvShared ? (
                        <Badge variant="neutral" label={t('channels.sharedEnvBadge')} />
                      ) : configured ? (
                        <Badge variant={active ? 'success' : 'neutral'} label={active ? t('channels.active') : t('channels.inactive')} />
                      ) : (
                        <Badge variant="neutral" label={t('channels.notSet')} />
                      )}
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{t(def.descriptionKey)}</p>
                  </div>
                </div>

                {setupError?.channel === def.type && (
                  <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-400">
                    {setupError.message}
                  </p>
                )}

                {/* Email selalu tersedia — tidak butuh konfigurasi. */}
                {def.type === 'email' && (
                  <div className="mt-4">
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      {t('channels.emailNote')}
                    </p>
                  </div>
                )}

                {channel?.isEnvShared ? (
                  <div className="mt-4 space-y-3">
                    <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">
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
                          : def.type === 'line'
                            ? t('channels.connectLine')
                            : t('channels.connectMeta')
                      }
                      variant="primary"
                      width="100%"
                      onClick={() => {
                        if (def.type === 'telegram') setSetupDialog('telegram');
                        else if (def.type === 'line') setSetupDialog('line');
                        else if (def.type === 'instagram' || def.type === 'facebook') openMetaDialog(def.type);
                      }}
                    />
                  </div>
                ) : configured && channel ? (
                  // Kartu Telegram/Line RINGKAS — switch aktif, re-register
                  // webhook & disconnect dipindah ke dialog. Di kartu hanya
                  // tombol Connected (membuka dialog).
                  def.type === 'telegram' || def.type === 'line' ? (
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

      {/* ── Channel yang butuh persetujuan platform ────────── */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
          {t('channels.comingSoonTitle')}
        </h2>
        <p className="mt-1 text-xs text-zinc-400">{t('channels.comingSoonDesc')}</p>

        <div className="mt-4 grid grid-cols-1 items-start gap-5 xl:grid-cols-3">
          {CHANNEL_COMING_SOON.map((def) => (
            <Card key={def.type} className="flex flex-col p-5">
              <div className="flex items-start gap-3">
                <span className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${def.accent}`}>
                  <def.icon className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{def.label}</h3>
                    <Badge variant="neutral" label={t('channels.unavailableBadge')} />
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{t(def.descriptionKey)}</p>
                </div>
              </div>

              {/* Syarat yang jujur — bukan tombol connect palsu. */}
              <div className="mt-4 rounded-lg border border-dashed border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-3 py-2.5">
                <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
                  <span className="font-medium text-zinc-700 dark:text-zinc-300">{t('channels.requiredLabel')}: </span>
                  {t(def.requirementKey)}
                </p>
              </div>
            </Card>
          ))}
        </div>
      </section>

      {/* ── App integrations ───────────────────────────────── */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
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
                  <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t('notion.name')}</h3>
                  {notion ? (
                    <Badge variant={notion.isActive ? 'success' : 'neutral'} label={notion.isActive ? t('notion.connected') : t('notion.notConnected')} />
                  ) : (
                    <Badge variant="neutral" label={t('channels.notSet')} />
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{t('notion.desc')}</p>
              </div>
            </div>

            {integrationError && (
              <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-400">
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
                  <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
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
                  <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t('obsidian.name')}</h3>
                  {obsidian ? (
                    <Badge variant="success" label={t('obsidian.connected')} />
                  ) : (
                    <Badge variant="neutral" label={t('channels.notSet')} />
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{t('obsidian.desc')}</p>
              </div>
            </div>

            {obsidianError && (
              <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-400">
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
                  <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
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
                  <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t('googleForms.name')}</h3>
                  {googleForms ? (
                    <Badge variant={googleForms.isActive ? 'success' : 'neutral'} label={googleForms.isActive ? t('googleForms.connected') : t('channels.inactive')} />
                  ) : (
                    <Badge variant="neutral" label={t('channels.notSet')} />
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{t('googleForms.desc')}</p>
              </div>
            </div>

            {formsError && (
              <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-400">
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
                  <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
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
                  <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t('tally.name')}</h3>
                  {tally ? (
                    <Badge variant={tally.isActive ? 'success' : 'neutral'} label={tally.isActive ? t('tally.connected') : t('channels.inactive')} />
                  ) : (
                    <Badge variant="neutral" label={t('channels.notSet')} />
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{t('tally.desc')}</p>
              </div>
            </div>

            {!tally ? (
              <Button
                label={t('tally.connect')}
                variant="primary"
                width="100%"
                className="mt-4"
                onClick={openTallyDialog}
              />
            ) : (
              <Button
                label={t('tally.configure')}
                variant="primary"
                width="100%"
                className="mt-4"
                icon={<IconSettings className="size-3.5" />}
                onClick={openTallyDialog}
              />
            )}
          </Card>

          {/* Google Calendar — booking → event kalender. */}
          <Card className="flex flex-col p-5">
            <div className="flex items-start gap-3">
              <BrandLogo src="/brands/google-calendar.svg" alt={t('googleCalendar.name')} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t('googleCalendar.name')}</h3>
                  {googleCalendar ? (
                    <Badge variant={googleCalendar.isActive ? 'success' : 'neutral'} label={googleCalendar.isActive ? t('googleCalendar.connected') : t('channels.inactive')} />
                  ) : (
                    <Badge variant="neutral" label={t('channels.notSet')} />
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{t('googleCalendar.desc')}</p>
              </div>
            </div>

            {calendarError && (
              <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-400">
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
                  <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
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
                  <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t('webhook.name')}</h3>
                  {webhook ? (
                    <Badge variant={webhook.isActive ? 'success' : 'neutral'} label={webhook.isActive ? t('webhook.connected') : t('channels.inactive')} />
                  ) : (
                    <Badge variant="neutral" label={t('channels.notSet')} />
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{t('webhook.desc')}</p>
              </div>
            </div>

            {webhookError && (
              <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-400">
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
                  <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
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
                  <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t('slack.name')}</h3>
                  {slack ? (
                    <Badge variant={slack.isActive ? 'success' : 'neutral'} label={slack.isActive ? t('slack.connected') : t('channels.inactive')} />
                  ) : (
                    <Badge variant="neutral" label={t('channels.notSet')} />
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{t('slack.desc')}</p>
              </div>
            </div>

            {slackError && (
              <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-400">
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
                  <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
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

          {/* Telegram Booking Alerts — notifikasi booking ke chat bisnis
              (deep-link bind: t.me/<bot>?start=oriole_<token> → Start). */}
          <Card className="flex flex-col p-5">
            <div className="flex items-start gap-3">
              <BrandLogo src="/brands/telegram.svg" alt={t('telegramAlerts.name')} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t('telegramAlerts.name')}</h3>
                  {telegramAlerts ? (
                    telegramAlerts.config.bound ? (
                      <Badge
                        variant={telegramAlerts.isActive ? 'success' : 'neutral'}
                        label={telegramAlerts.isActive ? t('telegramAlerts.bound') : t('channels.inactive')}
                      />
                    ) : (
                      <Badge variant="neutral" label={t('telegramAlerts.awaiting')} />
                    )
                  ) : (
                    <Badge variant="neutral" label={t('channels.notSet')} />
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{t('telegramAlerts.desc')}</p>
              </div>
            </div>

            {telegramAlertsError && (
              <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-400">
                {telegramAlertsError}
              </p>
            )}

            {!telegramAlerts ? (
              <Button
                label={t('telegramAlerts.connect')}
                variant="primary"
                width="100%"
                className="mt-4"
                isLoading={telegramAlertsConnecting}
                onClick={() => void connectTelegramAlerts()}
              />
            ) : (
              <div className="mt-4 space-y-3">
                {telegramAlertsBindHint && (
                  <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">
                    {t('telegramAlerts.bindHint')}
                  </p>
                )}

                {telegramAlerts.config.bound && telegramAlerts.config.chatName && (
                  <p className="rounded-lg bg-zinc-50 dark:bg-zinc-900 px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400">
                    {t('telegramAlerts.boundChat', { chat: telegramAlerts.config.chatName })}
                  </p>
                )}

                <Switch
                  label={t('telegramAlerts.activeSwitch')}
                  description={telegramAlerts.isActive ? t('telegramAlerts.activeDesc') : t('telegramAlerts.inactiveDesc')}
                  value={telegramAlerts.isActive}
                  onChange={() => void toggleTelegramAlertsActive()}
                  labelPosition="start"
                  labelSpacing="spread"
                />

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    label={t('telegramAlerts.test')}
                    variant="primary"
                    size="sm"
                    icon={<IconSend className="size-3.5" />}
                    isLoading={telegramAlertsTesting}
                    isDisabled={telegramAlertsTesting || !telegramAlerts.isActive || !telegramAlerts.config.bound}
                    onClick={() => void testTelegramAlerts()}
                  />
                  <Button
                    label={telegramAlerts.config.bound ? t('telegramAlerts.changeChat') : t('telegramAlerts.retryBind')}
                    variant="secondary"
                    size="sm"
                    icon={<IconSettings className="size-3.5" />}
                    isLoading={telegramAlertsConnecting}
                    isDisabled={telegramAlertsConnecting}
                    onClick={() => void connectTelegramAlerts()}
                  />
                  <Button
                    label={t('telegramAlerts.refresh')}
                    variant="ghost"
                    size="sm"
                    icon={<IconRefresh className="size-3.5" />}
                    onClick={() => void refreshTelegramAlerts()}
                  />
                  <Button
                    label={t('telegramAlerts.disconnect')}
                    variant="ghost"
                    size="sm"
                    icon={<IconTrash className="size-3.5" />}
                    isLoading={telegramAlertsBusy === 'disconnect'}
                    isDisabled={telegramAlertsBusy !== null}
                    onClick={() => void disconnectTelegramAlerts()}
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
                  <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t('video.name')}</h3>
                  {video ? (
                    <Badge variant={video.isActive ? 'success' : 'neutral'} label={video.isActive ? t('video.connected') : t('channels.inactive')} />
                  ) : (
                    <Badge variant="neutral" label={t('channels.notSet')} />
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{t('video.desc')}</p>
              </div>
            </div>

            {videoError && (
              <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-400">
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
                  <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t('payments.name')}</h3>
                  {payments ? (
                    <Badge variant={payments.isActive ? 'success' : 'neutral'} label={payments.isActive ? t('payments.connected') : t('channels.inactive')} />
                  ) : (
                    <Badge variant="neutral" label={t('channels.notSet')} />
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{t('payments.desc')}</p>
              </div>
            </div>

            {paymentsError && (
              <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-400">
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

          {/* WhatsApp Business — Meta Embedded Signup (Tech Provider). Setiap
              tenant menghubungkan NOMOR mereka sendiri lewat flow resmi Meta;
              token/WABA ID/Phone Number ID tidak pernah sampai ke frontend. */}
          <Card className="flex flex-col p-5">
            <div className="flex items-start gap-3">
              <BrandLogo src="/brands/whatsapp.svg" alt={t('whatsappBusiness.name')} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t('whatsappBusiness.name')}</h3>
                  <Badge
                    variant={whatsappStatusBadge().variant}
                    label={whatsappStatusBadge().label}
                  />
                </div>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{t('whatsappBusiness.desc')}</p>
              </div>
            </div>

            {whatsappNotice && (
              <p
                role="status"
                className={`mt-3 rounded-lg px-3 py-2 text-xs ${whatsappNotice.ok ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400' : 'bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-400'}`}
              >
                {whatsappNotice.text}
              </p>
            )}

            {whatsappError && (
              <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-400">
                {whatsappError}
              </p>
            )}

            {whatsappBusiness?.platformConfigured === false && (
              <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">
                {t('whatsappBusiness.platformNotConfigured')}
              </p>
            )}

            {/* Detail akun — hanya saat terhubung. */}
            {whatsappBusiness?.status === 'connected' && (
              <div className="mt-4 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-3 py-2.5">
                <div className="space-y-1.5">
                  <DetailRow
                    label={t('whatsappBusiness.numberLabel')}
                    value={whatsappBusiness.displayPhoneNumber ?? '—'}
                  />
                  <DetailRow
                    label={t('whatsappBusiness.businessLabel')}
                    value={whatsappBusiness.businessName ?? '—'}
                  />
                  <DetailRow
                    label={t('whatsappBusiness.aiLabel')}
                    value={whatsappBusiness.aiAssistantEnabled ? t('whatsappBusiness.aiOn') : t('whatsappBusiness.aiOff')}
                  />
                  {whatsappBusiness.lastSyncAt && (
                    <DetailRow
                      label={t('whatsappBusiness.lastSync')}
                      value={formatDateTime(whatsappBusiness.lastSyncAt)}
                    />
                  )}
                </div>
              </div>
            )}

            {(() => {
              const status = whatsappBusiness?.status ?? 'not_connected';
              if (status === 'connected') {
                return (
                  <div className="mt-4 space-y-3">
                    <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{t('whatsappBusiness.connectedHint')}</p>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        label={t('whatsappBusiness.refresh')}
                        variant="ghost"
                        size="sm"
                        icon={<IconRefresh className="size-3.5" />}
                        isLoading={whatsappBusy === 'refresh'}
                        isDisabled={whatsappBusy !== null}
                        onClick={() => void refreshWhatsAppBusiness()}
                      />
                      <Button
                        label={t('whatsappBusiness.check')}
                        variant="ghost"
                        size="sm"
                        isDisabled={whatsappBusy !== null}
                        onClick={() => void checkWhatsAppBusiness()}
                      />
                      <Button
                        label={t('whatsappBusiness.disconnect')}
                        variant="ghost"
                        size="sm"
                        icon={<IconTrash className="size-3.5" />}
                        isLoading={whatsappBusy === 'disconnect'}
                        isDisabled={whatsappBusy !== null}
                        onClick={() => void disconnectWhatsAppBusiness()}
                      />
                    </div>
                  </div>
                );
              }
              if (status === 'connecting') {
                return (
                  <div className="mt-4 space-y-3">
                    <p className="rounded-lg bg-blue-50 px-3 py-2 text-xs leading-relaxed text-blue-700">
                      {t('whatsappBusiness.connectingHint')}
                    </p>
                    <Button
                      label={t('whatsappBusiness.retry')}
                      variant="primary"
                      width="100%"
                      isLoading={whatsappBusy === 'connect'}
                      isDisabled={whatsappBusy !== null}
                      onClick={() => void connectWhatsAppBusiness()}
                    />
                  </div>
                );
              }
              if (status === 'error') {
                return (
                  <div className="mt-4 space-y-3">
                    <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{t('whatsappBusiness.errorHint')}</p>
                    {whatsappBusiness?.errorMessage && (
                      <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-400">
                        {whatsappBusiness.errorMessage}
                      </p>
                    )}
                    <Button
                      label={t('whatsappBusiness.reconnect')}
                      variant="primary"
                      width="100%"
                      isLoading={whatsappBusy === 'connect'}
                      isDisabled={whatsappBusy !== null}
                      onClick={() => void connectWhatsAppBusiness()}
                    />
                  </div>
                );
              }
              if (status === 'disconnected') {
                return (
                  <div className="mt-4 space-y-3">
                    <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{t('whatsappBusiness.disconnectedHint')}</p>
                    <Button
                      label={t('whatsappBusiness.reconnect')}
                      variant="primary"
                      width="100%"
                      isLoading={whatsappBusy === 'connect'}
                      isDisabled={whatsappBusy !== null}
                      onClick={() => void connectWhatsAppBusiness()}
                    />
                  </div>
                );
              }
              // not_connected
              return (
                <div className="mt-4 space-y-3">
                  <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{t('whatsappBusiness.notConnectedHint')}</p>
                  <Button
                    label={t('whatsappBusiness.connect')}
                    variant="primary"
                    width="100%"
                    icon={<IconCheck className="size-3.5" />}
                    isLoading={whatsappBusy === 'connect'}
                    isDisabled={whatsappBusiness?.platformConfigured === false}
                    onClick={() => void connectWhatsAppBusiness()}
                  />
                </div>
              );
            })()}
          </Card>
        </div>
      </section>

      {/* Dialog kelola payment link — dibuka dari kartu Payments. */}
      <PaymentsDialog
        isOpen={paymentsDialogOpen}
        onOpenChange={setPaymentsDialogOpen}
      />

      {/* Dialog setup Telegram — input bot token tidak tampil inline di kartu,
          hanya di dalam dialog ini. */}
      <Dialog
        isOpen={setupDialog === 'telegram'}
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

      {/* Dialog setup Line — channel access token + channel secret dari
          Line Developers Console (Messaging API, bukan LINE Login). */}
      <Dialog
        isOpen={setupDialog === 'line'}
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
                channelRow('line')
                  ? t('channels.settingsTitle')
                  : t('channels.connectLine')
              }
              subtitle={
                channelRow('line')
                  ? t('channels.lineDesc')
                  : t('channels.lineSetupSubtitle')
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
                const line = channelRow('line');
                if (!line) {
                  return (
                    <form id="line-setup-form" onSubmit={setupLineChannel} className="space-y-3">
                      <TextInput
                        label={t('channels.lineAccessToken')}
                        value={lineAccessToken}
                        onChange={setLineAccessToken}
                        placeholder={t('channels.lineAccessTokenPlaceholder')}
                        width="100%"
                      />
                      <TextInput
                        label={t('channels.lineChannelSecret')}
                        value={lineChannelSecret}
                        onChange={setLineChannelSecret}
                        placeholder={t('channels.lineChannelSecretPlaceholder')}
                        width="100%"
                      />
                      <a
                        href="https://developers.line.biz/console/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 transition hover:text-emerald-500"
                      >
                        <IconPlug className="size-3.5" />
                        {t('channels.lineConsole')}
                      </a>
                      <p className="rounded-lg bg-zinc-50 dark:bg-zinc-900 px-3 py-2 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                        {t('channels.lineHint')}
                      </p>
                      {setupError?.channel === 'line' && (
                        <p role="alert" className="text-xs text-red-600">{setupError.message}</p>
                      )}
                    </form>
                  );
                }
                return (
                  <div className="space-y-3">
                    <Switch
                      label={t('channels.activeSwitch')}
                      description={line.isActive ? t('channels.activeDesc') : t('channels.inactiveDesc')}
                      value={line.isActive}
                      onChange={() => void toggleChannel(line)}
                      isDisabled={busyChannel === 'line'}
                      labelPosition="start"
                      labelSpacing="spread"
                    />

                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        label={t('channels.rewebhook')}
                        variant="ghost"
                        size="sm"
                        icon={<IconRefresh className="size-3.5" />}
                        isDisabled={busyChannel === 'line'}
                        isLoading={busyChannel === 'line'}
                        onClick={() => void rewebhookLine()}
                      />
                      <Button
                        label={t('channels.disconnect')}
                        variant="ghost"
                        size="sm"
                        icon={<IconTrash className="size-3.5" />}
                        isDisabled={busyChannel === 'line'}
                        onClick={() => void removeChannel('line')}
                      />
                    </div>

                    {setupError?.channel === 'line' && (
                      <p role="alert" className="text-xs text-red-600">{setupError.message}</p>
                    )}
                  </div>
                );
              })()}
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              {channelRow('line') ? (
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
                    label={t('channels.connectLine')}
                    variant="primary"
                    type="submit"
                    form="line-setup-form"
                    isLoading={busyChannel === 'line'}
                    isDisabled={
                      lineAccessToken.trim().length < 10 || lineChannelSecret.trim().length < 8
                    }
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
                    <p className="rounded-lg bg-zinc-50 dark:bg-zinc-900 px-3 py-2 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                      {t('notion.howTo')}
                    </p>
                    {integrationError && (
                      <p role="alert" className="text-xs text-red-600">{integrationError}</p>
                    )}
                  </form>
                ) : notionDatabases.length === 0 ? (
                  <div>
                    <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">
                      {t('notion.noDatabases')}
                    </p>
                    {integrationError && (
                      <p role="alert" className="mt-2 text-xs text-red-600">{integrationError}</p>
                    )}
                  </div>
                ) : (
                  <div>
                    <p className="mb-2 text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('notion.stepDatabases')}</p>
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
                                ? 'border-amber-400 bg-amber-50/70 ring-2 ring-amber-500/15 dark:bg-amber-950/40 dark:ring-amber-500/25'
                                : 'border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:border-zinc-300 dark:hover:border-zinc-600'
                            }`}
                          >
                            <BrandLogo
                              src="/brands/notion.svg"
                              alt=""
                              chip={`size-8 rounded-lg shadow-none ${selected ? 'bg-amber-50 ring-1 ring-amber-400' : 'bg-white dark:bg-zinc-900 ring-1 ring-zinc-200'}`}
                              img="size-5"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{db.title}</span>
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
                <p className="rounded-lg bg-zinc-50 dark:bg-zinc-900 px-3 py-2 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                  {t('obsidian.howTo')}
                </p>
                {obsidianTested && (
                  <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
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
                    <p className="rounded-lg bg-zinc-50 dark:bg-zinc-900 px-3 py-2 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                      {t('googleForms.howTo')}
                    </p>
                    {formsError && (
                      <p role="alert" className="text-xs text-red-600">{formsError}</p>
                    )}
                  </form>
                ) : (
                  <div className="space-y-3">
                    <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-medium leading-relaxed text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
                      {t('googleForms.formFound', { title: formsPreview.form.title })}
                    </p>
                    <div>
                      <p className="mb-2 text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('googleForms.questionsLabel')}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {formsPreview.form.questions.map((question) => (
                          <span key={question.id} className="rounded-md bg-zinc-100 dark:bg-zinc-800 px-2 py-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
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
              title={tally ? t('tally.manageTitle') : t('tally.dialogTitle')}
              subtitle={tally ? t('tally.manageSubtitle') : t('tally.dialogSubtitle')}
              onOpenChange={(open) => {
                if (!open) closeTallyDialog();
              }}
              // Logo resmi Tally (mark) — polos tanpa chip/ring; hanya ukuran
              // layout karena SVG intrinsik 128px.
              startContent={<img src="/brands/tally.svg" alt="" className="h-8 w-auto shrink-0" />}
              hasDivider
            />
          }
          content={
            <LayoutContent>
              <div className="space-y-5">
                {/* Migrasi Typeform → Tally: ingatkan hubungkan ulang. */}
                {tally?.config.migratedFrom === 'typeform' && (
                  <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">
                    {t('tally.migratedNotice')}
                  </p>
                )}

                {tally ? (
                  <div className="space-y-5">
                    <Switch
                      label={t('tally.activeSwitch')}
                      description={tally.isActive ? t('tally.activeDesc') : t('tally.inactiveDesc')}
                      value={tally.isActive}
                      onChange={() => void toggleTallyActive()}
                      labelPosition="start"
                      labelSpacing="spread"
                    />

                    {/* Diagnostik: sinkronisasi form / konfirmasi customer gagal —
                        jangan "diam tanpa kabar". */}
                    {tally.config.lastConfirmationError || tally.config.lastContentSyncError ? (
                      <p
                        role="alert"
                        className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:bg-amber-950/40 dark:text-amber-400"
                      >
                        {tally.config.lastConfirmationError
                          ? t('tally.confirmationError', {
                              error: tally.config.lastConfirmationError,
                            })
                          : t('tally.contentSyncError', {
                              error: tally.config.lastContentSyncError ?? '',
                            })}
                      </p>
                    ) : null}

                    <div className="flex flex-wrap items-center gap-2">
                      {tally.config.formId && (
                        <Button
                          label={t('tally.syncServices')}
                          variant="secondary"
                          size="sm"
                          icon={<IconRefresh className="size-3.5" />}
                          isLoading={tallyBusy === 'update-content'}
                          isDisabled={tallyBusy !== null || !tally.isActive}
                          onClick={() => void updateTallyContent()}
                        />
                      )}
                      <Button
                        label={t('tally.rewebhook')}
                        variant="secondary"
                        size="sm"
                        icon={<IconRefresh className="size-3.5" />}
                        isLoading={tallyBusy === 'rewebhook'}
                        isDisabled={tallyBusy !== null || !tally.isActive}
                        onClick={() => void rewebhookTally()}
                      />
                      <Button
                        label={t('tally.disconnect')}
                        variant="destructive"
                        size="sm"
                        icon={<IconTrash className="size-3.5" />}
                        isLoading={tallyBusy === 'disconnect'}
                        isDisabled={tallyBusy !== null}
                        onClick={() => void disconnectTally()}
                      />
                    </div>
                  </div>
                ) : (
                  <form
                    id="tally-key-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void connectTally();
                    }}
                    className="space-y-3"
                  >
                    <div>
                      {/* Label "API Key" + pintasan "Get your API key" (ikon
                          arrow-square-out) di ujung kanan label. */}
                      <div className="mb-1.5 flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
                          {t('tally.tokenLabel')}
                        </span>
                        <a
                          href="https://tally.so/settings/api-keys"
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={t('tally.getKey')}
                          title={t('tally.getKey')}
                          className="rounded-md p-1 text-zinc-400 transition hover:bg-amber-50 hover:text-amber-600 dark:hover:bg-amber-950/40"
                        >
                          <IconExternalLink className="size-4" />
                        </a>
                      </div>
                      <TextInput
                        label={t('tally.tokenLabel')}
                        isLabelHidden
                        value={tallyApiKey}
                        onChange={setTallyApiKey}
                        placeholder={t('tally.tokenPlaceholder')}
                        width="100%"
                      />
                    </div>
                  </form>
                )}

                {tallyError && (
                  <div role="alert" className="flex items-center justify-between gap-3 rounded-lg bg-red-50 px-3 py-2 dark:bg-red-500/10">
                    <p className="min-w-0 flex-1 text-xs text-red-600 dark:text-red-400">{tallyError}</p>
                    {!tally && (
                      <Button
                        label={t('common.retry')}
                        variant="ghost"
                        size="sm"
                        isDisabled={tallyConnecting}
                        onClick={() => void connectTally()}
                      />
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
                {!tally && (
                  <Button
                    label={t('tally.connect')}
                    variant="primary"
                    type="submit"
                    form="tally-key-form"
                    isLoading={tallyConnecting}
                    isDisabled={tallyApiKey.trim().length < 10 || tallyConnecting}
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
                    <p className="rounded-lg bg-zinc-50 dark:bg-zinc-900 px-3 py-2 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                      {t('googleCalendar.howTo')}
                    </p>
                    {calendarError && (
                      <p role="alert" className="text-xs text-red-600">{calendarError}</p>
                    )}
                  </form>
                ) : calendars.length === 0 ? (
                  <div>
                    <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">
                      {t('googleCalendar.noCalendars')}
                    </p>
                    {calendarError && (
                      <p role="alert" className="mt-2 text-xs text-red-600">{calendarError}</p>
                    )}
                  </div>
                ) : (
                  <div>
                    <p className="mb-2 text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('googleCalendar.stepCalendars')}</p>
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
                                ? 'border-amber-400 bg-amber-50/70 ring-2 ring-amber-500/15 dark:bg-amber-950/40 dark:ring-amber-500/25'
                                : 'border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:border-zinc-300 dark:hover:border-zinc-600'
                            }`}
                          >
                            <BrandLogo
                              src="/brands/google-calendar.svg"
                              alt=""
                              chip={`size-8 rounded-lg shadow-none ${selected ? 'bg-amber-50 ring-1 ring-amber-400' : 'bg-white dark:bg-zinc-900 ring-1 ring-zinc-200'}`}
                              img="size-5"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{calendar.summary}</span>
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
                <p className="rounded-lg bg-zinc-50 dark:bg-zinc-900 px-3 py-2 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
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
                  <div className="rounded-lg bg-emerald-50 px-3 py-2 dark:bg-emerald-950/40">
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

                <p className="rounded-lg bg-zinc-50 dark:bg-zinc-900 px-3 py-2 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
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
                  <p className="rounded-lg bg-zinc-50 dark:bg-zinc-900 px-3 py-2 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
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
                  <p className="rounded-lg bg-zinc-50 dark:bg-zinc-900 px-3 py-2 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
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
                form: googleForms?.identifier ?? t('googleForms.name'),
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
                  <div className="mt-1 flex items-center gap-1.5 rounded-lg bg-zinc-50 dark:bg-zinc-900 p-2">
                    <p className="min-w-0 flex-1 break-all font-mono text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                      {googleForms?.config.formUrl ?? '—'}
                    </p>
                    <button
                      type="button"
                      onClick={() =>
                        void copyFormUrl(googleForms?.config.formUrl ?? '')
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
                              ? 'border-amber-500 bg-amber-50/60 dark:bg-amber-950/40'
                              : 'border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-900'
                          }`}
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium text-zinc-800 dark:text-zinc-200">
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
                    {channels.some((ch) => ch.channelType === 'line' && ch.isActive) && (
                      <DropdownMenuItem
                        label={t('channels.line')}
                        onClick={() => setSendFormChannel('line')}
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
                      sendFormMessage.ok ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400' : 'bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-400'
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
