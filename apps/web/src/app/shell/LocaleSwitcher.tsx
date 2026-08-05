import { useState } from 'react';
import { DropdownMenu, DropdownMenuItem } from '@astryxdesign/core';
import { useTranslation } from 'react-i18next';

import type { SupportedLocale } from '../../i18n';
import { IconCheck, IconChevronDown, IconGlobe } from './icons';

export const LANGUAGE_OPTIONS: { code: SupportedLocale; label: string; short: string }[] = [
  { code: 'en', label: 'English', short: 'EN' },
  { code: 'id', label: 'Bahasa Indonesia', short: 'ID' },
];

// Hover trigger di sidebar gelap: token astryx default hanya ~5% overlay —
// nyaris tak terlihat di atas zinc-950 (sama seperti trigger akun di AppShell).
const darkTriggerStyle = {
  height: 'auto',
  minHeight: 28,
  padding: 8,
  gap: 4,
  '--color-overlay-hover': 'rgba(255,255,255,0.14)',
};

/**
 * Pemilih bahasa (EN / ID) berbasis DropdownMenu Astryx.
 * Preferensi disimpan otomatis ke localStorage oleh LanguageDetector
 * dan dipakai di seluruh sesi berikutnya.
 */
export function LocaleSwitcher({
  dark = false,
  placement = 'below',
}: {
  dark?: boolean;
  placement?: 'above' | 'below';
}) {
  const { i18n, t } = useTranslation();
  const [open, setOpen] = useState(false);

  const currentCode =
    LANGUAGE_OPTIONS.find((option) => option.code === (i18n.resolvedLanguage ?? i18n.language))
      ?.code ?? 'en';
  const current = LANGUAGE_OPTIONS.find((option) => option.code === currentCode) ?? LANGUAGE_OPTIONS[0];

  const select = (code: SupportedLocale) => {
    if (code !== i18n.resolvedLanguage) void i18n.changeLanguage(code);
  };

  return (
    <DropdownMenu
      placement={placement}
      hasChevron={false}
      menuWidth={160}
      isMenuOpen={open}
      onOpenChange={setOpen}
      button={{
        label: t('nav.language'),
        variant: 'ghost',
        size: 'sm',
        style: dark ? darkTriggerStyle : undefined,
        children: (
          <span className={`flex items-center gap-1.5 text-xs font-semibold ${dark ? 'text-zinc-300' : 'text-zinc-600'}`}>
            <IconGlobe className="size-3.5" />
            <span className="tracking-wide">{current.short}</span>
          </span>
        ),
        endContent: (
          <IconChevronDown
            className={`size-3 transition-transform duration-200 ${open ? 'rotate-180' : ''} ${
              dark ? 'text-zinc-500' : 'text-zinc-400'
            }`}
          />
        ),
      }}
    >
      {LANGUAGE_OPTIONS.map((option) => {
        const selected = option.code === currentCode;
        return (
          <DropdownMenuItem
            key={option.code}
            label={option.label}
            onClick={() => select(option.code)}
            // Popover astryx mengikuti tema OS (light-dark), bukan konteks `dark` —
            // jadi pakai amber-500 agar kontras di popover putih maupun gelap.
            // DropdownMenuItem astryx tidak mengekspos aria-selected; centang ini
            // adalah satu-satunya indikator seleksi (bukan yang tak sengaja dihapus).
            endContent={
              selected ? <IconCheck className="size-3.5 text-amber-500" /> : undefined
            }
          />
        );
      })}
    </DropdownMenu>
  );
}
