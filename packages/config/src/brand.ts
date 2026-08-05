/**
 * Branding terpusat untuk Oriole.
 * Ubah di satu tempat — dipakai ulang oleh web, api, dan email.
 */
export const brand = {
  name: 'Oriole',
  slug: 'oriole',
  tagline: 'Booking, orchestrated.',
  emailFrom: 'Oriole <no-reply@oriole.app>',
} as const;

export type Brand = typeof brand;
