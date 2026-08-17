import { useMemo, useState, type FormEvent } from 'react';
import { INDUSTRIES } from '@oriole/call-goals';
import {
  Badge,
  Button,
  Dialog,
  DialogHeader,
  DropdownMenu,
  DropdownMenuItem,
  IconButton,
  Layout,
  LayoutContent,
  LayoutFooter,
  LayoutHeader,
  TextInput,
} from '@astryxdesign/core';
import { Trans, useTranslation } from 'react-i18next';

import { apiFetch } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import {
  defaultIndustryForCategory,
  getTemplateCategoryLabelKey,
  RECOMMENDED_TEMPLATE_CATEGORIES,
  type Workspace,
} from '../../lib/workspace';
import { useWorkspaceStore } from '../../stores/workspace';
import { industryKey } from '../../i18n/enums';
import {
  BusinessInfoForm,
  businessInfoFromWorkspace,
  businessInfoToPayload,
  EMPTY_BUSINESS_INFO,
  type BusinessInfoValues,
} from '../components/BusinessInfoForm';
import { AvatarPicker } from '../components/AvatarPicker';
import { WorkspaceAvatar } from '../components/WorkspaceAvatar';
import { IconCheck, IconChevronDown, IconEdit, IconPlus, IconSettings, IconTrash, IconX } from '../shell/icons';
import { Card, ConfirmDialog, PageHeader } from '../shell/ui';

/** Pilihan kategori — dipakai form buat & edit bisnis. Industri CALL-E mengikuti kategori otomatis. */
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
                ? 'border-amber-400 bg-white dark:bg-zinc-900 ring-2 ring-amber-500/10'
                : 'border-zinc-200 dark:border-zinc-700 bg-white/70 dark:bg-zinc-900/70 hover:border-zinc-300 dark:hover:border-zinc-600'
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
            <span className="flex items-center gap-2 text-sm font-medium text-zinc-800 dark:text-zinc-200">
              <span className="flex size-7 items-center justify-center rounded-md bg-zinc-100 dark:bg-zinc-800 text-xs">{item.emoji}</span>
              {t(item.labelKey)}
              <IconCheck className={`ml-auto size-4 ${selected ? 'text-amber-600' : 'text-transparent'}`} />
            </span>
          </label>
        );
      })}
    </div>
  );
}

/**
 * Dropdown industri bisnis — dipakai dialog edit bisnis. Opsi dari
 * INDUSTRIES (@oriole/call-goals), label terjemahan via industryKey.
 */
