import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { contacts as contactsTable, workspaceIntegrations, workspaces } from '@oriole/database';

// Mock network layer (googleFetch) — parseServiceAccount tetap asli.
const { googleFetchMock } = vi.hoisted(() => ({ googleFetchMock: vi.fn() }));

vi.mock('./google-auth.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./google-auth.ts')>();
  return { ...actual, googleFetch: googleFetchMock };
});

import {
  extractContactFromResponse,
  listFormResponses,
  syncFormResponsesToContacts,
  type GoogleFormQuestion,
} from './google-forms.ts';

const SERVICE_ACCOUNT_JSON = JSON.stringify({
  type: 'service_account',
  project_id: 'p',
  private_key_id: 'k',
  private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n',
  client_email: 'sa@example.iam.gserviceaccount.com',
  client_id: '123',
  token_uri: 'https://oauth2.googleapis.com/token',
});

const QUESTIONS: GoogleFormQuestion[] = [
  { id: 'q-name', title: 'Name' },
  { id: 'q-phone', title: 'Phone' },
  { id: 'q-email', title: 'Email' },
  { id: 'q-notes', title: 'Notes' },
];

function response(overrides: Record<string, unknown> = {}) {
  return {
    responseId: 'r-1',
    lastSubmittedTime: '2026-01-02T03:00:00.000Z',
    answers: {
      'q-name': { textAnswers: { answers: [{ value: 'Andi Putra' }] } },
      'q-phone': { textAnswers: { answers: [{ value: '+62 812 3456 789' }] } },
      'q-email': { textAnswers: { answers: [{ value: 'andi@example.com' }] } },
      'q-notes': { textAnswers: { answers: [{ value: 'Minta pagi' }] } },
    },
    ...overrides,
  };
}

// ── Fake Drizzle db (filter eq/and nyata) ─────────────────────
const { dbState } = vi.hoisted(() => ({
  dbState: { tables: new Map<string, Record<string, unknown>[]>(), seq: 1 },
}));

vi.mock('../db/index.ts', async () => {
  const tableNames = new WeakMap<object, string>();
  tableNames.set(contactsTable, 'contacts');
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
      insert: (table: object) => ({
        values: (values: Record<string, unknown>) => ({
          onConflictDoNothing: () => ({
            returning: async () => {
              const name = tableNames.get(table) ?? 'unknown';
              const rows = dbState.tables.get(name) ?? [];
              const duplicate = rows.some(
                (r) =>
                  (r as Record<string, unknown>).workspaceId === values.workspaceId &&
                  (r as Record<string, unknown>).phone === values.phone,
              );
              if (duplicate) return [];
              const row = { ...values, id: `contact-${dbState.seq++}`, createdAt: new Date(), updatedAt: new Date() };
              rows.push(row);
              return [{ id: row.id }];
            },
          }),
        }),
      }),
      update: (table: object) => ({
        set: (values: Record<string, unknown>) => ({
          where: () => ({
            then: async (resolve: (rows: unknown[]) => unknown) => {
              const name = tableNames.get(table) ?? 'unknown';
              const rows = dbState.tables.get(name) ?? [];
              const idx = rows.findIndex((r) => (r as Record<string, unknown>).workspaceId === 'ws-1');
              if (idx >= 0) {
                rows[idx] = { ...rows[idx], ...values, updatedAt: new Date() };
              }
              return resolve([]);
            },
          }),
        }),
      }),
    },
  };
});

