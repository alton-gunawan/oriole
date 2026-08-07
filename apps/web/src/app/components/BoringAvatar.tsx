import Avatar from 'boring-avatars';
import type { SVGProps } from 'react';

export type BoringAvatarVariant =
  | 'marble'
  | 'beam'
  | 'pixel'
  | 'sunset'
  | 'ring'
  | 'bauhaus'
  | 'geometric';

interface BoringAvatarProps {
  /** Seed untuk generate pola (nama user/workspace/email — apa pun yang unik). */
  name: string;
  size?: number;
  variant?: BoringAvatarVariant;
  colors?: string[];
  /** Border radius kecil — "rectangle rounded". Default rounded-md (6px). */
  radiusClass?: string;
  className?: string;
}

/** Palet default library — cukup kontras di sidebar gelap maupun latar terang. */
const DEFAULT_COLORS = ['#92A1C6', '#146A7C', '#F0AB3D', '#C271B4', '#C20D90'];

/**
 * Boring avatars sebagai ikon: pola deterministik dari `name` (selalu sama
 * untuk seed yang sama), dirender persegi dengan sudut membulat kecil —
 * bukan lingkaran. Pakai `variant` untuk membedakan jenis entitas
 * (mis. `marble` untuk user, `beam` untuk workspace).
 */
export function BoringAvatar({
  name,
  size = 32,
  variant = 'marble',
  colors = DEFAULT_COLORS,
  radiusClass = 'rounded-md',
  className = '',
  ...rest
}: BoringAvatarProps & Omit<SVGProps<SVGSVGElement>, 'name' | 'color'>) {
  return (
    <Avatar
      name={name}
      size={size}
      variant={variant}
      colors={colors}
      className={`shrink-0 overflow-hidden ${radiusClass} ${className}`}
      {...rest}
      aria-hidden="true"
    />
  );
}
