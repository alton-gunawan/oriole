import { useState, type FormEvent } from 'react';
import {
  Badge,
  Button,
  Dialog,
  DialogHeader,
  Layout,
  LayoutContent,
  LayoutFooter,
  TextInput,
} from '@astryxdesign/core';
import { Trans, useTranslation } from 'react-i18next';

import { apiFetch } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import {
  getTemplateCategoryLabelKey,
  RECOMMENDED_TEMPLATE_CATEGORIES,
  type Workspace,
} from '../../lib/workspace';
import { useWorkspaceStore } from '../../stores/workspace';
import { industryKey } from '../../i18n/enums';
import { AvatarPicker } from '../components/AvatarPicker';
import { WorkspaceAvatar } from '../components/WorkspaceAvatar';
import { IconCheck, IconEdit, IconPlus, IconTrash } from '../shell/icons';
import { Card, ConfirmDialog, PageHeader } from '../shell/ui';
import { WorkspaceCallSettings } from '../shell/WorkspaceCallSettings';

/** Pilihan kategori — dipakai form buat & edit project. Industri CALL-E mengikuti kategori otomatis. */
function CategoryPicker({
  value,
  onChange,
  name,
}: {
  value: string;
  onChange: (categoryId: string) => void;
  name: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-2 gap-2">
      {RECOMMENDED_TEMPLATE_CATEGORIES.map((item) => {
        const selected = value === item.id;
        return (
          <label
            key={item.id}
            className={`cursor-pointer rounded-lg border p-3 transition ${
              selected
                ? 'border-amber-400 bg-white ring-2 ring-amber-500/10'
                : 'border-zinc-200 bg-white/70 hover:border-zinc-300'
            }`}
          >
            <input
              type="radio"
              name={name}
              value={item.id}
              checked={selected}
              onChange={() => onChange(item.id)}
              className="sr-only"
            />
            <span className="flex items-center gap-2 text-sm font-medium text-zinc-800">
              <span className="flex size-7 items-center justify-center rounded-md bg-zinc-100 text-xs">{item.emoji}</span>
              {t(item.labelKey)}
              <IconCheck className={`ml-auto size-4 ${selected ? 'text-amber-600' : 'text-transparent'}`} />
            </span>
          </label>
        );
      })}
    </div>
  );
}

