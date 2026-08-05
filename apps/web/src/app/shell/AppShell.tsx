import { useEffect, useState, type ComponentType, type CSSProperties } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { DropdownMenu, DropdownMenuItem, IconButton } from '@astryxdesign/core';
import { useTranslation } from 'react-i18next';

import { signOut } from '../../lib/session';
import { useSessionStore } from '../../stores/session';
import { useWorkspaceStore } from '../../stores/workspace';
import type { TranslationKey } from '../../i18n';
import { LocaleSwitcher } from './LocaleSwitcher';
import {
  IconCalendar,
  IconChart,
  IconCheck,
  IconChat,
  IconChevronDown,
  IconCreditCard,
  IconDashboard,
  IconHelp,
  IconLogout,
  IconPlus,
  IconMenu,
  IconPhone,
  IconPlug,
  IconSettings,
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
  { to: '/app/bookings', labelKey: 'nav.bookings', icon: IconCalendar },
  { to: '/app/contacts', labelKey: 'nav.contacts', icon: IconUsers },
  { to: '/app/inbox', labelKey: 'nav.inbox', icon: IconChat },
  { to: '/app/channels', labelKey: 'nav.channels', icon: IconPlug },
  { to: '/app/calls', labelKey: 'nav.calls', icon: IconPhone },
  { to: '/app/analytics', labelKey: 'nav.analytics', icon: IconChart },
  { to: '/app/billing', labelKey: 'nav.billing', icon: IconCreditCard },
  { to: '/app/settings', labelKey: 'nav.settings', icon: IconSettings },
  { to: '/app/help', labelKey: 'nav.help', icon: IconHelp },
];

function Logo() {
  return (
    <div className="flex h-16 items-center gap-2.5 px-5">
      <span className="flex size-8 items-center justify-center rounded-lg bg-amber-500 text-sm font-extrabold text-zinc-950">
        O
      </span>
      <span className="text-sm font-bold tracking-tight text-zinc-100">Oriole</span>
    </div>
  );
}

// Perkuat hover trigger akun: token astryx default hanya ~5% overlay —
// nyaris tak terlihat di atas zinc-950. Dipasang di TOMBOL (bukan container)
// karena popover menu dirender inline sebagai sibling — kalau di container,
// item hover di popover terang ikut ke-override jadi tak terlihat.
const userMenuTriggerStyle = {
  height: 'auto',
  minHeight: 36,
  padding: 8,
  justifyContent: 'space-between',
  gap: 8,
  '--color-overlay-hover': 'rgba(255,255,255,0.14)',
};

// Hover merah untuk aksi logout: token yang sama dipakai astryx untuk hover
// item menu, di-override jadi merah (scoped ke item ini saja).
const logoutItemHoverStyle = {
  '--color-overlay-hover': 'rgba(239,68,68,0.18)',
} as CSSProperties;

