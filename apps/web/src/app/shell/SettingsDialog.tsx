import { useEffect, useState, type ComponentType } from 'react';
import {
  Button,
  Dialog,
  DialogHeader,
  Layout,
  LayoutContent,
  LayoutFooter,
  Switch,
  TextInput,
} from '@astryxdesign/core';
import { Trans, useTranslation } from 'react-i18next';

import { apiFetch } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { useSessionStore } from '../../stores/session';
import { useWorkspaceStore } from '../../stores/workspace';
import type { TranslationKey } from '../../i18n';
import { WorkspaceAvatar } from '../components/WorkspaceAvatar';
import { ConfirmDialog } from './ui';
import { IconBell, IconFolder, IconTrash, IconUser, type IconProps } from './icons';

/** Bagian dalam dialog Settings — ditampilkan di sidebar kiri dialog. */
const SECTIONS: {
  id: 'profile' | 'notifications' | 'projects';
  labelKey: TranslationKey;
  icon: ComponentType<IconProps>;
}[] = [
  { id: 'profile', labelKey: 'settings.profile', icon: IconUser },
  { id: 'notifications', labelKey: 'settings.notifications', icon: IconBell },
  { id: 'projects', labelKey: 'settings.projects', icon: IconFolder },
];

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
}: {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => unknown;
}) {
  const { t } = useTranslation();
  const user = useSessionStore((s) => s.user);
  const setUser = useSessionStore((s) => s.setUser);
  const [name, setName] = useState(user?.name ?? '');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bagian aktif dialog — kembali ke Profil setiap dibuka.
  const [activeSection, setActiveSection] = useState<(typeof SECTIONS)[number]['id']>('profile');
  // Notifikasi — state lokal (placeholder; belum ada API persist).
  const [notif, setNotif] = useState({ email: true, call: false, weekly: true });

  // ── Hapus project (soft-delete, permanen setelah 3 hari) ──
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const removeWorkspace = useWorkspaceStore((s) => s.removeWorkspace);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Segarkan form setiap dialog dibuka (nama bisa berubah dari luar),
  // bersihkan error lama, dan kembalikan ke bagian Profil.
  useEffect(() => {
    if (isOpen) {
      setName(user?.name ?? '');
      setError(null);
      setActiveSection('profile');
    }
  }, [isOpen, user?.name]);

  const close = () => {
    if (!isSaving && !isDeleting) onOpenChange(false);
  };

  const deleteWorkspace = async (workspaceId: string) => {
    setDeleteError(null);
    setIsDeleting(true);
    try {
      await apiFetch<{ ok: boolean }>(`/me/workspaces/${workspaceId}`, { method: 'DELETE' });
      removeWorkspace(workspaceId);
      setConfirmDeleteId(null);
      // Project terakhir dihapus → tutup dialog Settings; di belakangnya app
      // berpindah ke state kosong/onboarding (activeWorkspaceId null).
      if (workspaces.length === 1) onOpenChange(false);
    } catch (err) {
      setConfirmDeleteId(null);
      setDeleteError(errorMessage(err, t, 'errors.deleteProject'));
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
      const res = await apiFetch<{ name: string }>('/me', {
        method: 'PATCH',
        body: JSON.stringify({ name: clean }),
      });
      if (user) setUser({ ...user, name: res.name });
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
                className="w-44 shrink-0 space-y-1 self-start"
              >
                {SECTIONS.map((section) => {
                  const active = section.id === activeSection;
                  return (
                    <button
                      key={section.id}
                      type="button"
                      onClick={() => setActiveSection(section.id)}
                      aria-current={active ? 'true' : undefined}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium transition ${
                        active
                          ? 'bg-amber-500/10 text-amber-700'
                          : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'
                      }`}
                    >
                      <section.icon
                        className={`size-4 shrink-0 ${active ? 'text-amber-600' : 'text-zinc-400'}`}
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
                        <p className="truncate text-base font-semibold text-zinc-900">
                          {user?.name ?? t('common.noName')}
                        </p>
                        <p className="truncate text-sm text-zinc-500">{user?.email ?? ''}</p>
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

                    <p className="text-xs leading-relaxed text-zinc-400">{t('settings.emailManaged')}</p>
                  </div>
                )}

                {activeSection === 'projects' && (
                  <div className="space-y-4">
                    <p className="text-sm leading-relaxed text-zinc-500">{t('settings.projectsDesc')}</p>

                    <div className="space-y-2">
                      {workspaces.length === 0 ? (
                        <p className="rounded-xl border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-zinc-400">
                          {t('settings.projectsEmpty')}
                        </p>
                      ) : (
                        workspaces.map((workspace) => (
                          <div
                            key={workspace.id}
                            className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-3 transition hover:border-zinc-300"
                          >
                            <WorkspaceAvatar workspace={workspace} size={36} radiusClass="rounded-lg" />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-semibold text-zinc-900">{workspace.name}</p>
                              {workspace.id === activeWorkspaceId && (
                                <p className="text-xs font-medium text-amber-600">{t('nav.activeProject')}</p>
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

                {activeSection === 'notifications' && (
                  <div className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 px-4">
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

      {/* Konfirmasi hapus project — Dialog astryx memakai elemen <dialog>
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
            components={{ strong: <strong className="font-bold text-black" /> }}
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
    </>
  );
}
