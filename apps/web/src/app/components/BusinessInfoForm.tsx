import { useId } from 'react';
import { Field, Switch, TextInput, TimeInput, type ISOTimeString } from '@astryxdesign/core';
import { useTranslation } from 'react-i18next';

import type { BusinessHoursEntry, Workspace } from '../../lib/workspace';
import { WEEKDAY_LABEL_KEYS } from '../../lib/staff';
import { PhoneInput } from './PhoneInput';

/** Nilai form info bisnis — state lokal, dikonversi saat simpan. */
export interface BusinessInfoValues {
  website: string;
  phone: string;
  country: string;
  city: string;
  address: string;
  businessHours: BusinessHoursEntry[] | null;
}

/** Form kosong — dipakai form buat bisnis baru. */
export const EMPTY_BUSINESS_INFO: BusinessInfoValues = {
  website: '',
  phone: '',
  country: '',
  city: '',
  address: '',
  businessHours: null,
};

/**
 * Konversi nilai form → payload API. String kosong dikirim null (field
 * terhapus di DB); jam buka kosong dikirim null.
 */
export function businessInfoToPayload(info: BusinessInfoValues) {
  return {
    website: info.website.trim() || null,
    phone: info.phone.trim() || null,
    country: info.country.trim() || null,
    city: info.city.trim() || null,
    address: info.address.trim() || null,
    businessHours: info.businessHours && info.businessHours.length > 0 ? info.businessHours : null,
  };
}

/** Isi form dari workspace yang diedit. */
export function businessInfoFromWorkspace(
  workspace: Workspace | null | undefined,
): BusinessInfoValues {
  return {
    website: workspace?.website ?? '',
    phone: workspace?.phone ?? '',
    country: workspace?.country ?? '',
    city: workspace?.city ?? '',
    address: workspace?.address ?? '',
    businessHours: workspace?.businessHours ?? null,
  };
}

/** Menit sejak tengah malam → "HH:MM" untuk TimeInput. */
function toTimeString(minutes: number): ISOTimeString {
  const h = Math.floor(Math.max(0, minutes) / 60);
  const m = Math.max(0, minutes) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` as ISOTimeString;
}

/** "HH:MM" → menit sejak tengah malam. */
function toMinutes(time: string | undefined): number {
  if (!time) return 0;
  const [h, m] = time.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return 0;
  return h * 60 + m;
}

/** Array jam buka → slot per hari (null = tutup). Satu rentang per hari. */
function hoursToDraft(hours: BusinessHoursEntry[] | null | undefined): (BusinessHoursEntry | null)[] {
  const draft: (BusinessHoursEntry | null)[] = Array.from({ length: 7 }, () => null);
  for (const entry of hours ?? []) {
    if (entry.dayOfWeek >= 0 && entry.dayOfWeek <= 6) draft[entry.dayOfWeek] = entry;
  }
  return draft;
}

/** Slot per hari → array jam buka (hari tutup dilewati). */
function draftToHours(draft: (BusinessHoursEntry | null)[]): BusinessHoursEntry[] {
  return draft.flatMap((entry, day) =>
    entry ? [{ ...entry, dayOfWeek: day }] : [],
  );
}

/**
 * Form info bisnis detail: website, telepon, lokasi (negara/kota/alamat), dan
 * jam buka mingguan (per hari: toggle buka/tutup + jam mulai/selesai). Dipakai
 * dialog buat & edit bisnis agar data konsisten di kedua tempat.
 */
export function BusinessInfoForm({
  value,
  onChange,
}: {
  value: BusinessInfoValues;
  onChange: (next: BusinessInfoValues) => void;
}) {
  const { t } = useTranslation();
  const locationId = useId();
  const hoursId = useId();
  const set = (patch: Partial<BusinessInfoValues>) => onChange({ ...value, ...patch });

  const draft = hoursToDraft(value.businessHours);
  const setDay = (day: number, entry: BusinessHoursEntry | null) => {
    const next = [...draft];
    next[day] = entry;
    set({ businessHours: draftToHours(next) });
  };

  return (
    <div className="space-y-5">
      <TextInput
        label={t('ws.website')}
        value={value.website}
        onChange={(website) => set({ website })}
        placeholder={t('ws.websitePlaceholder')}
        width="100%"
      />
      <PhoneInput
        label={t('ws.phone')}
        value={value.phone}
        onChange={(phone) => set({ phone })}
        placeholder={t('ws.phonePlaceholder')}
      />

      <Field label={t('ws.location')} inputID={locationId}>
        <div className="space-y-3 pt-1">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <TextInput
              label={t('ws.country')}
              value={value.country}
              onChange={(country) => set({ country })}
              placeholder={t('ws.countryPlaceholder')}
              width="100%"
            />
            <TextInput
              label={t('ws.city')}
              value={value.city}
              onChange={(city) => set({ city })}
              placeholder={t('ws.cityPlaceholder')}
              width="100%"
            />
          </div>
          <TextInput
            label={t('ws.address')}
            value={value.address}
            onChange={(address) => set({ address })}
            placeholder={t('ws.addressPlaceholder')}
            width="100%"
          />
        </div>
      </Field>

      <Field label={t('ws.businessHours')} description={t('ws.businessHoursDesc')} inputID={hoursId}>
        <div className="mt-2 divide-y divide-zinc-200/80 dark:divide-zinc-800 rounded-xl border border-zinc-200/80 dark:border-zinc-800 bg-zinc-50/40 dark:bg-zinc-900/40 overflow-hidden">
          {draft.map((entry, day) => {
            const open = entry !== null;
            return (
              <div
                key={day}
                className="flex items-center justify-between gap-3 px-4 py-2.5 transition hover:bg-zinc-100/50 dark:hover:bg-zinc-800/40"
              >
                {/* Left: Switch toggle + Day Name */}
                <div className="flex items-center gap-3 min-w-[7.5rem]">
                  <Switch
                    label={t(WEEKDAY_LABEL_KEYS[day])}
                    isLabelHidden
                    value={open}
                    onChange={(enabled) =>
                      setDay(
                        day,
                        enabled
                          ? { dayOfWeek: day, startMinutes: 9 * 60, endMinutes: 17 * 60 }
                          : null,
                      )
                    }
                  />
                  <span
                    className={`text-sm font-medium transition ${
                      open
                        ? 'text-zinc-900 dark:text-zinc-100'
                        : 'text-zinc-600 dark:text-zinc-400'
                    }`}
                  >
                    {t(WEEKDAY_LABEL_KEYS[day])}
                  </span>
                </div>

                {/* Right: Time inputs or Closed badge */}
                {open ? (
                  <div className="flex items-center gap-2 pr-1">
                    <TimeInput
                      label={t('ws.openAt')}
                      isLabelHidden
                      size="sm"
                      hourFormat="24h"
                      value={toTimeString(entry.startMinutes)}
                      onChange={(value) =>
                        setDay(day, { ...entry, startMinutes: toMinutes(value) })
                      }
                      width="7.5rem"
                    />
                    <span className="shrink-0 text-xs text-zinc-400 dark:text-zinc-500">—</span>
                    <TimeInput
                      label={t('ws.closeAt')}
                      isLabelHidden
                      size="sm"
                      hourFormat="24h"
                      value={toTimeString(entry.endMinutes)}
                      onChange={(value) =>
                        setDay(day, { ...entry, endMinutes: toMinutes(value) })
                      }
                      width="7.5rem"
                    />
                  </div>
                ) : (
                  <div className="pr-3">
                    <span className="text-sm font-medium text-red-500 dark:text-red-400">
                      {t('ws.hoursClosed')}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Field>
    </div>
  );
}
