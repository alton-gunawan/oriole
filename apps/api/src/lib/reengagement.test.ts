import { describe, expect, it, vi } from 'vitest';

// Modul reengagement meng-import env/db/chat-engine/telegram-handler —
// mock semuanya agar import aman, lalu uji hanya fungsi pure classifyReEngagement.
vi.mock('../lib/env.ts', () => ({ env: new Proxy({}, { get: () => undefined }) }));
vi.mock('../inngest/client.ts', () => ({ inngest: { send: vi.fn() } }));
vi.mock('../db/index.ts', () => ({ db: {} }));
vi.mock('./chat-engine.ts', () => ({ findChatByPhone: vi.fn() }));
vi.mock('./telegram-handler.ts', () => ({
  dispatchTelegramText: vi.fn(),
  TelegramDispatchError: class TelegramDispatchError extends Error {},
}));

import { classifyReEngagement } from './reengagement.ts';
import type { ReEngagementBooking, ReEngagementContact } from './reengagement.ts';

const DAY = 86_400_000;
const NOW = new Date('2026-08-14T00:00:00.000Z');
const PHONE = '6281234567890';
const OTHER = '6289999999999';

const opts = { dormantDays: 60, noShowWindowDays: 30, cooldownDays: 30 };

const contact = (id: string, phone: string, lastReEngagedAt: Date | null = null): ReEngagementContact => ({
  id,
  phone,
  name: 'Budi',
  lastReEngagedAt,
});

const booking = (phone: string, daysAgo: number, status: string, noShowCount = 0): ReEngagementBooking => ({
  phone,
  customerName: 'Budi',
  scheduledAt: new Date(NOW.getTime() - daysAgo * DAY),
  status,
  noShowCount,
});

describe('classifyReEngagement', () => {
  it('no-show dalam window → reason no-show', () => {
    const out = classifyReEngagement(
      [booking(PHONE, 10, 'cancelled', 1)],
      [contact('c1', PHONE)],
      NOW,
      opts,
    );
    expect(out).toEqual([{ contactId: 'c1', phone: PHONE, name: 'Budi', reason: 'no-show' }]);
  });

  it('dorman (booking terakhir > 60 hari) → reason dormant', () => {
    const out = classifyReEngagement(
      [booking(PHONE, 90, 'completed')],
      [contact('c1', PHONE)],
      NOW,
      opts,
    );
    expect(out[0].reason).toBe('dormant');
  });

  it('booking aktif → skip', () => {
    const out = classifyReEngagement(
      [booking(PHONE, 90, 'completed'), booking(PHONE, 0, 'confirmed')],
      [contact('c1', PHONE)],
      NOW,
      opts,
    );
    expect(out).toEqual([]);
  });

  it('cooldown belum lewat → skip', () => {
    const out = classifyReEngagement(
      [booking(PHONE, 90, 'completed')],
      [contact('c1', PHONE, new Date(NOW.getTime() - 5 * DAY))],
      NOW,
      opts,
    );
    expect(out).toEqual([]);
  });

  it('no-show menang atas dorman', () => {
    const out = classifyReEngagement(
      [booking(PHONE, 90, 'completed'), booking(PHONE, 5, 'cancelled', 2)],
      [contact('c1', PHONE)],
      NOW,
      opts,
    );
    expect(out).toHaveLength(1);
    expect(out[0].reason).toBe('no-show');
  });

  it('booking terbaru masih segar (bukan no-show) → skip', () => {
    const out = classifyReEngagement(
      [booking(PHONE, 20, 'completed')],
      [contact('c1', PHONE)],
      NOW,
      opts,
    );
    expect(out).toEqual([]);
  });

  it('nomor beda format (0xx vs +62) dianggap pelanggan yang sama', () => {
    const out = classifyReEngagement(
      [booking('081234567890', 90, 'completed')],
      [contact('c1', '+6281234567890')],
      NOW,
      opts,
    );
    expect(out).toHaveLength(1);
    expect(out[0].reason).toBe('dormant');
  });

  it('pelanggan lain yang masih aktif tidak ikut ditandai', () => {
    const out = classifyReEngagement(
      [booking(PHONE, 90, 'completed'), booking(OTHER, 10, 'confirmed')],
      [contact('c1', PHONE), contact('c2', OTHER)],
      NOW,
      opts,
    );
    expect(out).toHaveLength(1);
    expect(out[0].phone).toBe(PHONE);
  });
});
