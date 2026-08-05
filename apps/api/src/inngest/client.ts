import { Inngest } from 'inngest';

import { env } from '../lib/env.ts';

/**
 * Inngest — durable background jobs & webhook orchestration.
 * Event key opsional: lokal cukup pakai Dev Server (`npx inngest-cli dev`).
 */
export const inngest = new Inngest({
  id: 'oriole-api',
  eventKey: env.INNGEST_EVENT_KEY,
});
