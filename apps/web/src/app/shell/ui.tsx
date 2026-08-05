import type { ComponentType, ReactNode } from 'react';
import { Button, Card as AstryxCard, Spinner } from '@astryxdesign/core';
import { useTranslation } from 'react-i18next';

import { IconArrowRight, type IconProps } from './icons';

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

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  // Wrapper layout — padding tetap dikontrol oleh pemanggil lewat className.
  return (
    <AstryxCard padding={0} className={className}>
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
