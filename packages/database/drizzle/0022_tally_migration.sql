-- Migrasi integrasi form: Typeform → Tally (data-only, schema tidak berubah).
--
-- Typeform dihapus dari aplikasi dan digantikan Tally. API key Typeform lama
-- tidak bisa dipakai Tally (platform berbeda), jadi baris integrasi 'typeform'
-- diubah menjadi 'tally' dalam keadaan NONAKTIF dengan marker migratedFrom —
-- workspace tinggal menghubungkan ulang dengan API key Tally di halaman
-- Integrations (banner migrasi muncul di UI).
UPDATE "workspace_integrations"
SET "integration_type" = 'tally',
    "identifier"       = NULL,
    "provider_config"  = '{"migratedFrom":"typeform"}'::jsonb,
    "is_active"        = false,
    "updated_at"       = now()
WHERE "integration_type" = 'typeform';
