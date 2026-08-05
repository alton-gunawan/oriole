import { CalleClient } from '@call-e/calle';

import { env } from '../lib/env.ts';

/**
 * CALL-E Developer API — official TypeScript SDK.
 * https://docs.heycall-e.com/
 */
export const calle = new CalleClient({
  apiKey: env.CALLE_API_KEY,
  baseUrl: env.CALLE_BASE_URL,
});
