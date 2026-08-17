import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock Inngest — emit* di reminders/integration-events tidak menyentuh network ──
const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
vi.mock('../inngest/client.ts', () => ({ inngest: { send: sendMock } }));

// ── Mock Vapi service — register/attach/unregister number + assistant CRUD ──
const { registerVapiMock, attachVapiMock, unregisterVapiMock, createVapiAssistantMock, updateVapiAssistantMock, deleteVapiAssistantMock } = vi.hoisted(() => ({
  registerVapiMock: vi.fn(),
  attachVapiMock: vi.fn(),
  unregisterVapiMock: vi.fn(),
  createVapiAssistantMock: vi.fn(),
  updateVapiAssistantMock: vi.fn(),
  deleteVapiAssistantMock: vi.fn(),
}));
vi.mock('../services/vapi.ts', () => ({
  registerVapiInboundNumber: registerVapiMock,
  attachVapiInboundNumber: attachVapiMock,
  unregisterVapiInboundNumber: unregisterVapiMock,
  createVapiAssistant: createVapiAssistantMock,
  updateVapiAssistant: updateVapiAssistantMock,
  deleteVapiAssistant: deleteVapiAssistantMock,
  vapiWebhookUrl: () => 'https://webhook.example.com/api/webhooks/vapi',
}));

// ── Fake Drizzle db (where-filtering penuh) — mirror services.test.ts ──────
const { dbState } = vi.hoisted(() => ({
  dbState: { tables: new Map<string, unknown[]>(), seq: 1 },
}));

