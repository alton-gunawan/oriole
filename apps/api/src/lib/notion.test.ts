import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildContactPagePayload,
  contactSyncKey,
  listNotionDatabases,
  syncContactsToNotion,
} from './notion.ts';

// ── Fake Drizzle db (syncContactsToNotion membaca integration + contacts) ──
const { dbState } = vi.hoisted(() => ({
  dbState: { tables: new Map<string, Record<string, unknown>[]>() },
}));

vi.mock('../db/index.ts', async () => {
  const { contacts, workspaceIntegrations } = await import('@oriole/database');
  const tableNames = new WeakMap<object, string>();
  tableNames.set(workspaceIntegrations, 'workspaceIntegrations');
  tableNames.set(contacts, 'contacts');

  function makeSelectBuilder(name: string) {
    const builder: {
      where: (...conds: unknown[]) => typeof builder;
      limit: (n: number) => typeof builder;
      then: (resolve: (rows: unknown[]) => unknown) => Promise<unknown>;
      _limit?: number;
    } = {
      _limit: undefined,
      where() {
        return builder;
      },
      limit(n: number) {
        builder._limit = n;
        return builder;
      },
      then(resolve: (rows: unknown[]) => unknown) {
        let rows = [...(dbState.tables.get(name) ?? [])];
        if (builder._limit != null) rows = rows.slice(0, builder._limit);
        return Promise.resolve(resolve(rows));
      },
    };
    return builder;
  }

  return {
    db: {
      select: () => ({
        from: (table: object) => makeSelectBuilder(tableNames.get(table) ?? 'unknown'),
      }),
      update: () => ({
        set: () => ({
          where: () => Promise.resolve(undefined),
        }),
      }),
    },
  };
});

// ── Stub fetch (Notion API) ───────────────────────────────────
const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  dbState.tables.clear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

const baseIntegration = {
  id: 'int-1',
  workspaceId: 'ws-1',
  integrationType: 'notion',
  identifier: 'Customers',
  providerConfig: { token: 'secret_abc', databaseId: 'db-1', databaseName: 'Customers' },
  isActive: true,
  lastSyncAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

const baseContact = (overrides: Record<string, unknown> = {}) => ({
  id: 'c-1',
  userId: 'test-user-1',
  workspaceId: 'ws-1',
  name: 'Andi Putra',
  phone: '+6281234567890',
  email: 'andi@example.com',
  notes: 'Regular client',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

describe('buildContactPagePayload — mapping kontak ke properti Notion', () => {
  const schema = {
    properties: {
      p1: { id: 'p1', name: 'Name', type: 'title' },
      p2: { id: 'p2', name: 'Phone', type: 'rich_text' },
      p3: { id: 'p3', name: 'Email', type: 'rich_text' },
      p4: { id: 'p4', name: 'Notes', type: 'rich_text' },
      p5: { id: 'p5', name: 'Created', type: 'date' },
    },
  };

  it('memetakan semua field ke properti yang namanya cocok', () => {
    const contact = {
      id: 'c-1',
      name: 'Andi Putra',
      phone: '+6281234567890',
      email: 'andi@example.com',
      notes: 'Regular client',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    const { properties } = buildContactPagePayload(schema, contact);
    expect(properties.Name).toEqual({ title: [{ text: { content: 'Andi Putra' } }] });
    expect(properties.Phone).toEqual({ rich_text: [{ text: { content: '+6281234567890' } }] });
    expect(properties.Email).toEqual({ rich_text: [{ text: { content: 'andi@example.com' } }] });
    expect(properties.Notes).toEqual({ rich_text: [{ text: { content: 'Regular client' } }] });
    expect(properties.Created).toEqual({ date: { start: '2026-01-01T00:00:00.000Z' } });
  });

  it('melewati properti yang tipe-nya tidak cocok / field kosong', () => {
    const schemaPartial = {
      properties: {
        p1: { id: 'p1', name: 'Name', type: 'title' },
        p2: { id: 'p2', name: 'Phone', type: 'number' }, // tipe salah → dilewati
      },
    };
    const contact = {
      id: 'c-1',
      name: 'Andi Putra',
      phone: '+6281234567890',
      email: null,
      notes: '',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    const { properties } = buildContactPagePayload(schemaPartial, contact);
    expect(properties.Name).toBeDefined();
    expect(properties.Phone).toBeUndefined();
  });

  it('memakai properti title apa pun bila tidak ada "Name"', () => {
    const schemaNoName = {
      properties: {
        p1: { id: 'p1', name: 'Customer', type: 'title' },
      },
    };
    const contact = {
      id: 'c-1',
      name: 'Andi Putra',
      phone: null,
      email: null,
      notes: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    const { properties } = buildContactPagePayload(schemaNoName, contact);
    expect(properties.Customer).toEqual({ title: [{ text: { content: 'Andi Putra' } }] });
  });
});

describe('contactSyncKey — dedup kontak', () => {
  const schema = {
    properties: {
      p1: { id: 'p1', name: 'Name', type: 'title' },
      p2: { id: 'p2', name: 'Phone', type: 'rich_text' },
    },
  };

  it('prioritas nomor telepon bila properti Phone ada', () => {
    const contact = {
      id: 'c-1',
      name: 'Andi Putra',
      phone: '+6281234567890',
      email: null,
      notes: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    expect(contactSyncKey(schema, contact)).toBe('phone:6281234567890');
  });

  it('fallback ke nama bila tidak ada telepon', () => {
    const contact = {
      id: 'c-1',
      name: 'Andi Putra',
      phone: null,
      email: null,
      notes: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    expect(contactSyncKey(schema, contact)).toBe('title:Andi Putra');
  });

  it('format telepon dinormalisasi (spasi/+/tanda baca diabaikan)', () => {
    const contact = {
      id: 'c-1',
      name: 'Andi Putra',
      phone: '+62 812-3456-7890',
      email: null,
      notes: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    expect(contactSyncKey(schema, contact)).toBe('phone:6281234567890');
  });
});

describe('listNotionDatabases — token divalidasi + daftar database', () => {
  it('mengembalikan database yang bisa diakses', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        results: [
          { id: 'db-1', url: 'https://notion.so/db1', title: [{ plain_text: 'Customers' }] },
          { id: 'db-2', url: 'https://notion.so/db2', title: [] },
        ],
      }),
    );
    const databases = await listNotionDatabases('secret_abc');
    expect(databases).toEqual([
      { id: 'db-1', title: 'Customers', url: 'https://notion.so/db1' },
      { id: 'db-2', title: 'Untitled', url: 'https://notion.so/db2' },
    ]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/v1/search');
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer secret_abc',
      'Notion-Version': '2022-06-28',
    });
  });

  it('token ditolak → NotionApiError dengan status', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ code: 'unauthorized', message: 'Invalid token' }, 401),
    );
    await expect(listNotionDatabases('bad-token')).rejects.toMatchObject({
      name: 'NotionApiError',
      status: 401,
      message: 'Invalid token',
    });
  });
});

