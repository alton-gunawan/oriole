import { useEffect, useState, type ComponentType } from 'react';
import {
  Button,
  Dialog,
  DialogHeader,
  DropdownMenu,
  DropdownMenuItem,
  Layout,
  LayoutContent,
  LayoutFooter,
  NumberInput,
  Switch,
  TextInput,
  useToast,
  type DropdownMenuOption,
} from '@astryxdesign/core';
import { Trans, useTranslation } from 'react-i18next';

import i18n, { type SupportedLocale } from '../../i18n';
import { apiFetch } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { applyAnalyticsConsent, isAnalyticsEnabled } from '../../lib/analytics';
import { browserTimezone, TIMEZONE_CURATED, timezoneLabel } from '../../lib/timezones';
import { callLanguageLabel, VOICE_OPTIONS, voiceLabel } from '../../lib/voice';
import type { Workspace } from '../../lib/workspace';
import { deleteUserAccount } from '../../lib/session';
import { useConsentStore } from '../../stores/consent';
import { useSessionStore } from '../../stores/session';
import { useWorkspaceStore } from '../../stores/workspace';
import type { TranslationKey } from '../../i18n';
import { WorkspaceAvatar } from '../components/WorkspaceAvatar';
import { LANGUAGE_OPTIONS } from './LocaleSwitcher';
import { BillingPanel } from './BillingPanel';
import { InboundNumberPanel } from './phone/InboundNumberPanel';
import { PhoneNumberPanel } from './phone/PhoneNumberPanel';
import { ConfirmDialog } from './ui';
import {
  IconBell,
  IconBuildings,
  IconCheck,
  IconChevronDown,
  IconCreditCard,
  IconGlobe,
  IconPhone,
  IconSettings,
  IconShield,
  IconTrash,
  IconUser,
  type IconProps,
} from './icons';

export type SettingsSectionId =
  | 'profile'
  | 'preferences'
  | 'billing'
  | 'voice'
  | 'notifications'
  | 'businesses'
  | 'privacy';

/** Bagian dalam dialog Settings — ditampilkan di sidebar kiri dialog. */
const SECTIONS: {
  id: SettingsSectionId;
  labelKey: TranslationKey;
  icon: ComponentType<IconProps>;
}[] = [
  { id: 'profile', labelKey: 'settings.profile', icon: IconUser },
  { id: 'preferences', labelKey: 'settings.preferences', icon: IconGlobe },
  { id: 'billing', labelKey: 'settings.billing', icon: IconCreditCard },
  { id: 'voice', labelKey: 'settings.voice', icon: IconPhone },
  { id: 'notifications', labelKey: 'settings.notifications', icon: IconBell },
  { id: 'privacy', labelKey: 'consent.privacy', icon: IconShield },
  { id: 'businesses', labelKey: 'settings.businesses', icon: IconBuildings },
];

/** Bahasa panggilan — opsi dropdown Voice AI. */
const CALL_LANGUAGE_OPTIONS = [
  { value: 'en' as const, label: 'English' },
  { value: 'id' as const, label: 'Bahasa Indonesia' },
];

/** Grup zona waktu per region — judul section di dropdown Settings. */
const TIMEZONE_GROUPS: { title: string; zones: string[] }[] = [
  { title: 'UTC', zones: ['UTC'] },
  { title: 'Asia', zones: TIMEZONE_CURATED.filter((zone) => zone.startsWith('Asia/')) },
  { title: 'Europe', zones: TIMEZONE_CURATED.filter((zone) => zone.startsWith('Europe/')) },
  { title: 'Americas', zones: TIMEZONE_CURATED.filter((zone) => zone.startsWith('America/')) },
  {
    title: 'Australia & Pacific',
    zones: TIMEZONE_CURATED.filter(
      (zone) => zone.startsWith('Australia/') || zone.startsWith('Pacific/'),
    ),
  },
];

