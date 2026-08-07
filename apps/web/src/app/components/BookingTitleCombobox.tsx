import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { InputGroup, TextInput } from '@astryxdesign/core';

import { ApiError, apiFetch } from '../../lib/api';
import type { BookingsListResponse } from '../../lib/bookings';
import {
  IconBookmark,
  IconCheck,
  IconChevronDown,
  IconClock,
  IconPlus,
  IconX,
} from '../shell/icons';

/* ── Template judul tersimpan (localStorage, per workspace) ──
 * User menyimpan judul yang sering dipakai sebagai template; dropdown
 * juga menyarankan judul dari booking sebelumnya di project ini.
 * Penyimpanan per-perangkat (localStorage) — mengikuti pola integrasi
 * Obsidian (konfigurasi perangkat lokal). */

const STORAGE_KEY_PREFIX = 'oriole.bookingTitleTemplates.';
const MAX_SAVED_TEMPLATES = 10;
const MAX_RECENT_TITLES = 6;

function loadSavedTemplates(workspaceId: string | null | undefined): string[] {
  if (!workspaceId) return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PREFIX + workspaceId);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

function persistTemplates(workspaceId: string, templates: string[]): void {
  try {
    localStorage.setItem(
      STORAGE_KEY_PREFIX + workspaceId,
      JSON.stringify(templates.slice(0, MAX_SAVED_TEMPLATES)),
    );
  } catch {
    // localStorage penuh / mode privat — abaikan, dropdown tetap berfungsi di sesi ini.
  }
}

interface BookingTitleComboboxProps {
  /** Judul saat ini — input tetap bisa diketik bebas (judul custom baru). */
  value: string;
  onChange: (value: string) => void;
  workspaceId: string | null | undefined;
  isRequired?: boolean;
  /** Kelas tata letak grid (mis. `sm:col-span-2`). */
  className?: string;
}

/**
 * Combobox judul booking — TextInput biasa (bebas diketik = judul custom)
 * dengan dropdown template judul:
 *  - Template tersimpan (localStorage per workspace, bisa disimpan/dihapus)
 *  - Judul terbaru dari booking sebelumnya di project ini
 * Pilih salah satu → isi input, lalu tetap bisa disunting. Keyboard:
 * ↑/↓ navigasi, Enter pilih, Escape tutup.
 */
