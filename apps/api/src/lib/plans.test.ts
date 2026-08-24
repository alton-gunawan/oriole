import { beforeAll, describe, expect, it } from 'vitest';

let PLANS: Record<string, { pricePerMonth: number; trialDays: number; trialCreditUsd: number; creditCardRequired: boolean; usagePricing: string; cancelAnytime: boolean; features: string[] }>;
let priceIdForPlan: (plan: 'free' | 'pro') => string | null;
let planFromPriceId: (priceId: string | null | undefined) => 'free' | 'pro' | null;
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

  ({ PLANS, priceIdForPlan, planFromPriceId, PLAN_ORDER } = await import('./plans'));
});

describe('PLANS', () => {
  it('Free: $0, calendar & bookings, services + staff, contacts, 1 channel reminder (email), tanpa voice AI volume', () => {
    const free = PLANS['free'];
    expect(free.pricePerMonth).toBe(0);
    expect(free.trialDays).toBe(0);
    expect(free.trialCreditUsd).toBe(0);
    expect(free.creditCardRequired).toBe(false);
    expect(free.features).toContain('Calendar & bookings');
    expect(free.features).toContain('Services + staff');
    expect(free.features).toContain('Contacts');
    expect(free.features).toContain('1 channel reminder (email)');
    expect(free.features).toContain('Tanpa voice AI volume');
  });

  it('Pro: $15/bulan, 7-day free trial, $5 voice credit, whatsapp inbox, auto reminders, voice AI, test call', () => {
    const pro = PLANS['pro'];
    expect(pro.pricePerMonth).toBe(15);
    expect(pro.trialDays).toBe(7);
    expect(pro.trialCreditUsd).toBe(5);
    expect(pro.creditCardRequired).toBe(true);
    expect(pro.cancelAnytime).toBe(true);
    expect(pro.usagePricing).toBe('+ pay only for the voice calls you use');
    expect(pro.features).toContain('WhatsApp / multi-channel inbox');
    expect(pro.features).toContain('Auto reminders');
    expect(pro.features).toContain('Voice AI inbound/outbound (PAYG)');
    expect(pro.features).toContain('Test call + call history');
    expect(pro.features).toContain('Gratis $5 credit untuk call');
  });

  it('urutan tampilan: free, pro', () => {
    expect(PLAN_ORDER).toEqual(['free', 'pro']);
  });
});

describe('priceIdForPlan', () => {
  it('mengembalikan price ID dari env untuk paket berbayar pro', () => {
    expect(priceIdForPlan('pro')).toBe('price_pro_test');
  });

  it('null untuk paket gratis', () => {
    expect(priceIdForPlan('free')).toBeNull();
  });
});

describe('planFromPriceId', () => {
  it('memetakan price ID pro ke pro', () => {
    expect(planFromPriceId('price_pro_test')).toBe('pro');
  });
});
