import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { bookings, workspaceIntegrations, workspaces } from '@oriole/database';

const { googleFetchMock } = vi.hoisted(() => ({ googleFetchMock: vi.fn() }));

vi.mock('./google-auth.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./google-auth.ts')>();
  return { ...actual, googleFetch: googleFetchMock };
});

import {
  buildCalendarEvent,
  deleteBookingCalendarEvent,
  listGoogleCalendars,
  syncBookingsToCalendar,
  upsertBookingCalendarEvent,
} from './google-calendar.ts';
import { GoogleApiError } from './google-auth.ts';

const SERVICE_ACCOUNT_JSON = JSON.stringify({
  type: 'service_account',
  project_id: 'p',
  private_key_id: 'k',
  private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n',
  client_email: 'sa@example.iam.gserviceaccount.com',
  client_id: '123',
  token_uri: 'https://oauth2.googleapis.com/token',
});

// ── Fake Drizzle db ───────────────────────────────────────────
const { dbState } = vi.hoisted(() => ({
  dbState: { tables: new Map<string, Record<string, unknown>[]>(), seq: 1 },
}));

vi.mock('../db/index.ts', async () => {
  const tableNames = new WeakMap<object, string>();
  tableNames.set(bookings, 'bookings');
  tableNames.set(workspaceIntegrations, 'workspaceIntegrations');
  tableNames.set(workspaces, 'workspaces');

  function columnKeyMap(table: object): Record<string, string> {
    const map: Record<string, string> = {};
    for (const [key, col] of Object.entries(table as Record<string, unknown>)) {
      if (col && typeof col === 'object' && 'name' in col && typeof (col as { name: unknown }).name === 'string') {
        map[(col as { name: string }).name] = key;
      }
    }
    return map;
  }

  function eqPairs(cond: unknown): { name: string; value: unknown }[] {
    const pairs: { name: string; value: unknown }[] = [];
    const walk = (node: unknown) => {
      if (!node || typeof node !== 'object') return;
      // Operator (mis. inArray) tidak punya semantik eq sederhana — skip
      // seluruh subtree agar tidak menghasilkan filter palsu.
      if ((node as { type?: unknown }).type === 'operator') return;
      const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
      if (!Array.isArray(chunks)) return;
      chunks.forEach((chunk, i) => {
        if (chunk && typeof chunk === 'object' && typeof (chunk as { name?: unknown }).name === 'string') {
          const raw = chunks[i + 2];
          let value: unknown =
            raw && typeof raw === 'object' && 'value' in (raw as object)
              ? (raw as { value: unknown }).value
              : raw;
          // inArray: chunk berisi daftar Param — ekstrak nilai-nilainya agar
          // filter memakai `includes` (bukan perbandingan array === nilai).
          if (
            Array.isArray(value) &&
            value.every((v) => v && typeof v === 'object' && 'value' in (v as object))
          ) {
            value = (value as { value: unknown }[]).map((v) => v.value);
          }
          pairs.push({ name: (chunk as { name: string }).name, value });
        } else {
          walk(chunk);
        }
      });
    };
    walk(cond);
    return pairs;
  }

  function makeSelectBuilder(name: string, table: object) {
    const colKey = columnKeyMap(table);
    const builder: {
      where: (...conds: unknown[]) => typeof builder;
      limit: (n: number) => typeof builder;
      then: (resolve: (rows: unknown[]) => unknown) => Promise<unknown>;
      _limit?: number;
      _filters: { name: string; value: unknown }[];
    } = {
      _limit: undefined,
      _filters: [],
      where(...conds) {
        builder._filters = conds.flatMap(eqPairs);
        return builder;
      },
      limit(n: number) {
        builder._limit = n;
        return builder;
      },
      then(resolve: (rows: unknown[]) => unknown) {
        let rows = [...(dbState.tables.get(name) ?? [])];
        if (builder._filters.length > 0) {
          rows = rows.filter((row) =>
            builder._filters.every((filter) => {
              const key = colKey[filter.name];
              if (key === undefined) return true;
              const rowVal = (row as Record<string, unknown>)[key];
              // Nilai array = inArray → cocokkan keanggotaan.
              return Array.isArray(filter.value)
                ? filter.value.includes(rowVal)
                : rowVal === filter.value;
            }),
          );
        }
        if (builder._limit != null) rows = rows.slice(0, builder._limit);
        return Promise.resolve(resolve(rows));
      },
    };
    return builder;
  }

  return {
    db: {
      select: () => ({ from: (table: object) => makeSelectBuilder(tableNames.get(table) ?? 'unknown', table) }),
      update: (table: object) => ({
        set: (values: Record<string, unknown>) => ({
          where: () => {
            const name = tableNames.get(table) ?? 'unknown';
            const rows = dbState.tables.get(name) ?? [];
            const idx = rows.findIndex((r) => (r as Record<string, unknown>).workspaceId === 'ws-1');
            if (idx >= 0) rows[idx] = { ...rows[idx], ...values, updatedAt: new Date() };
            return {};
          },
        }),
      }),
    },
  };
});

function baseBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: 'booking-1',
    title: 'Teeth Whitening',
    description: 'First visit',
    scheduledAt: new Date('2026-02-01T10:00:00.000Z'),
    timezone: 'Asia/Jakarta',
    status: 'pending',
    customerName: 'Andi',
    phone: '+628123456789',
    workspaceId: 'ws-1',
    userId: 'u-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function baseCalendarIntegration(overrides: Record<string, unknown> = {}) {
  return {
    id: 'int-c1',
    workspaceId: 'ws-1',
    integrationType: 'google-calendar',
    identifier: 'Work Calendar',
    providerConfig: {
      serviceAccountJson: SERVICE_ACCOUNT_JSON,
      serviceAccountEmail: 'sa@example.iam.gserviceaccount.com',
      calendarId: 'primary',
      calendarName: 'Work Calendar',
      eventIds: {},
    },
    isActive: true,
    lastSyncAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  googleFetchMock.mockReset();
  dbState.tables.set('workspaceIntegrations', [baseCalendarIntegration()]);
  dbState.tables.set('workspaces', [{ id: 'ws-1', name: 'Downtown Dental' }]);
  dbState.tables.set('bookings', [baseBooking()]);
});

describe('buildCalendarEvent', () => {
  it('menyusun payload dengan offset timezone dan durasi 60 menit', () => {
    const event = buildCalendarEvent(baseBooking() as never, 'Downtown Dental');
    expect(event.summary).toBe('Teeth Whitening');
    expect(event.description).toContain('First visit');
    expect(event.description).toContain('Downtown Dental');
    // 10:00 UTC di Asia/Jakarta = 17:00 +07:00.
    expect(event.start).toEqual({ dateTime: '2026-02-01T17:00:00+07:00', timeZone: 'Asia/Jakarta' });
    expect(event.end).toEqual({ dateTime: '2026-02-01T18:00:00+07:00', timeZone: 'Asia/Jakarta' });
    expect(event.extendedProperties.private).toMatchObject({
      orioleBookingId: 'booking-1',
      orioleSource: 'oriole',
    });
  });

  it('durasi kustom dipakai dan tidak valid di-fallback ke default', () => {
    const custom = buildCalendarEvent(baseBooking() as never, null, 30);
    expect(custom.end.dateTime).toBe('2026-02-01T17:30:00+07:00');
    const invalid = buildCalendarEvent(baseBooking() as never, null, 0);
    expect(invalid.end.dateTime).toBe('2026-02-01T18:00:00+07:00');
  });
});

describe('listGoogleCalendars', () => {
  it('memetakan item calendarList', async () => {
    googleFetchMock.mockResolvedValue({
      items: [
        { id: 'primary', summary: 'My Calendar', primary: true, accessRole: 'owner' },
        { id: 'cal-2', summary: 'Bookings', primary: false, accessRole: 'writer' },
      ],
    });
    const calendars = await listGoogleCalendars(JSON.parse(SERVICE_ACCOUNT_JSON) as never);
    expect(calendars).toEqual([
      { id: 'primary', summary: 'My Calendar', primary: true, accessRole: 'owner' },
      { id: 'cal-2', summary: 'Bookings', primary: false, accessRole: 'writer' },
    ]);
  });
});

