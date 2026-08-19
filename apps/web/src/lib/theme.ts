/** Preferensi tema app — 'system' mengikuti OS, 'light'/'dark' memaksa. */
export type AppTheme = 'system' | 'light' | 'dark';

export const THEME_STORAGE_KEY = 'oriole.sidebarTheme';

/** Baca preferensi tema tersimpan (default 'dark' bila belum pernah di-set). */
export function readStoredTheme(): AppTheme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'dark';
  } catch {
    return 'dark';
  }
}

/** Simpan preferensi tema (best-effort; localStorage bisa tidak tersedia). */
export function storeTheme(theme: AppTheme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // localStorage tidak tersedia — abaikan, berlaku untuk sesi ini.
  }
}

/**
 * Tulis tema ter-resolve ke `<html data-theme>` — hook astryx
 * (html[data-theme] → color-scheme) dan variant Tailwind `dark:` keduanya
 * membaca atribut ini. Mode 'system' di-resolve dari prefers-color-scheme.
 */
export function applyTheme(theme: AppTheme): void {
  const prefersDark =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  const resolved = theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme;
  document.documentElement.dataset.theme = resolved;
}

/** Terapkan tema tersimpan — dipanggil saat boot, SEBELUM render pertama,
 * agar halaman apa pun (termasuk auth di luar AppShell) langsung bertema
 * benar tanpa flash. */
export function applyStoredTheme(): void {
  applyTheme(readStoredTheme());
}