vi.mock('../db/index.ts', async () => {
  const {
    bookings,
    calleCalls,
    contacts,
    serviceStaff,
    services,
    staffMembers,
    staffSchedules,
    staffTimeOff,
    vapiInboundNumbers,
    workspaceIntegrations,
    workspaces,
  } = await import('@oriole/database');
  const tableNames = new WeakMap<object, string>();
  tableNames.set(workspaces, 'workspaces');
  tableNames.set(vapiInboundNumbers, 'vapi_inbound_numbers');
  tableNames.set(services, 'services');
  tableNames.set(serviceStaff, 'service_staff');
  tableNames.set(staffMembers, 'staff_members');
  tableNames.set(staffSchedules, 'staff_schedules');
  tableNames.set(staffTimeOff, 'staff_time_off');
  tableNames.set(bookings, 'bookings');
  tableNames.set(contacts, 'contacts');
  tableNames.set(workspaceIntegrations, 'workspace_integrations');
  tableNames.set(calleCalls, 'calle_calls');

  function columnKeyMap(table: object): Record<string, string> {
    const map: Record<string, string> = {};
    for (const [key, col] of Object.entries(table as Record<string, unknown>)) {
      if (col && typeof col === 'object' && 'name' in col && typeof (col as { name: unknown }).name === 'string') {
        map[(col as { name: string }).name] = key;
      }
    }
    return map;
  }

  const isSqlChunk = (c: unknown): c is { queryChunks: unknown[] } =>
    !!c && typeof c === 'object' && Array.isArray((c as { queryChunks?: unknown }).queryChunks);
  const isStringChunk = (c: unknown): c is { value: unknown[] } =>
    !!c && typeof c === 'object' && Array.isArray((c as { value?: unknown }).value) &&
    ((c as { value: unknown[] }).value.every((v) => typeof v === 'string'));
  const isColumnChunk = (c: unknown): c is { name: string } =>
    !!c && typeof c === 'object' && typeof (c as { name?: unknown }).name === 'string' && 'table' in (c as object);

  function buildPredicate(
    cond: unknown,
    colKey: Record<string, string>,
  ): (row: Record<string, unknown>) => boolean {
    const chunks = (cond as { queryChunks?: unknown[] } | null)?.queryChunks;
    if (!Array.isArray(chunks) || chunks.length === 0) return () => true;

    const hasGroupChildren = chunks.some(isSqlChunk);
    if (hasGroupChildren) {
      const subPreds: ((row: Record<string, unknown>) => boolean)[] = [];
      const ops: ('and' | 'or')[] = [];
      for (const chunk of chunks) {
        if (isStringChunk(chunk)) {
          const sep = chunk.value.join('').trim();
          if (sep === 'and' || sep === 'or') ops.push(sep);
        } else if (isSqlChunk(chunk)) {
          subPreds.push(buildPredicate(chunk, colKey));
        }
      }
      return (row) => {
        let result = subPreds[0]?.(row) ?? true;
        for (let i = 0; i < ops.length; i++) {
          const next = subPreds[i + 1]?.(row) ?? true;
          result = ops[i] === 'or' ? result || next : result && next;
        }
        return result;
      };
    }

    let colName: string | null = null;
    const stringParts: string[] = [];
    const params: unknown[] = [];
    for (const chunk of chunks) {
      if (isColumnChunk(chunk)) {
        colName = chunk.name;
        continue;
      }
      if (isStringChunk(chunk)) {
        stringParts.push(chunk.value.join(''));
        continue;
      }
      if (Array.isArray(chunk)) {
        for (const item of chunk) {
          if (item && typeof item === 'object' && 'value' in (item as object)) {
            params.push((item as { value: unknown }).value);
          } else if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
            params.push(item);
          }
        }
        continue;
      }
      if (chunk && typeof chunk === 'object' && 'value' in (chunk as object)) {
        params.push((chunk as { value: unknown }).value);
      } else if (typeof chunk === 'string' || typeof chunk === 'number' || typeof chunk === 'boolean') {
        params.push(chunk);
      }
    }
    if (!colName) return () => true;
    const key = colKey[colName];
    if (key === undefined) return () => true;

    const joined = stringParts.join('').replace(/\s+/g, ' ').trim();
    const OP_CANDIDATES = ['ilike', ' like ', 'is not null', 'is null', '>=', '<=', '!=', '<>', ' in ', 'in', '>', '<', '='];
    const op = OP_CANDIDATES.find((candidate) => joined.includes(candidate)) ?? '';

    const get = (row: Record<string, unknown>) => row[key];
    const value = params[0];
    if (op.includes('!=') || op.includes('<>')) return (row) => get(row) !== value;
    if (op.includes(' is not null')) return (row) => get(row) != null;
    if (op.includes(' is null')) return (row) => get(row) == null;
    if (op.includes('>=')) return (row) => (get(row) as number) >= (value as number);
    if (op.includes('<=')) return (row) => (get(row) as number) <= (value as number);
    if (op.includes('>')) return (row) => (get(row) as number) > (value as number);
    if (op.includes('<')) return (row) => (get(row) as number) < (value as number);
    if (op === 'in' || op.includes(' in ')) {
      return (row) => params.includes(get(row));
    }
    return (row) => get(row) === value;
  }

  function filterRows(name: string, conds: unknown[], table: object) {
    const colKey = columnKeyMap(table);
    const predicates = conds.map((c) => buildPredicate(c, colKey));
    return (dbState.tables.get(name) ?? [])
      .filter((row) => predicates.every((pred) => pred(row as Record<string, unknown>)));
  }

  const now = new Date('2026-01-01T00:00:00.000Z');

  return {
    db: {
      select: (fields?: Record<string, unknown>) => ({
        from: (table: object) => {
          const name = tableNames.get(table) ?? 'unknown';
          const colKey = columnKeyMap(table);
          const builder: {
            where: (...conds: unknown[]) => typeof builder;
            orderBy: () => typeof builder;
            limit: (n: number) => typeof builder;
            then: (resolve: (rows: unknown[]) => unknown) => Promise<unknown>;
            _conds: unknown[];
            _limit?: number;
          } = {
            _conds: [],
            where(...conds) {
              builder._conds = conds;
              return builder;
            },
            orderBy() {
              return builder;
            },
            limit(n: number) {
              builder._limit = n;
              return builder;
            },
            then(resolve) {
              let rows = filterRows(name, builder._conds, table);
              if (builder._limit != null) rows = rows.slice(0, builder._limit);
              if (fields) {
                rows = rows.map((row) => {
                  const rowObj = row as Record<string, unknown>;
                  const out: Record<string, unknown> = {};
                  for (const [alias, col] of Object.entries(fields)) {
                    const colName = (col as { name?: string } | undefined)?.name;
                    const key = colName ? colKey[colName] : undefined;
                    out[alias] = key !== undefined ? rowObj[key] : undefined;
                  }
                  return out;
                });
              }
              return Promise.resolve(resolve(rows));
            },
          };
          return builder;
        },
      }),
      insert: (table: object) => {
        const name = tableNames.get(table) ?? 'unknown';
        const insertRows = (values: Record<string, unknown> | Record<string, unknown>[]) => {
          const list = Array.isArray(values) ? values : [values];
          const rows: Record<string, unknown>[] = [];
          for (const value of list) {
            // Simulasi unique index bookings (workspace_id, source, source_ref):
            // insert kedua dengan key sama → dikembalikan kosong
            // (onConflictDoNothing) — idempotensi booking inbound.
            if (name === 'bookings' && value.source && value.sourceRef) {
              const dup = (dbState.tables.get('bookings') ?? []).some(
                (r) =>
                  (r as Record<string, unknown>).workspaceId === value.workspaceId &&
                  (r as Record<string, unknown>).source === value.source &&
                  (r as Record<string, unknown>).sourceRef === value.sourceRef,
              );
              if (dup) return rows;
            }
            // Simulasi upsert workspace_integrations (unique workspace_id +
            // integration_type): insert dengan key sama → baris lama diperbarui
            // (onConflictDoUpdate), bukan duplikat.
            if (name === 'workspace_integrations' && value.workspaceId && value.integrationType) {
              const store = dbState.tables.get('workspace_integrations') as Record<string, unknown>[] | undefined;
              const existing = store?.find(
                (r) =>
                  (r as Record<string, unknown>).workspaceId === value.workspaceId &&
                  (r as Record<string, unknown>).integrationType === value.integrationType,
              );
              if (existing) {
                const merged = { ...existing, ...value, updatedAt: new Date('2026-01-02T00:00:00.000Z') };
                const idx = store?.indexOf(existing) ?? -1;
                if (idx >= 0 && store) store[idx] = merged;
                rows.push(merged);
                continue;
              }
            }
            const row: Record<string, unknown> = {
              ...value,
              id: `${name}-${dbState.seq++}`,
              createdAt: now,
              updatedAt: now,
            };
            if (name === 'bookings') {
              row.durationMinutes ??= 60;
              row.status ??= 'pending';
              row.timezone ??= 'UTC';
            }
            dbState.tables.get(name)?.push(row);
            rows.push(row);
          }
          return rows;
        };
        const project = (rows: Record<string, unknown>[], fields?: Record<string, unknown>) => {
          if (!fields) return rows;
          const colKey = columnKeyMap(table);
          return rows.map((row) => {
            const out: Record<string, unknown> = {};
            for (const [alias, col] of Object.entries(fields)) {
              const colName = (col as { name?: string } | undefined)?.name;
              const key = colName ? colKey[colName] : undefined;
              out[alias] = key !== undefined ? row[key] : undefined;
            }
            return out;
          });
        };
        const makeChain = (values: Record<string, unknown> | Record<string, unknown>[]) => ({
          onConflictDoNothing: () => ({
            returning: async (fields?: Record<string, unknown>) => project(insertRows(values), fields),
            then(resolve: (rows: unknown[]) => unknown) {
              return Promise.resolve(resolve(project(insertRows(values))));
            },
          }),
          onConflictDoUpdate: () => ({
            returning: async (fields?: Record<string, unknown>) => project(insertRows(values), fields),
            then(resolve: (rows: unknown[]) => unknown) {
              return Promise.resolve(resolve(project(insertRows(values))));
            },
          }),
          returning: async (fields?: Record<string, unknown>) => project(insertRows(values), fields),
          then(resolve: (rows: unknown[]) => unknown) {
            return Promise.resolve(resolve(project(insertRows(values))));
          },
        });
        return { values: makeChain };
      },
      update: (table: object) => {
        const name = tableNames.get(table) ?? 'unknown';
        const doUpdate = (values: Record<string, unknown>, conds: unknown[]) => {
          const matched = filterRows(name, conds, table);
          if (matched.length === 0) return [];
          const store = dbState.tables.get(name) as unknown[] | undefined;
          const updated: Record<string, unknown>[] = [];
          for (const target of matched as Record<string, unknown>[]) {
            const index = store?.indexOf(target) ?? -1;
            if (index < 0) continue;
            const merged = { ...target, ...values, updatedAt: new Date('2026-01-02T00:00:00.000Z') };
            (store as unknown[])[index] = merged;
            updated.push(merged);
          }
          return updated;
        };
        return {
          set: (values: Record<string, unknown>) => ({
            where: (...conds: unknown[]) => ({
              returning: async () => doUpdate(values, conds),
              then(resolve: (rows: unknown[]) => unknown) {
                return Promise.resolve(resolve(doUpdate(values, conds)));
              },
            }),
          }),
        };
      },
      delete: (table: object) => {
        const name = tableNames.get(table) ?? 'unknown';
        const doDelete = (conds: unknown[]) => {
          const rows = filterRows(name, conds, table);
          if (rows.length === 0) return [];
          const store = dbState.tables.get(name) as unknown[] | undefined;
          for (const row of rows) {
            const index = store?.indexOf(row) ?? -1;
            if (index >= 0) store?.splice(index, 1);
          }
          return [{ id: (rows[0] as { id: string }).id }];
        };
        return {
          where: (...conds: unknown[]) => ({
            returning: async () => doDelete(conds),
            then(resolve: (rows: unknown[]) => unknown) {
              return Promise.resolve(resolve(doDelete(conds)));
            },
          }),
        };
      },
    },
  };
});

