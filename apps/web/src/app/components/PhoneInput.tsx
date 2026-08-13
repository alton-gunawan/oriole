import { useId, useMemo } from 'react';
import { Field, Selector, SelectorOption } from '@astryxdesign/core';
import { getCountryCallingCode, parsePhoneNumberFromString } from 'libphonenumber-js';
import { useTranslation } from 'react-i18next';
import PhoneNumberInput, { type Country } from 'react-phone-number-input';
// Catatan bundle: memuat SEMUA bendera SVG (~250) sekaligus karena diakses
// dinamis (flags[country]) sehingga tidak bisa di-tree-shake. Diterima
// sebagai biaya satu kali untuk fitur inti (country code picker).
import flags from 'react-phone-number-input/flags';

import './phone-input.css';

/* ── Bendera negara (inline SVG dari country-flag-icons) ────── */

function CountryFlag({
  country,
  title,
  ariaHidden = false,
}: {
  country?: Country;
  title?: string;
  /** Sembunyikan dari screen reader — dipakai di daftar opsi yang sudah punya label nama negara. */
  ariaHidden?: boolean;
}) {
  const Flag = country ? flags[country] : undefined;
  if (Flag) {
    return (
      <span className="phone-country-flag" aria-hidden={ariaHidden || undefined}>
        <Flag title={ariaHidden ? '' : title ?? country ?? ''} />
      </span>
    );
  }
  // "International" / negara tak dikenal → ikon globe kecil.
  return (
    <span className="phone-country-flag" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="12" cy="12" r="9.5" />
        <path d="M2.5 12h19M12 2.5c3 3 3 16 0 19-3-3-3-16 0-19Z" />
      </svg>
    </span>
  );
}

/* ── Kontrak countrySelectComponent dari react-phone-number-input ──
 * Library memanggil komponen ini dengan props:
 *   { value, options, onChange, onFocus, onBlur, disabled, readOnly,
 *     name, 'aria-label', ...countrySelectProps }
 * options: [{ value?: Country, label: string }] — value undefined = "International".
 */
interface LibraryCountryOption {
  value?: Country;
  label: string;
}

interface CountrySelectProps {
  value?: Country;
  options: LibraryCountryOption[];
  onChange: (country?: Country) => void;
  disabled?: boolean;
  readOnly?: boolean;
  'aria-label'?: string;
}

function CountrySelect({
  value,
  options,
  onChange,
  disabled,
  readOnly,
  'aria-label': ariaLabel,
}: CountrySelectProps) {
  const { t } = useTranslation();

  const selectorOptions = useMemo<{ value: string; label: string }[]>(
    () =>
      options.map((option) => ({
        // '' dipakai sebagai nilai "International" (value library = undefined).
        value: option.value ?? '',
        label: option.label,
      })),
    [options],
  );

  // Catatan: prop onFocus/onBlur/name dari library sengaja diabaikan —
  // hanya dipakai library untuk kelas fokus kosmetik & serialisasi form
  // (form di app ini dikirim via JS).
  return (
    <Selector
      label={ariaLabel ?? t('phoneInput.country')}
      isLabelHidden
      options={selectorOptions}
      value={value ?? ''}
      onChange={(selected) => onChange(selected === '' ? undefined : (selected as Country))}
      isDisabled={disabled || readOnly}
      className="phone-input-country"
      hasSearch
      searchPlaceholder={t('phoneInput.searchCountry')}
      startIcon={<CountryFlag country={value} title={value} />}
      renderOption={(option) => (
        <SelectorOption
          icon={
            <CountryFlag
              country={option.value ? (option.value as Country) : undefined}
              ariaHidden
            />
          }
          label={option.label}
          endContent={
            option.value ? (
              <span className="phone-country-code">
                +{getCountryCallingCode(option.value as Country)}
              </span>
            ) : undefined
          }
        />
      )}
    />
  );
}

