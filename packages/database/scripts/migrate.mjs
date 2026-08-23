import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { neon } from '@neondatabase/serverless';

const rootEnvPath = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(rootEnvPath)) {
  process.loadEnvFile(rootEnvPath);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set in environment or .env');
  process.exit(1);
}

const sql = neon(databaseUrl);

async function run() {
  console.log('Connecting to Neon database via HTTP...');

  // Ensure __drizzle_migrations table exists (standard drizzle tracking)
  await sql`
    CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `;

  // Apply 0031_onboarding.sql
  console.log('Applying 0031_onboarding.sql migration...');
  await sql`
    ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "onboarding_completed" boolean DEFAULT false NOT NULL;
  `;
  await sql`
    ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "onboarding_step" integer DEFAULT 1 NOT NULL;
  `;

  console.log('✓ Migration applied successfully! Columns onboarding_completed & onboarding_step now exist on profiles table.');
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
