import { useState } from 'react';

import { PlanetIcon } from './PlanetIcon';

interface WorkspaceAvatarProps {
  workspace: { name: string; avatarUrl?: string | null };
  size?: number;
  /** Border radius kecil — "rectangle rounded". Default rounded-md (6px). */
  radiusClass?: string;
  className?: string;
}

/**
 * Avatar project: menampilkan `workspace.avatarUrl` (planet DiceBear pilihan
 * atau gambar upload 1:1) bila ada; fallback ke `PlanetIcon` berbasis nama
 * (planet deterministik + badge huruf awal bila API DiceBear gagal).
 *
 * Simpan URL yang gagal, bukan boolean: saat `avatarUrl` berubah, gambar
 * dicoba lagi alih-alih stuck di fallback.
 */
export function WorkspaceAvatar({
  workspace,
  size = 28,
  radiusClass = 'rounded-md',
  className = '',
}: WorkspaceAvatarProps) {
  const avatarUrl = workspace.avatarUrl?.trim() || null;
  const [erroredUrl, setErroredUrl] = useState<string | null>(null);
  const failed = avatarUrl !== null && erroredUrl === avatarUrl;

  if (avatarUrl && !failed) {
    return (
      <img
        src={avatarUrl}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        className={`shrink-0 overflow-hidden ${radiusClass} ${className}`}
        onError={() => setErroredUrl(avatarUrl)}
        aria-hidden="true"
      />
    );
  }

  return <PlanetIcon name={workspace.name} size={size} radiusClass={radiusClass} className={className} />;
}
