import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';

import * as schema from './schema';

export * from './schema';

/**
 * Membuat Drizzle client terhadap Neon (HTTP driver serverless).
 * Semua query berjalan via HTTP — tanpa pool/connection persisten.
 */
export function createDb(databaseUrl: string) {
  const sql = neon(databaseUrl);
  return drizzle(sql, { schema });
}

export type Database = ReturnType<typeof createDb>;
