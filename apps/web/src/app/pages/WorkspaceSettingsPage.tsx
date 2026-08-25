import { useMemo, useState, type FormEvent } from 'react';
import {
  Button,
  Dialog,
  DialogHeader,
  DropdownMenu,
  DropdownMenuItem,
  Layout,
  LayoutContent,
  LayoutFooter,
  Selector,
  TextInput,
  useToast,
} from '@astryxdesign/core';
import { Trans, useTranslation } from 'react-i18next';

import { apiFetch } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import {
  defaultIndustryForCategory,
  getTemplateCategoryLabelKey,
  type Workspace,
} from '../../lib/workspace';
import { useWorkspaceStore } from '../../stores/workspace';
import { industryEmoji, industryKey } from '../../i18n/enums';
import {
  BusinessInfoForm,
  businessInfoFromWorkspace,
  businessInfoToPayload,
  EMPTY_BUSINESS_INFO,
  type BusinessInfoValues,
} from '../components/BusinessInfoForm';
import { AvatarPicker } from '../components/AvatarPicker';
import { WorkspaceAvatar } from '../components/WorkspaceAvatar';
import { IconBuildings, IconDotsHorizontal, IconEdit, IconPlus, IconTrash } from '../shell/icons';
import { Card, ConfirmDialog, PageHeader } from '../shell/ui';

const EDITABLE_INDUSTRIES = [
  'barbershop',
  'nail-salon',
  'massage-spa',
  'pet-grooming',
  'car-detailing',
  'yoga-pilates',
  'personal-trainer',
  'photography-studio',
] as const;

/** Pemetaan industri ke templateCategory default untuk kompatibilitas API */
const INDUSTRY_TO_CATEGORY: Record<string, string> = {
  barbershop: 'beauty-wellness',
  'nail-salon': 'beauty-wellness',
  'massage-spa': 'beauty-wellness',
  'pet-grooming': 'pet-care',
  'car-detailing': 'automotive',
  'yoga-pilates': 'fitness',
  'personal-trainer': 'fitness',
  'photography-studio': 'photography-creative',
  clinic: 'healthcare-clinics',
  salon: 'beauty-wellness',
  fitness: 'fitness',
  spa: 'beauty-wellness',
  dental: 'healthcare-clinics',
  other: 'professional-services',
};

function WorkspaceActionMenu({
  onEdit,
  onDelete,
}: {
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <DropdownMenu
      placement="below"
      menuWidth={160}
      isMenuOpen={open}
      onOpenChange={setOpen}
      button={{
        label: t('common.moreActions'),
        isIconOnly: true,
        icon: <IconDotsHorizontal className="size-4" />,
        variant: 'ghost',
        size: 'sm',
        style: { padding: 0 },
      }}
    >
      <DropdownMenuItem
        icon={<IconEdit className="size-4" />}
        label={t('common.edit')}
        onClick={onEdit}
      />
      <DropdownMenuItem
        icon={<IconTrash className="size-4 text-red-500" />}
        label={<span className="font-medium text-red-600">{t('common.delete')}</span>}
        onClick={onDelete}
      />
    </DropdownMenu>
  );
}