describe('syncContactsToNotion — sinkronisasi kontak ke database', () => {
  it('membuat page baru & mengupdate yang sudah ada (dedup via Phone)', async () => {
    dbState.tables.set('workspaceIntegrations', [baseIntegration]);
    dbState.tables.set('contacts', [baseContact(), baseContact({ id: 'c-2', name: 'Budi', phone: '+6281999' })]);

    // Skema database
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        properties: {
          t: { id: 't', name: 'Name', type: 'title' },
          ph: { id: 'ph', name: 'Phone', type: 'rich_text' },
          em: { id: 'em', name: 'Email', type: 'rich_text' },
        },
      }),
    );
    // Query page lama: satu sudah ada (Andi), satu belum (Budi)
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        results: [
          {
            id: 'page-andi',
            properties: {
              Name: { title: [{ plain_text: 'Andi Putra' }] },
              Phone: { rich_text: [{ plain_text: '+6281234567890' }] },
            },
          },
        ],
      }),
    );
    // PATCH page Andi
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'page-andi' }));
    // POST page Budi
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'page-budi' }));

    const result = await syncContactsToNotion('ws-1');
    expect(result).toEqual({ created: 1, updated: 1, total: 2 });

    const calls = fetchMock.mock.calls;
    expect(String(calls[2][0])).toContain('/pages/page-andi');
    expect((calls[2][1] as RequestInit).method).toBe('PATCH');
    expect(String(calls[3][0])).toContain('/pages');
    expect((calls[3][1] as RequestInit).method).toBe('POST');
    const postBody = JSON.parse(String((calls[3][1] as RequestInit).body)) as {
      parent: { database_id: string };
    };
    expect(postBody.parent).toEqual({ database_id: 'db-1' });
  });

  it('belum terhubung → NotionApiError 409', async () => {
    dbState.tables.set('workspaceIntegrations', []);
    await expect(syncContactsToNotion('ws-1')).rejects.toMatchObject({ status: 409 });
  });
});
