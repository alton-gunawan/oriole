import { lazy, Suspense, type ComponentType } from 'react';
import { Navigate, createBrowserRouter } from 'react-router';

import { RequireAuth } from './app/auth/RequireAuth';
import { AppShell } from './app/shell/AppShell';
import { BillingPage } from './app/pages/BillingPage';
import { BookingDetailPage } from './app/pages/BookingDetailPage';
import { BookingNewPage } from './app/pages/BookingNewPage';
import { BookingsPage } from './app/pages/BookingsPage';
import { CallsPage } from './app/pages/CallsPage';
import { ChannelsPage } from './app/pages/ChannelsPage';
import { ContactsPage } from './app/pages/ContactsPage';
import { DashboardPage } from './app/pages/DashboardPage';
import { HelpPage } from './app/pages/HelpPage';
import { InboxPage } from './app/pages/InboxPage';
import { LandingPage } from './app/pages/LandingPage';
import { SettingsPage } from './app/pages/SettingsPage';
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
        <main className="flex min-h-screen items-center justify-center bg-zinc-50">
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
      { path: 'channels', element: <ChannelsPage /> },
      { path: 'calls', element: <CallsPage /> },
      { path: 'analytics', element: withSuspense(AnalyticsPage) },
      { path: 'billing', element: <BillingPage /> },
      { path: 'settings', element: <SettingsPage /> },
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
