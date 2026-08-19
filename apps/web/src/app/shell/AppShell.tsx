import { useEffect, useState, type ComponentType } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { DropdownMenu, DropdownMenuItem, DropdownMenuSubMenu, IconButton, Spinner } from '@astryxdesign/core';
import { useTranslation } from 'react-i18next';

import { ApiError, apiFetch } from '../../lib/api';
import type { UnreadSummaryResponse } from '../../lib/messaging';
import { signOut } from '../../lib/session';
import { applyTheme, readStoredTheme, storeTheme, type AppTheme } from '../../lib/theme';
import { useSessionStore } from '../../stores/session';
import { useWorkspaceStore } from '../../stores/workspace';
import type { TranslationKey } from '../../i18n';
import { LanguageSubMenu } from './LocaleSwitcher';
import { BillingDialog } from './BillingDialog';
import { SettingsDialog } from './SettingsDialog';
import { WorkspaceAvatar } from '../components/WorkspaceAvatar';
import { AppLogo } from '../components/AppLogo';
import {
  IconBuildings,
  IconCalendar,
  IconCalendarCheck,
  IconCheck,
  IconChat,
  IconChevronDown,
  IconCreditCard,
  IconDashboard,
  IconDotsHorizontal,
  IconHelp,
  IconLogout,
  IconMenu,
  IconMonitor,
  IconMoon,
  IconPanelLeftClose,
  IconPanelLeftOpen,
  IconPhone,
  IconPlug,
  IconServices,
  IconSettings,
  IconStaff,
  IconSun,
  IconSunMoon,
  IconUsers,
  IconX,
  type IconProps,
} from './icons';

interface NavItem {
  to: string;
  /** Kunci i18n label navigasi. */
  labelKey: TranslationKey;
  icon: ComponentType<IconProps>;
}

const NAV: NavItem[] = [
  { to: '/app/dashboard', labelKey: 'nav.dashboard', icon: IconDashboard },
  { to: '/app/bookings', labelKey: 'nav.bookings', icon: IconCalendarCheck },
  { to: '/app/calendar', labelKey: 'nav.calendar', icon: IconCalendar },
  { to: '/app/contacts', labelKey: 'nav.contacts', icon: IconUsers },
  { to: '/app/services', labelKey: 'nav.services', icon: IconServices },
  { to: '/app/staff', labelKey: 'nav.staff', icon: IconStaff },
  { to: '/app/inbox', labelKey: 'nav.inbox', icon: IconChat },
  { to: '/app/calls', labelKey: 'nav.calls', icon: IconPhone },
  { to: '/app/integrations', labelKey: 'nav.integrations', icon: IconPlug },
  // Settings dibuka dari dropdown akun di footer sidebar — bukan item nav lagi.
  // Help dipindah ke footer sidebar (ikon kecil) — bukan item nav lagi.
];

function Logo({ collapsed = false }: { collapsed?: boolean }) {
  // Hanya ikon — tanpa nama brand. pb-4 memberi jarak dari switcher bisnis
  // di bawahnya; px-4 menyelaraskan dengan avatar di dalam trigger.
  return (
    <div className={`flex items-center pb-4 pt-4 ${collapsed ? 'justify-center px-0' : 'px-4'}`}>
      <span className="flex size-9 items-center justify-center overflow-hidden rounded-md bg-amber-500">
        <AppLogo />
      </span>
    </div>
  );
}

// Perkuat hover trigger akun: token astryx default hanya ~5% overlay —
// nyaris tak terlihat di atas bg-muted. Dipasang di TOMBOL (bukan container)
// karena popover menu dirender inline sebagai sibling — kalau di container,
// item hover di popover terang ikut ke-override jadi tak terlihat.
const userMenuTriggerStyle = {
  height: 'auto',
  minHeight: 32,
  padding: 6,
  justifyContent: 'space-between',
  gap: 8,
  '--color-overlay-hover': 'rgba(0,0,0,0.08)',
};

// Trigger switcher bisnis di sidebar terang — sama seperti trigger akun.
const businessTriggerStyle = {
  height: 'auto',
  minHeight: 30,
  padding: 5,
  justifyContent: 'space-between',
  gap: 8,
  '--color-overlay-hover': 'rgba(0,0,0,0.08)',
};

