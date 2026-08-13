import { useState } from 'react';
import { DropdownMenu, DropdownMenuItem, DropdownMenuSubMenu } from '@astryxdesign/core';
import { useTranslation } from 'react-i18next';

import type { SupportedLocale } from '../../i18n';
import { IconCheck, IconChevronDown, IconGlobe } from './icons';

export const LANGUAGE_OPTIONS: {
  code: SupportedLocale;
  label: string;
  short: string;
  flag: string;
}[] = [
  { code: 'en', label: 'English', short: 'EN', flag: '🇬🇧' },
  { code: 'id', label: 'Bahasa Indonesia', short: 'ID', flag: '🇮🇩' },
];

/** Kode bahasa aktif — fallback ke Inggris. */
function activeCode(resolved: string | undefined, fallback: string): SupportedLocale {
  return (
    LANGUAGE_OPTIONS.find((option) => option.code === (resolved ?? fallback))?.code ?? 'en'
  );
}

/** Opsi bahasa yang sedang aktif (flag/label/short) — dipakai trigger, submenu, dll. */
export function useActiveLanguageOption() {
  const { i18n } = useTranslation();
  const code = activeCode(i18n.resolvedLanguage, i18n.language);
  return LANGUAGE_OPTIONS.find((option) => option.code === code) ?? LANGUAGE_OPTIONS[0];
}

/**
 * Item bahasa siap-pakai untuk disisipkan ke DropdownMenu mana pun (footer
 * sidebar, halaman auth, dll.). Setiap item menampilkan flag + nama bahasa,
 * centang pada bahasa aktif, dan menutup menu otomatis saat dipilih.
 */
export function LanguageMenuItems() {
  const { i18n } = useTranslation();
  const currentCode = activeCode(i18n.resolvedLanguage, i18n.language);

  const select = (code: SupportedLocale) => {
    if (code !== i18n.resolvedLanguage) void i18n.changeLanguage(code);
  };

  return (
    <>
      {LANGUAGE_OPTIONS.map((option) => {
        const selected = option.code === currentCode;
        return (
          <DropdownMenuItem
            key={option.code}
            icon={<span className="text-sm leading-none">{option.flag}</span>}
            label={option.label}
            onClick={() => select(option.code)}
            endContent={
              selected ? <IconCheck className="size-3.5 text-amber-500" /> : undefined
            }
          />
        );
      })}
    </>
  );
}

/**
 * Submenu bahasa siap-pakai untuk DropdownMenu (footer sidebar, dll.): satu
 * baris "Language" dengan ikon globe yang membuka flyout berisi pilihan bahasa
 * (flag + nama + centang pada bahasa aktif). Memilih bahasa menutup seluruh
 * menu (submenu Astryx meng-close stack penuh pada leaf selection).
 */
export function LanguageSubMenu() {
  const { t } = useTranslation();
  return (
    <DropdownMenuSubMenu
      label={t('nav.language')}
      icon={<IconGlobe className="size-4" />}
    >
      <LanguageMenuItems />
    </DropdownMenuSubMenu>
  );
}

/**
 * Pemilih bahasa (EN / ID) berbasis DropdownMenu Astryx, dengan flag di
 * trigger maupun di tiap item. Preferensi disimpan otomatis ke localStorage
 * oleh LanguageDetector dan dipakai di seluruh sesi berikutnya.
 */
export function LocaleSwitcher({ placement = 'below' }: { placement?: 'above' | 'below' }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const current = useActiveLanguageOption();

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
        children: (
          <span className="flex items-center gap-1.5 text-xs font-semibold text-zinc-600">
            <span className="text-sm leading-none">{current.flag}</span>
            <span className="tracking-wide">{current.short}</span>
          </span>
        ),
        endContent: (
          <IconChevronDown
            className={`size-3 transition-transform duration-200 ${open ? 'rotate-180' : ''} text-zinc-400`}
          />
        ),
      }}
    >
      <LanguageMenuItems />
    </DropdownMenu>
  );
}
