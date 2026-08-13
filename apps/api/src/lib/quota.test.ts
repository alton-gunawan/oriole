import { beforeAll, describe, expect, it } from 'vitest';

let planFromSubscription: (
  status: string | null | undefined,
  priceId?: string | null | undefined,
) => 'free' | 'pro' | 'business';

let planFromPriceId: (priceId: string | null | undefined) => 'free' | 'pro' | 'business' | null;

beforeAll(async () => {
  // env.ts (via db/index.ts) divalidasi saat import pertama — set variabel
  // dummy dulu, sama seperti test file lain di package ini.
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/oriole_test';
  process.env.NEON_AUTH_URL = 'https://ep-test.neon.tech/neondb/auth';
  process.env.PADDLE_API_KEY = 'pdl_sdbx_test';
  process.env.PADDLE_WEBHOOK_SECRET = 'pdl_ntfset_test';
  process.env.PADDLE_PRO_PRICE_ID = 'price_pro_test';
  process.env.PADDLE_BUSINESS_PRICE_ID = 'price_biz_test';
  process.env.RESEND_API_KEY = 're_test';
  process.env.VAPI_API_KEY = 'vapi_test';
  process.env.VAPI_PHONE_NUMBER_ID = 'phone-number-test';

  ({ planFromSubscription } = await import('./quota'));
  ({ planFromPriceId } = await import('./plans'));
});

describe('planFromSubscription', () => {
  it('status active/trialing tanpa priceId → pro (fallback)', () => {
    expect(planFromSubscription('active')).toBe('pro');
    expect(planFromSubscription('trialing')).toBe('pro');
    expect(planFromSubscription('active', undefined)).toBe('pro');
    expect(planFromSubscription('active', null)).toBe('pro');
  });

  it('active + price ID Business → business', () => {
    expect(planFromSubscription('active', 'price_biz_test')).toBe('business');
    expect(planFromSubscription('trialing', 'price_biz_test')).toBe('business');
  });

  it('active + price ID Pro → pro', () => {
    expect(planFromSubscription('active', 'price_pro_test')).toBe('pro');
  });

  it('active + price ID tak dikenal → pro (default aman)', () => {
    expect(planFromSubscription('active', 'price_unknown')).toBe('pro');
  });

  it('status lain atau tanpa data → free (berapapun priceId)', () => {
    expect(planFromSubscription('canceled')).toBe('free');
    expect(planFromSubscription('past_due')).toBe('free');
    expect(planFromSubscription('unpaid')).toBe('free');
    expect(planFromSubscription('paused')).toBe('free');
    expect(planFromSubscription('canceled', 'price_biz_test')).toBe('free');
    expect(planFromSubscription(undefined)).toBe('free');
    expect(planFromSubscription(null)).toBe('free');
  });
});

describe('planFromPriceId', () => {
  it('price ID terdaftar → paket sesuai env', () => {
    expect(planFromPriceId('price_pro_test')).toBe('pro');
    expect(planFromPriceId('price_biz_test')).toBe('business');
  });

  it('price ID tak dikenal / kosong → null', () => {
    expect(planFromPriceId('price_unknown')).toBeNull();
    expect(planFromPriceId(undefined)).toBeNull();
    expect(planFromPriceId(null)).toBeNull();
    expect(planFromPriceId('')).toBeNull();
  });
});
