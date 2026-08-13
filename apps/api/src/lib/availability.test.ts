import { beforeAll, describe, expect, it } from 'vitest';

// Modul yang diuji meng-import env (validasi saat load) — set env dulu,
// lalu dynamic import agar tidak mengevaluasi lebih awal.
beforeAll(() => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/oriole_test';
  process.env.NEON_AUTH_URL = 'https://ep-test.neon.tech/neondb/auth';
  process.env.PADDLE_API_KEY = 'pdl_sdbx_test';
  process.env.PADDLE_WEBHOOK_SECRET = 'pdl_ntfset_test';
  process.env.RESEND_API_KEY = 're_test';
  process.env.VAPI_API_KEY = 'vapi_test';
  process.env.VAPI_PHONE_NUMBER_ID = 'phone-number-test';
});

async function loadEngine() {
  const [availability, recurrence] = await Promise.all([
    import('./availability.ts'),
    import('./recurrence.ts'),
  ]);
  return { ...availability, ...recurrence };
}

const t = (iso: string) => new Date(iso);

describe('intervalsOverlap', () => {
  it('interval yang saling menutup → true', async () => {
    const { intervalsOverlap } = await loadEngine();
    expect(intervalsOverlap({ start: t('2026-02-02T09:00:00Z'), end: t('2026-02-02T10:00:00Z') }, { start: t('2026-02-02T09:30:00Z'), end: t('2026-02-02T10:30:00Z') })).toBe(true);
  });

  it('interval yang mengandung interval lain → true', async () => {
    const { intervalsOverlap } = await loadEngine();
    expect(intervalsOverlap({ start: t('2026-02-02T09:00:00Z'), end: t('2026-02-02T11:00:00Z') }, { start: t('2026-02-02T09:30:00Z'), end: t('2026-02-02T10:00:00Z') })).toBe(true);
  });

  it('interval yang hanya bersentuhan (end == start) → false (half-open)', async () => {
    const { intervalsOverlap } = await loadEngine();
    expect(intervalsOverlap({ start: t('2026-02-02T09:00:00Z'), end: t('2026-02-02T10:00:00Z') }, { start: t('2026-02-02T10:00:00Z'), end: t('2026-02-02T11:00:00Z') })).toBe(false);
  });

  it('interval yang terpisah → false', async () => {
    const { intervalsOverlap } = await loadEngine();
    expect(intervalsOverlap({ start: t('2026-02-02T09:00:00Z'), end: t('2026-02-02T10:00:00Z') }, { start: t('2026-02-02T11:00:00Z'), end: t('2026-02-02T12:00:00Z') })).toBe(false);
  });
});

describe('mergeIntervals', () => {
  it('menggabungkan interval yang tumpang-tindih (input tidak terurut)', async () => {
    const { mergeIntervals } = await loadEngine();
    const merged = mergeIntervals([
      { start: t('2026-02-02T10:30:00Z'), end: t('2026-02-02T11:30:00Z') },
      { start: t('2026-02-02T09:00:00Z'), end: t('2026-02-02T10:00:00Z') },
      { start: t('2026-02-02T09:45:00Z'), end: t('2026-02-02T11:00:00Z') },
    ]);
    expect(merged).toEqual([{ start: t('2026-02-02T09:00:00Z'), end: t('2026-02-02T11:30:00Z') }]);
  });

  it('interval yang bersentuhan TIDAK digabung (menggabung hanya overlap sejati)', async () => {
    const { mergeIntervals } = await loadEngine();
    const merged = mergeIntervals([
      { start: t('2026-02-02T09:00:00Z'), end: t('2026-02-02T10:00:00Z') },
      { start: t('2026-02-02T10:00:00Z'), end: t('2026-02-02T11:00:00Z') },
    ]);
    expect(merged).toHaveLength(2);
  });
});