/* ── PhoneInput (komponen publik) ────────────────────────────── */

/**
 * Input nomor telepon dengan pemilih country code — dropdown memakai
 * komponen `Selector` dari Astryx dan setiap opsi menampilkan bendera
 * negaranya; bendera negara terpilih tampil sebagai prefix (startIcon)
 * di tombol dropdown. Logika nomor tetap dari `react-phone-number-input`
 * (libphonenumber-js).
 *
 * - Nilai keluar selalu format E.164 (mis. `+628123456789`) — cocok dengan
 *   validasi `phoneField` di API (8–15 digit, boleh diawali `+`).
 * - Negara default Indonesia (`+62`) sehingga pengguna tinggal mengetik
 *   nomor lokal, mis. `812 3456 7890`.
 * - Label/description/wajib/opsional mengikuti `Field` Astryx agar senada
 *   dengan `TextInput` yang dipakai halaman lain.
 *
 * Catatan: nilai pra-isi format lokal (tanpa `+`, mis. data lama `0812…`)
 * hanya DINORMALISASI untuk tampilan — state induk tetap menyimpan nilai
 * aslinya sampai pengguna mengedit. Konsekuensinya: (1) simpan-tanpa-edit
 * tetap mengirim format lama (API menerima keduanya); (2) nomor lokal asing
 * tanpa `+` ditafsirkan sebagai negara default, jadi pastikan
 * `defaultCountry` sesuai dengan data yang ada.
 */
export interface PhoneInputProps {
  /** Label field (sama seperti prop `label` pada TextInput). */
  label: string;
  /** Nomor saat ini (E.164 seperti `+628123456789`, atau kosong). */
  value: string;
  /** Dipanggil dengan nomor E.164 tanpa spasi saat pengguna mengetik. */
  onChange: (value: string) => void;
  /** Teks bantuan yang ditampilkan di dalam field saat kosong. */
  placeholder?: string;
  /** Deskripsi yang tampil di antara label dan field. */
  description?: string;
  /** Tandai field sebagai wajib (label marker `*`). */
  isRequired?: boolean;
  /** Tandai field sebagai opsional (label marker "(optional)"). */
  isOptional?: boolean;
  /** Sembunyikan label secara visual (tetap terbaca screen reader). */
  isLabelHidden?: boolean;
  /**
   * Negara default untuk kode area saat field kosong / nomor tanpa awalan.
   * @default 'ID'
   */
  defaultCountry?: Country;
  className?: string;
}

function toE164(value: string, defaultCountry: Country): string {
  if (!value || value.startsWith('+')) return value;
  const parsed = parsePhoneNumberFromString(value, defaultCountry);
  return parsed ? parsed.number : value;
}

export function PhoneInput({
  label,
  value,
  onChange,
  placeholder,
  description,
  isRequired = false,
  isOptional = false,
  isLabelHidden = false,
  defaultCountry = 'ID',
  className,
}: PhoneInputProps) {
  const inputId = useId();
  const descriptionId = useId();

  const normalizedValue = useMemo(() => toE164(value, defaultCountry), [value, defaultCountry]);

  return (
    <Field
      label={label}
      inputID={inputId}
      description={description}
      descriptionID={description ? descriptionId : undefined}
      isRequired={isRequired}
      isOptional={isOptional}
      isLabelHidden={isLabelHidden}
      className={className}
    >
      <PhoneNumberInput
        id={inputId}
        aria-describedby={description ? descriptionId : undefined}
        // `ph-no-capture`: nomor telepon = PII — jangan pernah ter-capture
        // autocapture/session replay PostHog.
        className="phone-input ph-no-capture"
        international
        withCountryCallingCode
        defaultCountry={defaultCountry}
        value={normalizedValue || undefined}
        onChange={(phone) => onChange(phone ?? '')}
        placeholder={placeholder}
        countrySelectComponent={CountrySelect}
      />
    </Field>
  );
}