// Trigger switcher project di sidebar gelap — sama seperti trigger akun.
const projectTriggerStyle = {
  height: 'auto',
  minHeight: 40,
  padding: 8,
  justifyContent: 'space-between',
  gap: 8,
  '--color-overlay-hover': 'rgba(255,255,255,0.14)',
};

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
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const navigate = useNavigate();

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
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const lastOpenedAt = useWorkspaceStore((s) => s.lastOpenedAt);
  const workspaceSwitcher = (workspaceId: string) => {
    setActiveWorkspace(workspaceId);
  };
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId);

  const onLogout = async () => {
    await signOut();
    navigate('/auth/sign-in', { replace: true });
  };

  const sidebar = (onNavigate?: () => void) => (
    <aside className="flex h-full w-64 flex-col bg-zinc-950">
      <Logo />

      <div className="px-3 pb-3">
        <DropdownMenu
          placement="below"
          hasChevron={false}
          menuWidth={300}
          isMenuOpen={projectMenuOpen}
          onOpenChange={setProjectMenuOpen}
          button={{
              label: activeWorkspace?.name ?? t('nav.selectProject'),
              variant: 'ghost',
              width: '100%',
              style: projectTriggerStyle,
              children: (
                <span className="flex min-w-0 items-center gap-2">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-zinc-950 text-[11px] font-bold text-amber-400">
                    {(activeWorkspace?.name ?? '?').slice(0, 1).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-left text-xs font-semibold text-zinc-200">
                    {activeWorkspace?.name ?? t('nav.selectProject')}
                  </span>
                </span>
              ),
              endContent: (
                <IconChevronDown
                  className={`size-3.5 shrink-0 text-zinc-500 transition-transform duration-200 ${
                    projectMenuOpen ? 'rotate-180' : ''
                  }`}
                />
              ),
            }}
          >
            {workspaces.map((workspace) => {
              const isActive = workspace.id === activeWorkspaceId;
              const lastOpened = lastOpenedAt[workspace.id];
              return (
                <DropdownMenuItem
                  key={workspace.id}
                  icon={
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-[11px] font-bold text-amber-700">
                      {workspace.name.slice(0, 1).toUpperCase()}
                    </span>
                  }
                  label={
                    <span className="block truncate text-xs font-semibold">{workspace.name}</span>
                  }
                  description={
                    lastOpened
                      ? t('nav.lastOpened', {
                          time: formatLastOpened(lastOpened, i18n.resolvedLanguage ?? 'en'),
                        })
                      : t('nav.lastOpenedNever')
                  }
                  endContent={
                    isActive ? <IconCheck className="size-4 shrink-0 text-amber-500" /> : undefined
                  }
                  onClick={() => workspaceSwitcher(workspace.id)}
                />
              );
            })}

            <div className="border-t border-zinc-200/70 p-1.5 dark:border-zinc-700/60">
              <NavLink
                to="/app/workspaces"
                onClick={() => {
                  // Item menu menutup popover sendiri via ctx.closeMenu(); link
                  // footer bukan menu item — tutup manual agar tidak tetap
                  // terbuka di atas halaman Workspaces.
                  setProjectMenuOpen(false);
                  onNavigate?.();
                }}
                className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold text-amber-600 transition hover:bg-amber-500/10 hover:text-amber-700 dark:text-amber-500 dark:hover:text-amber-400"
              >
                <IconPlus className="size-3.5" /> {t('nav.manageProjects')}
              </NavLink>
            </div>
          </DropdownMenu>
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-2">
        <p className="px-3 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-widest text-zinc-600">
          {t('nav.menu')}
        </p>
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/app/dashboard'}
            onClick={onNavigate}
            className={({ isActive }) =>
              `group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
                isActive
                  ? 'bg-amber-500/10 text-amber-400'
                  : 'text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-100'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <item.icon
                  className={`size-[18px] shrink-0 transition ${isActive ? 'text-amber-400' : 'text-zinc-500 group-hover:text-zinc-300'}`}
                />
                {t(item.labelKey)}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-zinc-800/80 p-3">
        <div className="mb-2 flex items-center justify-between px-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-zinc-600">
            {t('nav.language')}
          </span>
          <LocaleSwitcher dark placement="above" />
        </div>
        <DropdownMenu
          placement="above"
          hasChevron={false}
          isMenuOpen={userMenuOpen}
          onOpenChange={setUserMenuOpen}
          button={{
            label: user?.name ?? t('nav.user'),
            variant: 'ghost',
            width: '100%',
            style: userMenuTriggerStyle,
            children: (
              <span className="flex min-w-0 items-center gap-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-xs font-bold text-amber-400">
                  {(user?.name ?? user?.email ?? 'U').slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-left text-xs font-semibold text-zinc-200">
                    {user?.name ?? t('nav.user')}
                  </span>
                  <span className="block truncate text-left text-[11px] text-zinc-500">
                    {user?.email ?? ''}
                  </span>
                </span>
              </span>
            ),
            endContent: (
              <IconChevronDown
                className={`size-4 shrink-0 text-zinc-600 transition-transform duration-200 ${
                  userMenuOpen ? 'rotate-180' : ''
                }`}
              />
            ),
          }}
        >
          <DropdownMenuItem
            label={t('common.logout')}
            icon={<IconLogout className="size-4" />}
            onClick={onLogout}
            style={logoutItemHoverStyle}
          />
        </DropdownMenu>
      </div>
    </aside>
  );

  return (
    <div className="min-h-screen bg-zinc-50">
      {/* Sidebar — desktop */}
      <div className="fixed inset-y-0 left-0 z-40 hidden w-64 lg:block">{sidebar()}</div>

      {/* Sidebar — mobile (drawer) */}
      {menuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" id="app-menu-drawer">
          <div
            className="absolute inset-0 bg-zinc-950/60 backdrop-blur-sm"
            onClick={() => setMenuOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 w-64 shadow-2xl">
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

      <div className="lg:pl-64">
        {/* Hamburger mobile — header breadcrumb dihapus. */}
        <IconButton
          icon={<IconMenu className="size-4" />}
          label={t('nav.openMenu')}
          variant="ghost"
          size="sm"
          onClick={() => setMenuOpen(true)}
          className="fixed left-4 top-4 z-30 lg:hidden"
        />

        <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