export function WorkspaceSettingsPage() {
  const { t } = useTranslation();
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const addWorkspace = useWorkspaceStore((state) => state.addWorkspace);
  const updateWorkspace = useWorkspaceStore((state) => state.updateWorkspace);
  const removeWorkspace = useWorkspaceStore((state) => state.removeWorkspace);

  // ── Form buat project ─────────────────────────────────────
  const [isAdding, setIsAdding] = useState(false);
  const [name, setName] = useState('');
  const [category, setCategory] = useState<string>(RECOMMENDED_TEMPLATE_CATEGORIES[0].id);
  const [avatar, setAvatar] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // ── Form edit project (Dialog) ────────────────────────────
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editCategory, setEditCategory] = useState<string>(RECOMMENDED_TEMPLATE_CATEGORIES[0].id);
  const [editAvatar, setEditAvatar] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // ── Hapus project (konfirmasi AlertDialog) ────────────────
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const createWorkspace = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setIsCreating(true);
    try {
      const response = await apiFetch<{ workspace: Workspace }>('/me/workspaces', {
        method: 'POST',
        body: JSON.stringify({
          name,
          templateCategory: category,
          ...(avatar !== null ? { avatarUrl: avatar } : {}),
        }),
      });
      addWorkspace(response.workspace);
      setName('');
      setCategory(RECOMMENDED_TEMPLATE_CATEGORIES[0].id);
      setAvatar(null);
      setIsAdding(false);
    } catch (err) {
      setError(errorMessage(err, t, 'errors.createProject'));
    } finally {
      setIsCreating(false);
    }
  };

  const startEdit = (workspace: Workspace) => {
    setIsAdding(false);
    setConfirmDeleteId(null);
    setDeleteError(null);
    setEditingId(workspace.id);
    setEditName(workspace.name);
    setEditCategory(workspace.templateCategory);
    setEditAvatar(workspace.avatarUrl ?? null);
    setEditError(null);
  };

  const closeEditForm = () => {
    setEditingId(null);
    setEditError(null);
  };

  const handleEditDialogClose = (open: boolean) => {
    if (!open) closeEditForm();
  };

  const saveWorkspace = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingId) return;
    setEditError(null);
    setIsSaving(true);
    try {
      // Avatar dikirim hanya bila berubah (null → hapus avatar, kembali ke planet nama).
      const workspace = workspaces.find((item) => item.id === editingId);
      const avatarChanged = editAvatar !== (workspace?.avatarUrl ?? null);
      const response = await apiFetch<{ workspace: Workspace }>(`/me/workspaces/${editingId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: editName,
          templateCategory: editCategory,
          ...(avatarChanged ? { avatarUrl: editAvatar } : {}),
        }),
      });
      updateWorkspace(response.workspace);
      setEditingId(null);
    } catch (err) {
      setEditError(errorMessage(err, t, 'errors.saveProject'));
    } finally {
      setIsSaving(false);
    }
  };

  const deleteWorkspace = async (workspaceId: string) => {
    setDeleteError(null);
    setIsDeleting(true);
    try {
      await apiFetch<{ ok: boolean }>(`/me/workspaces/${workspaceId}`, { method: 'DELETE' });
      removeWorkspace(workspaceId);
      setConfirmDeleteId(null);
    } catch (err) {
      setConfirmDeleteId(null);
      setDeleteError(errorMessage(err, t, 'errors.deleteProject'));
    } finally {
      setIsDeleting(false);
    }
  };

  const handleDialogClose = (open: boolean) => {
    if (!open) closeAddForm();
  };

  const closeAddForm = () => {
    setIsAdding(false);
    setError(null);
  };

  const openAddForm = () => {
    setEditingId(null);
    setError(null);
    setAvatar(null);
    setIsAdding(true);
  };

  /** Label kategori terjemahan; fallback ke raw id bila tidak dikenal. */
  const categoryLabel = (categoryId: string): string => {
    const key = getTemplateCategoryLabelKey(categoryId);
    return key ? t(key) : categoryId;
  };

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('ws.title')}
        description={t('ws.description')}
      >
        <Button
          label={t('ws.addProject')}
          variant="secondary"
          icon={<IconPlus className="size-4" />}
          onClick={openAddForm}
        />
      </PageHeader>

      <Dialog
        isOpen={isAdding}
        onOpenChange={handleDialogClose}
        purpose="info"
        width={560}
      >
        {/* Layout (fill) = header tetap, konten scroll di tengah, footer aksi
            selalu terlihat — mencegah tombol submit terpotong di bawah fold. */}
        <Layout
          header={
            <DialogHeader
              title={t('ws.createTitle')}
              subtitle={t('ws.createSubtitle')}
              onOpenChange={handleDialogClose}
              hasDivider
            />
          }
          content={
            <LayoutContent>
              <form id="create-workspace-form" onSubmit={createWorkspace} className="space-y-5">
                <TextInput
                  label={t('ws.projectName')}
                  value={name}
                  onChange={setName}
                  placeholder={t('ws.projectPlaceholder')}
                  width="100%"
                />
                <AvatarPicker key="create-workspace-avatar" value={avatar} onChange={setAvatar} name={name || '?'} />
                <CategoryPicker value={category} onChange={setCategory} name="workspace-category" />
              </form>
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              {error && <p role="alert" className="pb-2 text-right text-sm text-red-600">{error}</p>}
              <div className="flex justify-end gap-2">
                <Button label={t('common.cancel')} variant="ghost" onClick={closeAddForm} isDisabled={isCreating} />
                <Button
                  label={t('ws.createProject')}
                  variant="primary"
                  isLoading={isCreating}
                  isDisabled={isCreating || name.trim().length < 2}
                  type="submit"
                  form="create-workspace-form"
                />
              </div>
            </LayoutFooter>
          }
        />
      </Dialog>

      <Dialog
        isOpen={editingId !== null}
        onOpenChange={handleEditDialogClose}
        purpose="info"
        width={560}
      >
        <Layout
          header={
            <DialogHeader
              title={t('ws.editProject')}
              subtitle={t('ws.editProjectDesc')}
              onOpenChange={handleEditDialogClose}
              hasDivider
            />
          }
          content={
            <LayoutContent>
              <form id="edit-workspace-form" onSubmit={saveWorkspace} className="space-y-5">
                <TextInput
                  label={t('ws.projectName')}
                  value={editName}
                  onChange={setEditName}
                  width="100%"
                />
                {/* key=editingId → remount per project agar state picker ikut project. */}
                <AvatarPicker key={`edit-${editingId}`} value={editAvatar} onChange={setEditAvatar} name={editName || '?'} />
                <CategoryPicker value={editCategory} onChange={setEditCategory} name="edit-workspace-category" />
              </form>
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              {editError && <p role="alert" className="pb-2 text-right text-sm text-red-600">{editError}</p>}
              <div className="flex justify-end gap-2">
                <Button label={t('common.cancel')} variant="ghost" onClick={closeEditForm} isDisabled={isSaving} />
                <Button
                  label={t('common.save')}
                  variant="primary"
                  isLoading={isSaving}
                  isDisabled={isSaving || editName.trim().length < 2}
                  type="submit"
                  form="edit-workspace-form"
                />
              </div>
            </LayoutFooter>
          }
        />
      </Dialog>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {workspaces.map((workspace) => (
          <Card key={workspace.id} className="p-5 transition hover:-translate-y-0.5 hover:shadow-md">
            <div className="flex items-start justify-between gap-4">
              <div className="flex min-w-0 items-center gap-3">
                <WorkspaceAvatar workspace={workspace} size={44} radiusClass="rounded-xl" />
                <div className="min-w-0">
                  <h2 className="truncate text-sm font-semibold text-zinc-900">{workspace.name}</h2>
                  <p className="mt-1 text-xs text-zinc-500">{categoryLabel(workspace.templateCategory)}</p>
                  <p className="mt-0.5 text-xs text-zinc-400">{t('ws.industry')} · {t(industryKey(workspace.industry))}</p>
                </div>
              </div>
              <Badge variant="success" label={t('ws.ready')} />
            </div>

            <p className="mt-5 text-xs leading-relaxed text-zinc-500">
              {t('ws.separateNote')}
            </p>
            <WorkspaceCallSettings workspace={workspace} />
            <div className="mt-4 flex justify-end gap-1">
              <Button
                label={t('common.edit')}
                variant="ghost"
                size="sm"
                icon={<IconEdit className="size-3.5" />}
                onClick={() => startEdit(workspace)}
              />
              <Button
                label={t('common.delete')}
                variant="ghost"
                size="sm"
                icon={<IconTrash className="size-3.5" />}
                onClick={() => {
                  setConfirmDeleteId(workspace.id);
                  setDeleteError(null);
                }}
              />
            </div>
          </Card>
        ))}
      </div>

      {/* Konfirmasi hapus project — menutup saat klik di luar dialog. */}
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

      {deleteError && (
        <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {deleteError}
        </p>
      )}
    </div>
  );
}
