/**
 * Logo aplikasi (mark burung, goresan tinta hitam di atas krem).
 *
 * Komponen ini hanya merender IMG yang memenuhi kontainer (size-full +
 * object-cover) — pemanggil yang menentukan ukuran & bentuk badge lewat
 * class kontainernya (mis. `size-12 rounded-2xl overflow-hidden`), jadi
 * satu sumber gambar dipakai di seluruh app: sidebar, splash auth,
 * onboarding, landing, favicon, dll. Gunakan overflow-hidden pada badge
 * agar sudut bulat memotong gambar.
 */
export function AppLogo({ className = '', alt = 'Oriole' }: { className?: string; alt?: string }) {
  return (
    <img
      src="/logo.jpeg"
      alt={alt}
      draggable={false}
      className={`size-full object-cover ${className}`}
    />
  );
}

/**
 * Brandmark lengkap (Logo icon badge + teks judul nama brand).
 */
export function AppBrand({
  className = '',
  iconSize = 'size-11',
  textSize = 'text-2xl',
  title = 'Oriole',
}: {
  className?: string;
  iconSize?: string;
  textSize?: string;
  title?: string;
}) {
  return (
    <div className={`inline-flex items-center gap-3.5 ${className}`}>
      <span
        className={`flex ${iconSize} shrink-0 items-center justify-center overflow-hidden rounded-md bg-amber-500 shadow-md shadow-amber-500/20 ring-1 ring-white/10`}
      >
        <AppLogo />
      </span>
      <span className={`${textSize} font-bold tracking-tight text-white`}>
        {title}
      </span>
    </div>
  );
}
