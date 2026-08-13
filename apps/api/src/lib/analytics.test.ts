import { afterEach, describe, expect, it } from 'vitest';

// Env wajib (dibaca env.ts saat modul di-import). POSTHOG_PUBLIC_KEY sengaja
// TIDAK disetel — default sink = null (analitik nonaktif); test yang butuh
// sink menyuntikkan fake via setAnalyticsSinkForTests. Import modul dilakukan
// secara dinamis SETELAH env disetel (ESM hoist import statis ke atas).
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/oriole_test';
process.env.NEON_AUTH_URL = 'https://ep-test.neon.tech/neondb/auth';
process.env.PADDLE_API_KEY = 'pdl_sdbx_test';
process.env.PADDLE_WEBHOOK_SECRET = 'pdl_ntfset_test';
process.env.RESEND_API_KEY = 're_test';
process.env.VAPI_API_KEY = 'vapi_test';
process.env.VAPI_PHONE_NUMBER_ID = 'phone-number-test';

const {
  captureBookingEvent,
  captureCallEvent,
  captureEvent,
  captureException,
  captureIntegrationEvent,
  capturePaymentEvent,
  captureWorkspaceEvent,
  flushAnalytics,
  getFeatureFlagValue,
  getSink,
  isAnalyticsEnabled,
  setAnalyticsSinkForTests,
  shutdownAnalytics,
} = await import('./analytics.ts');
import type { AnalyticsEventPayload, AnalyticsSink, FlagsSnapshot } from './analytics.ts';

/** Sink fiktif yang merekam semua event — tanpa jaringan ke PostHog. */
class FakeSink implements AnalyticsSink {
  captured: AnalyticsEventPayload[] = [];
  exceptions: { error: unknown; distinctId: string; properties?: Record<string, unknown> }[] = [];
  flushCalls = 0;
  shutdownCalls = 0;
  /** Nilai flag per key (boolean = on/off; undefined = flag tidak ada). */
  flags: Record<string, string | boolean> = {};
  /** true → evaluateFlags melempar (simulasi PostHog down). */
  flagError = false;
  flagCalls: { distinctId: string; groups?: Record<string, string>; flagKeys?: string[] }[] = [];

  capture(payload: AnalyticsEventPayload): void {
    this.captured.push(payload);
  }
  captureException(error: unknown, distinctId: string, properties?: Record<string, unknown>): void {
    this.exceptions.push({ error, distinctId, properties });
  }
  async evaluateFlags(
    distinctId: string,
    options?: { groups?: Record<string, string>; flagKeys?: string[] },
  ): Promise<FlagsSnapshot> {
    this.flagCalls.push({ distinctId, groups: options?.groups, flagKeys: options?.flagKeys });
    if (this.flagError) throw new Error('posthog down');
    return {
      isEnabled: (key) => this.flags[key] === true,
      getFlag: (key) => this.flags[key],
      getFlagPayload: () => undefined,
    };
  }
  async flush(): Promise<void> {
    this.flushCalls += 1;
  }
  async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
  }
}

