import { beforeAll, describe, expect, it } from 'vitest';

let PLANS: Record<string, { pricePerMonth: number; callsPerMonth: number; minutesPerMonth: number; inboundNumbersIncluded: number }>;
let priceIdForPlan: (plan: 'free' | 'pro' | 'business') => string | null;
let PLAN_ORDER: string[];

beforeAll(async () => {
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

  ({ PLANS, priceIdForPlan, PLAN_ORDER } = await import('./plans'));
});

describe('PLANS', () => {
  it('Free: $0, 10 panggilan, 30 menit, tanpa nomor masuk', () => {
    const free = PLANS['free'];
    expect(free.pricePerMonth).toBe(0);
    expect(free.callsPerMonth).toBe(10);
    expect(free.minutesPerMonth).toBe(30);
    expect(free.inboundNumbersIncluded).toBe(0);
  });

  it('Pro: $19, 50 panggilan, 150 menit (COGS ~$22 < harga bahkan di pemakaian penuh)', () => {
    const pro = PLANS['pro'];
    expect(pro.pricePerMonth).toBe(19);
    expect(pro.callsPerMonth).toBe(50);
    expect(pro.minutesPerMonth).toBe(150);
    expect(pro.inboundNumbersIncluded).toBe(0);
  });

  it('Business: $49, 150 panggilan, 450 menit + 1 nomor masuk', () => {
    const biz = PLANS['business'];
    expect(biz.pricePerMonth).toBe(49);
    expect(biz.callsPerMonth).toBe(150);
    expect(biz.minutesPerMonth).toBe(450);
    expect(biz.inboundNumbersIncluded).toBe(1);
  });

  it('urutan tampilan: free → pro → business', () => {
    expect(PLAN_ORDER).toEqual(['free', 'pro', 'business']);
  });
});

describe('priceIdForPlan', () => {
  it('mengembalikan price ID dari env untuk paket berbayar', () => {
    expect(priceIdForPlan('pro')).toBe('price_pro_test');
    expect(priceIdForPlan('business')).toBe('price_biz_test');
  });

  it('null untuk paket gratis', () => {
    expect(priceIdForPlan('free')).toBeNull();
  });
});
