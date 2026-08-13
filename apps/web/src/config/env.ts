/**
 * Environment frontend — variabel `VITE_*` (dibaca Vite saat build).
 * Default aman untuk development lokal (Vite mem-proxy /api → localhost:3000).
 */
export const env = {
  API_URL: import.meta.env.VITE_API_URL ?? '/api',
  NEON_AUTH_URL: (import.meta.env.VITE_NEON_AUTH_URL as string | undefined) ?? '',
  // PostHog analytics — token publik `phc_...` (aman di bundle browser).
  // Kosong = analitik frontend nonaktif (app tetap berjalan normal).
  POSTHOG_PROJECT_TOKEN: (import.meta.env.VITE_POSTHOG_PROJECT_TOKEN as string | undefined) ?? '',
  POSTHOG_HOST:
    (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ?? 'https://us.i.posthog.com',
} as const;
