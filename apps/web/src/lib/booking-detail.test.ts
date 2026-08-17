import { describe, expect, it } from 'vitest';

import type { CallRecord } from './bookings';
import {
  callDurationParts,
  callSummaryText,
  deriveCallOutcome,
} from './booking-detail';

/** Builder CallRecord ringkas untuk test — status/result yang relevan saja. */
function call(overrides: Partial<Pick<CallRecord, 'status' | 'result'>> = {}): Pick<CallRecord, 'status' | 'result'> {
  return { status: null, result: null, ...overrides };
}

describe('deriveCallOutcome', () => {
  it('tanpa call → unknown', () => {
    expect(deriveCallOutcome(null)).toBe('unknown');
    expect(deriveCallOutcome(undefined)).toBe('unknown');
  });

  it('tanpa status & tanpa result → unknown', () => {
    expect(deriveCallOutcome(call())).toBe('unknown');
  });

  it('panggilan masih berjalan (queued/ringing/in_progress) → unknown', () => {
    expect(deriveCallOutcome(call({ status: 'queued' }))).toBe('unknown');
    expect(deriveCallOutcome(call({ status: 'ringing' }))).toBe('unknown');
    expect(deriveCallOutcome(call({ status: 'in_progress' }))).toBe('unknown');
  });

  it('status canceled/cancelled → cancelled', () => {
    expect(deriveCallOutcome(call({ status: 'canceled' }))).toBe('cancelled');
    expect(deriveCallOutcome(call({ status: 'cancelled' }))).toBe('cancelled');
  });

  it('status failed + endedReason no-answer → no-answer', () => {
    expect(
      deriveCallOutcome(
        call({ status: 'failed', result: { endedReason: 'customer-did-not-answer' } }),
      ),
    ).toBe('no-answer');
  });

  it('status failed + endedReason busy → no-answer', () => {
    expect(
      deriveCallOutcome(call({ status: 'failed', result: { endedReason: 'customer-busy' } })),
    ).toBe('no-answer');
  });

  it('status failed + endedReason voicemail → no-answer', () => {
    expect(
      deriveCallOutcome(call({ status: 'failed', result: { endedReason: 'voicemail' } })),
    ).toBe('no-answer');
  });

  it('status failed + endedReason teknis → failed', () => {
    expect(
      deriveCallOutcome(call({ status: 'failed', result: { endedReason: 'transport-error' } })),
    ).toBe('failed');
  });

  it('status failed tanpa endedReason → failed', () => {
    expect(deriveCallOutcome(call({ status: 'failed' }))).toBe('failed');
  });

  it('status completed + booking completed → confirmed (goal tercapai)', () => {
    expect(
      deriveCallOutcome(call({ status: 'completed' }), { bookingCompleted: true }),
    ).toBe('confirmed');
    expect(
      deriveCallOutcome(call({ status: 'success' }), { bookingCompleted: true }),
    ).toBe('confirmed');
  });

  it('status completed tanpa booking completed → unknown (percakapan tanpa komitmen)', () => {
    expect(deriveCallOutcome(call({ status: 'completed' }))).toBe('unknown');
    expect(deriveCallOutcome(call({ status: 'completed' }), { bookingCompleted: false })).toBe('unknown');
  });

  it('status completed + booking failed-status → failed tetap menang (tidak dipaksa confirmed)', () => {
    expect(
      deriveCallOutcome(call({ status: 'failed' }), { bookingCompleted: true }),
    ).toBe('failed');
  });

  it('outcome eksplisit "confirmed" menang atas status', () => {
    expect(
      deriveCallOutcome(
        call({ status: 'completed', result: { outcome: 'Customer confirmed the appointment' } }),
      ),
    ).toBe('confirmed');
  });

  it('outcome eksplisit reschedule → reschedule-requested', () => {
    expect(
      deriveCallOutcome(call({ result: { outcome: 'customer requested reschedule' } })),
    ).toBe('reschedule-requested');
  });

  it('outcome eksplisit cancelled → cancelled', () => {
    expect(deriveCallOutcome(call({ result: { outcome: 'Cancelled' } }))).toBe('cancelled');
  });

  it('outcome eksplisit no-answer → no-answer (menang atas status completed)', () => {
    expect(
      deriveCallOutcome(
        call({ status: 'completed', result: { outcome: 'No answer' } }),
        { bookingCompleted: true },
      ),
    ).toBe('no-answer');
  });

  it('outcome eksplisit failed → failed', () => {
    expect(deriveCallOutcome(call({ result: { outcome: 'Call failed' } }))).toBe('failed');
  });

  it('result.result dipakai bila outcome tidak ada (alias lama)', () => {
    expect(
      deriveCallOutcome(call({ result: { result: 'confirmed attendance' } })),
    ).toBe('confirmed');
  });
});

describe('callDurationParts', () => {
  it('detik saja → menit 0', () => {
    expect(callDurationParts(32)).toEqual({ minutes: 0, seconds: 32 });
  });

  it('persis satu menit', () => {
    expect(callDurationParts(60)).toEqual({ minutes: 1, seconds: 0 });
  });

  it('menit + detik', () => {
    expect(callDurationParts(125)).toEqual({ minutes: 2, seconds: 5 });
  });

  it('dibulatkan ke detik terdekat', () => {
    expect(callDurationParts(32.7)).toEqual({ minutes: 0, seconds: 33 });
  });

  it('null / undefined / 0 / negatif / NaN → null', () => {
    expect(callDurationParts(null)).toBeNull();
    expect(callDurationParts(undefined)).toBeNull();
    expect(callDurationParts(0)).toBeNull();
    expect(callDurationParts(-5)).toBeNull();
    expect(callDurationParts(Number.NaN)).toBeNull();
    expect(callDurationParts(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('callSummaryText', () => {
  it('summary eksplisit dari result → teksnya', () => {
    expect(
      callSummaryText(call({ result: { summary: 'Sarah confirmed the appointment.' } })),
    ).toBe('Sarah confirmed the appointment.');
  });

  it('resultSummary (alias lama) → teksnya', () => {
    expect(
      callSummaryText(call({ result: { resultSummary: 'Customer confirmed.' } })),
    ).toBe('Customer confirmed.');
  });

  it('summary kosong / whitespace → null', () => {
    expect(callSummaryText(call({ result: { summary: '' } }))).toBeNull();
    expect(callSummaryText(call({ result: { summary: '   ' } }))).toBeNull();
  });

  it('tanpa summary (hanya outcome/status) → null', () => {
    expect(
      callSummaryText(call({ result: { outcome: 'confirmed', status: 'completed' } })),
    ).toBeNull();
  });

  it('tanpa result → null', () => {
    expect(callSummaryText(call())).toBeNull();
    expect(callSummaryText(null)).toBeNull();
  });
});
