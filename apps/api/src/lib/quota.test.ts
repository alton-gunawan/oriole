import { beforeAll, describe, expect, it } from 'vitest';

let planFromSubscription: (status: string | null | undefined) => 'free' | 'pro';

beforeAll(async () => {
  // env.ts (via db/index.ts) divalidasi saat import pertama — set variabel
  // dummy dulu, sama seperti test file lain di package ini.
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/oriole_test';
  process.env.NEON_AUTH_URL = 'https://ep-test.neon.tech/neondb/auth';
  process.env.PADDLE_API_KEY = 'pdl_sdbx_test';
  process.env.PADDLE_WEBHOOK_SECRET = 'pdl_ntfset_test';
  process.env.RESEND_API_KEY = 're_test';
  process.env.CALLE_API_KEY = 'calle_test';

  ({ planFromSubscription } = await import('./quota'));
});

describe('planFromSubscription', () => {
  it('status active/trialing → pro', () => {
    expect(planFromSubscription('active')).toBe('pro');
    expect(planFromSubscription('trialing')).toBe('pro');
  });

  it('status lain atau tanpa data → free', () => {
    expect(planFromSubscription('canceled')).toBe('free');
    expect(planFromSubscription('past_due')).toBe('free');
    expect(planFromSubscription('unpaid')).toBe('free');
    expect(planFromSubscription('paused')).toBe('free');
    expect(planFromSubscription(undefined)).toBe('free');
    expect(planFromSubscription(null)).toBe('free');
  });
});
