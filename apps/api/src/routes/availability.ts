import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';

import { getAvailableSlots } from '../lib/availability.ts';
import { loadStaffAvailability } from '../lib/availability.ts';
import { zonedDayStart } from '../lib/timezone.ts';
import { requireAuth } from '../middleware/auth.ts';
import { requireWorkspace, type WorkspaceVariables } from '../middleware/workspace.ts';

/** Rentang maksimum pencarian slot (hari) — mencegah query kalender meledak. */
const MAX_RANGE_DAYS = 31;

const dateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Tanggal harus YYYY-MM-DD');

const slotsQuerySchema = z
  .object({
    from: dateParam,
    to: dateParam,
    duration: z.coerce.number().int().min(5).max(720).default(60),
    staffId: z.string().uuid().optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
  })
  .refine((value) => value.to >= value.from, {
    message: 'to harus setelah atau sama dengan from',
    path: ['to'],
  });

/** Parse YYYY-MM-DD → komponen angka (validasi sudah di zod). */
function parseDateParam(value: string): { year: number; month: number; day: number } {
  return {
    year: Number(value.slice(0, 4)),
    month: Number(value.slice(5, 7)),
    day: Number(value.slice(8, 10)),
  };
}

export const availabilityRoutes = new Hono<{ Variables: WorkspaceVariables }>()
  /* ── Slot tersedia ─────────────────────────────────────────
   * GET /api/availability/slots?from=2026-02-01&to=2026-02-14&duration=60&staffId=…
   *
   * Tanpa staffId → 24/7 minus semua booking workspace + event kalender
   * eksternal. Dengan staffId → jadwal mingguan staf (zona staf), minus
   * booking staf, cuti, dan event eksternal.
   */
  .get('/slots', requireAuth, requireWorkspace, zValidator('query', slotsQuerySchema), async (c) => {
    const { from, to, duration, staffId, timezone: timezoneParam } = c.req.valid('query');
    const workspaceId = c.get('workspaceId');

    // Zona untuk membatasi hari kalender: zona staf (bila dipilih), lalu
    // param timezone, lalu UTC.
    let effectiveTimezone = timezoneParam ?? 'UTC';
    if (staffId) {
      const loaded = await loadStaffAvailability(staffId);
      if (!loaded || loaded.staff.workspaceId !== workspaceId) {
        return c.json({ error: 'Staf tidak ditemukan' }, 404);
      }
      effectiveTimezone = loaded.staff.timezone;
    }

    const fromParts = parseDateParam(from);
    const toParts = parseDateParam(to);
    const rangeStart = zonedDayStart(fromParts.year, fromParts.month, fromParts.day, effectiveTimezone);
    // Akhir hari `to` = awal hari berikutnya.
    const rangeEnd = zonedDayStart(toParts.year, toParts.month, toParts.day + 1, effectiveTimezone);

    if ((rangeEnd.getTime() - rangeStart.getTime()) / 86_400_000 > MAX_RANGE_DAYS) {
      return c.json({ error: `Rentang maksimal ${MAX_RANGE_DAYS} hari` }, 400);
    }

    const result = await getAvailableSlots({
      workspaceId,
      staffId: staffId ?? null,
      from: rangeStart,
      to: rangeEnd,
      durationMinutes: duration,
    });
    if (!result.ok) {
      return c.json({ error: 'Staf tidak ditemukan' }, 404);
    }
    return c.json({
      slots: result.slots.map((slot) => ({ start: slot.start.toISOString(), end: slot.end.toISOString() })),
      busy: result.busy.map((item) => ({ start: item.start.toISOString(), end: item.end.toISOString() })),
      truncated: result.truncated,
    });
  });