describe('upsertBookingCalendarEvent', () => {
  it('belum ada event → POST, mapping eventId disimpan', async () => {
    googleFetchMock.mockResolvedValue({ id: 'evt-1' });

    const result = await upsertBookingCalendarEvent('ws-1', 'booking-1');
    expect(result).toEqual({ action: 'created', eventId: 'evt-1' });

    // googleFetch(serviceAccount, scopes, path, init) → path di index 2, init di index 3.
    const requestUrl = googleFetchMock.mock.calls[0][2] as string;
    const init = googleFetchMock.mock.calls[0][3] as { method?: string };
    expect(requestUrl).toBe('/calendar/v3/calendars/primary/events');
    expect(init.method).toBe('POST');

    const integration = (dbState.tables.get('workspaceIntegrations') ?? [])[0];
    expect((integration.providerConfig as { eventIds: Record<string, string> }).eventIds).toEqual({
      'booking-1': 'evt-1',
    });
  });

  it('event sudah ada → PATCH event yang sama (bukan buat baru)', async () => {
    dbState.tables.set('workspaceIntegrations', [
      baseCalendarIntegration({
        providerConfig: {
          ...baseCalendarIntegration().providerConfig,
          eventIds: { 'booking-1': 'evt-existing' },
        },
      }),
    ]);
    googleFetchMock.mockResolvedValue({ id: 'evt-existing' });

    const result = await upsertBookingCalendarEvent('ws-1', 'booking-1');
    expect(result).toEqual({ action: 'updated', eventId: 'evt-existing' });

    const requestUrl = googleFetchMock.mock.calls[0][2] as string;
    const init = googleFetchMock.mock.calls[0][3] as { method?: string };
    expect(requestUrl).toBe('/calendar/v3/calendars/primary/events/evt-existing');
    expect(init.method).toBe('PATCH');
  });

  it('event lama dihapus manual (PATCH 404) → fallback ke create, mapping diperbarui', async () => {
    dbState.tables.set('workspaceIntegrations', [
      baseCalendarIntegration({
        providerConfig: {
          ...baseCalendarIntegration().providerConfig,
          eventIds: { 'booking-1': 'evt-stale' },
        },
      }),
    ]);
    googleFetchMock
      .mockRejectedValueOnce(new GoogleApiError('not found', 404))
      .mockResolvedValueOnce({ id: 'evt-new' });

    const result = await upsertBookingCalendarEvent('ws-1', 'booking-1');
    expect(result).toEqual({ action: 'created', eventId: 'evt-new' });
    // PATCH (404) lalu POST (create) — bukan retry PATCH selamanya.
    expect(googleFetchMock).toHaveBeenCalledTimes(2);
    const methods = googleFetchMock.mock.calls.map((call) => (call[3] as { method?: string })?.method);
    expect(methods).toEqual(['PATCH', 'POST']);

    const integration = (dbState.tables.get('workspaceIntegrations') ?? [])[0];
    expect((integration.providerConfig as { eventIds: Record<string, string> }).eventIds).toEqual({
      'booking-1': 'evt-new',
    });
  });

  it('booking terminal (cancelled) → skip, tidak ada panggilan Google', async () => {
    dbState.tables.set('bookings', [baseBooking({ status: 'cancelled' })]);
    const result = await upsertBookingCalendarEvent('ws-1', 'booking-1');
    expect(result).toEqual({ action: 'skipped', reason: 'status-cancelled' });
    expect(googleFetchMock).not.toHaveBeenCalled();
  });

  it('integrasi tidak aktif → skip', async () => {
    dbState.tables.set('workspaceIntegrations', [baseCalendarIntegration({ isActive: false })]);
    const result = await upsertBookingCalendarEvent('ws-1', 'booking-1');
    expect(result).toEqual({ action: 'skipped', reason: 'not-connected' });
    expect(googleFetchMock).not.toHaveBeenCalled();
  });

  it('booking milik workspace lain → tidak ditemukan', async () => {
    dbState.tables.set('bookings', [baseBooking({ workspaceId: 'ws-2' })]);
    const result = await upsertBookingCalendarEvent('ws-1', 'booking-1');
    expect(result).toEqual({ action: 'skipped', reason: 'booking-not-found' });
  });
});