export function BookingTitleCombobox({
  value,
  onChange,
  workspaceId,
  isRequired = false,
  className,
}: BookingTitleComboboxProps) {
  const { t } = useTranslation();

  const [isOpen, setIsOpen] = useState(false);
  const [savedTemplates, setSavedTemplates] = useState<string[]>(() =>
    loadSavedTemplates(workspaceId),
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const [justSaved, setJustSaved] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const justSavedTimerRef = useRef<number | null>(null);
  const listboxId = useId();

  // Ganti project → muat ulang template tersimpan milik project itu.
  useEffect(() => {
    setSavedTemplates(loadSavedTemplates(workspaceId));
    setIsOpen(false);
  }, [workspaceId]);

  // Bersihkan timer feedback "Tersimpan ✓" saat komponen dilepas.
  useEffect(() => {
    return () => {
      if (justSavedTimerRef.current !== null) window.clearTimeout(justSavedTimerRef.current);
    };
  }, []);

  // Judul dari booking sebelumnya dimuat malas (lazy) — hanya saat dropdown dibuka.
  // Memakai query key yang sama dengan picker kontak (BookingNewPage) — hasil
  // `/bookings?limit=200` dipakai bersama, tidak ada fetch ganda per fitur.
  const { data: bookingsPage } = useQuery({
    queryKey: ['bookings-contacts', workspaceId],
    queryFn: () => apiFetch<BookingsListResponse>('/bookings?limit=200'),
    enabled: isOpen && !!workspaceId,
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 1,
  });

  /** Judul terbaru dari booking project ini — terkecuali yang sudah tersimpan. */
  const recentTitles = useMemo(() => {
    const seen = new Set(savedTemplates.map((item) => item.trim().toLowerCase()));
    const list: string[] = [];
    for (const booking of bookingsPage?.bookings ?? []) {
      const title = booking.title?.trim();
      if (!title || seen.has(title.toLowerCase())) continue;
      seen.add(title.toLowerCase());
      list.push(title);
      if (list.length >= MAX_RECENT_TITLES) break;
    }
    return list;
  }, [bookingsPage, savedTemplates]);

  // Filter opsional: saat user mengetik, hanya tampilkan yang cocok.
  const query = value.trim().toLowerCase();
  const savedOptions = useMemo(
    () => savedTemplates.filter((item) => !query || item.toLowerCase().includes(query)),
    [savedTemplates, query],
  );
  const recentOptions = useMemo(
    () => recentTitles.filter((item) => !query || item.toLowerCase().includes(query)),
    [recentTitles, query],
  );
  const options = [...savedOptions, ...recentOptions];

  const canSave =
    value.trim().length > 0 &&
    !savedTemplates.some((item) => item.toLowerCase() === value.trim().toLowerCase());

  // Reset highlight saat dropdown dibuka / daftar berubah.
  useEffect(() => {
    if (isOpen) setActiveIndex(0);
  }, [isOpen, options.length]);

  // Tutup saat klik ATAU fokus berpindah ke luar combobox (klik lain, Tab,
  // pindah field) — kalau tidak, dropdown tetap menutupi form untuk user keyboard.
  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [isOpen]);

  const selectOption = (title: string) => {
    onChange(title);
    setIsOpen(false);
  };

  const saveCurrentAsTemplate = () => {
    const title = value.trim();
    if (!title || !workspaceId) return;
    const next = [
      title,
      ...savedTemplates.filter((item) => item.toLowerCase() !== title.toLowerCase()),
    ].slice(0, MAX_SAVED_TEMPLATES);
    setSavedTemplates(next);
    persistTemplates(workspaceId, next);
    setJustSaved(true);
    if (justSavedTimerRef.current !== null) window.clearTimeout(justSavedTimerRef.current);
    justSavedTimerRef.current = window.setTimeout(() => setJustSaved(false), 1600);
  };

  const removeTemplate = (title: string) => {
    const next = savedTemplates.filter((item) => item !== title);
    setSavedTemplates(next);
    if (workspaceId) persistTemplates(workspaceId, next);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!isOpen) setIsOpen(true);
      else setActiveIndex((index) => Math.min(index + 1, options.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!isOpen) setIsOpen(true);
      else setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      if (isOpen && options.length > 0) {
        event.preventDefault();
        selectOption(options[Math.min(activeIndex, options.length - 1)]);
      }
    } else if (event.key === 'Escape') {
      if (isOpen) {
        event.preventDefault();
        setIsOpen(false);
      }
    }
  };

  return (
    <div ref={containerRef} className={`relative ${className ?? ''}`}>
      <InputGroup
        label={t('bookingNew.bookingTitle')}
        isRequired={isRequired}
        className="w-full"
      >
        <TextInput
          label={t('bookingNew.bookingTitle')}
          isLabelHidden
          value={value}
          onChange={onChange}
          onFocus={() => setIsOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={t('bookingNew.titlePlaceholder')}
          width="100%"
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={
            isOpen && options.length > 0
              ? `booking-title-option-${Math.min(activeIndex, options.length - 1)}`
              : undefined
          }
        />
        <button
          type="button"
          aria-label={t('bookingNew.titleTemplateToggle')}
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          onClick={() => setIsOpen((open) => !open)}
          className="flex shrink-0 items-center justify-center self-stretch px-2 text-zinc-400 transition hover:bg-zinc-50 hover:text-zinc-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500"
        >
          <IconChevronDown
            className={`size-4 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          />
        </button>
      </InputGroup>

      {isOpen && (
        <div
          id={listboxId}
          role="listbox"
          aria-label={t('bookingNew.titleTemplates')}
          className="combobox-popover absolute left-0 right-0 z-30 mt-1.5 max-h-72 overflow-y-auto rounded-xl border border-zinc-200 bg-white p-1.5 shadow-lg"
        >
          {savedOptions.length > 0 && (
            <div>
              <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                {t('bookingNew.templateSaved')}
              </p>
              <ul>
                {savedOptions.map((title, index) => (
                  <li key={title}>
                    <div
                      id={`booking-title-option-${index}`}
                      role="option"
                      aria-selected={index === Math.min(activeIndex, options.length - 1)}
                      className={`flex items-center rounded-lg ${
                        index === Math.min(activeIndex, options.length - 1)
                          ? 'bg-amber-50'
                          : ''
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => selectOption(title)}
                        className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left"
                      >
                        <IconBookmark className="size-3.5 shrink-0 text-amber-500" />
                        <span className="truncate text-sm text-zinc-700">{title}</span>
                      </button>
                      <button
                        type="button"
                        aria-label={t('bookingNew.templateRemove', { title })}
                        onClick={() => removeTemplate(title)}
                        className="mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-600"
                      >
                        <IconX className="size-3.5" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {recentOptions.length > 0 && (
            <div>
              <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                {t('bookingNew.templateRecent')}
              </p>
              <ul>
                {recentOptions.map((title, offset) => {
                  const index = savedOptions.length + offset;
                  return (
                    <li key={title}>
                      <div
                        id={`booking-title-option-${index}`}
                        role="option"
                        aria-selected={index === Math.min(activeIndex, options.length - 1)}
                        className={`flex items-center rounded-lg ${
                          index === Math.min(activeIndex, options.length - 1) ? 'bg-amber-50' : ''
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => selectOption(title)}
                          className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left"
                        >
                          <IconClock className="size-3.5 shrink-0 text-zinc-400" />
                          <span className="truncate text-sm text-zinc-600">{title}</span>
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {options.length === 0 && (
            <p className="px-2.5 py-3 text-sm text-zinc-500">
              {query ? t('bookingNew.templateNoMatch') : t('bookingNew.templateEmpty')}
            </p>
          )}

          <div className="mt-1 border-t border-zinc-100 pt-1">
            {justSaved ? (
              <p className="flex items-center gap-1.5 px-2.5 py-2 text-sm font-medium text-emerald-600">
                <IconCheck className="size-3.5" />
                {t('bookingNew.templateSavedFeedback')}
              </p>
            ) : canSave ? (
              <button
                type="button"
                onClick={saveCurrentAsTemplate}
                className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-2 text-left text-sm font-medium text-amber-700 transition hover:bg-amber-50"
              >
                <IconPlus className="size-3.5" />
                {t('bookingNew.templateSaveAction', { title: value.trim() })}
              </button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
