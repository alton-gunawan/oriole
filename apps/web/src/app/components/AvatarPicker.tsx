import { useId, useRef, useState } from 'react';
import { Button, Field } from '@astryxdesign/core';
import { useTranslation } from 'react-i18next';

import { PLANETS_API_BASE, PlanetIcon } from './PlanetIcon';
import { IconCheck, IconRefresh, IconTrash, IconUpload } from '../shell/icons';
/** Jumlah opsi planet yang ditampilkan per shuffle. */
const PLANET_OPTION_COUNT = 8;
/** Ukuran canvas hasil upload (piksel) — 1:1 persegi, cukup untuk avatar 96px+. */
const AVATAR_CANVAS_SIZE = 512;
/** Batas ukuran file mentah sebelum di-compress. */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const dicebearUrl = (seed: string) => `${PLANETS_API_BASE}?seed=${encodeURIComponent(seed)}`;

const isDicebearUrl = (value: string | null): value is string =>
  value !== null && value.startsWith(PLANETS_API_BASE);

/** Ambil seed dari URL planet DiceBear (null bila bukan URL planet). */
function seedFromUrl(value: string | null): string | null {
  if (!value || !isDicebearUrl(value)) return null;
  try {
    return new URL(value).searchParams.get('seed');
  } catch {
    return null;
  }
}