describe('subtractIntervals', () => {
  it('tanpa busy → free utuh', async () => {
    const { subtractIntervals } = await loadEngine();
    const free = [{ start: t('2026-02-02T09:00:00Z'), end: t('2026-02-02T17:00:00Z') }];
    expect(subtractIntervals(free, [])).toEqual(free);
  });

  it('busy di tengah → dua segmen', async () => {
    const { subtractIntervals } = await loadEngine();
    const result = subtractIntervals(
      [{ start: t('2026-02-02T09:00:00Z'), end: t('2026-02-02T17:00:00Z') }],
      [{ start: t('2026-02-02T12:00:00Z'), end: t('2026-02-02T13:00:00Z') }],
    );
    expect(result).toEqual([
      { start: t('2026-02-02T09:00:00Z'), end: t('2026-02-02T12:00:00Z') },
      { start: t('2026-02-02T13:00:00Z'), end: t('2026-02-02T17:00:00Z') },
    ]);
  });

  it('busy menutupi ujung kiri free', async () => {
    const { subtractIntervals } = await loadEngine();
    const result = subtractIntervals(
      [{ start: t('2026-02-02T09:00:00Z'), end: t('2026-02-02T17:00:00Z') }],
      [{ start: t('2026-02-02T08:00:00Z'), end: t('2026-02-02T10:30:00Z') }],
    );
    expect(result).toEqual([{ start: t('2026-02-02T10:30:00Z'), end: t('2026-02-02T17:00:00Z') }]);
  });

  it('busy menutupi ujung kanan free', async () => {
    const { subtractIntervals } = await loadEngine();
    const result = subtractIntervals(
      [{ start: t('2026-02-02T09:00:00Z'), end: t('2026-02-02T17:00:00Z') }],
      [{ start: t('2026-02-02T16:00:00Z'), end: t('2026-02-02T18:00:00Z') }],
    );
    expect(result).toEqual([{ start: t('2026-02-02T09:00:00Z'), end: t('2026-02-02T16:00:00Z') }]);
  });

  it('busy menutupi seluruh free → kosong', async () => {
    const { subtractIntervals } = await loadEngine();
    expect(
      subtractIntervals(
        [{ start: t('2026-02-02T09:00:00Z'), end: t('2026-02-02T17:00:00Z') }],
        [{ start: t('2026-02-02T09:00:00Z'), end: t('2026-02-02T17:00:00Z') }],
      ),
    ).toEqual([]);
  });

  it('beberapa busy berurutan + busy di luar free diabaikan', async () => {
    const { subtractIntervals } = await loadEngine();
    const result = subtractIntervals(
      [{ start: t('2026-02-02T09:00:00Z'), end: t('2026-02-02T17:00:00Z') }],
      [
        { start: t('2026-02-02T10:00:00Z'), end: t('2026-02-02T10:30:00Z') },
        { start: t('2026-02-02T10:30:00Z'), end: t('2026-02-02T11:00:00Z') },
        { start: t('2026-02-02T13:00:00Z'), end: t('2026-02-02T14:00:00Z') },
        { start: t('2026-02-02T18:00:00Z'), end: t('2026-02-02T19:00:00Z') },
      ],
    );
    expect(result).toEqual([
      { start: t('2026-02-02T09:00:00Z'), end: t('2026-02-02T10:00:00Z') },
      { start: t('2026-02-02T11:00:00Z'), end: t('2026-02-02T13:00:00Z') },
      { start: t('2026-02-02T14:00:00Z'), end: t('2026-02-02T17:00:00Z') },
    ]);
  });
});

describe('withBuffer', () => {
  it('melebarkan interval di kedua ujung', async () => {
    const { withBuffer } = await loadEngine();
    const result = withBuffer([{ start: t('2026-02-02T10:00:00Z'), end: t('2026-02-02T11:00:00Z') }], 15);
    expect(result[0].start.toISOString()).toBe('2026-02-02T09:45:00.000Z');
    expect(result[0].end.toISOString()).toBe('2026-02-02T11:15:00.000Z');
  });

  it('buffer 0 → interval tidak diubah', async () => {
    const { withBuffer } = await loadEngine();
    const intervals = [{ start: t('2026-02-02T10:00:00Z'), end: t('2026-02-02T11:00:00Z') }];
    expect(withBuffer(intervals, 0)).toBe(intervals);
  });
});