describe('deleteBookingCalendarEvent', () => {
  it('event ada → DELETE + mapping dibersihkan', async () => {
    dbState.tables.set('workspaceIntegrations', [
      baseCalendarIntegration({
        providerConfig: {
          ...baseCalendarIntegration().providerConfig,
          eventIds: { 'booking-1': 'evt-1', 'booking-2': 'evt-2' },
        },
      }),
    ]);
    googleFetchMock.mockResolvedValue(undefined);

    const result = await deleteBookingCalendarEvent('ws-1', 'booking-1');
    expect(result).toEqual({ deleted: true });

    const requestUrl = googleFetchMock.mock.calls[0][2] as string;
    const init = googleFetchMock.mock.calls[0][3] as { method?: string };
    expect(requestUrl).toBe('/calendar/v3/calendars/primary/events/evt-1');
    expect(init.method).toBe('DELETE');

    const integration = (dbState.tables.get('workspaceIntegrations') ?? [])[0];
    expect((integration.providerConfig as { eventIds: Record<string, string> }).eventIds).toEqual({
      'booking-2': 'evt-2',
    });
  });

  it('tidak ada event untuk booking → tidak ada panggilan Google', async () => {
    const result = await deleteBookingCalendarEvent('ws-1', 'booking-1');
    expect(result).toEqual({ deleted: false });
    expect(googleFetchMock).not.toHaveBeenCalled();
  });

  it('event sudah dihapus manual (DELETE 404) → idempoten: mapping tetap dibersihkan', async () => {
    dbState.tables.set('workspaceIntegrations', [
      baseCalendarIntegration({
        providerConfig: {
          ...baseCalendarIntegration().providerConfig,
          eventIds: { 'booking-1': 'evt-gone' },
        },
      }),
    ]);
    googleFetchMock.mockRejectedValueOnce(new GoogleApiError('not found', 404));

    const result = await deleteBookingCalendarEvent('ws-1', 'booking-1');
    expect(result).toEqual({ deleted: true });
    const integration = (dbState.tables.get('workspaceIntegrations') ?? [])[0];
    expect((integration.providerConfig as { eventIds: Record<string, string> }).eventIds).toEqual({});
  });

  it('DELETE gagal selain 404 → error diteruskan (Inngest retry)', async () => {
    dbState.tables.set('workspaceIntegrations', [
      baseCalendarIntegration({
        providerConfig: {
          ...baseCalendarIntegration().providerConfig,
          eventIds: { 'booking-1': 'evt-x' },
        },
      }),
    ]);
    googleFetchMock.mockRejectedValueOnce(new GoogleApiError('boom', 500));
    await expect(deleteBookingCalendarEvent('ws-1', 'booking-1')).rejects.toMatchObject({ status: 500 });
  });
});

describe('syncBookingsToCalendar', () => {
  it('upsert semua booking aktif, error bila belum terhubung', async () => {
    dbState.tables.set('bookings', [
      baseBooking({ id: 'b-1' }),
      baseBooking({ id: 'b-2', status: 'confirmed' }),
      baseBooking({ id: 'b-3', status: 'cancelled' }),
    ]);
    googleFetchMock.mockResolvedValueOnce({ id: 'evt-a' }).mockResolvedValueOnce({ id: 'evt-b' });

    const result = await syncBookingsToCalendar('ws-1');
    // syncBookingsToCalendar hanya meng-iterasi booking pending/confirmed —
    // b-3 (cancelled) tidak masuk loop sama sekali (guard status terminal
    // diuji terpisah di upsertBookingCalendarEvent).
    expect(result).toEqual({ created: 2, updated: 0, skipped: 0 });
  });

  it('belum terhubung → GoogleApiError 409', async () => {
    dbState.tables.set('workspaceIntegrations', []);
    await expect(syncBookingsToCalendar('ws-1')).rejects.toBeInstanceOf(GoogleApiError);
  });
});

// Guard: and/eq tetap dipakai saat refactor.
void and;
void eq;