function IndustryDropdown({
  value,
  onChange,
}: {
  value: string;
  onChange: (industry: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const selected = INDUSTRIES.find((industry) => industry === value);
  const label = selected ? t(industryKey(selected)) : t(industryKey(value));

  return (
    <DropdownMenu
      placement="below"
      hasChevron={false}
      menuWidth={260}
      isMenuOpen={open}
      onOpenChange={setOpen}
      button={{
        label: t('ws.industry'),
        variant: 'secondary',
        size: 'sm',
        children: (
          <span className="flex w-56 items-center justify-between gap-2 text-xs font-semibold text-zinc-600 dark:text-zinc-400">
            <span className="truncate">{label}</span>
            <IconChevronDown
              className={`size-3 shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''} text-zinc-400`}
            />
          </span>
        ),
      }}
    >
      {INDUSTRIES.map((industry) => {
        const selected = industry === value;
        return (
          <DropdownMenuItem
            key={industry}
            label={t(industryKey(industry))}
            onClick={() => onChange(industry)}
            endContent={
              selected ? <IconCheck className="size-3.5 text-amber-500" /> : undefined
            }
          />
        );
      })}
    </DropdownMenu>
  );
}

export function WorkspaceSettingsPage() {
  const { t } = useTranslation();
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const addWorkspace = useWorkspaceStore((state) => state.addWorkspace);
  const updateWorkspace = useWorkspaceStore((state) => state.updateWorkspace);
  const removeWorkspace = useWorkspaceStore((state) => state.removeWorkspace);

  // Bisnis yang sedang aktif (current) selalu tampil sebagai kartu PERTAMA
  // dan ditandai badge "Current" — legend status di bagian Bisnis.
  const orderedWorkspaces = useMemo(
    () =>
      [...workspaces].sort((a, b) => {
        if (a.id === activeWorkspaceId) return -1;
        if (b.id === activeWorkspaceId) return 1;
        return 0;
      }),
    [workspaces, activeWorkspaceId],
  );

  // ── Form buat bisnis ─────────────────────────────────────
  const [isAdding, setIsAdding] = useState(false);
  const [name, setName] = useState('');
  const [category, setCategory] = useState<string>(RECOMMENDED_TEMPLATE_CATEGORIES[0].id);
  const [avatar, setAvatar] = useState<string | null>(null);
  const [createInfo, setCreateInfo] = useState<BusinessInfoValues>(EMPTY_BUSINESS_INFO);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // ── Form edit bisnis (Dialog) ────────────────────────────
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editCategory, setEditCategory] = useState<string>(RECOMMENDED_TEMPLATE_CATEGORIES[0].id);
  const [editIndustry, setEditIndustry] = useState<string>(defaultIndustryForCategory(RECOMMENDED_TEMPLATE_CATEGORIES[0].id));
  const [editInfo, setEditInfo] = useState<BusinessInfoValues>(EMPTY_BUSINESS_INFO);
  const [editAvatar, setEditAvatar] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // ── Hapus bisnis (konfirmasi AlertDialog) ────────────────
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
          ...businessInfoToPayload(createInfo),
        }),
      });
      addWorkspace(response.workspace);
      setName('');
      setCategory(RECOMMENDED_TEMPLATE_CATEGORIES[0].id);
      setAvatar(null);
      setCreateInfo(EMPTY_BUSINESS_INFO);
      setIsAdding(false);
    } catch (err) {
      setError(errorMessage(err, t, 'errors.createBusiness'));
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
    setEditIndustry(workspace.industry ?? defaultIndustryForCategory(workspace.templateCategory));
    setEditInfo(businessInfoFromWorkspace(workspace));
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
          // Kategori (template) tidak diubah di dialog edit — hanya dipilih
          // saat create. Industri dikirim eksplisit dari dropdown.
          templateCategory: editCategory,
          industry: editIndustry,
          ...(avatarChanged ? { avatarUrl: editAvatar } : {}),
          // Info bisnis detail — form edit adalah sumber kebenaran field ini
          // (string kosong dikirim null agar field terhapus di DB).
          ...businessInfoToPayload(editInfo),
        }),
      });
      updateWorkspace(response.workspace);
      setEditingId(null);
    } catch (err) {
      setEditError(errorMessage(err, t, 'errors.saveBusiness'));
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
      setDeleteError(errorMessage(err, t, 'errors.deleteBusiness'));
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
    setCreateInfo(EMPTY_BUSINESS_INFO);
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
        icon={IconSettings}
      >
        <button
          type="button"
          onClick={openAddForm}
          className="inline-flex items-center gap-2 rounded-lg bg-amber-500 h-8 px-4 text-base font-semibold text-white shadow-sm transition hover:bg-amber-600 active:scale-[0.98]"
        >
          <IconPlus className="size-4" />
          {t('ws.addBusiness')}
        </button>
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
                  label={t('ws.businessName')}
                  value={name}
                  onChange={setName}
                  placeholder={t('ws.businessPlaceholder')}
                  width="100%"
                />
                <AvatarPicker key="create-workspace-avatar" value={avatar} onChange={setAvatar} name={name || '?'} />
                <CategoryPicker value={category} onChange={setCategory} name="workspace-category" />
                <BusinessInfoForm value={createInfo} onChange={setCreateInfo} />
              </form>
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              {error && <p role="alert" className="pb-2 text-right text-sm text-red-600">{error}</p>}
              <div className="flex justify-end gap-2">
                <Button label={t('common.cancel')} variant="ghost" onClick={closeAddForm} isDisabled={isCreating} />
                <Button
                  label={t('ws.createBusiness')}
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
            <LayoutHeader hasDivider>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{t('ws.editBusiness')}</h2>
                  <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">{t('ws.editBusinessDesc')}</p>
                </div>
                <IconButton
                  label={t('common.close')}
                  icon={<IconX className="size-4" />}
                  variant="ghost"
                  onClick={closeEditForm}
                />
              </div>
            </LayoutHeader>
          }
          content={
            <LayoutContent>
              <form id="edit-workspace-form" onSubmit={saveWorkspace} className="space-y-5">
                <TextInput
                  label={t('ws.businessName')}
                  value={editName}
                  onChange={setEditName}
                  width="100%"
                />
                {/* key=editingId → remount per bisnis agar state picker ikut bisnis. */}
                <AvatarPicker key={`edit-${editingId}`} value={editAvatar} onChange={setEditAvatar} name={editName || '?'} />
                <div>
                  <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('ws.industry')}</p>
                  <p className="mt-1 mb-2 text-xs text-zinc-500 dark:text-zinc-400">{t('ws.industryDesc')}</p>
                  <IndustryDropdown value={editIndustry} onChange={setEditIndustry} />
                </div>
                <BusinessInfoForm value={editInfo} onChange={setEditInfo} />
              </form>
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              <>
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
              </>
            </LayoutFooter>
          }
        />
      </Dialog>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {orderedWorkspaces.map((workspace) => (
          <Card
            key={workspace.id}
            className={`p-5 transition hover:-translate-y-0.5 hover:shadow-md ${
              // Legend: kartu bisnis yang sedang aktif diberi border amber di
              // pinggir agar langsung terlihat mana yang sedang dipakai.
              workspace.id === activeWorkspaceId
                ? 'border-amber-400 ring-2 ring-amber-500/30'
                : ''
            }`}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex min-w-0 items-center gap-3">
                <WorkspaceAvatar workspace={workspace} size={44} radiusClass="rounded-xl" />
                <div className="min-w-0">
                  <h2 className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{workspace.name}</h2>
                  <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{categoryLabel(workspace.templateCategory)}</p>
                  <p className="mt-0.5 text-xs text-zinc-400">{t('ws.industry')} · {t(industryKey(workspace.industry))}</p>
                </div>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                {workspace.id === activeWorkspaceId && (
                  <Badge variant="warning" label={t('ws.current')} />
                )}
                <Badge variant="success" label={t('ws.ready')} />
              </div>
            </div>

            <p className="mt-5 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
              {t('ws.separateNote')}
            </p>
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

      {/* Konfirmasi hapus bisnis — menutup saat klik di luar dialog. */}
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

      {deleteError && (
        <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-400">
          {deleteError}
        </p>
      )}
    </div>
  );
}
