/**
 * Environment frontend — variabel `VITE_*` (dibaca Vite saat build).
 * Default aman untuk development lokal (Vite mem-proxy /api → localhost:3000).
 */
export const env = {
  API_URL: import.meta.env.VITE_API_URL ?? '/api',
  NEON_AUTH_URL: (import.meta.env.VITE_NEON_AUTH_URL as string | undefined) ?? '',
} as const;
