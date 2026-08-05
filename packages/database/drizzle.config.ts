import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'drizzle-kit';

// Muat .env dari root monorepo (file ini: packages/database/drizzle.config.ts
// → root repo berada 2 tingkat di atas). Tidak menimpa env platform.
const rootEnvPath = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(rootEnvPath)) {
  process.loadEnvFile(rootEnvPath);
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  // `neon_auth` di-scan hanya untuk pull (introspection) — jangan migrasikan schema itu.
  schemaFilter: ['public', 'neon_auth'],
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
});
