import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildAiBookingTools, executeAiTool, type AiToolContext } from './ai-tools.ts';

// ── Mocks ───────────────────────────────────────────────────────

// Env minimal — modul impor vapi-inbound/services memakai env di module scope.
vi.mock('../lib/env.ts', () => ({ env: new Proxy({}, { get: () => undefined }) }));

const { inngestSendMock } = vi.hoisted(() => ({ inngestSendMock: vi.fn() }));
vi.mock('../inngest/client.ts', () => ({ inngest: { send: inngestSendMock } }));

const { dbState } = vi.hoisted(() => ({
  dbState: {} as Record<string, Record<string, unknown>[]>,
}));

vi.mock('../db/index.ts', async () => {
  const {
    bookings,
    contacts,
    conversations,
    serviceStaff,
    services,
    staffMembers,
    staffSchedules,
    staffTimeOff,
    workspaceIntegrations,
    workspaces,
  } = await import('@oriole/database');
  const tableNames = new WeakMap<object, string>();
  tableNames.set(workspaces, 'workspaces');
  tableNames.set(bookings, 'bookings');
  tableNames.set(contacts, 'contacts');
  tableNames.set(conversations, 'conversations');
  tableNames.set(services, 'services');
  tableNames.set(serviceStaff, 'serviceStaff');
  tableNames.set(staffMembers, 'staffMembers');
  tableNames.set(staffSchedules, 'staffSchedules');
  tableNames.set(staffTimeOff, 'staffTimeOff');
  tableNames.set(workspaceIntegrations, 'workspaceIntegrations');

  function makeSelectBuilder(name: string) {
    const builder: {
      _limit?: number;
      _order?: 'asc' | 'desc';
      where: () => typeof builder;
      orderBy: () => typeof builder;
      limit: (n: number) => typeof builder;
      then: (resolve: (rows: unknown[]) => unknown) => Promise<unknown>;
    } = {
      where() {
        return builder;
      },
      orderBy() {
        builder._order = 'desc';
        return builder;
      },
      limit(n: number) {
        builder._limit = n;
        return builder;
      },
      then(resolve: (rows: unknown[]) => unknown) {
        let rows = [...(dbState[name] ?? [])];
        if (builder._limit != null) rows = rows.slice(0, builder._limit);
        return Promise.resolve(resolve(rows));
      },
    };
    return builder;
  }

  function makeInsertBuilder(name: string) {
    return {
      values: (values: Record<string, unknown>) => {
        const insertRow = () => {
          const row = { id: `${name}-${dbState[name].length + 1}`, ...values };
          dbState[name].push(row);
          return row;
        };
        return {
          returning: async () => [insertRow()],
          onConflictDoNothing: () => ({
            returning: async () => [insertRow()],
            then: (resolve: (value: unknown) => unknown) => Promise.resolve(resolve(undefined)),
          }),
        };
      },
    };
  }

  function makeUpdateBuilder(name: string) {
    return {
      set: (values: Record<string, unknown>) => ({
        where: () => {
          const target = dbState[name]?.[0];
          if (target) Object.assign(target, { ...values, updatedAt: new Date() });
        },
      }),
    };
  }

  return {
    db: {
      select: () => ({ from: (table: object) => makeSelectBuilder(tableNames.get(table) ?? 'unknown') }),
      insert: (table: object) => makeInsertBuilder(tableNames.get(table) ?? 'unknown'),
      update: (table: object) => makeUpdateBuilder(tableNames.get(table) ?? 'unknown'),
    },
  };
});

// ── Fixtures ────────────────────────────────────────────────────

const WORKSPACE_ID = 'ws-1';
const CONVERSATION_ID = 'conv-1';
const PHONE = '6281234567890';
const SERVICE_ID = 'svc-1';
const STAFF_ID = 'staff-1';
const BOOKING_ID = 'booking-1';

function baseCtx(overrides: Partial<AiToolContext> = {}): AiToolContext {
  return {
    workspaceId: WORKSPACE_ID,
    conversationId: CONVERSATION_ID,
    customerPhone: PHONE,
    customerName: 'Budi',
    language: 'id',
    ...overrides,
  };
}

