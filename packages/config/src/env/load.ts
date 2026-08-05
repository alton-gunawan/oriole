import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Parse konten file `.env` sederhana (key=value, komentar `#`, kutipan
 * opsional). Tanpa dependency — cukup untuk format yang dipakai repo ini.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

/**
 * Memuat file `.env` di root monorepo.
 *
 * Nilai dari `.env` MENGALAHKAN variabel yang sudah ada di environment.
 * Ini penting untuk development: shell tertentu (mis. shell desktop app)
 * menyuntikkan variabel ambient seperti `PORT` yang bisa bertabrakan dengan
 * konfigurasi eksplisit repo ini — `.env` adalah sumber kebenaran lokal.
 *
 * Aman untuk produksi: image container (Dockerfile) TIDAK menyalin `.env`,
 * jadi di Railway/Fly/Render variabel platform tetap menang.
 *
 * Path dihitung relatif terhadap file ini (bukan cwd), jadi aman
 * dipanggil dari package mana pun.
 */
export function loadRootEnv(): void {
  // Saat test (Vitest), biarkan variabel dummy yang ditetapkan test-file
  // menang — jangan biarkan .env menimpa NODE_ENV=test dan nilai lainnya.
  if (process.env.NODE_ENV === 'test') return;
  const rootEnvPath = fileURLToPath(new URL('../../../../.env', import.meta.url));
  if (!existsSync(rootEnvPath)) return;
  for (const [key, value] of Object.entries(parseEnvFile(readFileSync(rootEnvPath, 'utf8')))) {
    // NODE_ENV adalah MODE RUNTIME (test/production) yang di-set oleh
    // runner/platform, bukan nilai konfigurasi seperti PORT — jangan
    // biarkan .env development menimpanya (mis. test yang menyimulasikan
    // produksi, atau `NODE_ENV=production` lokal).
    if (key === 'NODE_ENV') continue;
    process.env[key] = value;
  }
}
