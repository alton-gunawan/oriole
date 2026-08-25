import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';

import { apiFetch } from '../../lib/api';

/**
 * Redirect satu-kali untuk membuka detail customer dari kolom customer di
 * daftar booking. Booking lama (sebelum contact-sync) belum punya contactId
 * — tab baru ini memastikan kontak ada (POST /bookings/:id/ensure-contact,
 * idempoten: cari by nomor / buat bila belum ada), lalu pindah ke detail-nya.
 * Gagal / tanpa kontak → kembali ke daftar kontak.
 */
export function ContactEnsureRedirect() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const navigate = useNavigate();

  useEffect(() => {
    const bookingId = params.get('booking');
    if (!bookingId) {
      navigate('/app/contacts', { replace: true });
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const body = await apiFetch<{ contactId: string | null }>(
          `/bookings/${bookingId}/ensure-contact`,
          { method: 'POST' },
        );
        if (cancelled) return;
        if (body.contactId) {
          navigate(`/app/contacts?contactId=${encodeURIComponent(body.contactId)}`, { replace: true });
        } else {
          navigate('/app/contacts', { replace: true });
        }
      } catch {
        if (!cancelled) navigate('/app/contacts', { replace: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params, navigate]);

  return (
    <div className="flex min-h-[40vh] items-center justify-center">
      <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('contactDetail.opening')}</p>
    </div>
  );
}
