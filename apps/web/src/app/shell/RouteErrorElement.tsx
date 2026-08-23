import { useEffect, useState, type ReactNode } from 'react';
import { isRouteErrorResponse, Link, useLocation, useRouteError } from 'react-router';
import { useTranslation } from 'react-i18next';

import { captureClientError } from '../../lib/analytics';
import { AppLogo } from '../components/AppLogo';
import {
  IconAlertTriangle,
  IconCheck,
  IconCopy,
  IconHome,
  IconRefreshCw,
  IconSearch,
  IconShield,
} from './icons';

/**
 * Layar error presentational — dipakai oleh RouteErrorElement (error router)
 * dan RootErrorBoundary (error di luar router, mis. provider). Tanpa hook
 * router supaya aman dirender dari mana saja.
 */
export function ErrorScreen({
  title,
  description,
  actions,
  technicalDetails,
  variant = 'error',
}: {
  title: string;
  description: string;
  actions?: ReactNode;
  /** Detail teknis (status/message/stack) — ditampilkan dalam <details>. */
  technicalDetails?: string;
  variant?: 'error' | 'notFound' | 'auth';
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (!technicalDetails) return;
    void navigator.clipboard.writeText(technicalDetails);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const getIcon = () => {
    switch (variant) {
      case 'notFound':
        return (
          <span className="flex size-16 items-center justify-center rounded-2xl border border-blue-500/20 bg-blue-500/10 text-blue-400 shadow-[0_0_30px_rgba(59,130,246,0.15)]">
            <IconSearch className="size-8" />
          </span>
        );
      case 'auth':
        return (
          <span className="flex size-16 items-center justify-center rounded-2xl border border-amber-500/20 bg-amber-500/10 text-amber-400 shadow-[0_0_30px_rgba(245,158,11,0.15)]">
            <IconShield className="size-8" />
          </span>
        );
      case 'error':
      default:
        return (
          <span className="flex size-16 items-center justify-center rounded-2xl border border-rose-500/20 bg-rose-500/10 text-rose-400 shadow-[0_0_30px_rgba(244,63,94,0.15)]">
            <IconAlertTriangle className="size-8" />
          </span>
        );
    }
  };

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-[#090d10] px-5 py-12 text-zinc-100 selection:bg-rose-500/30">
      <div
        className="pointer-events-none absolute left-1/2 top-1/2 size-[32rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#1017e8]/10 blur-3xl"
        aria-hidden="true"
      />

      <Link
        to="/"
        className="relative mb-8 inline-flex items-center gap-2.5 opacity-90 transition hover:opacity-100"
      >
        <span className="flex size-7 items-center justify-center overflow-hidden rounded-md bg-white text-zinc-950 shadow-sm">
          <AppLogo />
        </span>
        <span className="text-[17px] font-semibold text-white">oriole</span>
      </Link>

      <div className="relative w-full max-w-md rounded-3xl border border-white/10 bg-zinc-900/80 p-7 text-center shadow-2xl backdrop-blur-xl sm:p-9">
        <div className="mx-auto flex justify-center">{getIcon()}</div>
        <h1 className="mt-6 text-2xl font-bold tracking-tight text-white sm:text-3xl">
          {title}
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-zinc-400 sm:text-base">
          {description}
        </p>

        {actions && (
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            {actions}
          </div>
        )}

        {import.meta.env.DEV && technicalDetails && (
          <details className="mt-8 overflow-hidden rounded-2xl border border-white/10 bg-zinc-950/80 text-left">
            <summary className="flex cursor-pointer select-none items-center justify-between px-4 py-3 text-xs font-mono font-medium text-zinc-400 transition hover:text-zinc-200">
              <span>{t('errors.technicalDetails')}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleCopy();
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-zinc-300 transition hover:bg-white/10 hover:text-white"
              >
                {copied ? (
                  <>
                    <IconCheck className="size-3 text-emerald-400" />
                    <span>Copied</span>
                  </>
                ) : (
                  <>
                    <IconCopy className="size-3" />
                    <span>Copy</span>
                  </>
                )}
              </button>
            </summary>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words border-t border-white/10 px-4 py-3 font-mono text-[11px] leading-relaxed text-zinc-400 selection:bg-rose-500/30">
              {technicalDetails}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}

/**
 * errorElement untuk route React Router — pengganti layar
 * "Unexpected Application Error!" bawaan. Dipasang di router:
 *  - level root: menangkap error landing/auth & 404 global;
 *  - per-halaman /app: menangkap error di dalam shell (sidebar tetap tampil).
 *
 * Varian:
 *  - 404 (isRouteErrorResponse) → "Halaman tidak ditemukan" + tombol beranda;
 *  - 401 → sesi berakhir, arahkan ke halaman masuk;
 *  - lainnya → pesan generik + muat ulang.
 */
export function RouteErrorElement() {
  const { t } = useTranslation();
  const error = useRouteError();
  const location = useLocation();

  // Error tracking PostHog — hanya error sungguhan (bukan 404/401 respon).
  useEffect(() => {
    if (error instanceof Error) void captureClientError(error);
  }, [error]);

  const is404 = isRouteErrorResponse(error) && error.status === 404;
  const is401 = isRouteErrorResponse(error) && error.status === 401;

  // Rincian teknis — berguna untuk debugging (status, data, atau stack).
  const technicalDetails = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}\n${typeof error.data === 'string' ? error.data : JSON.stringify(error.data)}`
    : error instanceof Error
      ? `${error.message}\n${error.stack ?? ''}`
      : undefined;

  // Di dalam /app → kembali ke dashboard; di luar → beranda publik.
  const homeTo = location.pathname.startsWith('/app') ? '/app/dashboard' : '/';
  const homeLabel = location.pathname.startsWith('/app')
    ? t('errors.backToDashboard')
    : t('errors.backToHome');

  if (is404) {
    return (
      <ErrorScreen
        variant="notFound"
        title={t('errors.notFoundTitle')}
        description={t('errors.notFoundDesc')}
        actions={
          <Link
            to={homeTo}
            className="inline-flex items-center gap-2 rounded-xl bg-white px-5 py-2.5 text-sm font-medium text-black shadow-sm transition hover:bg-zinc-200"
          >
            <IconHome className="size-4" />
            {homeLabel}
          </Link>
        }
      />
    );
  }

  if (is401) {
    return (
      <ErrorScreen
        variant="auth"
        title={t('errors.routeSessionTitle')}
        description={t('errors.routeSessionDesc')}
        actions={
          <Link
            to="/auth/sign-in"
            className="inline-flex items-center gap-2 rounded-xl bg-white px-5 py-2.5 text-sm font-medium text-black shadow-sm transition hover:bg-zinc-200"
          >
            {t('errors.signInAgain')}
          </Link>
        }
      />
    );
  }

  return (
    <ErrorScreen
      variant="error"
      title={t('errors.routeErrorTitle')}
      description={t('errors.routeErrorDesc')}
      technicalDetails={technicalDetails}
      actions={
        <>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex items-center gap-2 rounded-xl bg-white px-5 py-2.5 text-sm font-medium text-black shadow-sm transition hover:bg-zinc-200"
          >
            <IconRefreshCw className="size-4" />
            {t('errors.reloadPage')}
          </button>
          <Link
            to={homeTo}
            className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-white/10"
          >
            <IconHome className="size-4" />
            {homeLabel}
          </Link>
        </>
      }
    />
  );
}