describe('generateSlots', () => {
  it('breakdown per step 15 menit, slot muat penuh (half-open)', async () => {
    const { generateSlots } = await loadEngine();
    const slots = generateSlots(
      [{ start: t('2026-02-02T09:00:00Z'), end: t('2026-02-02T12:00:00Z') }],
      { durationMinutes: 60 },
    );
    // Slot terakhir = 11:00 (11:15+60 menit > 12:00 → tidak muat penuh).
    expect(slots).toHaveLength(9);
    expect(slots[0].start.toISOString()).toBe('2026-02-02T09:00:00.000Z');
    expect(slots[0].end.toISOString()).toBe('2026-02-02T10:00:00.000Z');
    expect(slots[8].start.toISOString()).toBe('2026-02-02T11:00:00.000Z');
  });

  it('slot terakhir tidak melewati batas free', async () => {
    const { generateSlots } = await loadEngine();
    const slots = generateSlots(
      [{ start: t('2026-02-02T09:00:00Z'), end: t('2026-02-02T10:45:00Z') }],
      { durationMinutes: 60, stepMinutes: 30 },
    );
    expect(slots.map((s) => s.start.toISOString())).toEqual(['2026-02-02T09:00:00.000Z', '2026-02-02T09:30:00.000Z']);
  });

  it('maxSlots membatasi jumlah hasil', async () => {
    const { generateSlots } = await loadEngine();
    const slots = generateSlots(
      [{ start: t('2026-02-02T00:00:00Z'), end: t('2026-02-03T00:00:00Z') }],
      { durationMinutes: 30, maxSlots: 10 },
    );
    expect(slots).toHaveLength(10);
  });
});

describe('scheduleWindowsForDay (zona waktu)', () => {
  it('Senin 09:00-17:00 Asia/Jakarta → 02:00-10:00 UTC', async () => {
    const { scheduleWindowsForDay } = await loadEngine();
    const windows = scheduleWindowsForDay(
      [{ dayOfWeek: 1, startMinutes: 9 * 60, endMinutes: 17 * 60 } as never],
      t('2026-02-02T00:00:00Z'), // Senin
      'Asia/Jakarta',
    );
    expect(windows).toEqual([{ start: t('2026-02-02T02:00:00Z'), end: t('2026-02-02T10:00:00Z') }]);
  });

  it('jadwal hari lain tidak bocor ke hari Senin', async () => {
    const { scheduleWindowsForDay } = await loadEngine();
    const windows = scheduleWindowsForDay(
      [{ dayOfWeek: 3, startMinutes: 9 * 60, endMinutes: 17 * 60 } as never],
      t('2026-02-02T00:00:00Z'),
      'Asia/Jakarta',
    );
    expect(windows).toEqual([]);
  });

  it('dua rentang dalam sehari → dua jendela', async () => {
    const { scheduleWindowsForDay } = await loadEngine();
    const windows = scheduleWindowsForDay(
      [
        { dayOfWeek: 1, startMinutes: 9 * 60, endMinutes: 12 * 60 },
        { dayOfWeek: 1, startMinutes: 14 * 60, endMinutes: 18 * 60 },
      ] as never,
      t('2026-02-02T00:00:00Z'),
      'UTC',
    );
    expect(windows).toEqual([
      { start: t('2026-02-02T09:00:00Z'), end: t('2026-02-02T12:00:00Z') },
      { start: t('2026-02-02T14:00:00Z'), end: t('2026-02-02T18:00:00Z') },
    ]);
  });
});

