import { lazy, Suspense, type ComponentType } from 'react';
import { Navigate, createBrowserRouter } from 'react-router';

import { RequireAuth } from './app/auth/RequireAuth';
import { AppShell } from './app/shell/AppShell';
import { BookingDetailPage } from './app/pages/BookingDetailPage';
import { BookingNewPage } from './app/pages/BookingNewPage';
import { BookingsPage } from './app/pages/BookingsPage';
import { CallsPage } from './app/pages/CallsPage';
import { IntegrationsPage } from './app/pages/IntegrationsPage';
import { ContactsPage } from './app/pages/ContactsPage';
import { DashboardPage } from './app/pages/DashboardPage';
import { HelpPage } from './app/pages/HelpPage';
import { InboxPage } from './app/pages/InboxPage';
import { LandingPage } from './app/pages/LandingPage';
import { OnboardingPage } from './app/pages/OnboardingPage';
import { WorkspaceSettingsPage } from './app/pages/WorkspaceSettingsPage';

/**
 * Halaman auth di-lazy-load agar SDK Neon Auth (better-auth) tidak ikut
 * bundle awal — chunk terpisah baru dimuat saat membuka /auth/*.
 */
const SignInPage = lazy(() =>
  import('./app/auth/SignInPage').then((m) => ({ default: m.SignInPage })),
);
const SignUpPage = lazy(() =>
  import('./app/auth/SignUpPage').then((m) => ({ default: m.SignUpPage })),
);
const CallbackPage = lazy(() =>
  import('./app/auth/CallbackPage').then((m) => ({ default: m.CallbackPage })),
);

/**
 * AnalyticsPage di-lazy-load agar recharts (dependency tremor) tidak ikut
 * bundle awal — chunk terpisah baru dimuat saat membuka /app/analytics.
 */
const AnalyticsPage = lazy(() =>
  import('./app/pages/AnalyticsPage').then((m) => ({ default: m.AnalyticsPage })),
);

function withSuspense(Component: ComponentType) {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center bg-surface">
          <span
            aria-hidden
            className="inline-block size-6 animate-spin rounded-full border-2 border-zinc-300 border-t-amber-500"
          />
        </main>
      }
    >
      <Component />
    </Suspense>
  );
}

/**
 * Router utama.
 * - `/` → landing page publik.
 * - `/app/*` → app shell terproteksi (RequireAuth); halaman section sebagai child.
 * - `/auth/*` → halaman auth (lazy).
 */
export const router = createBrowserRouter([
  {
    path: '/',
    element: <LandingPage />,
  },
  {
    path: '/app/onboarding',
    element: (
      <RequireAuth>
        <OnboardingPage />
      </RequireAuth>
    ),
  },
  {
    path: '/app',
    element: (
      <RequireAuth>
        <AppShell />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <Navigate to="/app/dashboard" replace /> },
      { path: 'dashboard', element: <DashboardPage /> },
      { path: 'bookings', element: <BookingsPage /> },
      { path: 'bookings/new', element: <BookingNewPage /> },
      { path: 'bookings/:id', element: <BookingDetailPage /> },
      { path: 'contacts', element: <ContactsPage /> },
      { path: 'inbox', element: <InboxPage /> },
      { path: 'integrations', element: <IntegrationsPage /> },
      // Backward compat: /app/channels lama → halaman Integrations.
      { path: 'channels', element: <Navigate to="/app/integrations" replace /> },
      { path: 'calls', element: <CallsPage /> },
      { path: 'analytics', element: withSuspense(AnalyticsPage) },
      // Billing kini dialog dari dropdown akun (sidebar footer) — URL lama
      // dialihkan ke dashboard agar bookmark/link lama tidak 404.
      { path: 'billing', element: <Navigate to="/app/dashboard" replace /> },
      // Settings kini dialog dari menu sidebar — URL lama dialihkan ke
      // dashboard agar bookmark/link lama tidak 404.
      { path: 'settings', element: <Navigate to="/app/dashboard" replace /> },
      { path: 'workspaces', element: <WorkspaceSettingsPage /> },
      { path: 'help', element: <HelpPage /> },
    ],
  },
  {
    path: '/auth/sign-in',
    element: withSuspense(SignInPage),
  },
  {
    path: '/auth/sign-up',
    element: withSuspense(SignUpPage),
  },
  {
    path: '/auth/callback',
    element: withSuspense(CallbackPage),
  },
]);
