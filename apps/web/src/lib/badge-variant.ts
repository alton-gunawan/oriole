/** Variant Badge tinted (non-semantik) untuk kategori & staf — sesuai panduan Astryx. */
export const TINTED_BADGE_VARIANTS = [
  'blue',
  'cyan',
  'green',
  'orange',
  'pink',
  'purple',
  'red',
  'teal',
  'yellow',
] as const;

/** Peta deterministik teks → warna Badge, agar teks sama selalu berwarna sama. */
export function tintedBadgeVariant(text: string): (typeof TINTED_BADGE_VARIANTS)[number] {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return TINTED_BADGE_VARIANTS[hash % TINTED_BADGE_VARIANTS.length];
}
