import { describe, expect, it } from 'vitest';
import {
  aggregateBookingsByMonth,
  aggregateBookingStatus,
  aggregateCallOutcomes,
  aggregateMessagesByChannel,
  buildFunnel,
  countNeedsAttention,
  countThisMonth,
  monthKey,
  type BookingRow,
  type CallRow,
  type ConversationRow,
  type MessageRow,
} from './analytics.ts';

// Waktu tetap: 2026-07-15 → 12 bulan terakhir = Agu 2025 … Jul 2026.
const NOW = new Date('2026-07-15T12:00:00.000Z');

function booking(status: string, createdAt: Date): BookingRow {
  return { status, createdAt };
}

function call(status: string | null, createdAt: Date): CallRow {
  return { status, createdAt };
}

function message(channel: string, direction: string): MessageRow {
  return { channel, direction };
}

describe('monthKey & lastTwelveMonths', () => {
  it('monthKey memformat YYYY-MM dengan nol depan', () => {
    expect(monthKey(new Date('2026-01-05T00:00:00.000Z'))).toBe('2026-01');
    expect(monthKey(new Date('2026-11-05T00:00:00.000Z'))).toBe('2026-11');
  });
});

describe('aggregateBookingsByMonth', () => {
  it('mengisi 12 bulan terakhir dengan nol untuk bulan kosong', () => {
    const rows = [booking('confirmed', new Date('2026-07-01T00:00:00.000Z'))];
    const result = aggregateBookingsByMonth(rows, NOW);

    expect(result).toHaveLength(12);
    expect(result[0]).toEqual({ month: '2025-08', count: 0 });
    expect(result[11]).toEqual({ month: '2026-07', count: 1 });
  });

  it('menjumlahkan booking di bulan yang sama', () => {
    const rows = [
      booking('confirmed', new Date('2026-03-01T00:00:00.000Z')),
      booking('cancelled', new Date('2026-03-20T00:00:00.000Z')),
      booking('pending', new Date('2026-03-31T00:00:00.000Z')),
    ];
    const result = aggregateBookingsByMonth(rows, NOW);
    const march = result.find((row) => row.month === '2026-03');
    expect(march?.count).toBe(3);
  });

  it('mengabaikan booking di luar 12 bulan terakhir', () => {
    const rows = [booking('confirmed', new Date('2024-01-01T00:00:00.000Z'))];
    const result = aggregateBookingsByMonth(rows, NOW);
    expect(result.every((row) => row.count === 0)).toBe(true);
  });
});

describe('aggregateBookingStatus', () => {
  it('mengelompokkan berdasarkan status', () => {
    const rows = [
      booking('confirmed', NOW),
      booking('confirmed', NOW),
      booking('cancelled', NOW),
      booking('completed', NOW),
    ];
    const result = aggregateBookingStatus(rows);
    expect(result).toEqual(
      expect.arrayContaining([
        { status: 'confirmed', count: 2 },
        { status: 'cancelled', count: 1 },
        { status: 'completed', count: 1 },
      ]),
    );
  });
});

describe('buildFunnel', () => {
  it('funnel menurun: created ≥ confirmed ≥ completed', () => {
    const rows = [
      booking('confirmed', NOW),
      booking('completed', NOW),
      booking('cancelled', NOW),
      booking('pending', NOW),
    ];
    const funnel = buildFunnel(rows);
    expect(funnel).toEqual([
      { step: 'created', count: 4 },
      { step: 'confirmed', count: 2 },
      { step: 'completed', count: 1 },
    ]);
  });

  it('workspace kosong → funnel semua nol', () => {
    expect(buildFunnel([])).toEqual([
      { step: 'created', count: 0 },
      { step: 'confirmed', count: 0 },
      { step: 'completed', count: 0 },
    ]);
  });
});

describe('aggregateCallOutcomes', () => {
  it('null status dikelompokkan sebagai unknown', () => {
    const rows = [
      call('completed', NOW),
      call('completed', NOW),
      call('failed', NOW),
      call(null, NOW),
    ];
    const result = aggregateCallOutcomes(rows);
    expect(result).toEqual(
      expect.arrayContaining([
        { status: 'completed', count: 2 },
        { status: 'failed', count: 1 },
        { status: 'unknown', count: 1 },
      ]),
    );
  });
});

describe('aggregateMessagesByChannel', () => {
  it('memecah inbound/outbound per channel', () => {
    const rows = [
      message('telegram', 'inbound'),
      message('telegram', 'inbound'),
      message('telegram', 'outbound'),
      message('whatsapp', 'outbound'),
    ];
    const result = aggregateMessagesByChannel(rows);
    expect(result).toEqual(
      expect.arrayContaining([
        { channel: 'telegram', inbound: 2, outbound: 1 },
        { channel: 'whatsapp', inbound: 0, outbound: 1 },
      ]),
    );
  });
});

describe('countNeedsAttention', () => {
  it('menghitung percakapan dengan state.needsAttention', () => {
    const rows: ConversationRow[] = [
      { state: { needsAttention: true } },
      { state: { needsAttention: false } },
      { state: null },
      { state: { step: 'awaiting-time' } },
    ];
    expect(countNeedsAttention(rows)).toBe(1);
  });
});

describe('countThisMonth', () => {
  it('hanya menghitung baris pada bulan berjalan', () => {
    const rows = [
      booking('confirmed', new Date('2026-07-01T00:00:00.000Z')),
      booking('pending', new Date('2026-07-31T00:00:00.000Z')),
      booking('pending', new Date('2026-06-30T00:00:00.000Z')),
    ];
    expect(countThisMonth(rows, NOW)).toBe(2);
  });
});
