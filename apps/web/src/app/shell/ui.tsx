import { useEffect, useId, useState, type ComponentType, type CSSProperties, type ReactNode } from 'react';
import {
  Button,
  Card as AstryxCard,
  Dialog,
  DropdownMenu,
  DropdownMenuItem,
  Layout,
  LayoutContent,
  LayoutFooter,
  Spinner,
  TextInput,
  type ButtonVariant,
  type CardVariant,
} from '@astryxdesign/core';
import { Trans, useTranslation } from 'react-i18next';

import { IconArrowRight, IconDotsVertical, IconRefreshCw, type IconProps } from './icons';

/* ── Reload menu (⋯) ─────────────────────────────────────────
 * Tombol tiga titik yang membuka menu aksi — saat ini berisi Reload.
 * Dipakai di header halaman agar toolbar tetap bersih dan aksi
 * sekunder (refresh) tidak memakan tempat. */

export function ReloadMenuButton({
  isFetching,
  onReload,
}: {
  isFetching: boolean;
  onReload: () => void;
}) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <DropdownMenu
      placement="below"
      hasChevron={false}
      menuWidth={180}
      isMenuOpen={menuOpen}
      onOpenChange={setMenuOpen}
      // Penanda untuk override posisi-area (menu membuka ke kiri dari tombol).
      className="menu-open-left"
      button={{
        label: t('common.moreActions'),
        variant: 'ghost',
        size: 'md',
        isIconOnly: true,
        icon: <IconDotsVertical className="size-4 text-zinc-500" />,
        // Border tanpa background: ghost = transparan, border diberi lewat
        // inline agar setara dengan tombol "New booking" di sebelahnya.
        style: { border: '1px solid var(--color-border-emphasized)' },
      }}
    >
      <DropdownMenuItem
        icon={
          isFetching ? <Spinner size="sm" /> : <IconRefreshCw className="size-4" />
        }
        label={t('common.reload')}
        isDisabled={isFetching}
        onClick={() => {
          setMenuOpen(false);
          onReload();
        }}
      />
    </DropdownMenu>
  );
}

/* ── Page header ────────────────────────────────────────────── */