export function WorkspaceSettingsPage() {
  const { t } = useTranslation();
  const toast = useToast();
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
  const [industry, setIndustry] = useState<string>('barbershop');
  const [avatar, setAvatar] = useState<string | null>(null);
  const [createInfo, setCreateInfo] = useState<BusinessInfoValues>(EMPTY_BUSINESS_INFO);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // ── Form edit bisnis (Dialog) ────────────────────────────
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editCategory, setEditCategory] = useState<string>('beauty-wellness');
  const [editIndustry, setEditIndustry] = useState<string>('barbershop');
  const [editAvatar, setEditAvatar] = useState<string | null>(null);
  const [editInfo, setEditInfo] = useState<BusinessInfoValues>(EMPTY_BUSINESS_INFO);
  const [editError, setEditError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const createIndustryOptions = useMemo(
    () =>
      EDITABLE_INDUSTRIES.map((ind) => ({
        value: ind,
        label: `${industryEmoji(ind)} ${t(industryKey(ind))}`,
      })),
    [t],
  );

  const editIndustryOptions = useMemo(() => {
    const list: string[] = [...EDITABLE_INDUSTRIES];
    if (editIndustry && !list.includes(editIndustry)) {
      list.push(editIndustry);
    }
    return list.map((ind) => ({
      value: ind,
      label: `${industryEmoji(ind)} ${t(industryKey(ind))}`,
    }));
  }, [editIndustry, t]);

  // ── Hapus bisnis (konfirmasi AlertDialog) ────────────────
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const createWorkspace = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setIsCreating(true);
    try {
      const templateCategory = INDUSTRY_TO_CATEGORY[industry] ?? 'beauty-wellness';
      const response = await apiFetch<{ workspace: Workspace }>('/me/workspaces', {
        method: 'POST',
        body: JSON.stringify({
          name,
          templateCategory,
          industry,
          ...(avatar !== null ? { avatarUrl: avatar } : {}),
          ...businessInfoToPayload(createInfo),
        }),
      });
      addWorkspace(response.workspace);
      setName('');
      setIndustry('barbershop');
      setAvatar(null);
      setCreateInfo(EMPTY_BUSINESS_INFO);
      setIsAdding(false);
      toast({
        body: t('ws.businessCreated'),
        type: 'info',
        isAutoHide: true,
        autoHideDuration: 4000,
      });
    } catch (err) {
      const msg = errorMessage(err, t, 'errors.createBusiness');
      setError(msg);
      toast({
        body: msg,
        type: 'error',
        isAutoHide: true,
        autoHideDuration: 5000,
      });
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
      toast({
        body: t('ws.businessUpdated'),
        type: 'info',
        isAutoHide: true,
        autoHideDuration: 4000,
      });
    } catch (err) {
      const msg = errorMessage(err, t, 'errors.saveBusiness');
      setEditError(msg);
      toast({
        body: msg,
        type: 'error',
        isAutoHide: true,
        autoHideDuration: 5000,
      });
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
      toast({
        body: t('ws.businessDeleted'),
        type: 'info',
        isAutoHide: true,
        autoHideDuration: 4000,
      });
    } catch (err) {
      setConfirmDeleteId(null);
      const msg = errorMessage(err, t, 'errors.deleteBusiness');
      setDeleteError(msg);
      toast({
        body: msg,
        type: 'error',
        isAutoHide: true,
        autoHideDuration: 5000,
      });
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
    setName('');
    setIndustry('barbershop');
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
        icon={IconBuildings}
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
        width={520}
      >
        {/* Layout (fill) = header tetap, konten scroll di tengah, footer aksi
            selalu terlihat — mencegah tombol submit terpotong di bawah fold. */}
        <Layout
          header={
            <DialogHeader
              title={t('ws.createTitle')}
              subtitle={t('ws.createSubtitle')}
              startContent={<IconBuildings className="size-5 shrink-0 text-amber-600" />}
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
                <Selector
                  label={t('ws.industry')}
                  description={t('ws.industryDesc')}
                  options={createIndustryOptions}
                  value={industry}
                  onChange={(val) => setIndustry(val ?? 'barbershop')}
                  width="100%"
                />
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
        width={520}
      >
        <Layout
          header={
            <DialogHeader
              title={t('ws.editBusiness')}
              subtitle={t('ws.editBusinessDesc')}
              startContent={<IconBuildings className="size-5 shrink-0 text-amber-600" />}
              onOpenChange={handleEditDialogClose}
              hasDivider
            />
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
                <Selector
                  label={t('ws.industry')}
                  description={t('ws.industryDesc')}
                  options={editIndustryOptions}
                  value={editIndustry}
                  onChange={(val) => setEditIndustry(val ?? 'barbershop')}
                  width="100%"
                />
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

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
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
              <WorkspaceAvatar workspace={workspace} size={44} radiusClass="rounded-md" />
              <WorkspaceActionMenu
                onEdit={() => startEdit(workspace)}
                onDelete={() => {
                  setConfirmDeleteId(workspace.id);
                  setDeleteError(null);
                }}
              />
            </div>

            <div className="mt-4 min-w-0">
              <h2 className="truncate text-base font-semibold text-zinc-900 dark:text-zinc-100">{workspace.name}</h2>
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{categoryLabel(workspace.templateCategory)}</p>
              <p className="mt-0.5 text-xs text-zinc-400">{t('ws.industry')} · {industryEmoji(workspace.industry)} {t(industryKey(workspace.industry))}</p>
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