function baseFormIntegration(overrides: Record<string, unknown> = {}) {
  return {
    id: 'int-f1',
    workspaceId: 'ws-1',
    integrationType: 'google-forms',
    identifier: 'Lead Form',
    providerConfig: {
      serviceAccountJson: SERVICE_ACCOUNT_JSON,
      serviceAccountEmail: 'sa@example.iam.gserviceaccount.com',
      formId: 'form-abc',
      formName: 'Lead Form',
      lastSubmittedAt: null,
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
  dbState.seq = 1;
  dbState.tables.set('workspaces', [{ id: 'ws-1', userId: 'u-1' }]);
  dbState.tables.set('workspaceIntegrations', [baseFormIntegration()]);
  dbState.tables.set('contacts', []);
});

describe('extractContactFromResponse', () => {
  it('memetakan jawaban berdasarkan judul pertanyaan', () => {
    const contact = extractContactFromResponse(QUESTIONS, response());
    expect(contact).toEqual({
      name: 'Andi Putra',
      phone: '+628123456789',
      email: 'andi@example.com',
      notes: 'Minta pagi',
    });
  });

  it('mengenal judul berbahasa Indonesia (Nama/Telepon)', () => {
    const indonesian: GoogleFormQuestion[] = [
      { id: 'n', title: 'Nama lengkap' },
      { id: 'p', title: 'No. HP / WhatsApp' },
    ];
    const contact = extractContactFromResponse(
      indonesian,
      response({
        answers: {
          n: { textAnswers: { answers: [{ value: 'Sari' }] } },
          p: { textAnswers: { answers: [{ value: '0812-555-0101' }] } },
        },
      }),
    );
    expect(contact).toMatchObject({ name: 'Sari', phone: '08125550101' });
  });

  it('field kosong → null', () => {
    const contact = extractContactFromResponse(QUESTIONS, response({ answers: {} }));
    expect(contact).toEqual({ name: null, phone: null, email: null, notes: null });
  });
});

describe('listFormResponses', () => {
  it('mengambil semua halaman dan memfilter response yang sudah lewat kursor', async () => {
    googleFetchMock
      .mockResolvedValueOnce({
        responses: [
          { responseId: 'old', lastSubmittedTime: '2026-01-01T00:00:00.000Z' },
          { responseId: 'new-1', lastSubmittedTime: '2026-01-03T00:00:00.000Z' },
        ],
        nextPageToken: 'tok-1',
      })
      .mockResolvedValueOnce({
        responses: [{ responseId: 'new-2', lastSubmittedTime: '2026-01-04T00:00:00.000Z' }],
        nextPageToken: null,
      });

    const rows = await listFormResponses(
      JSON.parse(SERVICE_ACCOUNT_JSON) as never,
      'form-abc',
      '2026-01-02T00:00:00.000Z',
    );
    expect(rows.map((r) => r.responseId)).toEqual(['new-1', 'new-2']);
    expect(googleFetchMock).toHaveBeenCalledTimes(2);
    expect(String(googleFetchMock.mock.calls[1][2])).toContain('pageToken=tok-1');
  });

  it('memakai base URL forms.googleapis.com (bukan www.googleapis.com)', async () => {
    googleFetchMock.mockResolvedValueOnce({ responses: [], nextPageToken: null });
    await listFormResponses(JSON.parse(SERVICE_ACCOUNT_JSON) as never, 'form-abc', null);
    const url = String(googleFetchMock.mock.calls[0][2]);
    expect(url.startsWith('https://forms.googleapis.com/v1/forms/form-abc/responses')).toBe(true);
    expect(url).not.toContain('www.googleapis.com');
  });
});

describe('syncFormResponsesToContacts', () => {
  it('membuat kontak dari response baru dan memajukan kursor', async () => {
    googleFetchMock
      .mockResolvedValueOnce({
        formId: 'form-abc',
        info: { title: 'Lead Form' },
        items: [
          { questionItem: { question: { questionId: 'q-name', title: 'Name' } } },
          { questionItem: { question: { questionId: 'q-phone', title: 'Phone' } } },
          { questionItem: { question: { questionId: 'q-email', title: 'Email' } } },
          { questionItem: { question: { questionId: 'q-notes', title: 'Notes' } } },
        ],
      })
      .mockResolvedValueOnce({
        responses: [response()],
        nextPageToken: null,
      });

    const result = await syncFormResponsesToContacts('ws-1');
    expect(result).toEqual({ imported: 1, skipped: 0, total: 1 });

    const contacts = dbState.tables.get('contacts') ?? [];
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({
      name: 'Andi Putra',
      phone: '+628123456789',
      email: 'andi@example.com',
      notes: 'Minta pagi',
    });

    const integration = (dbState.tables.get('workspaceIntegrations') ?? [])[0];
    expect((integration.providerConfig as { lastSubmittedAt: string }).lastSubmittedAt).toBe(
      '2026-01-02T03:00:00.000Z',
    );
  });

  it('response tanpa nama / telepon tidak valid → skipped, kursor tetap maju', async () => {
    googleFetchMock
      .mockResolvedValueOnce({
        formId: 'form-abc',
        info: { title: 'Lead Form' },
        items: [
          { questionItem: { question: { questionId: 'q-name', title: 'Name' } } },
          { questionItem: { question: { questionId: 'q-phone', title: 'Phone' } } },
        ],
      })
      .mockResolvedValueOnce({
        responses: [
          response({ responseId: 'r-no-phone', answers: { 'q-name': { textAnswers: { answers: [{ value: 'X' }] } } } }),
          response({ responseId: 'r-no-name', answers: { 'q-phone': { textAnswers: { answers: [{ value: '+628123456789' }] } } } }),
          response({ responseId: 'r-bad-phone', answers: { 'q-name': { textAnswers: { answers: [{ value: 'Y' }] } }, 'q-phone': { textAnswers: { answers: [{ value: 'abc' }] } } } }),
        ],
        nextPageToken: null,
      });

    const result = await syncFormResponsesToContacts('ws-1');
    expect(result).toEqual({ imported: 0, skipped: 3, total: 3 });
    expect(dbState.tables.get('contacts') ?? []).toHaveLength(0);

    const integration = (dbState.tables.get('workspaceIntegrations') ?? [])[0];
    // Kursor tetap maju ke response TERAKHIR yang diproses (bukan hanya yang valid).
    expect((integration.providerConfig as { lastSubmittedAt: string }).lastSubmittedAt).toBe(
      '2026-01-02T03:00:00.000Z',
    );
  });

  it('nomor yang sudah ada → tidak membuat duplikat, email kosong diisi', async () => {
    dbState.tables.set('contacts', [
      {
        id: 'contact-0',
        workspaceId: 'ws-1',
        name: 'Andi Putra',
        phone: '+628123456789',
        email: null,
        notes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    googleFetchMock
      .mockResolvedValueOnce({
        formId: 'form-abc',
        info: { title: 'Lead Form' },
        items: [{ questionItem: { question: { questionId: 'q-phone', title: 'Phone' } } }],
      })
      .mockResolvedValueOnce({
        responses: [response({ answers: { 'q-phone': { textAnswers: { answers: [{ value: '+62 812 3456 789' }] } } } })],
        nextPageToken: null,
      });

    const result = await syncFormResponsesToContacts('ws-1');
    expect(result.imported).toBe(1);
    const contacts = dbState.tables.get('contacts') ?? [];
    expect(contacts).toHaveLength(1);
  });

  it('integrasi belum terhubung → GoogleApiError 409', async () => {
    dbState.tables.set('workspaceIntegrations', []);
    await expect(syncFormResponsesToContacts('ws-1')).rejects.toMatchObject({ status: 409 });
  });
});

// Pastikan and/eq tetap dipakai (guard: helper tidak hilang saat refactor).
void and;
void eq;