const now = new Date('2026-01-01T00:00:00.000Z');
const WORKSPACE_ID = 'ws-1';
const SERVICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function baseWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    id: WORKSPACE_ID,
    userId: 'user-1',
    name: 'Salon Cantik',
    templateCategory: 'beauty-wellness',
    industry: 'spa',
    callGoalLanguage: 'id',
    chatLanguage: 'en',
    reminderLeadMinutes: 120,
    autoCallEnabled: false,
    autoCallLeadHours: 24,
    aiEnabled: false,
    aiKnowledge: null,
    avatarUrl: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function baseInboundNumber(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inb-1',
    userId: 'user-1',
    workspaceId: WORKSPACE_ID,
    vapiPhoneNumberId: 'vapi-number-1',
    number: '+14155550123',
    name: 'Main line',
    provider: 'vapi',
    isActive: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function baseService(overrides: Record<string, unknown> = {}) {
  return {
    id: SERVICE_ID,
    name: 'Haircut & Styling',
    description: null,
    durationMinutes: 60,
    priceMinor: 50_000,
    currency: 'IDR',
    color: '#f59e0b',
    category: null,
    isActive: true,
    sortOrder: 0,
    userId: 'user-1',
    workspaceId: WORKSPACE_ID,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function seedTable(name: string, rows: Record<string, unknown>[]) {
  dbState.tables.set(name, rows as unknown[]);
}

/** Tanggal + jam UTC beberapa hari ke depan (agar tidak pernah "lewat"). */
function futureSlot(days = 2, hour = 10, minute = 0): { date: string; time: string } {
  const d = new Date(Date.now() + days * 86_400_000);
  d.setUTCHours(hour, minute, 0, 0);
  return {
    date: d.toISOString().slice(0, 10),
    time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  };
}

let lib: typeof import('./vapi-inbound.ts');

beforeAll(async () => {
  lib = await import('./vapi-inbound.ts');
});

beforeEach(() => {
  dbState.tables.clear();
  dbState.seq = 1;
  sendMock.mockReset();
  registerVapiMock.mockReset();
  registerVapiMock.mockResolvedValue({ vapiPhoneNumberId: 'vapi-number-1', number: '+14155550123' });
  unregisterVapiMock.mockReset();
  unregisterVapiMock.mockResolvedValue(undefined);
  attachVapiMock.mockReset();
  attachVapiMock.mockResolvedValue({
    vapiPhoneNumberId: 'vapi-free-1',
    number: '+14155550123',
    provider: 'vapi',
  });
  createVapiAssistantMock.mockReset();
  createVapiAssistantMock.mockResolvedValue({
    assistantId: 'vapi-assistant-1',
    name: 'oriole-receptionist-salon-cantik',
  });
  updateVapiAssistantMock.mockReset();
  updateVapiAssistantMock.mockResolvedValue(undefined);
  deleteVapiAssistantMock.mockReset();
  deleteVapiAssistantMock.mockResolvedValue(undefined);
});

describe('buildInboundAssistant — asisten transient inbound', () => {
  it('mengandung tool check_availability & create_booking + serverMessages tool-calls', () => {
    const assistant = lib.buildInboundAssistant({
      workspaceName: 'Salon Cantik',
      language: 'id',
      services: [
        { ...baseService(), staffIds: [] } as never,
      ],
      servicesText: null,
    });
    const tools = (assistant.model as { tools?: { function?: { name: string } }[] }).tools ?? [];
    const names = tools.map((tool) => tool.function?.name);
    expect(names).toContain('check_availability');
    expect(names).toContain('create_booking');
    expect(assistant.serverMessages).toContain('tool-calls');
    expect(assistant.maxDurationSeconds).toBe(900);
  });

  it('prompt berisi nama layanan + harga dari katalog', () => {
    const assistant = lib.buildInboundAssistant({
      workspaceName: 'Salon Cantik',
      language: 'en',
      services: [{ ...baseService(), staffIds: [] } as never],
      servicesText: null,
    });
    const system = (assistant.model as { messages?: { role: string; content: string }[] }).messages?.[0].content ?? '';
    expect(system).toContain('Salon Cantik');
    expect(system).toContain('Haircut & Styling');
  });

  it('bahasa mengikuti workspace (first message id)', async () => {
    seedTable('workspaces', [baseWorkspace()]);
    seedTable('services', [baseService()]);
    const assistant = await lib.buildInboundAssistantForWorkspace(WORKSPACE_ID);
    expect(assistant?.firstMessage).toContain('Terima kasih sudah menghubungi Salon Cantik');
  });

  it('daftar layanan kompak: durasi pendek + harga tanpa simbol, mata uang di header', () => {
    const assistant = lib.buildInboundAssistant({
      workspaceName: 'Salon Cantik',
      language: 'id',
      services: [{ ...baseService(), staffIds: [] } as never],
      servicesText: null,
    });
    const system = (assistant.model as { messages?: { role: string; content: string }[] }).messages?.[0].content ?? '';
    expect(system).toContain('LAYANAN YANG TERSEDIA (harga dalam IDR):');
    expect(system).toContain('- Haircut & Styling (60m, 500)');
  });

  it('mata uang bercampur → simbol mata uang tetap per baris', () => {
    const assistant = lib.buildInboundAssistant({
      workspaceName: 'Salon Cantik',
      language: 'id',
      services: [
        { ...baseService(), staffIds: [] } as never,
        { ...baseService(), id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Consult', currency: 'USD', staffIds: [] } as never,
      ],
      servicesText: null,
    });
    const system = (assistant.model as { messages?: { role: string; content: string }[] }).messages?.[0].content ?? '';
    expect(system).not.toContain('(harga dalam');
    // Intl currency memakai non-breaking space — cocokkan dengan \\s*.
    expect(system).toMatch(/- Haircut & Styling \(60m, IDR\s*500\)/);
  });

  it('KB super-panjang dibatasi agar tidak membebani token tiap turn', () => {
    const longKb = Array.from({ length: 300 }, (_, i) => `Baris ${i}: ${'x'.repeat(30)}`).join('\n');
    const assistant = lib.buildInboundAssistant({
      workspaceName: 'Salon Cantik',
      language: 'id',
      services: [{ ...baseService(), staffIds: [] } as never],
      knowledgeText: longKb,
    });
    const system = (assistant.model as { messages?: { role: string; content: string }[] }).messages?.[0].content ?? '';
    expect(system).toContain('…');
    expect(system.length).toBeLessThan(longKb.length + 2000);
  });
});

describe('provisionInboundAssistantForWorkspace — jalur hibrida', () => {
  it('inboundAssistantName: slug bersih dengan prefix oriole-receptionist', () => {
    expect(lib.inboundAssistantName('Salon Cantik')).toBe('oriole-receptionist-salon-cantik');
    expect(lib.inboundAssistantName('  Klinik Gigi — Pusat  ')).toBe('oriole-receptionist-klinik-gigi-pusat');
  });

  it('provision pertama: create di Vapi + simpan assistantId di workspace_integrations', async () => {
    seedTable('workspaces', [baseWorkspace()]);
    seedTable('services', [baseService()]);
    seedTable('workspace_integrations', []);
    createVapiAssistantMock.mockResolvedValue({
      assistantId: 'vapi-assistant-1',
      name: 'oriole-receptionist-salon-cantik',
    });

    const result = await lib.provisionInboundAssistantForWorkspace(WORKSPACE_ID);
    expect(result).toEqual({
      assistantId: 'vapi-assistant-1',
      name: 'oriole-receptionist-salon-cantik',
      updated: false,
    });
    expect(createVapiAssistantMock).toHaveBeenCalledTimes(1);
    expect(updateVapiAssistantMock).not.toHaveBeenCalled();
    const rows = dbState.tables.get('workspace_integrations') ?? [];
    expect(rows).toHaveLength(1);
    const row = rows[0] as { integrationType: string; providerConfig: { assistantId: string } };
    expect(row.integrationType).toBe('vapi-assistant');
    expect(row.providerConfig.assistantId).toBe('vapi-assistant-1');
  });

  it('provision ulang: update asisten yang sama (bukan duplikat)', async () => {
    seedTable('workspaces', [baseWorkspace()]);
    seedTable('services', [baseService()]);
    seedTable('workspace_integrations', [
      {
        id: 'wsint-1',
        workspaceId: WORKSPACE_ID,
        integrationType: 'vapi-assistant',
        identifier: 'vapi-assistant-1',
        providerConfig: { assistantId: 'vapi-assistant-1', name: 'oriole-receptionist-salon-cantik', provisionedAt: '2026-01-01T00:00:00.000Z' },
        isActive: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const result = await lib.provisionInboundAssistantForWorkspace(WORKSPACE_ID);
    expect(result.updated).toBe(true);
    expect(updateVapiAssistantMock).toHaveBeenCalledWith(
      'vapi-assistant-1',
      expect.objectContaining({ name: 'oriole-receptionist-salon-cantik' }),
    );
    expect(createVapiAssistantMock).not.toHaveBeenCalled();
    // Upsert — tetap satu baris, providerConfig diperbarui.
    const rows = dbState.tables.get('workspace_integrations') ?? [];
    expect(rows).toHaveLength(1);
  });

  it('getInboundAssistantForWorkspace: null bila belum di-provision, id bila ada', async () => {
    seedTable('workspace_integrations', []);
    await expect(lib.getInboundAssistantForWorkspace(WORKSPACE_ID)).resolves.toBeNull();

    seedTable('workspace_integrations', [
      {
        id: 'wsint-1',
        workspaceId: WORKSPACE_ID,
        integrationType: 'vapi-assistant',
        identifier: 'vapi-assistant-1',
        providerConfig: { assistantId: 'vapi-assistant-1', name: 'oriole-receptionist-salon-cantik' },
        isActive: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await expect(lib.getInboundAssistantForWorkspace(WORKSPACE_ID)).resolves.toEqual({
      assistantId: 'vapi-assistant-1',
      name: 'oriole-receptionist-salon-cantik',
    });
  });

  it('getWorkspaceIdByAssistantId: resolve workspace dari assistantId permanen (Playground)', async () => {
    seedTable('workspace_integrations', [
      {
        id: 'wsint-1',
        workspaceId: WORKSPACE_ID,
        integrationType: 'vapi-assistant',
        identifier: 'vapi-assistant-1',
        providerConfig: { assistantId: 'vapi-assistant-1', name: 'oriole-receptionist-salon-cantik' },
        isActive: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await expect(lib.getWorkspaceIdByAssistantId('vapi-assistant-1')).resolves.toBe(WORKSPACE_ID);
    await expect(lib.getWorkspaceIdByAssistantId('vapi-assistant-999')).resolves.toBeNull();
  });
});

describe('resolveInboundWorkspaceId — mapping nomor → workspace', () => {
  it('mengembalikan workspaceId untuk nomor terdaftar', async () => {
    seedTable('vapi_inbound_numbers', [baseInboundNumber()]);
    await expect(lib.resolveInboundWorkspaceId('vapi-number-1')).resolves.toBe(WORKSPACE_ID);
  });

  it('null untuk nomor asing', async () => {
    seedTable('vapi_inbound_numbers', [baseInboundNumber()]);
    await expect(lib.resolveInboundWorkspaceId('vapi-number-999')).resolves.toBeNull();
  });
});

describe('registerInboundNumberForWorkspace / unregister', () => {
  it('register: buat nomor di Vapi + simpan baris mapping', async () => {
    seedTable('vapi_inbound_numbers', []);
    const number = await lib.registerInboundNumberForWorkspace({
      userId: 'user-1',
      workspaceId: WORKSPACE_ID,
      name: 'Cabang Senopati',
      areaCode: '21',
    });
    expect(registerVapiMock).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      name: 'Cabang Senopati',
      areaCode: '21',
    });
    expect(number.vapiPhoneNumberId).toBe('vapi-number-1');
    expect(number.name).toBe('Cabang Senopati');
    const rows = dbState.tables.get('vapi_inbound_numbers') ?? [];
    expect(rows).toHaveLength(1);
    // Opt-in Voice AI → event sync asisten terkirim (create=true).
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'vapi/assistant.sync',
        data: expect.objectContaining({ workspaceId: WORKSPACE_ID, create: true }),
      }),
    );
  });

  it('unregister: hapus dari Vapi + hapus baris lokal', async () => {
    seedTable('vapi_inbound_numbers', [baseInboundNumber()]);
    await lib.unregisterInboundNumberForWorkspace({ workspaceId: WORKSPACE_ID, inboundNumberId: 'inb-1' });
    expect(unregisterVapiMock).toHaveBeenCalledWith('vapi-number-1');
    expect(dbState.tables.get('vapi_inbound_numbers') ?? []).toHaveLength(0);
  });

  it('unregister nomor TERAKHIR dengan asisten tersimpan → asisten dihapus (tanpa orphan)', async () => {
    seedTable('vapi_inbound_numbers', [baseInboundNumber()]);
    seedTable('workspace_integrations', [
      {
        id: 'wsint-1',
        workspaceId: WORKSPACE_ID,
        integrationType: 'vapi-assistant',
        identifier: 'vapi-assistant-1',
        providerConfig: { assistantId: 'vapi-assistant-1', name: 'oriole-receptionist-salon-cantik' },
        isActive: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await lib.unregisterInboundNumberForWorkspace({ workspaceId: WORKSPACE_ID, inboundNumberId: 'inb-1' });
    expect(deleteVapiAssistantMock).toHaveBeenCalledWith('vapi-assistant-1');
    expect(dbState.tables.get('workspace_integrations') ?? []).toHaveLength(0);
  });

  it('unregister saat masih ada nomor lain → asisten DIPERTAHANKAN', async () => {
    seedTable('vapi_inbound_numbers', [
      baseInboundNumber(),
      baseInboundNumber({ id: 'inb-2', vapiPhoneNumberId: 'vapi-number-2' }),
    ]);
    seedTable('workspace_integrations', [
      {
        id: 'wsint-1',
        workspaceId: WORKSPACE_ID,
        integrationType: 'vapi-assistant',
        identifier: 'vapi-assistant-1',
        providerConfig: { assistantId: 'vapi-assistant-1', name: 'x' },
        isActive: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await lib.unregisterInboundNumberForWorkspace({ workspaceId: WORKSPACE_ID, inboundNumberId: 'inb-1' });
    expect(deleteVapiAssistantMock).not.toHaveBeenCalled();
    expect(dbState.tables.get('workspace_integrations') ?? []).toHaveLength(1);
  });

  it('unregister nomor asing → InboundNumberNotFoundError', async () => {
    seedTable('vapi_inbound_numbers', [baseInboundNumber()]);
    await expect(
      lib.unregisterInboundNumberForWorkspace({ workspaceId: WORKSPACE_ID, inboundNumberId: 'inb-999' }),
    ).rejects.toThrow('tidak ditemukan');
    expect(unregisterVapiMock).not.toHaveBeenCalled();
  });
});

describe('handleInboundToolCall — check_availability', () => {
  it('mengembalikan slot untuk tanggal (tanpa staf → UTC)', async () => {
    seedTable('workspaces', [baseWorkspace()]);
    seedTable('services', [baseService()]);
    seedTable('bookings', []);
    seedTable('workspace_integrations', []);
    const { date } = futureSlot();
    const outcome = await lib.handleInboundToolCall(WORKSPACE_ID, { callId: 'call-1', toolCallId: 'tc-1' }, {
      name: 'check_availability',
      arguments: JSON.stringify({ date, serviceName: 'Haircut & Styling' }),
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const result = outcome.result as { slots: { time: string }[]; timezone: string; serviceName: string };
      expect(result.slots.length).toBeGreaterThan(0);
      expect(result.timezone).toBe('UTC');
      expect(result.serviceName).toBe('Haircut & Styling');
    }
  });

  it('format tanggal invalid → error', async () => {
    seedTable('services', [baseService()]);
    const outcome = await lib.handleInboundToolCall(WORKSPACE_ID, { callId: 'call-1', toolCallId: 'tc-1' }, {
      name: 'check_availability',
      arguments: JSON.stringify({ date: '20/08/2026' }),
    });
    expect(outcome).toEqual({ ok: false, error: expect.stringMatching(/format tanggal tidak valid/i) as never });
  });

  it('layanan tidak dikenal → error berisi daftar layanan', async () => {
    seedTable('services', [baseService(), baseService({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Coloring' })]);
    const { date } = futureSlot();
    const outcome = await lib.handleInboundToolCall(WORKSPACE_ID, { callId: 'call-1', toolCallId: 'tc-1' }, {
      name: 'check_availability',
      arguments: JSON.stringify({ date, serviceName: 'Pijat' }),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain('Haircut & Styling');
  });
});

describe('handleInboundToolCall — create_booking', () => {
  it('sukses: membuat booking + kontak, source=vapi-inbound, idempoten key', async () => {
    seedTable('workspaces', [baseWorkspace()]);
    seedTable('services', [baseService()]);
    seedTable('bookings', []);
    seedTable('contacts', []);
    seedTable('workspace_integrations', []);

    const { date, time } = futureSlot();
    const outcome = await lib.handleInboundToolCall(WORKSPACE_ID, { callId: 'call-1', toolCallId: 'tc-1' }, {
      name: 'create_booking',
      arguments: JSON.stringify({
        serviceName: 'Haircut & Styling',
        date,
        time,
        customerName: 'Budi',
        customerPhone: '+6281234567890',
      }),
    });
    expect(outcome.ok).toBe(true);
    const rows = dbState.tables.get('bookings') ?? [];
    expect(rows).toHaveLength(1);
    const booking = rows[0] as Record<string, unknown>;
    expect(booking.source).toBe('vapi-inbound');
    expect(booking.sourceRef).toBe('call-1:tc-1');
    expect(booking.serviceId).toBe(SERVICE_ID);
    expect(booking.customerName).toBe('Budi');
    // Kontak dibuat otomatis dari nomor customer.
    expect(dbState.tables.get('contacts') ?? []).toHaveLength(1);
    // Reminder dijadwalkan (booking/created) — auto-call mati (seed).
    expect(sendMock.mock.calls.map((c) => c[0]?.name)).toContain('booking/created');
    if (outcome.ok) {
      expect((outcome.result as { bookingId: string }).bookingId).toBeTruthy();
    }
  });

  it('retry tool-call yang sama (sourceRef sama) → idempoten, satu booking', async () => {
    seedTable('workspaces', [baseWorkspace()]);
    seedTable('services', [baseService()]);
    seedTable('contacts', []);
    seedTable('workspace_integrations', []);
    seedTable('bookings', []);

    const { date, time } = futureSlot();
    const args = JSON.stringify({
      serviceName: 'Haircut & Styling',
      date,
      time,
      customerName: 'Budi',
      customerPhone: '+6281234567890',
    });
    const first = await lib.handleInboundToolCall(WORKSPACE_ID, { callId: 'call-1', toolCallId: 'tc-1' }, {
      name: 'create_booking',
      arguments: args,
    });
    expect(first.ok).toBe(true);
    const firstId = first.ok ? (first.result as { bookingId: string }).bookingId : '';
    // Retry tool-calls yang sama (Vapi mengulang saat webhook timeout) —
    // mengembalikan booking yang sama, BUKAN booking ganda / slot terisi.
    const second = await lib.handleInboundToolCall(WORKSPACE_ID, { callId: 'call-1', toolCallId: 'tc-1' }, {
      name: 'create_booking',
      arguments: args,
    });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect((second.result as { bookingId: string }).bookingId).toBe(firstId);
    }
    expect(dbState.tables.get('bookings') ?? []).toHaveLength(1);
  });

  it('slot di masa lalu → error', async () => {
    seedTable('workspaces', [baseWorkspace()]);
    seedTable('services', [baseService()]);
    seedTable('bookings', []);
    seedTable('contacts', []);
    seedTable('workspace_integrations', []);
    const past = new Date(Date.now() - 3_600_000);
    const date = past.toISOString().slice(0, 10);
    const time = past.toISOString().slice(11, 16);
    const outcome = await lib.handleInboundToolCall(WORKSPACE_ID, { callId: 'call-1', toolCallId: 'tc-1' }, {
      name: 'create_booking',
      arguments: JSON.stringify({
        serviceName: 'Haircut & Styling',
        date,
        time,
        customerName: 'Budi',
        customerPhone: '+6281234567890',
      }),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain('sudah lewat');
  });

  it('slot bentrok dengan booking lain → error konflik', async () => {
    seedTable('workspaces', [baseWorkspace()]);
    seedTable('services', [baseService()]);
    seedTable('contacts', []);
    seedTable('workspace_integrations', []);

    const { date, time } = futureSlot();
    const start = new Date(`${date}T${time}:00.000Z`);
    seedTable('bookings', [
      {
        id: 'booking-1',
        userId: 'user-1',
        workspaceId: WORKSPACE_ID,
        title: 'Existing',
        scheduledAt: start,
        timezone: 'UTC',
        status: 'pending',
        durationMinutes: 60,
        staffId: null,
        serviceId: null,
      },
    ]);
    const outcome = await lib.handleInboundToolCall(WORKSPACE_ID, { callId: 'call-1', toolCallId: 'tc-1' }, {
      name: 'create_booking',
      arguments: JSON.stringify({
        serviceName: 'Haircut & Styling',
        date,
        time,
        customerName: 'Budi',
        customerPhone: '+6281234567890',
      }),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain('terisi');
  });

  it('field wajib kurang → error', async () => {
    seedTable('workspaces', [baseWorkspace()]);
    seedTable('services', [baseService()]);
    seedTable('bookings', []);
    const outcome = await lib.handleInboundToolCall(WORKSPACE_ID, { callId: 'call-1', toolCallId: 'tc-1' }, {
      name: 'create_booking',
      arguments: JSON.stringify({ serviceName: 'Haircut & Styling', date: '2026-08-20' }),
    });
    expect(outcome.ok).toBe(false);
  });

  it('tool tidak dikenal → error', async () => {
    const outcome = await lib.handleInboundToolCall(WORKSPACE_ID, { callId: 'call-1', toolCallId: 'tc-1' }, {
      name: 'send_email',
      arguments: '{}',
    });
    expect(outcome).toEqual({ ok: false, error: expect.stringMatching(/tidak dikenal/i) as never });
  });
});

describe('attachInboundNumberForWorkspace — pasang nomor yang sudah ada', () => {
  it('idempoten: sudah terpasang di workspace ini → kembalikan baris lama', async () => {
    seedTable('vapi_inbound_numbers', [
      {
        id: 'inb-1',
        userId: 'user-1',
        workspaceId: WORKSPACE_ID,
        vapiPhoneNumberId: 'vapi-free-1',
        number: '+14155550123',
        name: null,
        provider: 'vapi',
        isActive: true,
        createdAt: now,
      },
    ]);
    const result = await lib.attachInboundNumberForWorkspace({
      userId: 'user-1',
      workspaceId: WORKSPACE_ID,
      vapiPhoneNumberId: 'vapi-free-1',
    });
    expect(result.id).toBe('inb-1');
    expect(attachVapiMock).not.toHaveBeenCalled();
  });

  it('nomor dipakai workspace lain → InboundNumberInUseError', async () => {
    seedTable('vapi_inbound_numbers', [
      {
        id: 'inb-2',
        userId: 'user-2',
        workspaceId: 'ws-2',
        vapiPhoneNumberId: 'vapi-free-1',
        number: '+14155550123',
        name: null,
        provider: 'vapi',
        isActive: true,
        createdAt: now,
      },
    ]);
    await expect(
      lib.attachInboundNumberForWorkspace({
        userId: 'user-1',
        workspaceId: WORKSPACE_ID,
        vapiPhoneNumberId: 'vapi-free-1',
      }),
    ).rejects.toThrow(/workspace lain/);
  });

  it('baru → set server URL di Vapi + simpan mapping', async () => {
    const result = await lib.attachInboundNumberForWorkspace({
      userId: 'user-1',
      workspaceId: WORKSPACE_ID,
      vapiPhoneNumberId: 'vapi-free-1',
      name: 'Line utama',
    });
    expect(attachVapiMock).toHaveBeenCalledWith({
      vapiPhoneNumberId: 'vapi-free-1',
      name: 'Line utama',
    });
    expect(result.vapiPhoneNumberId).toBe('vapi-free-1');
    expect(result.number).toBe('+14155550123');
    expect(result.isActive).toBe(true);
  });
});