describe('expandRecurrence', () => {
  const anchor = t('2026-02-02T10:00:00Z'); // Senin

  it('daily × interval 1, count 3', async () => {
    const { expandRecurrence } = await loadEngine();
    const result = expandRecurrence({ frequency: 'daily', interval: 1, count: 3 }, anchor);
    expect(result.map((d) => d.toISOString())).toEqual([
      '2026-02-02T10:00:00.000Z',
      '2026-02-03T10:00:00.000Z',
      '2026-02-04T10:00:00.000Z',
    ]);
  });

  it('weekly dengan weekdays [Sen, Rab], count 4', async () => {
    const { expandRecurrence } = await loadEngine();
    const result = expandRecurrence({ frequency: 'weekly', interval: 1, weekdays: [1, 3], count: 4 }, anchor);
    expect(result.map((d) => d.toISOString())).toEqual([
      '2026-02-02T10:00:00.000Z', // Sen
      '2026-02-04T10:00:00.000Z', // Rab
      '2026-02-09T10:00:00.000Z', // Sen berikutnya
      '2026-02-11T10:00:00.000Z', // Rab berikutnya
    ]);
  });

  it('weekly interval 2 → tiap 2 minggu', async () => {
    const { expandRecurrence } = await loadEngine();
    const result = expandRecurrence({ frequency: 'weekly', interval: 2, count: 3 }, anchor);
    expect(result.map((d) => d.toISOString())).toEqual([
      '2026-02-02T10:00:00.000Z',
      '2026-02-16T10:00:00.000Z',
      '2026-03-02T10:00:00.000Z',
    ]);
  });

  it('monthly interval 1, count 3', async () => {
    const { expandRecurrence } = await loadEngine();
    const result = expandRecurrence({ frequency: 'monthly', interval: 1, count: 3 }, anchor);
    expect(result.map((d) => d.toISOString())).toEqual([
      '2026-02-02T10:00:00.000Z',
      '2026-03-02T10:00:00.000Z',
      '2026-04-02T10:00:00.000Z',
    ]);
  });

  it('until membatasi (daily sampai 2026-02-20)', async () => {
    const { expandRecurrence } = await loadEngine();
    const result = expandRecurrence({ frequency: 'daily', interval: 1, until: '2026-02-20' }, anchor);
    expect(result).toHaveLength(19); // 2 Feb .. 20 Feb
    expect(result[result.length - 1].toISOString()).toBe('2026-02-20T10:00:00.000Z');
  });

  it('count dihitung dari anchor walau from memfilter', async () => {
    const { expandRecurrence } = await loadEngine();
    const result = expandRecurrence(
      { frequency: 'daily', interval: 1, count: 10 },
      anchor,
      { from: t('2026-02-04T00:00:00Z') },
    );
    // Total 10 kemunculan (2..11 Feb); filter from → 8 kemunculan (4..11 Feb).
    expect(result).toHaveLength(8);
    expect(result[0].toISOString()).toBe('2026-02-04T10:00:00.000Z');
  });

  it('to membatasi rentang akhir', async () => {
    const { expandRecurrence } = await loadEngine();
    const result = expandRecurrence(
      { frequency: 'daily', interval: 1, count: 10 },
      anchor,
      { to: t('2026-02-05T23:59:59Z') },
    );
    expect(result).toHaveLength(4);
  });

  it('maxOccurrences membatasi deret mentah (anti-loop)', async () => {
    const { expandRecurrence } = await loadEngine();
    const result = expandRecurrence(
      { frequency: 'daily', interval: 1, count: 100 },
      anchor,
      { maxOccurrences: 10 },
    );
    expect(result).toHaveLength(10);
  });

  it('weekly tanpa weekdays → hanya hari anchor', async () => {
    const { expandRecurrence } = await loadEngine();
    const result = expandRecurrence({ frequency: 'weekly', interval: 1, count: 3 }, anchor);
    expect(result.map((d) => d.toISOString())).toEqual([
      '2026-02-02T10:00:00.000Z',
      '2026-02-09T10:00:00.000Z',
      '2026-02-16T10:00:00.000Z',
    ]);
  });
});

describe('recurrenceSchema', () => {
  it('menerima aturan valid', async () => {
    const { recurrenceSchema } = await loadEngine();
    const parsed = recurrenceSchema.safeParse({ frequency: 'weekly', interval: 2, weekdays: [1, 3], count: 4 });
    expect(parsed.success).toBe(true);
  });

  it('menolak frequency tak dikenal', async () => {
    const { recurrenceSchema } = await loadEngine();
    expect(recurrenceSchema.safeParse({ frequency: 'yearly' }).success).toBe(false);
  });

  it('menolak weekdays kosong untuk weekly', async () => {
    const { recurrenceSchema } = await loadEngine();
    expect(recurrenceSchema.safeParse({ frequency: 'weekly', weekdays: [] }).success).toBe(false);
  });

  it('menolak until bukan YYYY-MM-DD', async () => {
    const { recurrenceSchema } = await loadEngine();
    expect(recurrenceSchema.safeParse({ frequency: 'daily', until: '2026/02/20' }).success).toBe(false);
  });

  it('menolak kunci tak dikenal (strict)', async () => {
    const { recurrenceSchema } = await loadEngine();
    expect(recurrenceSchema.safeParse({ frequency: 'daily', bogus: true }).success).toBe(false);
  });

  it('menolak count 0', async () => {
    const { recurrenceSchema } = await loadEngine();
    expect(recurrenceSchema.safeParse({ frequency: 'daily', count: 0 }).success).toBe(false);
  });
});
