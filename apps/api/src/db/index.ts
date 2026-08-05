import { createDb } from '@oriole/database';

import { env } from '../lib/env.ts';

/** Drizzle client (Neon HTTP driver) — konstruktor offline, query baru jalan saat dipakai. */
export const db = createDb(env.DATABASE_URL);
