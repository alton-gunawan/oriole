import { lazy, Suspense, type ComponentType } from 'react';
import { Navigate, createBrowserRouter } from 'react-router';

import { RequireAuth } from './app/auth/RequireAuth';
import { AppShell } from './app/shell/AppShell';
import { RouteErrorElement } from './app/shell/RouteErrorElement';
import { BookingDetailPage } from './app/pages/BookingDetailPage';
import { BookingNewPage } from './app/pages/BookingNewPage';
import { BookingsPage } from './app/pages/BookingsPage';
import { CalendarPage } from './app/pages/CalendarPage';
import { StaffPage } from './app/pages/StaffPage';
import { ServicesPage } from './app/pages/ServicesPage';
import { CallsPage } from './app/pages/CallsPage';
import { IntegrationsPage } from './app/pages/IntegrationsPage';
import { ContactDetailPage } from './app/pages/ContactDetailPage';
import { ContactEnsureRedirect } from './app/pages/ContactEnsureRedirect';
import { ContactsPage } from './app/pages/ContactsPage';
import { DashboardPage } from './app/pages/DashboardPage';
import { HelpPage } from './app/pages/HelpPage';
import { InboxPage } from './app/pages/InboxPage';
import { LandingPage } from './app/pages/LandingPage';
import { OnboardingPage } from './app/pages/OnboardingPage';
import { StaffDetailPage } from './app/pages/StaffDetailPage';
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
const ForgotPasswordPage = lazy(() =>
  import('./app/auth/ForgotPasswordPage').then((m) => ({ default: m.ForgotPasswordPage })),
);
const CallbackPage = lazy(() =>
  import('./app/auth/CallbackPage').then((m) => ({ default: m.CallbackPage })),
);
const UserAgreementPage = lazy(() =>
  import('./app/pages/UserAgreementPage').then((m) => ({ default: m.UserAgreementPage })),
);
const PrivacyPolicyPage = lazy(() =>
  import('./app/pages/PrivacyPolicyPage').then((m) => ({ default: m.PrivacyPolicyPage })),
);

function withSuspense(Component: ComponentType) {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center bg-surface">
          <span
            aria-hidden
            className="inline-block size-6 animate-spin rounded-full border-2 border-zinc-300 dark:border-zinc-600 border-t-amber-500"
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
/**
 * errorElement per halaman /app — error dirender DI DALAM shell (sidebar &
 * navigasi tetap tampil), bukan menggantikan seluruh AppShell.
 */
const PAGE_ERROR = { errorElement: <RouteErrorElement /> };

export const router = createBrowserRouter([
  {
    // Root pathless: errorElement level teratas menangkap error landing,
    // auth, dan URL tak dikenal (404) — pengganti layar default React Router.
    errorElement: <RouteErrorElement />,
    children: [
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
          { index: true, ...PAGE_ERROR, element: <Navigate to="/app/dashboard" replace /> },
          { path: 'dashboard', ...PAGE_ERROR, element: <DashboardPage /> },
          { path: 'bookings', ...PAGE_ERROR, element: <BookingsPage /> },
          { path: 'bookings/new', ...PAGE_ERROR, element: <BookingNewPage /> },
          { path: 'calendar', ...PAGE_ERROR, element: <CalendarPage /> },
          { path: 'staff', ...PAGE_ERROR, element: <StaffPage /> },
          { path: 'staff/:id', ...PAGE_ERROR, element: <StaffDetailPage /> },
          { path: 'services', ...PAGE_ERROR, element: <ServicesPage /> },
          { path: 'bookings/:id', ...PAGE_ERROR, element: <BookingDetailPage /> },
          { path: 'contacts', ...PAGE_ERROR, element: <ContactsPage /> },
          // Redirect one-shot dari kolom customer (booking tanpa contactId):
          // pastikan kontak ada → buka detail-nya. Static segment menang atas
          // 'contacts/:id' di react-router, jadi urutan tidak masalah.
          { path: 'contacts/ensure', ...PAGE_ERROR, element: <ContactEnsureRedirect /> },
          { path: 'contacts/:id', ...PAGE_ERROR, element: <ContactDetailPage /> },
          { path: 'inbox', ...PAGE_ERROR, element: <InboxPage /> },
          { path: 'integrations', ...PAGE_ERROR, element: <IntegrationsPage /> },
          // Backward compat: /app/channels lama → halaman Integrations.
          { path: 'channels', ...PAGE_ERROR, element: <Navigate to="/app/integrations" replace /> },
          { path: 'calls', ...PAGE_ERROR, element: <CallsPage /> },
          // Billing kini dialog dari dropdown akun (sidebar footer) — URL lama
          // dialihkan ke dashboard agar bookmark/link lama tidak 404.
          { path: 'billing', ...PAGE_ERROR, element: <Navigate to="/app/dashboard" replace /> },
          // Settings kini dialog dari menu sidebar — URL lama dialihkan ke
          // dashboard agar bookmark/link lama tidak 404.
          { path: 'settings', ...PAGE_ERROR, element: <Navigate to="/app/dashboard" replace /> },
          { path: 'workspaces', ...PAGE_ERROR, element: <WorkspaceSettingsPage /> },
          { path: 'help', ...PAGE_ERROR, element: <HelpPage /> },
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
        path: '/auth/forgot-password',
        element: withSuspense(ForgotPasswordPage),
      },
      {
        path: '/auth/callback',
        element: withSuspense(CallbackPage),
      },
      {
        path: '/user-agreement',
        element: withSuspense(UserAgreementPage),
      },
      {
        path: '/terms',
        element: <Navigate to="/user-agreement" replace />,
      },
      {
        path: '/privacy-policy',
        element: withSuspense(PrivacyPolicyPage),
      },
      {
        path: '/privacy',
        element: <Navigate to="/privacy-policy" replace />,
      },
    ],
  },
]);