const randomSeed = () => `ws-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Baca file gambar, potong center-crop jadi persegi 1:1, resize ke
 * 512×512, lalu encode WebP (fallback JPEG). Selalu persegi — ratio 1:1
 * dipaksakan di level data, bukan hanya di tampilan.
 */
function fileToSquareDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read'));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error('decode'));
      image.onload = () => {
        try {
          // Center-crop persegi: potong sisi terpanjang agar seimbang.
          const side = Math.min(image.width, image.height);
          const sx = (image.width - side) / 2;
          const sy = (image.height - side) / 2;
          const canvas = document.createElement('canvas');
          canvas.width = AVATAR_CANVAS_SIZE;
          canvas.height = AVATAR_CANVAS_SIZE;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            reject(new Error('canvas'));
            return;
          }
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(image, sx, sy, side, side, 0, 0, AVATAR_CANVAS_SIZE, AVATAR_CANVAS_SIZE);
          const webp = canvas.toDataURL('image/webp', 0.85);
          // Browser tanpa WebP (Safari lama) mengembalikan PNG — gunakan JPEG.
          resolve(webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.85));
        } catch (error) {
          reject(error instanceof Error ? error : new Error('canvas'));
        }
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

interface AvatarPickerProps {
  /** Nilai avatar saat ini; null = planet otomatis dari nama bisnis. */
  value: string | null;
  onChange: (value: string | null) => void;
  /** Nama bisnis — seed fallback untuk preview planet otomatis. */
  name: string;
}

/**
 * Pilih avatar bisnis: (1) planet DiceBear — grid 8 opsi + shuffle, atau
 * (2) upload gambar sendiri — di-crop 1:1 dan di-compress client-side.
 * Output `value` berupa URL DiceBear, data URL gambar, atau null (default).
 */
export function AvatarPicker({ value, onChange, name }: AvatarPickerProps) {
  const { t } = useTranslation();
  const fieldId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  // Mode awal mengikuti nilai yang ada: planet DiceBear → tab planet,
  // data URL upload → tab upload, null → planet.
  const [mode, setMode] = useState<'planet' | 'upload'>(() =>
    isDicebearUrl(value) ? 'planet' : value ? 'upload' : 'planet',
  );
  // Base seed grid planet; dipakai seed nilai lama (agar opsi grid stabil
  // saat edit), atau seed acak baru.
  const [baseSeed, setBaseSeed] = useState<string>(() => seedFromUrl(value) ?? randomSeed());
  const [error, setError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  // Opsi pertama = seed saat ini (bila planet DiceBear dipilih di sesi lalu),
  // sehingga planet yang sedang dipilih tetap tampil + ter-highlight saat edit.
  const options = Array.from({ length: PLANET_OPTION_COUNT }, (_, i) =>
    i === 0 ? baseSeed : `${baseSeed}-${i - 1}`,
  );

  const selectPlanet = (seed: string) => {
    setError(null);
    setMode('planet');
    onChange(dicebearUrl(seed));
  };

  const shuffle = () => {
    setError(null);
    setMode('planet');
    setBaseSeed(randomSeed());
  };

  const resetToDefault = () => {
    setError(null);
    setMode('planet');
    onChange(null);
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (!file.type.startsWith('image/')) {
      setError(t('ws.avatarErrorType'));
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(t('ws.avatarErrorSize'));
      return;
    }
    setIsProcessing(true);
    try {
      const dataUrl = await fileToSquareDataUrl(file);
      setMode('upload');
      onChange(dataUrl);
    } catch {
      setError(t('ws.avatarErrorRead'));
    } finally {
      setIsProcessing(false);
    }
  };

  const isUploaded = value !== null && !isDicebearUrl(value);
  const tabClass = (active: boolean) =>
    `rounded-md px-2.5 py-1 text-xs font-medium transition ${
      active
        ? 'bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 shadow-xs'
        : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200'
    }`;

  return (
    <Field label={t('ws.avatarLabel')} description={t('ws.avatarDesc')} inputID={fieldId}>
      <div className="mt-1 mb-3 inline-flex gap-1 rounded-lg bg-zinc-100 dark:bg-zinc-800 p-0.5">
        <button type="button" className={tabClass(mode === 'planet')} onClick={() => setMode('planet')}>
          {t('ws.avatarPlanetTab')}
        </button>
        <button type="button" className={tabClass(mode === 'upload')} onClick={() => setMode('upload')}>
          {t('ws.avatarUploadTab')}
        </button>
      </div>

      {mode === 'planet' ? (
        <div className="space-y-4">
          <div className="flex items-center gap-4">
            <Preview value={value} name={name} size={64} />
            <div className="space-y-2">
              <Button
                label={t('ws.avatarShuffle')}
                variant="secondary"
                size="sm"
                icon={<IconRefresh className="size-3.5" />}
                onClick={shuffle}
              />
              {value !== null && (
                <Button
                  label={t('ws.avatarReset')}
                  variant="ghost"
                  size="sm"
                  onClick={resetToDefault}
                />
              )}
            </div>
          </div>

          <div className="grid grid-cols-8 gap-2" role="radiogroup" aria-label={t('ws.avatarPlanetTab')}>
            {options.map((seed) => {
              const url = dicebearUrl(seed);
              const selected = url === value;
              return (
                <button
                  key={seed}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  title={t('ws.avatarChoosePlanet')}
                  onClick={() => selectPlanet(seed)}
                  className={`relative aspect-square w-full overflow-hidden rounded-lg transition ${
                    selected
                      ? 'ring-2 ring-amber-500 ring-offset-2'
                      : 'ring-1 ring-zinc-200 hover:ring-amber-300'
                  }`}
                >
                  <img
                    src={url}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                  {selected && (
                    <span className="absolute inset-0 flex items-center justify-center bg-amber-500/25">
                      <span className="flex size-5 items-center justify-center rounded-full bg-amber-500 text-white shadow-sm">
                        <IconCheck className="size-3" />
                      </span>
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-4">
            <Preview value={value} name={name} size={64} />
            <div className="space-y-2">
              <Button
                label={t('ws.avatarUploadButton')}
                variant="secondary"
                size="sm"
                icon={<IconUpload className="size-3.5" />}
                isLoading={isProcessing}
                onClick={() => inputRef.current?.click()}
              />
              {isUploaded && (
                <Button
                  label={t('ws.avatarRemove')}
                  variant="ghost"
                  size="sm"
                  icon={<IconTrash className="size-3.5" />}
                  onClick={resetToDefault}
                />
              )}
            </div>
          </div>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('ws.avatarUploadHint')}</p>
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={(event) => {
              void handleFile(event.target.files?.[0]);
              // Reset value agar file sama bisa dipilih ulang.
              event.target.value = '';
            }}
          />
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-red-600">{error}</p>}
    </Field>
  );
}

/** Preview persegi 1:1 dari nilai saat ini; null → planet otomatis dari nama. */
function Preview({ value, name, size }: { value: string | null; name: string; size: number }) {
  if (value) {
    return (
      <img
        src={value}
        alt=""
        width={size}
        height={size}
        className="aspect-square shrink-0 rounded-md object-cover ring-1 ring-zinc-200"
      />
    );
  }
  return (
    <span className="flex shrink-0 items-center justify-center rounded-md bg-zinc-100 dark:bg-zinc-800 ring-1 ring-zinc-200" style={{ width: size, height: size }}>
      <PlanetIcon name={name} size={Math.round(size * 0.62)} radiusClass="rounded-md" />
    </span>
  );
}