/** Dropdown pilihan bahasa — trigger menampilkan flag + kode, centang pada aktif. */
function LanguageDropdown({
  value,
  onSelect,
}: {
  value: SupportedLocale;
  onSelect: (code: SupportedLocale) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = LANGUAGE_OPTIONS.find((option) => option.code === value) ?? LANGUAGE_OPTIONS[0];
  return (
    <DropdownMenu
      placement="below"
      hasChevron={false}
      menuWidth={190}
      isMenuOpen={open}
      onOpenChange={setOpen}
      button={{
        label: current.label,
        variant: 'secondary',
        size: 'sm',
        children: (
          <span className="max-w-44 truncate text-base font-semibold text-zinc-600 dark:text-zinc-400">
            {current.label}
          </span>
        ),
        endContent: (
          <IconChevronDown
            className={`size-3 shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''} text-zinc-400`}
          />
        ),
      }}
    >
      {LANGUAGE_OPTIONS.map((option) => {
        const selected = option.code === value;
        return (
          <DropdownMenuItem
            key={option.code}
            label={option.label}
            onClick={() => onSelect(option.code)}
            endContent={selected ? <IconCheck className="size-3.5 text-amber-500" /> : undefined}
          />
        );
      })}
    </DropdownMenu>
  );
}

/** Dropdown bahasa panggilan Voice AI (en / id) — opsi backend nyata. */
function VoiceLanguageDropdown({
  value,
  onSelect,
}: {
  value: 'en' | 'id';
  onSelect: (code: 'en' | 'id') => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu
      placement="below"
      hasChevron={false}
      menuWidth={200}
      isMenuOpen={open}
      onOpenChange={setOpen}
      button={{
        label: callLanguageLabel(value),
        variant: 'secondary',
        size: 'sm',
        children: (
          <span className="flex w-44 items-center justify-between gap-2 text-base font-semibold text-zinc-600 dark:text-zinc-400">
            <span className="truncate">{callLanguageLabel(value)}</span>
            <IconChevronDown
              className={`size-3 shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''} text-zinc-400`}
            />
          </span>
        ),
      }}
    >
      {CALL_LANGUAGE_OPTIONS.map((option) => (
        <DropdownMenuItem
          key={option.value}
          label={option.label}
          onClick={() => onSelect(option.value)}
          endContent={option.value === value ? <IconCheck className="size-3.5 text-amber-500" /> : undefined}
        />
      ))}
    </DropdownMenu>
  );
}

/** Dropdown suara asisten Voice AI — opsi kurasi ElevenLabs (ID nyata). */
function VoiceDropdown({
  value,
  onSelect,
}: {
  value: string;
  onSelect: (voiceId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu
      placement="below"
      hasChevron={false}
      menuWidth={220}
      isMenuOpen={open}
      onOpenChange={setOpen}
      button={{
        label: voiceLabel(value),
        variant: 'secondary',
        size: 'sm',
        children: (
          <span className="flex w-44 items-center justify-between gap-2 text-base font-semibold text-zinc-600 dark:text-zinc-400">
            <span className="truncate">{voiceLabel(value)}</span>
            <IconChevronDown
              className={`size-3 shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''} text-zinc-400`}
            />
          </span>
        ),
      }}
    >
      {VOICE_OPTIONS.map((option) => (
        <DropdownMenuItem
          key={option.value}
          label={option.label}
          onClick={() => onSelect(option.value)}
          endContent={option.value === value ? <IconCheck className="size-3.5 text-amber-500" /> : undefined}
        />
      ))}
    </DropdownMenu>
  );
}

/**
 * Dropdown zona waktu — item "Auto" (null = ikuti browser) + zona kurasi
 * dikelompokkan per region. Mode data Astryx (items + sections).
 */
function TimezoneDropdown({
  value,
  onSelect,
  autoLabel,
}: {
  value: string | null;
  onSelect: (zone: string | null) => void;
  autoLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const check = (selected: boolean) =>
    selected ? <IconCheck className="size-3.5 text-amber-500" /> : undefined;
  const items: DropdownMenuOption[] = [
    { label: autoLabel, onClick: () => onSelect(null), icon: check(value === null) },
    { type: 'divider' },
    ...TIMEZONE_GROUPS.map((group) => ({
      type: 'section' as const,
      title: group.title,
      items: group.zones.map((zone) => ({
        label: timezoneLabel(zone),
        onClick: () => onSelect(zone),
        icon: check(value === zone),
      })),
    })),
  ];
  const display = value ? timezoneLabel(value) : autoLabel;
  return (
    <DropdownMenu
      placement="below"
      hasChevron={false}
      menuWidth={300}
      isMenuOpen={open}
      onOpenChange={setOpen}
      items={items}
      button={{
        label: display,
        variant: 'secondary',
        size: 'sm',
        children: (
          <span className="max-w-44 truncate text-base font-semibold text-zinc-600 dark:text-zinc-400">
            {display}
          </span>
        ),
        endContent: (
          <IconChevronDown
            className={`size-3 shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''} text-zinc-400`}
          />
        ),
      }}
    />
  );
}

/**
 * Dialog Settings — pengganti halaman /app/settings dan dialog profil lama.
 * Sidebar kiri di dalam dialog berpindah antar bagian: Profil dan Notifikasi.
 * Dibuka dari menu sidebar ("Settings") maupun dropdown akun di footer
 * sidebar. Mengikuti template dialog Layout: header tetap, konten scroll,
 * footer aksi selalu terlihat.
 */
export function SettingsDialog({
  isOpen,
  onOpenChange,
  initialSection = 'profile',
}: {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => unknown;
  initialSection?: SettingsSectionId;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const user = useSessionStore((s) => s.user);
  const setUser = useSessionStore((s) => s.setUser);
  const [name, setName] = useState(user?.name ?? '');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bagian aktif dialog.
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(initialSection);
  // Preferensi — bahasa (ikut i18n aktif) + zona waktu (default browser).
  const [prefLanguage, setPrefLanguage] = useState<SupportedLocale>(() =>
    (i18n.resolvedLanguage as SupportedLocale) ?? 'en',
  );
  // null = Auto (ikuti zona waktu browser).
  const [prefTimezone, setPrefTimezone] = useState<string | null>(user?.timezone ?? null);
  // ── Voice AI — pengaturan workspace (Section B & C) ───────
  const [voiceName, setVoiceName] = useState('Sarah');
  const [voiceLanguage, setVoiceLanguage] = useState<'en' | 'id'>('en');
  const [voiceId, setVoiceId] = useState('');
  const [autoCallEnabled, setAutoCallEnabled] = useState(false);
  const [autoCallLeadHours, setAutoCallLeadHours] = useState(24);
  const [maxCallAttempts, setMaxCallAttempts] = useState(2);
  // Privasi — consent replay/survei (sync dengan stores/consent + PostHog).
  const replayConsent = useConsentStore((s) => s.replayConsent);
  const setReplayConsent = useConsentStore((s) => s.setReplayConsent);
  // Notifikasi — state lokal (placeholder; belum ada API persist).
  const [notif, setNotif] = useState({ email: true, call: false, weekly: true });

  // ── Hapus bisnis (soft-delete, permanen setelah 3 hari) ──
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const updateWorkspace = useWorkspaceStore((s) => s.updateWorkspace);
  const removeWorkspace = useWorkspaceStore((s) => s.removeWorkspace);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // ── Hapus akun pengguna (permanen) ──
  // Error ditampilkan via toast (astryx Toast), bukan inline di dialog.
  const [confirmDeleteUserOpen, setConfirmDeleteUserOpen] = useState(false);
  const [isDeletingUser, setIsDeletingUser] = useState(false);

  // Segarkan form setiap dialog dibuka (nama bisa berubah dari luar),
  // bersihkan error lama, dan set bagian aktif.
  useEffect(() => {
    if (isOpen) {
      setName(user?.name ?? '');
      setError(null);
      setDeleteError(null);
      setConfirmDeleteUserOpen(false);
      setConfirmDeleteId(null);
      setActiveSection(initialSection);
      setPrefLanguage((i18n.resolvedLanguage as SupportedLocale) ?? 'en');
      setPrefTimezone(user?.timezone ?? null);
      // Voice AI — isi dari workspace aktif + status koneksi.
      const activeWs = workspaces.find((item) => item.id === activeWorkspaceId);
      setVoiceName(activeWs?.callAssistantName ?? 'Sarah');
      setVoiceLanguage(activeWs?.callGoalLanguage === 'id' ? 'id' : 'en');
      setVoiceId(activeWs?.callVoiceId ?? '');
      setAutoCallEnabled(activeWs?.autoCallEnabled ?? false);
      setAutoCallLeadHours(activeWs?.autoCallLeadHours ?? 24);
      setMaxCallAttempts(activeWs?.maxCallAttempts ?? 2);
    }
  }, [isOpen, user?.name, user?.timezone, workspaces, activeWorkspaceId]);

  const close = () => {
    if (!isSaving && !isDeleting && !isDeletingUser) {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      onOpenChange(false);
      requestAnimationFrame(() => {
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
      });
    }
  };

  const handleDeleteUser = async () => {
    setIsDeletingUser(true);
    try {
      await deleteUserAccount();
      setConfirmDeleteUserOpen(false);
      onOpenChange(false);
      // Toast sukses — viewport self-mounting dari useToast tetap tampil
      // meski sesi sudah dibersihkan dan app berpindah ke halaman auth.
      toast({
        body: t('settings.deleteAccountSuccess'),
        type: 'info',
        isAutoHide: true,
        autoHideDuration: 5000,
      });
    } catch (err) {
      const msg = errorMessage(err, t, 'errors.deleteAccount');
      setConfirmDeleteUserOpen(false);
      toast({
        body: msg,
        type: 'error',
        isAutoHide: true,
        autoHideDuration: 5000,
      });
    } finally {
      setIsDeletingUser(false);
    }
  };

  const deleteWorkspace = async (workspaceId: string) => {
    setDeleteError(null);
    setIsDeleting(true);
    try {
      await apiFetch<{ ok: boolean }>(`/me/workspaces/${workspaceId}`, { method: 'DELETE' });
      removeWorkspace(workspaceId);
      setConfirmDeleteId(null);
      // Bisnis terakhir dihapus → tutup dialog Settings; di belakangnya app
      // berpindah ke state kosong/onboarding (activeWorkspaceId null).
      if (workspaces.length === 1) onOpenChange(false);
    } catch (err) {
      setConfirmDeleteId(null);
      setDeleteError(errorMessage(err, t, 'errors.deleteBusiness'));
    } finally {
      setIsDeleting(false);
    }
  };

  const save = async () => {
    if (isSaving) return; // cegah double-submit
    const clean = name.trim();
    if (!clean) {
      setError(t('errors.profileNameRequired'));
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      const res = await apiFetch<{ name: string; language?: string | null; timezone?: string | null }>(
        '/me',
        {
          method: 'PATCH',
          body: JSON.stringify({ name: clean, language: prefLanguage, timezone: prefTimezone }),
        },
      );
      if (user) {
        setUser({
          ...user,
          name: res.name,
          language: res.language ?? null,
          timezone: res.timezone ?? null,
        });
      }
      // Voice AI — pengaturan asisten & perilaku panggilan workspace aktif.
      if (activeWorkspaceId) {
        const wsRes = await apiFetch<{ workspace: Workspace }>(
          `/me/workspaces/${activeWorkspaceId}`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              callAssistantName: voiceName.trim() || 'Sarah',
              callGoalLanguage: voiceLanguage,
              callVoiceId: voiceId || null,
              autoCallEnabled,
              autoCallLeadHours,
              maxCallAttempts,
            }),
          },
        );
        updateWorkspace(wsRes.workspace);
      }
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err, t, 'errors.saveProfile'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <>
      <Dialog
        isOpen={isOpen}
        // Semua jalan keluar (tombol X, backdrop, Escape) lewat close() agar
        // dialog tidak bisa ditutup saat penyimpanan berjalan.
        onOpenChange={(open) => {
          if (!open) close();
        }}
        purpose="info"
        width={720}
        maxHeight="min(85vh, 640px)"
      >
      <Layout
        header={
          <DialogHeader
            title={t('settings.title')}
            subtitle={t('settings.description')}
            startContent={<IconSettings className="size-5 shrink-0 text-amber-600" />}
            onOpenChange={(open) => {
              if (!open) close();
            }}
            hasDivider
          />
        }
        content={
          <LayoutContent>
            <div className="flex gap-6">
              {/* Sidebar kiri dialog — berpindah antar bagian Settings. */}
              <nav
                aria-label={t('settings.title')}
                className="sticky top-0 w-44 shrink-0 space-y-1 self-start"
              >
                {SECTIONS.map((section) => {
                  const active = section.id === activeSection;
                  return (
                    <button
                      key={section.id}
                      type="button"
                      onClick={() => setActiveSection(section.id)}
                      aria-current={active ? 'true' : undefined}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-base font-medium transition ${
                        active
                          ? 'bg-amber-500/10 text-amber-700'
                          : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100'
                      }`}
                    >
                      <section.icon
                        className={`size-[18px] shrink-0 ${active ? 'text-amber-600' : 'text-zinc-400'}`}
                      />
                      {t(section.labelKey)}
                    </button>
                  );
                })}
              </nav>

              {/* Konten bagian aktif */}
              <div className="min-w-0 flex-1">
                {activeSection === 'profile' && (
                  <div className="space-y-5">
                    <div className="flex items-center gap-3">
                      <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-lg font-bold text-amber-400">
                        {(user?.name ?? user?.email ?? 'U').slice(0, 1).toUpperCase()}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-base font-semibold text-zinc-900 dark:text-zinc-100">
                          {user?.name ?? t('common.noName')}
                        </p>
                        <p className="truncate text-sm text-zinc-500 dark:text-zinc-400">{user?.email ?? ''}</p>
                      </div>
                    </div>

                    <TextInput
                      label={t('common.name')}
                      value={name}
                      onChange={setName}
                      isRequired
                      width="100%"
                    />
                    <TextInput
                      label={t('common.email')}
                      value={user?.email ?? ''}
                      isDisabled
                      width="100%"
                    />

                    {/* Danger zone — Hapus Akun */}
                    <div>
                      <p className="mb-1.5 text-base font-medium text-zinc-700 dark:text-zinc-300">
                        {t('settings.dangerZone')}
                      </p>
                      <div className="space-y-4">
                        <div className="flex items-center justify-between gap-4">
                          <div className="min-w-0">
                            <p className="mb-1.5 text-base font-medium text-zinc-700 dark:text-zinc-300">
                              {t('settings.deleteAccountTitle')}
                            </p>
                            <p className="text-sm text-zinc-500 dark:text-zinc-400">
                              {t('settings.deleteAccountDesc')}
                            </p>
                          </div>
                          <Button
                            label={t('settings.deleteAccountCta')}
                            variant="destructive"
                            size="sm"
                            icon={<IconTrash className="size-3.5" />}
                            onClick={() => {
                              setConfirmDeleteUserOpen(true);
                            }}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {activeSection === 'preferences' && (
                  <div className="space-y-5">
                    {/* Bahasa — ganti langsung (i18n), disimpan saat Save. */}
                    <div>
                      <p className="mb-1.5 text-base font-medium text-zinc-700 dark:text-zinc-300">
                        {t('settings.language')}
                      </p>
                      <p className="mb-1.5 text-sm text-zinc-500 dark:text-zinc-400">
                        {t('settings.languageDesc')}
                      </p>
                      <LanguageDropdown
                        value={prefLanguage}
                        onSelect={(code) => {
                          setPrefLanguage(code);
                          if (code !== i18n.resolvedLanguage) void i18n.changeLanguage(code);
                        }}
                      />
                    </div>

                    {/* Zona waktu — default booking/jadwal baru. */}
                    <div>
                      <p className="mb-1.5 text-base font-medium text-zinc-700 dark:text-zinc-300">
                        {t('settings.timezone')}
                      </p>
                      <p className="mb-1.5 text-sm text-zinc-500 dark:text-zinc-400">
                        {t('settings.timezoneDesc')}
                      </p>
                      <TimezoneDropdown
                        value={prefTimezone}
                        onSelect={setPrefTimezone}
                        autoLabel={`${t('settings.timezoneAuto')} (${browserTimezone()})`}
                      />
                    </div>
                  </div>
                )}

                {activeSection === 'billing' && <BillingPanel />}

                {activeSection === 'voice' && (
                  <div className="space-y-5">
                    {/* Bagian A — Phone Number: entry point setup + management */}
                    <PhoneNumberPanel />

                    {/* Bagian A2 — Inbound (AI receptionist): nomor yang
                        dilayani resepsionis AI saat customer menelepon. */}
                    <InboundNumberPanel />

                    {/* Bagian B — AI assistant (name/language/voice) */}
                    <div>
                      <p className="mb-1.5 text-base font-medium text-zinc-700 dark:text-zinc-300">
                        {t('voiceAi.assistantTitle')}
                      </p>
                      <div className="space-y-4">
                        <TextInput
                          label={t('voiceAi.assistantName')}
                          value={voiceName}
                          onChange={setVoiceName}
                          placeholder="Sarah"
                          width="100%"
                        />
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                          <div>
                            <p className="mb-1.5 text-base font-medium text-zinc-700 dark:text-zinc-300">
                              {t('voiceAi.language')}
                            </p>
                            <VoiceLanguageDropdown value={voiceLanguage} onSelect={setVoiceLanguage} />
                          </div>
                          <div>
                            <p className="mb-1.5 text-base font-medium text-zinc-700 dark:text-zinc-300">
                              {t('voiceAi.voice')}
                            </p>
                            <VoiceDropdown value={voiceId} onSelect={setVoiceId} />
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Bagian C — call behavior (auto-call + timing + attempts) */}
                    <div>
                      <p className="mb-1.5 text-base font-medium text-zinc-700 dark:text-zinc-300">
                        {t('voiceAi.behaviorTitle')}
                      </p>
                      <div className="space-y-4">
                        <Switch
                          label={t('voiceAi.autoCall')}
                          description={t('voiceAi.autoCallDesc')}
                          value={autoCallEnabled}
                          onChange={setAutoCallEnabled}
                          labelPosition="start"
                          labelSpacing="spread"
                        />
                        {/* Call timing — backend hanya mendukung jam SEBELUM
                            jadwal (autoCallLeadHours); "Immediately" tidak
                            didukung mesin auto-call (Inngest). */}
                        <div>
                          <p className="mb-1.5 text-base font-medium text-zinc-700 dark:text-zinc-300">
                            {t('voiceAi.callTiming')}
                          </p>
                          <p className="mb-1.5 text-sm text-zinc-500 dark:text-zinc-400">
                            {t('voiceAi.beforeAppointment')}
                          </p>
                          <div className="flex items-center gap-2">
                            <NumberInput
                              label={t('voiceAi.hoursBefore')}
                              isLabelHidden
                              value={autoCallLeadHours}
                              onChange={(value) => setAutoCallLeadHours(value ?? 24)}
                              min={1}
                              max={10080}
                              width="w-20"
                            />
                            <span className="text-sm text-zinc-500 dark:text-zinc-400">
                              {t('voiceAi.hours')}
                            </span>
                          </div>
                        </div>
                        <div>
                          <p className="mb-1.5 text-base font-medium text-zinc-700 dark:text-zinc-300">
                            {t('voiceAi.maxAttempts')}
                          </p>
                          <p className="mb-1.5 text-sm text-zinc-500 dark:text-zinc-400">
                            {t('voiceAi.maxAttemptsDesc')}
                          </p>
                          <NumberInput
                            label={t('voiceAi.maxAttempts')}
                            isLabelHidden
                            value={maxCallAttempts}
                            onChange={(value) => setMaxCallAttempts(value ?? 2)}
                            min={1}
                            max={10}
                            width="w-20"
                          />
                        </div>
                      </div>
                    </div>

                    {/* Bagian D — call goal (read-only, berbasis industri) */}
                    <div>
                      <p className="mb-1.5 text-base font-medium text-zinc-700 dark:text-zinc-300">
                        {t('voiceAi.goalTitle')}
                      </p>
                      <p className="mb-1.5 text-sm text-zinc-500 dark:text-zinc-400">
                        {t('voiceAi.goalDesc')}
                      </p>
                      <ul className="space-y-2">
                        <li className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
                          <IconCheck className="size-4 shrink-0 text-emerald-500" />
                          {t('voiceAi.goalConfirm')}
                        </li>
                        <li className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
                          <IconCheck className="size-4 shrink-0 text-emerald-500" />
                          {t('voiceAi.goalReschedule')}
                        </li>
                        <li className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
                          <IconCheck className="size-4 shrink-0 text-emerald-500" />
                          {t('voiceAi.goalCancel')}
                        </li>
                      </ul>
                    </div>
                  </div>
                )}

                {activeSection === 'businesses' && (
                  <div className="space-y-4">
                    <p className="text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">{t('settings.businessesDesc')}</p>

                    <div className="space-y-2">
                      {workspaces.length === 0 ? (
                        <p className="rounded-md border border-dashed border-zinc-300 dark:border-zinc-600 px-4 py-8 text-center text-sm text-zinc-400">
                          {t('settings.businessesEmpty')}
                        </p>
                      ) : (
                        workspaces.map((workspace) => (
                          <div
                            key={workspace.id}
                            className="flex items-center gap-3 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-4 py-3 transition hover:border-zinc-300 dark:hover:border-zinc-600"
                          >
                            <WorkspaceAvatar workspace={workspace} size={36} radiusClass="rounded-md" />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{workspace.name}</p>
                              {workspace.id === activeWorkspaceId && (
                                <p className="text-xs font-medium text-amber-600">{t('nav.activeBusiness')}</p>
                              )}
                            </div>
                            <Button
                              label={t('common.delete')}
                              variant="destructive"
                              size="sm"
                              icon={<IconTrash className="size-3.5" />}
                              isDisabled={isDeleting}
                              onClick={() => {
                                setConfirmDeleteId(workspace.id);
                                setDeleteError(null);
                              }}
                            />
                          </div>
                        ))
                      )}
                    </div>

                    {deleteError && (
                      <p role="alert" className="text-sm text-red-600">{deleteError}</p>
                    )}
                  </div>
                )}

                {activeSection === 'privacy' && (
                  <div className="space-y-5">
                    <p className="text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">{t('consent.privacyDesc')}</p>

                    <Switch
                      label={t('consent.sessionReplayLabel')}
                      description={t('consent.sessionReplayDesc')}
                      value={replayConsent === 'granted'}
                      onChange={(enabled) => {
                        const next = enabled ? 'granted' : 'denied';
                        setReplayConsent(next);
                        void applyAnalyticsConsent(next);
                      }}
                      labelPosition="start"
                      labelSpacing="spread"
                    />

                    {!isAnalyticsEnabled && (
                      <p className="text-sm leading-relaxed text-zinc-400">
                        {t('consent.analyticsDisabled')}
                      </p>
                    )}
                    {replayConsent === 'denied' && (
                      <p className="text-sm leading-relaxed text-zinc-400">
                        {t('consent.deniedNote')}
                      </p>
                    )}
                  </div>
                )}

                {activeSection === 'notifications' && (
                  <div className="space-y-5">
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
                )}

              </div>
            </div>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            {error && (
              <p role="alert" className="pb-2 text-right text-sm text-red-600">{error}</p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                label={t('common.cancel')}
                variant="ghost"
                onClick={close}
                isDisabled={isSaving}
              />
              <Button
                label={t('common.save')}
                variant="primary"
                onClick={() => void save()}
                isLoading={isSaving}
              />
            </div>
          </LayoutFooter>
        }        />
      </Dialog>

      {/* Konfirmasi hapus bisnis — Dialog astryx memakai elemen <dialog>
          native (top layer), jadi dua dialog menumpuk dengan benar:
          confirm menutupi dialog Settings dengan backdrop sendiri. */}
      <ConfirmDialog
        isOpen={confirmDeleteId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmDeleteId(null);
            setDeleteError(null);
          }
        }}
        title={t('ws.deleteTitle')}
        description={
          <Trans
            i18nKey="ws.deleteQuestion"
            components={{ strong: <strong className="font-bold text-black dark:text-zinc-100" /> }}
          />
        }
        cancelLabel={t('common.cancel')}
        actionLabel={t('common.delete')}
        actionVariant="destructive"
        isActionLoading={isDeleting}
        onAction={() => {
          if (confirmDeleteId) void deleteWorkspace(confirmDeleteId);
        }}
        confirmText={
          confirmDeleteId
            ? (workspaces.find((workspace) => workspace.id === confirmDeleteId)?.name ?? '')
            : undefined
        }
        width={420}
      />

      {/* Konfirmasi hapus akun pengguna — memerlukan konfirmasi email / nama akun */}
      <ConfirmDialog
        isOpen={confirmDeleteUserOpen}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmDeleteUserOpen(false);
          }
        }}
        title={t('settings.deleteAccountConfirmTitle')}
        description={
          <p>
            <Trans
              i18nKey="settings.deleteAccountConfirmQuestion"
              components={{ strong: <strong className="font-bold text-black dark:text-zinc-100" /> }}
            />
          </p>
        }
        cancelLabel={t('common.cancel')}
        actionLabel={t('settings.deleteAccountConfirmAction')}
        actionVariant="destructive"
        isActionLoading={isDeletingUser}
        onAction={() => {
          void handleDeleteUser();
        }}
        confirmText={user?.email || user?.name || undefined}
        width={440}
      />
    </>
  );
}