const SERVICE_ROW = {
  id: SERVICE_ID,
  workspaceId: WORKSPACE_ID,
  userId: 'user-1',
  name: 'Potong Rambut',
  description: 'Potong rambut standar',
  durationMinutes: 45,
  priceMinor: 10000,
  currency: 'IDR',
  color: '#000000',
  category: ['Haircut'],
  isActive: true,
  sortOrder: 0,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

const STAFF_ROW = {
  id: STAFF_ID,
  workspaceId: WORKSPACE_ID,
  userId: 'user-1',
  name: 'Andi',
  email: null,
  phone: null,
  color: '#000000',
  timezone: 'Asia/Jakarta',
  isActive: true,
  bufferMinutes: 0,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

const SCHEDULE_ROW = { id: 'sched-1', staffId: STAFF_ID, dayOfWeek: 4, startMinutes: 540, endMinutes: 1020 };

beforeEach(() => {
  dbState.workspaces = [{ id: WORKSPACE_ID, userId: 'user-1' }];
  dbState.bookings = [];
  dbState.contacts = [];
  dbState.conversations = [];
  dbState.services = [];
  dbState.serviceStaff = [];
  dbState.staffMembers = [];
  dbState.staffSchedules = [];
  dbState.staffTimeOff = [];
  dbState.workspaceIntegrations = [];
  inngestSendMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── buildAiBookingTools ─────────────────────────────────────────

describe('buildAiBookingTools', () => {
  it('mendefinisikan 7 tool booking dengan nama arsitektur existing', () => {
    const names = buildAiBookingTools('id').map((t) => t.function.name);
    expect(names).toEqual([
      'get_available_slots',
      'get_service',
      'get_staff_availability',
      'get_customer_bookings',
      'create_booking',
      'reschedule_booking',
      'cancel_booking',
    ]);
  });
});

// ── get_available_slots ─────────────────────────────────────────

describe('get_available_slots', () => {
  it('menghasilkan slot nyata dari mesin availabilitas (tanpa staf = 24/7)', async () => {
    dbState.services = [SERVICE_ROW];
    const out = await executeAiTool(baseCtx(), 'get_available_slots', JSON.stringify({ date: '2026-08-20', serviceName: 'Potong Rambut' }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.serviceName).toBe('Potong Rambut');
    const slots = (out.result as { slots: unknown[] }).slots;
    expect(slots.length).toBeGreaterThan(0);
  });

  it('tanggal tidak valid → error', async () => {
    const out = await executeAiTool(baseCtx(), 'get_available_slots', JSON.stringify({ date: '20-08-2026' }));
    expect(out.ok).toBe(false);
  });

  it('layanan tidak dikenal → error dengan daftar layanan tersedia', async () => {
    // Dua layanan — toleransi typo (satu layanan) tidak berlaku lagi.
    dbState.services = [SERVICE_ROW, { ...SERVICE_ROW, id: 'svc-2', name: 'Creambath', priceMinor: 15000 }];
    const out = await executeAiTool(baseCtx(), 'get_available_slots', JSON.stringify({ date: '2026-08-20', serviceName: 'Pijat' }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain('Potong Rambut');
  });
});

// ── get_service ─────────────────────────────────────────────────

describe('get_service', () => {
  it('mengembalikan info layanan dari katalog (live, bukan KB)', async () => {
    dbState.services = [SERVICE_ROW];
    const out = await executeAiTool(baseCtx(), 'get_service', JSON.stringify({ serviceName: 'Potong Rambut' }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result).toMatchObject({
      name: 'Potong Rambut',
      durationMinutes: 45,
      serviceId: SERVICE_ID,
    });
    // priceMinor 10000 (sen) = Rp 100.
    expect(String(out.result.price)).toContain('100');
  });
});

// ── get_staff_availability ──────────────────────────────────────

describe('get_staff_availability', () => {
  it('mengembalikan jam kerja staf pada tanggal diminta', async () => {
    dbState.staffMembers = [STAFF_ROW];
    dbState.staffSchedules = [SCHEDULE_ROW];
    const out = await executeAiTool(baseCtx(), 'get_staff_availability', JSON.stringify({ date: '2026-08-20', staffName: 'Andi' }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.staffName).toBe('Andi');
    const workingHours = (out.result as { workingHours: unknown[] }).workingHours;
    expect(workingHours.length).toBeGreaterThan(0);
  });

  it('staf tidak ditemukan → error', async () => {
    dbState.staffMembers = [STAFF_ROW];
    const out = await executeAiTool(baseCtx(), 'get_staff_availability', JSON.stringify({ date: '2026-08-20', staffName: 'Siapa' }));
    expect(out.ok).toBe(false);
  });
});

// ── get_customer_bookings ───────────────────────────────────────

describe('get_customer_bookings', () => {
  it('mengembalikan booking customer (pencocokan nomor tenant-scoped)', async () => {
    dbState.bookings = [
      {
        id: BOOKING_ID,
        workspaceId: WORKSPACE_ID,
        userId: 'user-1',
        title: 'Potong Rambut',
        phone: PHONE,
        status: 'pending',
        timezone: 'UTC',
        scheduledAt: new Date('2026-08-20T07:00:00.000Z'),
      },
      {
        id: 'booking-other',
        workspaceId: WORKSPACE_ID,
        userId: 'user-1',
        title: 'Milik orang lain',
        phone: '6289999999999',
        status: 'pending',
        timezone: 'UTC',
        scheduledAt: new Date('2026-08-21T07:00:00.000Z'),
      },
    ];
    const out = await executeAiTool(baseCtx(), 'get_customer_bookings', undefined);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const ids = (out.result.bookings as { bookingId: string }[]).map((b) => b.bookingId);
    expect(ids).toContain(BOOKING_ID);
    expect(ids).not.toContain('booking-other');
  });

  it('tanpa nomor customer → error (tidak membocorkan booking orang lain)', async () => {
    const out = await executeAiTool(baseCtx({ customerPhone: null }), 'get_customer_bookings', undefined);
    expect(out.ok).toBe(false);
  });
});

// ── create_booking ──────────────────────────────────────────────

describe('create_booking', () => {
  const futureDate = '2027-01-15';

  it('membuat booking nyata (status pending, source ai-chat) + idempotent sourceRef', async () => {
    dbState.services = [SERVICE_ROW];
    const out = await executeAiTool(
      baseCtx(),
      'create_booking',
      JSON.stringify({ serviceName: 'Potong Rambut', date: futureDate, time: '14:00' }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.bookingIds).toHaveLength(1);
    expect(dbState.bookings).toHaveLength(1);
    expect(dbState.bookings[0]).toMatchObject({ source: 'ai-chat', status: 'pending', serviceId: SERVICE_ID });
    expect(inngestSendMock).toHaveBeenCalled(); // reminder/auto-call pipeline
  });

  it('nama customer tidak diketahui → error (minta model bertanya, jangan menebak)', async () => {
    dbState.services = [SERVICE_ROW];
    const out = await executeAiTool(
      baseCtx({ customerName: null }),
      'create_booking',
      JSON.stringify({ serviceName: 'Potong Rambut', date: futureDate, time: '14:00' }),
    );
    expect(out.ok).toBe(false);
    expect(dbState.bookings).toHaveLength(0);
  });

  it('slot bentrok dengan booking aktif → error (backend menolak, LLM tidak boleh memaksa)', async () => {
    dbState.services = [SERVICE_ROW];
    // Booking bentrok 13:00–14:45 UTC (durasi layanan 45 menit).
    dbState.bookings = [
      {
        id: 'existing',
        workspaceId: WORKSPACE_ID,
        userId: 'user-1',
        title: 'Sudah ada',
        status: 'confirmed',
        scheduledAt: new Date('2027-01-15T13:00:00.000Z'),
        durationMinutes: 120,
        timezone: 'UTC',
      },
    ];
    const out = await executeAiTool(
      baseCtx(),
      'create_booking',
      JSON.stringify({ serviceName: 'Potong Rambut', date: futureDate, time: '14:00' }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/terisi/i);
  });

  it('format tanggal/jam tidak valid → error', async () => {
    dbState.services = [SERVICE_ROW];
    const out = await executeAiTool(
      baseCtx(),
      'create_booking',
      JSON.stringify({ serviceName: 'Potong Rambut', date: futureDate, time: '25:00' }),
    );
    expect(out.ok).toBe(false);
  });

  it('argumen bukan JSON → error', async () => {
    const out = await executeAiTool(baseCtx(), 'create_booking', 'bukan-json{{{');
    expect(out.ok).toBe(false);
  });

  it('tool tidak dikenal → error', async () => {
    const out = await executeAiTool(baseCtx(), 'delete_everything', undefined);
    expect(out.ok).toBe(false);
  });
});

// ── reschedule_booking ──────────────────────────────────────────

describe('reschedule_booking', () => {
  function seedBooking() {
    dbState.conversations = [{ id: CONVERSATION_ID, bookingId: BOOKING_ID }];
    dbState.bookings = [
      {
        id: BOOKING_ID,
        workspaceId: WORKSPACE_ID,
        userId: 'user-1',
        title: 'Potong Rambut',
        phone: PHONE,
        status: 'pending',
        timezone: 'UTC',
        durationMinutes: 45,
        scheduledAt: new Date('2027-01-15T07:00:00.000Z'),
        staffId: null,
      },
    ];
  }

  it('mengubah jadwal booking customer ke slot baru (backend yang mengubah)', async () => {
    seedBooking();
    const out = await executeAiTool(
      baseCtx(),
      'reschedule_booking',
      JSON.stringify({ newDate: '2027-01-20', newTime: '10:00' }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.bookingIds).toEqual([BOOKING_ID]);
    expect(dbState.bookings[0].scheduledAt).not.toBe('2027-01-15T07:00:00.000Z');
  });

  it('booking tidak ditemukan → error', async () => {
    const out = await executeAiTool(
      baseCtx(),
      'reschedule_booking',
      JSON.stringify({ newDate: '2027-01-20', newTime: '10:00' }),
    );
    expect(out.ok).toBe(false);
  });
});

// ── cancel_booking ──────────────────────────────────────────────

describe('cancel_booking', () => {
  it('membatalkan booking customer (status cancelled)', async () => {
    dbState.conversations = [{ id: CONVERSATION_ID, bookingId: BOOKING_ID }];
    dbState.bookings = [
      {
        id: BOOKING_ID,
        workspaceId: WORKSPACE_ID,
        userId: 'user-1',
        title: 'Potong Rambut',
        phone: PHONE,
        status: 'pending',
        timezone: 'UTC',
        scheduledAt: new Date('2027-01-15T07:00:00.000Z'),
      },
    ];
    const out = await executeAiTool(baseCtx(), 'cancel_booking', undefined);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.bookingIds).toEqual([BOOKING_ID]);
    expect(dbState.bookings[0].status).toBe('cancelled');
  });

  it('booking tidak ditemukan → error', async () => {
    const out = await executeAiTool(baseCtx(), 'cancel_booking', undefined);
    expect(out.ok).toBe(false);
  });
});
