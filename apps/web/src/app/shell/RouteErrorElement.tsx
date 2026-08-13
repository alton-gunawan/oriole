import { useEffect, type ReactNode } from 'react';
import { isRouteErrorResponse, Link, useLocation, useRouteError } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '@astryxdesign/core';

import { captureClientError } from '../../lib/analytics';
import { IconAlertTriangle, IconHome, IconRefreshCw } from './icons';

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
}: {
  title: string;
  description: string;
  actions?: ReactNode;
  /** Detail teknis (status/message/stack) — ditampilkan dalam <details>. */
  technicalDetails?: string;
}) {
  const { t } = useTranslation();
  return (
    // `<div>` bukan `<main>` — komponen ini bisa dirender DI DALAM <main>
    // AppShell (error halaman /app), jadi main bertingkat harus dihindari.
    <div className="flex min-h-screen flex-col items-center justify-center bg-surface px-6 py-12">
      <div className="w-full max-w-md text-center">
        <span className="mx-auto flex size-16 items-center justify-center rounded-2xl bg-red-50 text-red-500">
          <IconAlertTriangle className="size-8" />
        </span>
        <h1 className="mt-6 text-2xl font-bold tracking-tight text-zinc-900">{title}</h1>
        <p className="mt-3 text-sm leading-relaxed text-zinc-500">{description}</p>

        {actions && <div className="mt-8 flex flex-wrap items-center justify-center gap-3">{actions}</div>}

        {/* Detail teknis hanya untuk pengembang — bisa berisi data error
            mentah yang sensitif; di produksi disembunyikan. */}
        {import.meta.env.DEV && technicalDetails && (
          <details className="mt-8 rounded-xl border border-zinc-200 bg-zinc-50 text-left">
            <summary className="cursor-pointer select-none px-4 py-2.5 text-xs font-medium text-zinc-500 transition hover:text-zinc-700">
              {t('errors.technicalDetails')}
            </summary>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words border-t border-zinc-200 px-4 py-3 font-mono text-[11px] leading-relaxed text-zinc-500">
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
        title={t('errors.notFoundTitle')}
        description={t('errors.notFoundDesc')}
        actions={
          <Link
            to={homeTo}
            className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700"
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
        title={t('errors.routeSessionTitle')}
        description={t('errors.routeSessionDesc')}
        actions={
          <Link
            to="/auth/sign-in"
            className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700"
          >
            {t('errors.signInAgain')}
          </Link>
        }
      />
    );
  }

  return (
    <ErrorScreen
      title={t('errors.routeErrorTitle')}
      description={t('errors.routeErrorDesc')}
      technicalDetails={technicalDetails}
      actions={
        <>
          <Button
            label={t('errors.reloadPage')}
            variant="primary"
            icon={<IconRefreshCw className="size-4" />}
            onClick={() => window.location.reload()}
          />
          <Link
            to={homeTo}
            className="inline-flex items-center gap-2 rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50"
          >
            <IconHome className="size-4" />
            {homeLabel}
          </Link>
        </>
      }
    />
  );
}