/**
 * Badge unread amber (pill) — dipakai di business switcher & item nav Inbox.
 * Sembunyi saat count <= 0; tampilkan "99+" saat overflow.
 */
function UnreadBadge({ count, label, className }: { count: number; label: string; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      role="status"
      aria-label={label}
      className={`flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-amber-500 px-1 text-[11px] font-bold leading-none text-zinc-950 ${className ?? ''}`}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

/** Inisial user untuk avatar footer: huruf pertama kata pertama + terakhir. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

/** "Last opened" relatif terhadap sekarang, mengikuti bahasa aktif. */
function formatLastOpened(iso: string, language: string): string {
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 365 * 24 * 60 * 60 * 1000],
    ['month', 30 * 24 * 60 * 60 * 1000],
    ['week', 7 * 24 * 60 * 60 * 1000],
    ['day', 24 * 60 * 60 * 1000],
    ['hour', 60 * 60 * 1000],
    ['minute', 60 * 1000],
  ];
  const diff = Date.now() - new Date(iso).getTime();
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  // Kurang dari satu menit → "this minute"/"baru saja" (numeric:auto).
  for (const [unit, ms] of units) {
    if (Math.abs(diff) >= ms) {
      return rtf.format(-Math.max(1, Math.round(diff / ms)), unit);
    }
  }
  return rtf.format(0, 'minute');
}