describe('analytics (server-side PostHog)', () => {
  afterEach(() => {
    // Reset cache sink antar test (undefined → dibuat ulang dari env saat
    // dipakai; env tanpa key → null, jadi tidak ada klien PostHog dibuat).
    setAnalyticsSinkForTests(undefined);
  });

  it('tanpa POSTHOG_PUBLIC_KEY → sink null, semua helper no-op aman', async () => {
    expect(isAnalyticsEnabled).toBe(false);
    expect(getSink()).toBeNull();
    expect(() => captureEvent({ event: 'x', distinctId: 'u' })).not.toThrow();
    expect(() => captureException(new Error('x'), 'u')).not.toThrow();
    await expect(flushAnalytics()).resolves.toBeUndefined();
    await expect(shutdownAnalytics()).resolves.toBeUndefined();
  });

  it('sink null dipaksa → captureEvent no-op tanpa throw', () => {
    setAnalyticsSinkForTests(null);
    expect(getSink()).toBeNull();
    expect(() => captureEvent({ event: 'x', distinctId: 'u' })).not.toThrow();
  });

  it('captureEvent meneruskan payload apa adanya ke sink', () => {
    const sink = new FakeSink();
    setAnalyticsSinkForTests(sink);

    captureEvent({
      event: 'test.event',
      distinctId: 'u-1',
      properties: { a: 1 },
      groups: { workspace: 'ws-1' },
    });

    expect(sink.captured).toHaveLength(1);
    expect(sink.captured[0]).toMatchObject({
      event: 'test.event',
      distinctId: 'u-1',
      properties: { a: 1 },
      groups: { workspace: 'ws-1' },
    });
  });

  it('captureBookingEvent → group workspace + properti no-PII, distinctId = userId', () => {
    const sink = new FakeSink();
    setAnalyticsSinkForTests(sink);

    captureBookingEvent('booking.created', {
      workspaceId: 'ws-1',
      bookingId: 'b-1',
      userId: 'u-1',
      source: 'manual',
      goalType: 'booking-reminder',
      status: 'pending',
    });

    const ev = sink.captured[0];
    expect(ev.event).toBe('booking.created');
    expect(ev.distinctId).toBe('u-1');
    expect(ev.groups).toEqual({ workspace: 'ws-1' });
    expect(ev.properties).toMatchObject({
      booking_id: 'b-1',
      source: 'manual',
      goal_type: 'booking-reminder',
      status: 'pending',
    });
    // PII tidak boleh pernah masuk properti event.
    expect(ev.properties).not.toHaveProperty('phone');
    expect(ev.properties).not.toHaveProperty('email');
    expect(ev.properties).not.toHaveProperty('customer_name');
  });

  it('captureBookingEvent tanpa userId → distinctId fallback workspace:* (system)', () => {
    const sink = new FakeSink();
    setAnalyticsSinkForTests(sink);

    captureBookingEvent('booking.completed', {
      workspaceId: 'ws-1',
      bookingId: 'b-1',
      status: 'completed',
    });

    expect(sink.captured[0].distinctId).toBe('workspace:ws-1');
    expect(sink.captured[0].groups).toEqual({ workspace: 'ws-1' });
  });

  it('captureCallEvent → durasi + status + id + ended_reason, group workspace', () => {
    const sink = new FakeSink();
    setAnalyticsSinkForTests(sink);

    captureCallEvent('call.completed', {
      workspaceId: 'ws-1',
      bookingId: 'b-1',
      callId: 'call-1',
      status: 'completed',
      goalType: 'booking-reminder',
      durationSeconds: 42,
      endedReason: 'customer-ended-call',
    });

    const ev = sink.captured[0];
    expect(ev.event).toBe('call.completed');
    expect(ev.distinctId).toBe('workspace:ws-1');
    expect(ev.properties).toMatchObject({
      booking_id: 'b-1',
      call_id: 'call-1',
      status: 'completed',
      goal_type: 'booking-reminder',
      duration_seconds: 42,
      ended_reason: 'customer-ended-call',
    });
  });

  it('captureWorkspaceEvent → template category + industry', () => {
    const sink = new FakeSink();
    setAnalyticsSinkForTests(sink);

    captureWorkspaceEvent('workspace.created', {
      userId: 'u-1',
      workspaceId: 'ws-1',
      templateCategory: 'salon',
      industry: 'beauty',
    });

    const ev = sink.captured[0];
    expect(ev.event).toBe('workspace.created');
    expect(ev.distinctId).toBe('u-1');
    expect(ev.groups).toEqual({ workspace: 'ws-1' });
    expect(ev.properties).toMatchObject({
      workspace_id: 'ws-1',
      template_category: 'salon',
      industry: 'beauty',
    });
  });

  it('captureIntegrationEvent → integration_type tanpa kredensial', () => {
    const sink = new FakeSink();
    setAnalyticsSinkForTests(sink);

    captureIntegrationEvent('integration.connected', {
      workspaceId: 'ws-1',
      integrationType: 'slack',
    });

    const ev = sink.captured[0];
    expect(ev.event).toBe('integration.connected');
    expect(ev.properties).toEqual({
      workspace_id: 'ws-1',
      integration_type: 'slack',
    });
    expect(ev.properties).not.toHaveProperty('webhook_url');
    expect(ev.properties).not.toHaveProperty('token');
  });

  it('capturePaymentEvent → jumlah + mata uang, group workspace', () => {
    const sink = new FakeSink();
    setAnalyticsSinkForTests(sink);

    capturePaymentEvent('payment.completed', {
      workspaceId: 'ws-1',
      paymentLinkId: 'pay-1',
      bookingId: 'b-1',
      status: 'paid',
      amountMinor: 25000,
      currency: 'USD',
    });

    const ev = sink.captured[0];
    expect(ev.event).toBe('payment.completed');
    expect(ev.groups).toEqual({ workspace: 'ws-1' });
    expect(ev.properties).toMatchObject({
      payment_link_id: 'pay-1',
      booking_id: 'b-1',
      status: 'paid',
      amount_minor: 25000,
      currency: 'USD',
    });
  });

  it('captureException → diteruskan ke sink dengan distinctId', () => {
    const sink = new FakeSink();
    setAnalyticsSinkForTests(sink);
    const error = new Error('boom');

    captureException(error, 'u-1', { path: '/api/x' });

    expect(sink.exceptions).toHaveLength(1);
    expect(sink.exceptions[0].error).toBe(error);
    expect(sink.exceptions[0].distinctId).toBe('u-1');
    expect(sink.exceptions[0].properties).toEqual({ path: '/api/x' });
  });

  it('flushAnalytics / shutdownAnalytics memanggil sink', async () => {
    const sink = new FakeSink();
    setAnalyticsSinkForTests(sink);

    await flushAnalytics();
    await shutdownAnalytics();

    expect(sink.flushCalls).toBe(1);
    expect(sink.shutdownCalls).toBe(1);
  });

  it('getFeatureFlagValue → sink tanpa evaluateFlags = fallback (analitik nonaktif)', async () => {
    // Tanpa key → sink null, tanpa metode flag.
    expect(await getFeatureFlagValue('reminders-enabled', 'ws-1', { fallback: true })).toBe(true);
    expect(await getFeatureFlagValue('reminders-enabled', 'ws-1', { fallback: false })).toBe(false);
  });

  it('getFeatureFlagValue → nilai boolean flag menimpa fallback', async () => {
    const sink = new FakeSink();
    sink.flags = { 'reminders-enabled': false, 'beta-ui': true };
    setAnalyticsSinkForTests(sink);

    await expect(
      getFeatureFlagValue('reminders-enabled', 'workspace:ws-1', {
        groups: { workspace: 'ws-1' },
        fallback: true,
      }),
    ).resolves.toBe(false);
    await expect(
      getFeatureFlagValue('beta-ui', 'workspace:ws-1', { groups: { workspace: 'ws-1' }, fallback: false }),
    ).resolves.toBe(true);

    // Satu pemanggilan /flags dengan group workspace + subset flag.
    expect(sink.flagCalls).toHaveLength(2);
    expect(sink.flagCalls[0]).toMatchObject({ distinctId: 'workspace:ws-1', groups: { workspace: 'ws-1' } });
    expect(sink.flagCalls[0].flagKeys).toEqual(['reminders-enabled']);
  });

  it('getFeatureFlagValue → flag tidak ada (undefined) = fallback, bukan false', async () => {
    const sink = new FakeSink();
    sink.flags = {}; // tidak ada flag → getFlag undefined
    setAnalyticsSinkForTests(sink);

    // Kill-switch: flag belum dibuat TIDAK boleh mematikan fitur.
    await expect(
      getFeatureFlagValue('reminders-enabled', 'workspace:ws-1', { fallback: true }),
    ).resolves.toBe(true);
  });

  it('getFeatureFlagValue → PostHog error/network gagal = fallback, tidak throw', async () => {
    const sink = new FakeSink();
    sink.flagError = true;
    setAnalyticsSinkForTests(sink);

    await expect(
      getFeatureFlagValue('reminders-enabled', 'workspace:ws-1', { fallback: true }),
    ).resolves.toBe(true);
  });
});
