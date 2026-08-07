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