export function PageHeader({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-zinc-900">{title}</h1>
        {description && <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-zinc-500">{description}</p>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

/* ── Card ───────────────────────────────────────────────────── */

export function Card({
  children,
  className = '',
  variant = 'default',
  style,
}: {
  children: ReactNode;
  className?: string;
  /** 'transparent' = tanpa border & background (kontainer tanpa bobot visual). */
  variant?: CardVariant;
  /** Gaya inline — dipakai mis. override token radius (`--_card-radius`). */
  style?: CSSProperties & Record<`--${string}`, string | number>;
}) {
  // Wrapper layout — padding tetap dikontrol oleh pemanggil lewat className.
  return (
    <AstryxCard padding={0} variant={variant} className={className} style={style}>
      {children}
    </AstryxCard>
  );
}

/* ── Stat card (Dashboard / Analytics) ──────────────────────── */

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  trend,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: ComponentType<IconProps>;
  trend?: { label: string; positive: boolean };
}) {
  const { t } = useTranslation();
  return (
    <Card className="p-5 transition duration-200 hover:-translate-y-0.5 hover:shadow-md">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">{label}</p>
          <p className="mt-2 text-2xl font-bold tracking-tight text-zinc-900">{value}</p>
          {hint && <p className="mt-1 text-xs text-zinc-500">{hint}</p>}
        </div>
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-600">
          <Icon className="size-5" />
        </span>
      </div>
      {trend && (
        <div className="mt-3 flex items-center gap-1.5 text-xs">
          <span
            className={`rounded-md px-1.5 py-0.5 font-semibold ${
              trend.positive ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'
            }`}
          >
            {trend.positive ? '▲' : '▼'} {trend.label}
          </span>
          <span className="text-zinc-400">{t('common.vsLastMonth')}</span>
        </div>
      )}
    </Card>
  );
}

/* ── Sesi habis (401) — ditampilkan sesaat sebelum RequireAuth
   mengarahkan ke halaman masuk. ─────────────────────────────── */

export function SessionExpiredCard() {
  const { t } = useTranslation();
  return (
    <Card className="flex flex-col items-center gap-4 p-10 text-center">
      <span className="flex size-12 items-center justify-center rounded-2xl bg-zinc-100">
        <Spinner size="md" />
      </span>
      <p className="text-sm text-zinc-500">{t('errors.sessionExpired')}</p>
    </Card>
  );
}

/* ── ConfirmDialog ────────────────────────────────────────────
 * Varian AlertDialog yang menutup saat klik di luar dialog.
 * AlertDialog astryx meng-hardcode purpose='form' (klik luar diblokir),
 * jadi di sini dipakai Dialog purpose='info' agar backdrop-click menutup.
 * Tampilan & perilaku tombol disamakan dengan AlertDialog bawaan. */

export function ConfirmDialog({
  isOpen,
  onOpenChange,
  title,
  description,
  cancelLabel,
  actionLabel,
  actionVariant = 'destructive',
  isActionLoading = false,
  onAction,
  width = 420,
  confirmText,
}: {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => unknown;
  title: string;
  /** Bisa berisi markup — mis. <Trans> dengan <strong> untuk penekanan. */
  description: ReactNode;
  cancelLabel?: string;
  actionLabel: string;
  actionVariant?: ButtonVariant;
  isActionLoading?: boolean;
  onAction: () => unknown;
  width?: number | string;
  /**
   * Bila diisi, user harus mengetik teks persis ini (mis. nama project) di
   * input konfirmasi sebelum tombol aksi aktif — mencegah hapus tidak sengaja.
   */
  confirmText?: string;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const descriptionId = useId();
  const [typed, setTyped] = useState('');

  // Reset input setiap dialog dibuka/ditutup agar tidak basi antar project.
  useEffect(() => {
    if (!isOpen) setTyped('');
  }, [isOpen]);

  const hasConfirm = confirmText !== undefined;
  // Nama kosong (lookup gagal/stale) TIDAK pernah memenuhi gate — kalau tidak,
  // '' === '' membuat tombol aktif tanpa mengetik apa pun.
  const matches = hasConfirm && confirmText !== '' && typed === confirmText;
  const canConfirm = !hasConfirm || matches;

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      purpose="info"
      width={width}
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <Layout
        content={
          <LayoutContent>
            <h2 id={titleId} className="text-lg font-bold text-zinc-900">{title}</h2>
            <p id={descriptionId} className="mt-1.5 text-sm leading-relaxed text-zinc-500">{description}</p>

            {hasConfirm && (
              <div className="mt-4 space-y-1.5">
                <p className="text-xs font-medium leading-relaxed text-zinc-500">
                  <Trans
                    i18nKey="confirm.typeToConfirm"
                    values={{ name: confirmText }}
                    components={{ strong: <strong className="font-semibold text-zinc-900" /> }}
                  />
                </p>
                <TextInput
                  label={t('confirm.typeToConfirmAria')}
                  isLabelHidden
                  value={typed}
                  onChange={setTyped}
                  placeholder={confirmText}
                  isRequired
                  hasAutoFocus
                  width="100%"
                  onEnter={() => {
                    if (canConfirm && !isActionLoading) onAction();
                  }}
                />
                {typed.length > 0 && !matches && (
                  <p role="alert" className="text-xs font-medium text-red-600">
                    {t('confirm.mismatch')}
                  </p>
                )}
              </div>
            )}
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <div className="flex justify-end gap-2">
              <Button
                label={cancelLabel ?? 'Cancel'}
                variant="ghost"
                onClick={() => onOpenChange(false)}
              />
              <Button
                label={actionLabel}
                variant={actionVariant}
                onClick={() => onAction()}
                isLoading={isActionLoading}
                isDisabled={!canConfirm || isActionLoading}
              />
            </div>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

/* ── Empty state ────────────────────────────────────────────── */

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: ComponentType<IconProps>;
  title: string;
  description: string;
  action?: { label: string; onClick?: () => void; disabled?: boolean };
}) {
  return (
    <Card className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <span className="flex size-14 items-center justify-center rounded-2xl bg-zinc-100 text-zinc-400">
        <Icon className="size-7" />
      </span>
      <h3 className="mt-5 text-base font-semibold text-zinc-900">{title}</h3>
      <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-zinc-500">{description}</p>
      {action && (
        <Button
          className="mt-6"
          label={action.label}
          variant="primary"
          icon={<IconArrowRight className="size-4" />}
          isDisabled={action.disabled}
          onClick={action.onClick}
        />
      )}
    </Card>
  );
}