export function AppShell() {
  const { t, i18n } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [businessMenuOpen, setBusinessMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isBillingOpen, setIsBillingOpen] = useState(false);
  // Sidebar desktop bisa diciutkan jadi rail ikon (toggle di footer sidebar).
  // Preferensi disimpan per-perangkat (localStorage) — pola sama seperti
  // lokalisasi & integrasi Obsidian.
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem('oriole.sidebarCollapsed') === '1';
    } catch {
      return false;
    }
  });
  const navigate = useNavigate();
  // Halaman Calendar memakai layout full-bleed (tanpa max-width/padding) agar
  // kalender bisa melebar penuh & mengisi sisa tinggi viewport. Halaman lain
  // tetap memakai kontainer standar max-w-6xl.
  const location = useLocation();
  const isCalendarFullBleed = location.pathname === '/app/calendar';
  // Tema SELURUH app: 'system' mengikuti OS, 'light'/'dark' memaksa.
  // Disimpan per-perangkat di localStorage — logika di lib/theme.ts.
  const [sidebarTheme, setSidebarTheme] = useState<AppTheme>(readStoredTheme);

  // Terapkan saat mount & saat pilihan berubah; saat mode system, ikuti
  // perubahan preferensi OS (light/dark) secara live.
  useEffect(() => {
    applyTheme(sidebarTheme);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (sidebarTheme === 'system') applyTheme('system');
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [sidebarTheme]);

  const changeSidebarTheme = (theme: AppTheme) => {
    setSidebarTheme(theme);
    applyTheme(theme);
    storeTheme(theme);
  };

  const toggleSidebarCollapsed = () => {
    setIsSidebarCollapsed((collapsed) => {
      try {
        localStorage.setItem('oriole.sidebarCollapsed', collapsed ? '0' : '1');
      } catch {
        // localStorage tidak tersedia — abaikan, toggle tetap berfungsi untuk sesi ini.
      }
      return !collapsed;
    });
  };

  // Layar ≥ lg (1024px, breakpoint Tailwind `lg:`) → sidebar desktop. Di layar
  // kecil sidebar desktop TIDAK ikut di-render: kalau dua sidebar (desktop
  // `hidden` + drawer) mount bersamaan, business switcher di keduanya berbagi
  // state `businessMenuOpen` yang sama — kedua popover native `popover="auto"`
  // saling menutup (spec: show() satu auto-popover menutup yang lain) sehingga
  // menu drawer langsung tertutup setelah dibuka.
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const onChange = (event: MediaQueryListEvent) => {
      setIsDesktop(event.matches);
      // Naik ke desktop: tutup drawer + dropdown agar tidak "tersangkut"
      // terbuka dan muncul lagi diam-diam saat resize balik ke mobile.
      if (event.matches) {
        setMenuOpen(false);
        setBusinessMenuOpen(false);
        setUserMenuOpen(false);
      }
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Tutup drawer mobile dengan tombol Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);
  const user = useSessionStore((s) => s.user);
  // Total unread per bisnis — badge di business switcher + badge item nav
  // Inbox. Di-poll tiap menit + direfetch tiap dropdown dibuka agar tidak
  // basi saat pesan masuk.
  const { data: unreadSummary, refetch: refetchUnread } = useQuery({
    queryKey: ['unread-summary'],
    queryFn: () => apiFetch<UnreadSummaryResponse>('/me/unread-summary'),
    refetchInterval: 60_000,
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 1,
  });
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const isSwitching = useWorkspaceStore((s) => s.isSwitching);
  const switchWorkspace = useWorkspaceStore((s) => s.switchWorkspace);
  const lastOpenedAt = useWorkspaceStore((s) => s.lastOpenedAt);
  const workspaceSwitcher = (workspaceId: string) => {
    void switchWorkspace(workspaceId);
  };
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId);
  // Total unread inbox workspace aktif — badge di item nav Inbox.
  const inboxUnread = activeWorkspaceId
    ? (unreadSummary?.unreadByWorkspace[activeWorkspaceId] ?? 0)
    : 0;

  const onLogout = async () => {
    await signOut();
    navigate('/auth/sign-in', { replace: true });
  };

  const sidebar = (
    onNavigate?: () => void,
    options: { collapsed?: boolean; showCollapse?: boolean } = {},
  ) => {
    const { collapsed = false, showCollapse = false } = options;
    // aside w-full: lebar dianimasikan oleh wrapper fixed (transition-[width]),
    // bukan di sini — kalau dua-duanya menganimasi width, transisinya terasa
    // ganda/aneh. Tinggi item ikon memakai h-11 FIXED (bukan aspect-square)
    // agar tinggi tidak ikut membesar saat lebar rail sedang bertransisi.
    return (
    <aside id="app-sidebar" className="flex h-full w-full flex-col border-r border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900">
      <Logo collapsed={collapsed} />

      <div className="px-2.5 pb-2">
        <DropdownMenu
          placement="below"
          hasChevron={false}
          menuWidth={300}
          isMenuOpen={businessMenuOpen}
          onOpenChange={(open) => {
            setBusinessMenuOpen(open);
            // Segarkan badge unread setiap dropdown bisnis dibuka.
            if (open) void refetchUnread();
          }}
          button={{
              label: activeWorkspace?.name ?? t('nav.selectBusiness'),
              variant: 'ghost',
              width: '100%',
              style: collapsed
                ? { ...businessTriggerStyle, justifyContent: 'center' }
                : businessTriggerStyle,
              children: (
                <span className={`flex min-w-0 items-center gap-2 ${collapsed ? 'justify-center' : ''}`}>
                  <WorkspaceAvatar workspace={activeWorkspace ?? { name: '?' }} size={24} />
                  {!collapsed && (
                    <span className="min-w-0 flex-1 truncate text-left text-base font-semibold text-zinc-800 dark:text-zinc-200">
                      {activeWorkspace?.name ?? t('nav.selectBusiness')}
                    </span>
                  )}
                </span>
              ),
              endContent: collapsed ? undefined : (
                <IconChevronDown
                  className={`size-3.5 shrink-0 text-zinc-400 transition-transform duration-200 ${
                    businessMenuOpen ? 'rotate-180' : ''
                  }`}
                />
              ),
            }}
          >
            {/* Hanya daftar bisnis yang scroll (max ~4 item, 192px); footer
                "Kelola bisnis" di bawah TETAP terlihat. Keyboard nav aman:
                astryx mencari item via [role="menuitem"] descendant dari
                [role="menu"], jadi wrapper div tidak memutusnya. pr-1 memberi
                ruang scrollbar agar tidak menimpa teks item. */}
            <div className="max-h-48 overflow-y-auto overscroll-contain pr-1">
            {workspaces.map((workspace) => {
              const isActive = workspace.id === activeWorkspaceId;
              const lastOpened = lastOpenedAt[workspace.id];
              const unread = unreadSummary?.unreadByWorkspace[workspace.id] ?? 0;
              return (
                <DropdownMenuItem
                  key={workspace.id}
                  icon={<WorkspaceAvatar workspace={workspace} size={24} />}
                  label={
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="block truncate text-sm font-semibold">{workspace.name}</span>
                      <UnreadBadge count={unread} label={t('inbox.unread', { count: unread })} />
                    </span>
                  }
                    description={
                      <span className="block text-xs">
                        {lastOpened
                          ? t('nav.lastOpened', {
                              time: formatLastOpened(lastOpened, i18n.resolvedLanguage ?? 'en'),
                            })
                          : t('nav.lastOpenedNever')}
                      </span>
                    }
                    endContent={
                      isActive ? <IconCheck className="size-3.5 shrink-0 text-amber-500" /> : undefined
                    }
                    onClick={() => workspaceSwitcher(workspace.id)}
                  />
                );
              })}
            </div>

            {/* Tanpa p-1.5: popover astryx sudah punya padding sendiri (--_dropdown-menu-padding),
                jadi wrapper tanpa padding membuat tombol selebar item menu di atasnya. */}
            <div className="border-t border-zinc-200/70 dark:border-zinc-700/70">
              <NavLink
                to="/app/workspaces"
                onClick={() => {
                  // Item menu menutup popover sendiri via ctx.closeMenu(); link
                  // footer bukan menu item — tutup manual agar tidak tetap
                  // terbuka di atas halaman Workspaces.
                  setBusinessMenuOpen(false);
                  onNavigate?.();
                }}
                className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-amber-600 transition hover:bg-amber-500/10 hover:text-amber-700 dark:text-amber-500 dark:hover:text-amber-400"
              >
                <IconBuildings className="size-3.5" /> {t('nav.manageBusinesses')}
              </NavLink>
            </div>
          </DropdownMenu>
      </div>

      {/* Padding horizontal rail ciut = px-2.5 (10px), SAMA dengan margin
          business switcher di atasnya — tombol ikon jadi 44×44 (1:1), tidak
          selebar rail penuh. */}
      <nav className="flex-1 overflow-y-auto px-2.5 py-1">
        {!collapsed && (
          <p className="px-2.5 pb-1 pt-0.5 text-xs font-normal uppercase tracking-widest text-zinc-500 dark:text-zinc-400">
            {t('nav.menu')}
          </p>
        )}
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/app/dashboard'}
            onClick={onNavigate}
            title={collapsed ? t(item.labelKey) : undefined}
            aria-label={collapsed ? t(item.labelKey) : undefined}
            className={({ isActive }) =>
              `group flex w-full items-center rounded-lg text-base font-normal transition ${
                collapsed ? 'justify-center px-1.5 h-11' : 'gap-2.5 px-2.5 py-1.5'
              } ${
                isActive
                  ? 'bg-amber-500/10 text-amber-600'
                  : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/70 dark:hover:bg-zinc-700/70 hover:text-zinc-900 dark:hover:text-zinc-100'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <item.icon
                  className={`size-4 shrink-0 transition ${isActive ? 'text-amber-600' : 'text-zinc-400 group-hover:text-zinc-600 dark:group-hover:text-zinc-400'}`}
                />
                {!collapsed && t(item.labelKey)}
                {/* Badge unread khusus item Inbox (workspace aktif). */}
                {!collapsed && item.to === '/app/inbox' && (
                  <UnreadBadge
                    count={inboxUnread}
                    label={t('inbox.unread', { count: inboxUnread })}
                    className="ml-auto"
                  />
                )}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {/* Tema diterapkan app-wide via data-theme di <html> (applyTheme). */}
      <div className="border-t border-zinc-200/80 dark:border-zinc-700/80 p-2.5">
        <DropdownMenu
          placement="above"
          hasChevron={false}
          isMenuOpen={userMenuOpen}
          onOpenChange={setUserMenuOpen}
          button={{
            label: user?.name ?? t('nav.user'),
            variant: 'ghost',
            width: '100%',
            style: collapsed
              ? { ...userMenuTriggerStyle, justifyContent: 'center', padding: 4, height: 44 }
              : userMenuTriggerStyle,
            children: (
              <span className={`flex min-w-0 items-center gap-2.5 ${collapsed ? 'justify-center' : ''}`}>
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-amber-500/10 text-[11px] font-bold text-amber-700">
                  {initialsOf(user?.name ?? user?.email ?? 'U')}
                </span>
                {!collapsed && (
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-left text-sm font-normal text-zinc-800 dark:text-zinc-200">
                      {user?.name ?? t('nav.user')}
                    </span>
                    <span className="block truncate text-left text-sm text-zinc-500 dark:text-zinc-400">
                      {user?.email ?? ''}
                    </span>
                  </span>
                )}
              </span>
            ),
            endContent: collapsed ? undefined : (
              <IconDotsHorizontal className="size-4 shrink-0 text-zinc-400" />
            ),
          }}
        >
          {/* Settings — dialog identitas akun, notifikasi, & keamanan (dipindah
              dari halaman /app/settings & dialog profil lama). */}
          <DropdownMenuItem
            label={t('nav.settings')}
            icon={<IconSettings className="size-4" />}
            onClick={() => setIsSettingsOpen(true)}
          />
          {/* Billing — dialog langganan & kuota (dipindah dari halaman /app/billing) */}
          <DropdownMenuItem
            label={t('nav.billing')}
            icon={<IconCreditCard className="size-4" />}
            onClick={() => setIsBillingOpen(true)}
          />
          {/* Pemilihan bahasa — submenu flyout berisi pilihan EN/ID. */}
          <LanguageSubMenu />
          {/* Tema popover — submenu flyout (sama seperti Language) berisi
              pilihan Light / Dark / System dengan centang pada pilihan aktif. */}
          <DropdownMenuSubMenu
            label={t('nav.theme')}
            icon={<IconSunMoon className="size-4" />}
          >
            <DropdownMenuItem
              label={t('nav.themeLight')}
              icon={<IconSun className="size-4" />}
              onClick={() => changeSidebarTheme('light')}
              endContent={
                sidebarTheme === 'light' ? <IconCheck className="size-3.5 text-amber-500" /> : undefined
              }
            />
            <DropdownMenuItem
              label={t('nav.themeDark')}
              icon={<IconMoon className="size-4" />}
              onClick={() => changeSidebarTheme('dark')}
              endContent={
                sidebarTheme === 'dark' ? <IconCheck className="size-3.5 text-amber-500" /> : undefined
              }
            />
            <DropdownMenuItem
              label={t('nav.themeSystem')}
              icon={<IconMonitor className="size-4" />}
              onClick={() => changeSidebarTheme('system')}
              endContent={
                sidebarTheme === 'system' ? <IconCheck className="size-3.5 text-amber-500" /> : undefined
              }
            />
          </DropdownMenuSubMenu>
          <DropdownMenuItem
            label={t('common.logout')}
            icon={<IconLogout className="size-4" />}
            onClick={onLogout}
          />
        </DropdownMenu>

        {/* Aksi footer — baris ikon kecil: Help (paling kiri) + toggle
            ciutkan sidebar (paling kanan), tanpa separator dari menu akun.
            Toggle hanya untuk sidebar desktop (showCollapse; drawer mobile
            punya tombol tutup sendiri). Saat rail ciut, Help disembunyikan —
            yang tampil hanya tombol collapsible (full width, rasio 1:1). */}
        <div
          className={`flex items-center ${
            collapsed ? 'mt-0 justify-center gap-0' : 'mt-0.5 justify-between gap-1'
          }`}
        >
          {!collapsed && (
            <NavLink
              to="/app/help"
              onClick={onNavigate}
              title={t('nav.help')}
              aria-label={t('nav.help')}
              className={({ isActive }) =>
                `flex size-7 shrink-0 items-center justify-center rounded-lg transition ${
                  isActive
                    ? 'bg-amber-500/10 text-amber-600'
                    : 'text-zinc-400 hover:bg-zinc-200/70 dark:hover:bg-zinc-700/70 hover:text-zinc-600 dark:hover:text-zinc-400'
                }`
              }
            >
              <IconHelp className="size-4" />
            </NavLink>
          )}

          {showCollapse && (
            <button
              type="button"
              onClick={toggleSidebarCollapsed}
              aria-controls="app-sidebar"
              title={collapsed ? t('nav.expandSidebar') : t('nav.collapseSidebar')}
              aria-label={collapsed ? t('nav.expandSidebar') : t('nav.collapseSidebar')}
              aria-expanded={!collapsed}
              className={`flex shrink-0 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-zinc-200/70 dark:hover:bg-zinc-700/70 hover:text-zinc-600 dark:hover:text-zinc-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500 ${
                collapsed ? 'h-11 w-full' : 'size-7'
              }`}
            >
              {collapsed ? (
                <IconPanelLeftOpen className="size-3.5" />
              ) : (
                <IconPanelLeftClose className="size-4" />
              )}
            </button>
          )}
        </div>
      </div>
    </aside>
    );
  };

  return (
    <div className="min-h-screen bg-surface">
      {/* Sidebar — desktop. Hanya di-mount saat viewport ≥ lg supaya tidak
          ada dua salinan sidebar (desktop + drawer) yang popover switchernya
          saling menutup di layar kecil. */}
      {isDesktop && (
        <div
          className={`fixed inset-y-0 left-0 z-40 hidden transition-[width] duration-200 ease-out lg:block ${
            isSidebarCollapsed ? 'w-16' : 'w-60'
          }`}
        >
          {sidebar(undefined, { collapsed: isSidebarCollapsed, showCollapse: true })}
        </div>
      )}

      {/* Sidebar — mobile (drawer) */}
      {menuOpen && !isDesktop && (
        <div className="fixed inset-0 z-50 lg:hidden" id="app-menu-drawer">
          <div
            className="absolute inset-0 bg-zinc-950/60 backdrop-blur-sm"
            onClick={() => setMenuOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 w-60 shadow-2xl">
            <IconButton
              icon={<IconX className="size-4" />}
              label={t('nav.closeMenu')}
              variant="ghost"
              size="sm"
              onClick={() => setMenuOpen(false)}
              className="absolute right-3 top-4 z-10"
            />
            {sidebar(() => setMenuOpen(false))}
          </div>
        </div>
      )}

      {/* Loader saat pindah bisnis — menutupi layar sampai data workspace
          baru selesai dimuat (isSwitching di-reset oleh store). */}
      {isSwitching && (
        <div
          role="status"
          aria-live="polite"
          className="fixed inset-0 z-[60] flex items-center justify-center bg-surface/70 backdrop-blur-[2px]"
        >
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-8 py-6 shadow-lg">
            <Spinner size="xl" />
            <p className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">{t('nav.switchingBusiness')}</p>
          </div>
        </div>
      )}

      <div
        className={`transition-[padding] duration-200 ease-out ${
          isSidebarCollapsed ? 'lg:pl-16' : 'lg:pl-60'
        }`}
      >
        {/* Hamburger mobile — header breadcrumb dihapus. */}
        <IconButton
          icon={<IconMenu className="size-4" />}
          label={t('nav.openMenu')}
          variant="ghost"
          size="sm"
          onClick={() => setMenuOpen(true)}
          className="fixed left-4 top-4 z-30 lg:hidden"
        />

        <main
          className={`mx-auto w-full ${
            isCalendarFullBleed
              ? 'flex h-dvh max-w-none flex-col overflow-hidden px-0 py-0'
              : 'max-w-6xl px-4 py-8 sm:px-6 lg:px-8'
          }`}
        >
          <Outlet />
        </main>
      </div>

      {/* Dialog settings — satu instance untuk seluruh shell (sidebar desktop
          & drawer mobile sama-sama memakai state isSettingsOpen). */}
      <SettingsDialog isOpen={isSettingsOpen} onOpenChange={setIsSettingsOpen} />
      {/* Dialog billing — dibuka dari dropdown akun di footer sidebar. */}
      <BillingDialog isOpen={isBillingOpen} onOpenChange={setIsBillingOpen} />
    </div>
  );
}
