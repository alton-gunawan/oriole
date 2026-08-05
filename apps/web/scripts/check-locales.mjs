#!/usr/bin/env node
/**
 * Guard produksi untuk katalog i18n:
 *  - Semua kunci di `en` (source of truth) harus ada di bahasa lain (id).
 *  - Tidak boleh ada kunci asing yang tidak ada di `en`.
 *  - Nilai string tidak boleh kosong.
 *
 * Dipanggil otomatis di `pnpm build` (apps/web) dan CI.
 * Gagal → exit code 1 → build/CI merah.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const localesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/i18n/locales');
const LOCALES = ['en', 'id'];

function readCatalog(lang) {
  const file = path.join(localesDir, lang, 'translation.json');
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Flatten objek bertingkat → set kunci bertitik (nilai leaf saja). */
function flattenKeys(obj, prefix = '', out = new Set()) {
  for (const [key, value] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      flattenKeys(value, full, out);
    } else {
      out.add(full);
    }
  }
  return out;
}

/** Cek nilai leaf kosong (string kosong / null / array kosong). */
function findEmptyValues(obj, prefix = '', out = []) {
  for (const [key, value] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      findEmptyValues(value, full, out);
    } else if (value === null || value === undefined || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && value.length === 0)) {
      out.push(full);
    }
  }
  return out;
}

const catalogs = Object.fromEntries(LOCALES.map((lang) => [lang, readCatalog(lang)]));
const enKeys = flattenKeys(catalogs.en);
const errors = [];

for (const lang of LOCALES) {
  const keys = flattenKeys(catalogs[lang]);

  for (const key of enKeys) {
    if (!keys.has(key)) errors.push(`[${lang}] kunci hilang: ${key}`);
  }
  for (const key of keys) {
    if (!enKeys.has(key)) errors.push(`[${lang}] kunci tidak ada di en (hapus atau tambahkan ke en): ${key}`);
  }

  for (const empty of findEmptyValues(catalogs[lang])) {
    errors.push(`[${lang}] nilai kosong: ${empty}`);
  }
}

if (errors.length > 0) {
  console.error(`\n[i18n] Katalog tidak sinkron (${errors.length} masalah):`);
  for (const error of errors) console.error(`  ✗ ${error}`);
  console.error('\nPerbaiki apps/web/src/i18n/locales/*/translation.json lalu jalankan ulang.\n');
  process.exit(1);
}

console.log(`[i18n] OK — ${enKeys.size} kunci sinkron di semua bahasa (${LOCALES.join(', ')}) dan tidak ada nilai kosong.`);
