import { describe, expect, it } from 'vitest';

import { determineCallGoal, FAILED_ATTEMPT_THRESHOLD, REMINDER_WINDOW_HOURS } from './determine-call-goal.ts';
import type { BookingGoalContext } from './types.ts';

const BASE: BookingGoalContext = {
  id: 'b1',
  title: 'Cleaning',
  status: 'pending',
  scheduledAt: new Date(Date.now() + 72 * 3_600_000).toISOString(),
  timezone: 'UTC',
  changeRequested: false,
  noShowCount: 0,
  previousCallAttempts: 0,
  failedCallAttempts: 0,
};

const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

describe('determineCallGoal', () => {
  it('tidak memanggil untuk booking dibatalkan', () => {
    const decision = determineCallGoal({ ...BASE, status: 'cancelled' });
    expect(decision.goalType).toBeNull();
  });

  it('tidak memanggil untuk booking selesai', () => {
    const decision = determineCallGoal({ ...BASE, status: 'completed' });
    expect(decision.goalType).toBeNull();
  });

  it('status tidak dikenal diperlakukan sebagai pending (tidak crash)', () => {
    const decision = determineCallGoal({
      ...BASE,
      status: 'weird-status' as BookingGoalContext['status'],
    });
    expect(decision.goalType).toBe('confirm-attendance');
  });

  it('prioritas: perubahan jadwal → reschedule-assistance', () => {
    const decision = determineCallGoal({ ...BASE, changeRequested: true, status: 'confirmed' });
    expect(decision.goalType).toBe('reschedule-assistance');
  });

  it('jadwal sudah lewat → final-follow-up', () => {
    const decision = determineCallGoal({ ...BASE, scheduledAt: inHours(-2) });
    expect(decision.goalType).toBe('final-follow-up');
  });

  it(`banyak panggilan gagal (>= ${FAILED_ATTEMPT_THRESHOLD}) → final-follow-up`, () => {
    const decision = determineCallGoal({ ...BASE, failedCallAttempts: FAILED_ATTEMPT_THRESHOLD });
    expect(decision.goalType).toBe('final-follow-up');
  });

  it('riwayat no-show → confirm-with-accountability', () => {
    const decision = determineCallGoal({ ...BASE, noShowCount: 1 });
    expect(decision.goalType).toBe('confirm-with-accountability');
  });

  it(`confirmed ≤ ${REMINDER_WINDOW_HOURS} jam → reminder-reconfirm`, () => {
    const decision = determineCallGoal({
      ...BASE,
      status: 'confirmed',
      scheduledAt: inHours(REMINDER_WINDOW_HOURS),
    });
    expect(decision.goalType).toBe('reminder-reconfirm');
  });

  it('confirmed lebih dari 24 jam dan belum pernah dihubungi → confirm-attendance', () => {
    const decision = determineCallGoal({
      ...BASE,
      status: 'confirmed',
      scheduledAt: inHours(48),
      previousCallAttempts: 0,
    });
    expect(decision.goalType).toBe('confirm-attendance');
  });

  it('belum pernah dihubungi → confirm-attendance', () => {
    const decision = determineCallGoal(BASE);
    expect(decision.goalType).toBe('confirm-attendance');
  });

  it('sudah pernah dihubungi tapi masih pending → reminder-reconfirm', () => {
    const decision = determineCallGoal({ ...BASE, previousCallAttempts: 1 });
    expect(decision.goalType).toBe('reminder-reconfirm');
  });

  it('selalu menyertakan alasan', () => {
    expect(determineCallGoal(BASE).reason).toBeTruthy();
  });
});
