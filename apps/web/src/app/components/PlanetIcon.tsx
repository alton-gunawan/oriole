import { useState, type ImgHTMLAttributes } from 'react';

/** Base URL HTTP API resmi DiceBear (style Planets, v10). */
export const PLANETS_API_BASE = 'https://api.dicebear.com/10.x/planets/svg';

interface PlanetIconProps {
  /** Seed untuk generate planet (nama workspace — apa pun yang unik). */
  name: string;
  size?: number;
  /** Border radius kecil — "rectangle rounded". Default rounded-md (6px). */
  radiusClass?: string;
  className?: string;
}

/**
 * Avatar gaya "Planets" DiceBear (https://www.dicebear.com/styles/planets/)
 * sebagai ikon project: satu planet bertekstur, cincin & bulan opsional, dan
 * langit berbintang. Style ini baru tersedia di DiceBear v10 dan belum
 * dirilis sebagai paket npm, jadi dirender via HTTP API resmi. Pola
 * deterministik dari `name` — seed yang sama selalu menghasilkan planet yang
 * sama. Dirender persegi dengan sudut membulat kecil, bukan lingkaran.
 *
 * Bila API tidak terjangkau / gagal, fallback ke badge huruf awal (pola yang
 * sama dengan halaman Workspaces) agar switcher tidak menampilkan gambar
 * rusak.
 */
export function PlanetIcon({
  name,
  size = 28,
  radiusClass = 'rounded-md',
  className = '',
  ...rest
}: PlanetIconProps & Omit<ImgHTMLAttributes<HTMLImageElement>, 'name' | 'src' | 'width' | 'height' | 'alt'>) {
  const label = name.trim();
  const seed = encodeURIComponent(label || '?');
  // Simpan seed yang gagal, bukan boolean: saat `name` berubah (mis. pindah
  // workspace) seed berbeda → img dicoba lagi, bukan stuck di fallback.
  const [erroredSeed, setErroredSeed] = useState<string | null>(null);
  const failed = erroredSeed === seed;

  if (failed) {
    return (
      <span
        aria-hidden="true"
        className={`flex shrink-0 select-none items-center justify-center overflow-hidden bg-zinc-800 font-bold text-white ${radiusClass} ${className}`}
        style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }}
      >
        {(label || '?').slice(0, 1).toUpperCase()}
      </span>
    );
  }

  return (
    <img
      src={`${PLANETS_API_BASE}?seed=${seed}`}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      className={`shrink-0 overflow-hidden ${radiusClass} ${className}`}
      onError={() => setErroredSeed(seed)}
      {...rest}
      aria-hidden="true"
    />
  );
}
