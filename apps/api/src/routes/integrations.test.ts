import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import { ensureTallyFormEnhanced } from '../lib/tally.ts';

import { TelnyxApiError } from '../services/telnyx.ts';
import { VapiCredentialApiError } from '../services/vapi-credential.ts';

// ── Mocks ───────────────────────────────────────────────────────

// Mock jose agar requireAuth tidak perlu JWKS remote (network).
const { jwtVerifyMock } = vi.hoisted(() => ({
  jwtVerifyMock: vi.fn(),
}));

vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => vi.fn()),
  jwtVerify: jwtVerifyMock,
}));

vi.mock('../lib/env.ts', () => ({
  env: {
    API_URL: 'http://localhost:3000',
    NEON_AUTH_URL: 'https://ep-test.neon.tech/neondb/auth',
    VAPI_API_KEY: 'vapi_test_key',
    VAPI_PHONE_NUMBER_ID: 'vapi-default-1',
  },
}));

// Mock layanan Vapi — daftar nomor phone number (dipakai blok Voice AI).
const { listVapiPhoneNumbersMock, listOperatorVapiPhoneNumbersMock } = vi.hoisted(() => ({
  listVapiPhoneNumbersMock: vi.fn(),
  listOperatorVapiPhoneNumbersMock: vi.fn(),
}));

vi.mock('../services/vapi.ts', () => ({
  listVapiPhoneNumbers: listVapiPhoneNumbersMock,
  listOperatorVapiPhoneNumbers: listOperatorVapiPhoneNumbersMock,
}));

// Mock lib inbound — route panggilan MASUK di-stub (unit: routing + status).
const {
  listInboundNumbersMock,
  registerInboundNumberForWorkspaceMock,
  unregisterInboundNumberForWorkspaceMock,
  InboundNumberNotFoundErrorMock,
} = vi.hoisted(() => ({
  listInboundNumbersMock: vi.fn(),
  registerInboundNumberForWorkspaceMock: vi.fn(),
  unregisterInboundNumberForWorkspaceMock: vi.fn(),
  InboundNumberNotFoundErrorMock: class extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'InboundNumberNotFoundError';
    }
  },
}));

vi.mock('../lib/vapi-inbound.ts', () => ({
  listInboundNumbers: listInboundNumbersMock,
  registerInboundNumberForWorkspace: registerInboundNumberForWorkspaceMock,
  unregisterInboundNumberForWorkspace: unregisterInboundNumberForWorkspaceMock,
  InboundNumberNotFoundError: InboundNumberNotFoundErrorMock,
}));

// Mock BYOC orchestrator — semua panggilan Telnyx / kredensial Vapi di-stub.
const { searchTelnyxByocMock, connectTelnyxByocMock, TelnyxByocNumberUnavailableErrorMock } =
  vi.hoisted(() => ({
    searchTelnyxByocMock: vi.fn(),
    connectTelnyxByocMock: vi.fn(),
    TelnyxByocNumberUnavailableErrorMock: class extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'TelnyxByocNumberUnavailableError';
      }
    },
  }));

vi.mock('../lib/telnyx-byoc.ts', () => ({
  searchTelnyxByoc: searchTelnyxByocMock,
  connectTelnyxByoc: connectTelnyxByocMock,
  TelnyxByocNumberUnavailableError: TelnyxByocNumberUnavailableErrorMock,
}));

// Mock lib Notion — semua panggilan network di-stub.
const {
  getNotionUserMock,
  listNotionDatabasesMock,
  syncContactsToNotionMock,
  NotionApiErrorMock,
} = vi.hoisted(() => ({
  getNotionUserMock: vi.fn(),
  listNotionDatabasesMock: vi.fn(),
  syncContactsToNotionMock: vi.fn(),
  NotionApiErrorMock: class extends Error {
    constructor(
      message: string,
      readonly status?: number,
    ) {
      super(message);
      this.name = 'NotionApiError';
    }
  },
}));

vi.mock('../lib/notion.ts', () => ({
  NotionApiError: NotionApiErrorMock,
  getNotionUser: getNotionUserMock,
  listNotionDatabases: listNotionDatabasesMock,
  syncContactsToNotion: syncContactsToNotionMock,
}));

// Mock Google — Forms, Calendar, webhook keluar.
const { GoogleApiErrorMock, parseServiceAccountMock } = vi.hoisted(() => ({
  GoogleApiErrorMock: class extends Error {
    constructor(
      message: string,
      readonly status?: number,
    ) {
      super(message);
      this.name = 'GoogleApiError';
    }
  },
  parseServiceAccountMock: vi.fn(),
}));

vi.mock('../lib/google-auth.ts', () => ({
  GoogleApiError: GoogleApiErrorMock,
  parseServiceAccount: parseServiceAccountMock,
}));

const {
  getFormMetadataMock,
  syncFormResponsesToContactsMock,
} = vi.hoisted(() => ({
  getFormMetadataMock: vi.fn(),
  syncFormResponsesToContactsMock: vi.fn(),
}));

vi.mock('../lib/google-forms.ts', () => ({
  getFormMetadata: getFormMetadataMock,
  syncFormResponsesToContacts: syncFormResponsesToContactsMock,
}));

const {
  listGoogleCalendarsMock,
  getGoogleCalendarMock,
  syncBookingsToCalendarMock,
} = vi.hoisted(() => ({
  listGoogleCalendarsMock: vi.fn(),
  getGoogleCalendarMock: vi.fn(),
  syncBookingsToCalendarMock: vi.fn(),
}));

vi.mock('../lib/google-calendar.ts', () => ({
  listGoogleCalendars: listGoogleCalendarsMock,
  getGoogleCalendar: getGoogleCalendarMock,
  syncBookingsToCalendar: syncBookingsToCalendarMock,
}));

const { sendTestWebhookMock, WebhookDeliveryErrorMock } = vi.hoisted(() => ({
  sendTestWebhookMock: vi.fn(),
  WebhookDeliveryErrorMock: class extends Error {
    constructor(
      message: string,
      readonly status?: number,
    ) {
      super(message);
      this.name = 'WebhookDeliveryError';
    }
  },
}));

vi.mock('../lib/outgoing-webhooks.ts', () => ({
  sendTestWebhook: sendTestWebhookMock,
  WebhookDeliveryError: WebhookDeliveryErrorMock,
}));

const { dispatchFormInvitationMock, FormSendErrorMock } = vi.hoisted(() => ({
  dispatchFormInvitationMock: vi.fn(),
  FormSendErrorMock: class extends Error {
    constructor(
      message: string,
      readonly status?: number,
    ) {
      super(message);
      this.name = 'FormSendError';
    }
  },
}));

vi.mock('../lib/form-send.ts', () => ({
  dispatchFormInvitation: dispatchFormInvitationMock,
  FormSendError: FormSendErrorMock,
}));

// Mock Slack — pengiriman webhook di-stub (jangan hit network).
const {
  deliverSlackMessageMock,
  sendTestSlackMock,
  buildSlackMessageMock,
  SlackDeliveryErrorMock,
} = vi.hoisted(() => ({
  deliverSlackMessageMock: vi.fn(),
  sendTestSlackMock: vi.fn(),
  buildSlackMessageMock: vi.fn((event: string) => ({ text: event, blocks: [] })),
  SlackDeliveryErrorMock: class extends Error {
    constructor(
      message: string,
      readonly status?: number,
    ) {
      super(message);
      this.name = 'SlackDeliveryError';
    }
  },
}));

vi.mock('../lib/slack.ts', () => ({
  deliverSlackMessage: deliverSlackMessageMock,
  sendTestSlack: sendTestSlackMock,
  buildSlackMessage: buildSlackMessageMock,
  SlackDeliveryError: SlackDeliveryErrorMock,
}));

// ── Fake Drizzle db ─────────────────────────────────────────────
const { dbState } = vi.hoisted(() => ({
  dbState: {
    tables: new Map<string, Record<string, unknown>[]>(),
    seq: 1,
  },
}));

vi.mock('../db/index.ts', async () => {
  const { services, workspaces, workspaceIntegrations } = await import('@oriole/database');
  const tableNames = new WeakMap<object, string>();
  tableNames.set(workspaces, 'workspaces');
  tableNames.set(workspaceIntegrations, 'workspaceIntegrations');
  tableNames.set(services, 'services');

  const NOW = new Date('2026-01-01T00:00:00.000Z');

  function makeSelectBuilder(name: string) {
    const builder: {
      where: (...conds: unknown[]) => typeof builder;
      limit: (n: number) => typeof builder;
      orderBy: (...cols: unknown[]) => typeof builder;
      then: (resolve: (rows: unknown[]) => unknown) => Promise<unknown>;
      _limit?: number;
    } = {
      _limit: undefined,
      where() {
        return builder;
      },
      orderBy() {
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
      insert: (table: object) => ({
        values: (values: Record<string, unknown> | Record<string, unknown>[]) => ({
          returning: async () => {
            const name = tableNames.get(table) ?? 'unknown';
            const rows = dbState.tables.get(name) ?? [];
            const row = {
              ...(Array.isArray(values) ? values[0] ?? {} : values),
              id: `row-${dbState.seq++}`,
              createdAt: NOW,
              updatedAt: NOW,
            };
            rows.push(row);
            return [row];
          },
          onConflictDoUpdate: () => ({
            returning: async () => {
              const name = tableNames.get(table) ?? 'unknown';
              const rows = dbState.tables.get(name) ?? [];
              const first = Array.isArray(values) ? values[0] ?? {} : values;
              const idx = rows.findIndex(
                (r) =>
                  r.workspaceId === first.workspaceId &&
                  r.integrationType === first.integrationType,
              );
              if (idx >= 0) {
                const merged = { ...rows[idx], ...first, updatedAt: NOW };
                rows[idx] = merged;
                return [merged];
              }
              const row = { ...first, id: `int-${dbState.seq++}`, createdAt: NOW, updatedAt: NOW };
              rows.push(row);
              return [row];
            },
          }),
        }),
      }),
      update: (table: object) => ({
        set: (values: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => {
              const name = tableNames.get(table) ?? 'unknown';
              const rows = dbState.tables.get(name) ?? [];
              const idx = rows.findIndex((r) => r.workspaceId === 'ws-1');
              if (idx < 0) return [];
              rows[idx] = { ...rows[idx], ...values, updatedAt: NOW };
              return [rows[idx]];
            },
          }),
        }),
      }),
      delete: (table: object) => ({
        where: () => {
          // Hapus baris workspace ini saat where dipanggil (mendukung pola
          // `await db.delete().where()` tanpa `.returning()`).
          const name = tableNames.get(table) ?? 'unknown';
          const rows = dbState.tables.get(name) ?? [];
          const idx = rows.findIndex((r) => r.workspaceId === 'ws-1');
          const deletedId = idx >= 0 ? (rows.splice(idx, 1)[0]?.id ?? null) : null;
          return {
            returning: async () => (deletedId ? [{ id: deletedId }] : []),
          };
        },
      }),
    },
  };
});

// ── Setup app ───────────────────────────────────────────────────
const AUTH_HEADER = { Authorization: 'Bearer test-jwt-token' };
const WORKSPACE_HEADER = { 'X-Workspace-Id': 'ws-1' };

let app: Hono;

function baseIntegration(overrides: Record<string, unknown> = {}) {
  return {
    id: 'int-1',
    workspaceId: 'ws-1',
    integrationType: 'notion',
    identifier: 'Customers',
    providerConfig: { token: 'secret_abc', databaseId: 'db-1', databaseName: 'Customers' },
    isActive: true,
    lastSyncAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

beforeAll(async () => {
  jwtVerifyMock.mockReset();
  jwtVerifyMock.mockResolvedValue({ payload: { sub: 'test-user-1', email: 'user@example.com' } });

  const { integrationsRoutes } = await import('./integrations.ts');
  app = new Hono().route('/api/integrations', integrationsRoutes);
});

beforeEach(() => {
  dbState.tables.set('workspaces', [{ id: 'ws-1', userId: 'test-user-1' }]);
  dbState.tables.set('workspaceIntegrations', []);
  getNotionUserMock.mockReset();
  listNotionDatabasesMock.mockReset();
  syncContactsToNotionMock.mockReset();
  dispatchFormInvitationMock.mockReset();
  listVapiPhoneNumbersMock.mockReset();
  listVapiPhoneNumbersMock.mockResolvedValue([
    { id: 'vapi-telnyx-1', number: '+628211111111', name: null, provider: 'telnyx' },
    { id: 'vapi-default-1', number: '+15550000000', name: 'Default', provider: 'vapi' },
  ]);
  listInboundNumbersMock.mockReset();
  listInboundNumbersMock.mockResolvedValue([]);
  registerInboundNumberForWorkspaceMock.mockReset();
  unregisterInboundNumberForWorkspaceMock.mockReset();
  listOperatorVapiPhoneNumbersMock.mockReset();
  listOperatorVapiPhoneNumbersMock.mockResolvedValue([
    { id: 'vapi-telnyx-1', number: '+628211111111', name: null, provider: 'telnyx' },
    { id: 'vapi-default-1', number: '+15550000000', name: 'Default', provider: 'vapi' },
  ]);
  searchTelnyxByocMock.mockReset();
  connectTelnyxByocMock.mockReset();
});

describe('GET /api/integrations', () => {
  it('tanpa auth → 401', async () => {
    const res = await app.request('/api/integrations');
    expect(res.status).toBe(401);
  });

  it('tanpa integrasi → daftar kosong', async () => {
    const res = await app.request('/api/integrations', {
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { integrations: unknown[] };
    expect(body.integrations).toEqual([]);
  });

  it('integrasi Notion → public (token tidak bocor)', async () => {
    dbState.tables.set('workspaceIntegrations', [
      baseIntegration({ lastSyncAt: new Date('2026-01-02T00:00:00.000Z') }),
    ]);
    const res = await app.request('/api/integrations', {
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      integrations: {
        integrationType: string;
        identifier: string | null;
        isActive: boolean;
        lastSyncAt: string | null;
        config: { databaseId: string | null; databaseName: string | null };
      }[];
    };
    expect(body.integrations[0]).toMatchObject({
      integrationType: 'notion',
      identifier: 'Customers',
      isActive: true,
      config: { databaseId: 'db-1', databaseName: 'Customers' },
    });
    expect(body.integrations[0].lastSyncAt).toBe('2026-01-02T00:00:00.000Z');
    expect(JSON.stringify(body)).not.toContain('secret_abc');
  });
});

describe('POST /api/integrations/notion/databases', () => {
  it('token valid → daftar database dari Notion', async () => {
    getNotionUserMock.mockResolvedValue({ id: 'user-1', name: 'Budi' });
    listNotionDatabasesMock.mockResolvedValue([
      { id: 'db-1', title: 'Customers', url: 'https://notion.so/db1' },
    ]);
    const res = await app.request('/api/integrations/notion/databases', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'secret_abc' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { name: string | null }; databases: { id: string }[] };
    expect(body.user.name).toBe('Budi');
    expect(body.databases).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain('secret_abc');
  });

  it('token ditolak Notion → 401', async () => {
    getNotionUserMock.mockRejectedValue(new NotionApiErrorMock('Invalid token', 401));
    const res = await app.request('/api/integrations/notion/databases', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'bad-token-123456' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/integrations/notion/connect', () => {
  it('sukses → 201, row tersimpan, token tidak bocor', async () => {
    getNotionUserMock.mockResolvedValue({ id: 'user-1', name: 'Budi' });
    listNotionDatabasesMock.mockResolvedValue([
      { id: 'db-1', title: 'Customers', url: 'https://notion.so/db1' },
    ]);
    const res = await app.request('/api/integrations/notion/connect', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'secret_abc', databaseId: 'db-1', databaseName: 'Customers' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      integration: { integrationType: string; identifier: string | null };
    };
    expect(body.integration).toMatchObject({ integrationType: 'notion', identifier: 'Customers' });
    expect(JSON.stringify(body)).not.toContain('secret_abc');

    const rows = dbState.tables.get('workspaceIntegrations') ?? [];
    expect(rows).toHaveLength(1);
    expect((rows[0].providerConfig as { token: string }).token).toBe('secret_abc');
  });

  it('database tidak ada di akun → 400, tidak menyimpan apa pun', async () => {
    getNotionUserMock.mockResolvedValue({ id: 'user-1', name: 'Budi' });
    listNotionDatabasesMock.mockResolvedValue([{ id: 'other-db', title: 'X', url: 'https://n/x' }]);
    const res = await app.request('/api/integrations/notion/connect', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'secret_abc', databaseId: 'db-1' }),
    });
    expect(res.status).toBe(400);
    expect(dbState.tables.get('workspaceIntegrations')).toHaveLength(0);
  });

  it('token ditolak → 401', async () => {
    getNotionUserMock.mockRejectedValue(new NotionApiErrorMock('Invalid token', 401));
    const res = await app.request('/api/integrations/notion/connect', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'bad-token-123456', databaseId: 'db-1' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/integrations/notion', () => {
  it('mengubah isActive sesuai body', async () => {
    dbState.tables.set('workspaceIntegrations', [baseIntegration({ isActive: true })]);
    const res = await app.request('/api/integrations/notion', {
      method: 'PATCH',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { integration: { isActive: boolean } };
    expect(body.integration.isActive).toBe(false);
    expect(JSON.stringify(body)).not.toContain('secret_abc');
  });

  it('belum terhubung → 404', async () => {
    const res = await app.request('/api/integrations/notion', {
      method: 'PATCH',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: false }),
    });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/integrations/notion', () => {
  it('terhubung → dihapus', async () => {
    dbState.tables.set('workspaceIntegrations', [baseIntegration()]);
    const res = await app.request('/api/integrations/notion', {
      method: 'DELETE',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(200);
    expect(dbState.tables.get('workspaceIntegrations')).toHaveLength(0);
  });

  it('belum terhubung → 404', async () => {
    const res = await app.request('/api/integrations/notion', {
      method: 'DELETE',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/integrations/notion/sync', () => {
  it('sukses → jumlah created/updated', async () => {
    syncContactsToNotionMock.mockResolvedValue({ created: 2, updated: 1, total: 3 });
    const res = await app.request('/api/integrations/notion/sync', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { created: number; updated: number; total: number };
    expect(body).toMatchObject({ created: 2, updated: 1, total: 3 });
  });

  it('belum terhubung → 409', async () => {
    syncContactsToNotionMock.mockRejectedValue(new NotionApiErrorMock('Belum terhubung', 409));
    const res = await app.request('/api/integrations/notion/sync', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(409);
  });
});

// ── Google Forms ───────────────────────────────────────────────
const SERVICE_ACCOUNT_JSON = JSON.stringify({
  type: 'service_account',
  project_id: 'oriole-test',
  private_key_id: 'k',
  private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n',
  client_email: 'sa@oriole-test.iam.gserviceaccount.com',
  client_id: '123',
  token_uri: 'https://oauth2.googleapis.com/token',
});

const FORM_METADATA = {
  formId: 'form-abc',
  title: 'Lead Form',
  questions: [
    { id: 'q1', title: 'Name' },
    { id: 'q2', title: 'Phone' },
    { id: 'q3', title: 'Email' },
  ],
};

beforeEach(() => {
  parseServiceAccountMock.mockReset();
  parseServiceAccountMock.mockReturnValue({
    clientEmail: 'sa@oriole-test.iam.gserviceaccount.com',
    privateKey: 'x',
    tokenUri: 'https://oauth2.googleapis.com/token',
    projectId: 'oriole-test',
  });
  getFormMetadataMock.mockReset();
  syncFormResponsesToContactsMock.mockReset();
  listGoogleCalendarsMock.mockReset();
  getGoogleCalendarMock.mockReset();
  syncBookingsToCalendarMock.mockReset();
  sendTestWebhookMock.mockReset();
  deliverSlackMessageMock.mockReset();
  sendTestSlackMock.mockReset();
  buildSlackMessageMock.mockImplementation((event: string) => ({ text: event, blocks: [] }));
});

describe('POST /api/integrations/forms/preview', () => {
  it('kredensial valid → metadata form + pertanyaan (tanpa kebocoran JSON key)', async () => {
    getFormMetadataMock.mockResolvedValue(FORM_METADATA);
    const res = await app.request('/api/integrations/forms/preview', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceAccountJson: SERVICE_ACCOUNT_JSON, formId: 'form-abc' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { form: { title: string }; serviceAccountEmail: string };
    expect(body.form.title).toBe('Lead Form');
    expect(body.serviceAccountEmail).toBe('sa@oriole-test.iam.gserviceaccount.com');
    expect(JSON.stringify(body)).not.toContain('private_key');
  });

  it('Google menolak (403) → status Google dipetakan', async () => {
    getFormMetadataMock.mockRejectedValue(new GoogleApiErrorMock('Access denied', 403));
    const res = await app.request('/api/integrations/forms/preview', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceAccountJson: SERVICE_ACCOUNT_JSON, formId: 'form-abc' }),
    });
    expect(res.status).toBe(403);
  });

  it('kredensial tidak valid → 400', async () => {
    parseServiceAccountMock.mockImplementation(() => {
      throw new GoogleApiErrorMock('Kredensial service account tidak valid.', 400);
    });
    const res = await app.request('/api/integrations/forms/preview', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceAccountJson: 'x', formId: 'form-abc' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/integrations/forms/connect', () => {
  it('sukses → 201, tersimpan, kredensial tidak bocor', async () => {
    getFormMetadataMock.mockResolvedValue(FORM_METADATA);
    const res = await app.request('/api/integrations/forms/connect', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceAccountJson: SERVICE_ACCOUNT_JSON, formId: 'form-abc' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      integration: { integrationType: string; config: { formId: string; formName: string } };
    };
    expect(body.integration).toMatchObject({
      integrationType: 'google-forms',
      config: { formId: 'form-abc', formName: 'Lead Form' },
    });
    expect(JSON.stringify(body)).not.toContain('private_key');

    const rows = dbState.tables.get('workspaceIntegrations') ?? [];
    expect(rows).toHaveLength(1);
    expect((rows[0].providerConfig as { serviceAccountJson: string }).serviceAccountJson).toBe(
      SERVICE_ACCOUNT_JSON,
    );
  });

  it('form tidak bisa diakses → 403, tidak menyimpan apa pun', async () => {
    getFormMetadataMock.mockRejectedValue(new GoogleApiErrorMock('Form not found', 404));
    const res = await app.request('/api/integrations/forms/connect', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceAccountJson: SERVICE_ACCOUNT_JSON, formId: 'form-xyz' }),
    });
    // 404 dari Google → 400 (form tidak ditemukan di akun ini).
    expect(res.status).toBe(400);
    expect(dbState.tables.get('workspaceIntegrations')).toHaveLength(0);
  });
});

describe('POST /api/integrations/forms/sync', () => {
  it('sukses → jumlah imported/skipped', async () => {
    syncFormResponsesToContactsMock.mockResolvedValue({ imported: 2, skipped: 1, total: 3 });
    const res = await app.request('/api/integrations/forms/sync', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { imported: number; skipped: number; total: number };
    expect(body).toMatchObject({ imported: 2, skipped: 1, total: 3 });
  });

  it('belum terhubung → 409', async () => {
    syncFormResponsesToContactsMock.mockRejectedValue(new GoogleApiErrorMock('Belum terhubung', 409));
    const res = await app.request('/api/integrations/forms/sync', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(409);
  });
});

describe('POST /api/integrations/forms/send', () => {
  const SEND_BODY = {
    integrationType: 'google-forms',
    contactId: '550e8400-e29b-41d4-a716-446655440000',
    channel: 'whatsapp',
  };

  const formsIntegration = () =>
    baseIntegration({
      integrationType: 'google-forms',
      identifier: 'Lead Form',
      providerConfig: { formId: 'form-abc', formName: 'Lead Form' },
    });

  it('tanpa auth → 401', async () => {
    const res = await app.request('/api/integrations/forms/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SEND_BODY),
    });
    expect(res.status).toBe(401);
  });

  it('body tidak valid → 400 (channel asing / contactId bukan UUID)', async () => {
    const badChannel = await app.request('/api/integrations/forms/send', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...SEND_BODY, channel: 'sms' }),
    });
    expect(badChannel.status).toBe(400);

    const badContact = await app.request('/api/integrations/forms/send', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...SEND_BODY, contactId: 'not-a-uuid' }),
    });
    expect(badContact.status).toBe(400);
  });

  it('form belum terhubung → 404', async () => {
    const res = await app.request('/api/integrations/forms/send', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify(SEND_BODY),
    });
    expect(res.status).toBe(404);
    expect(dispatchFormInvitationMock).not.toHaveBeenCalled();
  });

  it('integrasi dijeda → 409', async () => {
    dbState.tables.set('workspaceIntegrations', [
      baseIntegration({
        integrationType: 'google-forms',
        isActive: false,
        providerConfig: { formId: 'form-abc' },
      }),
    ]);
    const res = await app.request('/api/integrations/forms/send', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify(SEND_BODY),
    });
    expect(res.status).toBe(409);
    expect(dispatchFormInvitationMock).not.toHaveBeenCalled();
  });

  it('sukses → 201 dengan formUrl & channel', async () => {
    dbState.tables.set('workspaceIntegrations', [formsIntegration()]);
    dispatchFormInvitationMock.mockResolvedValue({
      sent: true,
      channel: 'email',
      formUrl: 'https://docs.google.com/forms/d/e/form-abc/viewform',
    });
    const res = await app.request('/api/integrations/forms/send', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...SEND_BODY, channel: 'email' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { sent: boolean; channel: string; formUrl: string };
    expect(body).toMatchObject({ sent: true, channel: 'email' });
    expect(body.formUrl).toContain('docs.google.com');
    expect(dispatchFormInvitationMock).toHaveBeenCalledWith(
      expect.objectContaining({ formId: 'form-abc', formName: 'Lead Form', contactId: SEND_BODY.contactId }),
    );
  });

  it('customer belum terhubung → status dari FormSendError (409)', async () => {
    dbState.tables.set('workspaceIntegrations', [formsIntegration()]);
    dispatchFormInvitationMock.mockRejectedValue(
      new FormSendErrorMock('Customer belum terhubung ke WhatsApp', 409),
    );
    const res = await app.request('/api/integrations/forms/send', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify(SEND_BODY),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('Customer belum terhubung');
  });
});

describe('PATCH/DELETE /api/integrations/forms', () => {
  it('PATCH mengubah isActive', async () => {
    dbState.tables.set('workspaceIntegrations', [
      baseIntegration({
        integrationType: 'google-forms',
        identifier: 'Lead Form',
        providerConfig: { formId: 'form-abc', formName: 'Lead Form' },
      }),
    ]);
    const res = await app.request('/api/integrations/forms', {
      method: 'PATCH',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: false }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { integration: { isActive: boolean } }).integration.isActive).toBe(false);
  });

  it('DELETE menghapus integrasi', async () => {
    dbState.tables.set('workspaceIntegrations', [
      baseIntegration({ integrationType: 'google-forms', providerConfig: { formId: 'form-abc' } }),
    ]);
    const res = await app.request('/api/integrations/forms', {
      method: 'DELETE',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(200);
    expect(dbState.tables.get('workspaceIntegrations')).toHaveLength(0);
  });

  it('DELETE belum terhubung → 404', async () => {
    const res = await app.request('/api/integrations/forms', {
      method: 'DELETE',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(404);
  });
});

// ── Google Calendar ────────────────────────────────────────────
describe('POST /api/integrations/calendar/calendars', () => {
  it('service account valid → daftar kalender', async () => {
    listGoogleCalendarsMock.mockResolvedValue([
      { id: 'primary', summary: 'My Calendar', primary: true, accessRole: 'owner' },
    ]);
    const res = await app.request('/api/integrations/calendar/calendars', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceAccountJson: SERVICE_ACCOUNT_JSON }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { calendars: { id: string }[]; serviceAccountEmail: string };
    expect(body.calendars).toHaveLength(1);
    expect(body.serviceAccountEmail).toBe('sa@oriole-test.iam.gserviceaccount.com');
    expect(JSON.stringify(body)).not.toContain('private_key');
  });

  it('kredensial ditolak → 401', async () => {
    listGoogleCalendarsMock.mockRejectedValue(new GoogleApiErrorMock('Unauthorized', 401));
    const res = await app.request('/api/integrations/calendar/calendars', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceAccountJson: SERVICE_ACCOUNT_JSON }),
    });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/integrations/calendar/connect', () => {
  it('sukses → 201, eventIds kosong, kredensial tidak bocor', async () => {
    getGoogleCalendarMock.mockResolvedValue({ id: 'primary', summary: 'My Calendar' });
    const res = await app.request('/api/integrations/calendar/connect', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceAccountJson: SERVICE_ACCOUNT_JSON, calendarId: 'primary' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      integration: { integrationType: string; config: { calendarId: string; calendarName: string } };
    };
    expect(body.integration).toMatchObject({
      integrationType: 'google-calendar',
      config: { calendarId: 'primary', calendarName: 'My Calendar' },
    });
    expect(JSON.stringify(body)).not.toContain('private_key');

    const rows = dbState.tables.get('workspaceIntegrations') ?? [];
    expect((rows[0].providerConfig as { eventIds: Record<string, string> }).eventIds).toEqual({});
  });
});

describe('POST /api/integrations/calendar/sync', () => {
  it('sukses → jumlah created/updated/skipped', async () => {
    syncBookingsToCalendarMock.mockResolvedValue({ created: 1, updated: 2, skipped: 0 });
    const res = await app.request('/api/integrations/calendar/sync', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ created: 1, updated: 2, skipped: 0 });
  });

  it('belum terhubung → 409', async () => {
    syncBookingsToCalendarMock.mockRejectedValue(new GoogleApiErrorMock('Belum terhubung', 409));
    const res = await app.request('/api/integrations/calendar/sync', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(409);
  });
});

describe('PATCH/DELETE /api/integrations/calendar', () => {
  it('PATCH mengubah isActive', async () => {
    dbState.tables.set('workspaceIntegrations', [
      baseIntegration({ integrationType: 'google-calendar', providerConfig: { calendarId: 'primary' } }),
    ]);
    const res = await app.request('/api/integrations/calendar', {
      method: 'PATCH',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: false }),
    });
    expect(res.status).toBe(200);
  });

  it('DELETE belum terhubung → 404', async () => {
    const res = await app.request('/api/integrations/calendar', {
      method: 'DELETE',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(404);
  });
});

// ── Outgoing webhook ───────────────────────────────────────────
describe('POST /api/integrations/webhook/connect', () => {
  it('sukses → 201, url tersimpan, secret tidak bocor', async () => {
    const res = await app.request('/api/integrations/webhook/connect', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/hook', secret: 'super-secret-123' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      integration: { integrationType: string; config: { url: string; hasSecret: boolean } };
    };
    expect(body.integration).toMatchObject({
      integrationType: 'webhook',
      config: { url: 'https://example.com/hook', hasSecret: true },
    });
    expect(JSON.stringify(body)).not.toContain('super-secret-123');

    const rows = dbState.tables.get('workspaceIntegrations') ?? [];
    expect((rows[0].providerConfig as { secret: string }).secret).toBe('super-secret-123');
  });

  it('tanpa secret → hasSecret false', async () => {
    const res = await app.request('/api/integrations/webhook/connect', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/hook' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { integration: { config: { hasSecret: boolean } } };
    expect(body.integration.config.hasSecret).toBe(false);
  });

  it('URL tidak valid / secret terlalu pendek → 400', async () => {
    const badUrl = await app.request('/api/integrations/webhook/connect', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'not-a-url' }),
    });
    expect(badUrl.status).toBe(400);

    const shortSecret = await app.request('/api/integrations/webhook/connect', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/hook', secret: 'short' }),
    });
    expect(shortSecret.status).toBe(400);
  });

  it('re-connect menggantikan konfigurasi lama (upsert)', async () => {
    dbState.tables.set('workspaceIntegrations', [
      baseIntegration({
        integrationType: 'webhook',
        providerConfig: { url: 'https://old.example.com/hook', secret: 'old-secret-abc' },
      }),
    ]);
    const res = await app.request('/api/integrations/webhook/connect', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://new.example.com/hook', secret: 'new-secret-abc' }),
    });
    expect(res.status).toBe(201);
    const rows = dbState.tables.get('workspaceIntegrations') ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0].providerConfig).toMatchObject({ url: 'https://new.example.com/hook' });
  });
});

describe('POST /api/integrations/webhook/test', () => {
  it('terkirim → 200 dengan status', async () => {
    sendTestWebhookMock.mockResolvedValue({ delivered: true, status: 200 });
    const res = await app.request('/api/integrations/webhook/test', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { delivered: boolean; status: number };
    expect(body).toMatchObject({ delivered: true, status: 200 });
  });

  it('belum terhubung → 409', async () => {
    sendTestWebhookMock.mockRejectedValue(new WebhookDeliveryErrorMock('Belum terhubung', 409));
    const res = await app.request('/api/integrations/webhook/test', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(409);
  });

  it('penerima error (non-2xx) → 502', async () => {
    sendTestWebhookMock.mockRejectedValue(new WebhookDeliveryErrorMock('Penerima menjawab 500', 500));
    const res = await app.request('/api/integrations/webhook/test', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(502);
  });
});

// ── Slack ───────────────────────────────────────────────────────
describe('POST /api/integrations/slack/connect', () => {
  it('sukses → 201, URL tersimpan, URL webhook tidak bocor (hanya host)', async () => {
    deliverSlackMessageMock.mockResolvedValue({ ok: true, status: 200 });
    const res = await app.request('/api/integrations/slack/connect', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        webhookUrl: 'https://hooks.slack.com/services/T00000000/B00000000/XXXXXX',
        channel: '#general',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      integration: {
        integrationType: string;
        identifier: string | null;
        config: { webhookUrlHost: string | null; channel: string | null };
      };
    };
    expect(body.integration).toMatchObject({
      integrationType: 'slack',
      identifier: '#general',
      config: { webhookUrlHost: 'hooks.slack.com', channel: '#general' },
    });
    expect(JSON.stringify(body)).not.toContain('XXXXXX');
    expect(deliverSlackMessageMock).toHaveBeenCalledWith(
      'https://hooks.slack.com/services/T00000000/B00000000/XXXXXX',
      expect.any(Object),
    );

    const rows = dbState.tables.get('workspaceIntegrations') ?? [];
    expect(rows).toHaveLength(1);
    expect((rows[0].providerConfig as { webhookUrl: string }).webhookUrl).toBe(
      'https://hooks.slack.com/services/T00000000/B00000000/XXXXXX',
    );
  });

  it('URL bukan Slack Incoming Webhook → 400 tanpa panggilan Slack', async () => {
    const res = await app.request('/api/integrations/slack/connect', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhookUrl: 'https://example.com/hook' }),
    });
    expect(res.status).toBe(400);
    expect(deliverSlackMessageMock).not.toHaveBeenCalled();
    expect(dbState.tables.get('workspaceIntegrations')).toHaveLength(0);
  });

  it('ping uji ditolak Slack → 502, tidak menyimpan apa pun', async () => {
    deliverSlackMessageMock.mockRejectedValue(
      new SlackDeliveryErrorMock('Slack menolak: invalid_payload', 400),
    );
    const res = await app.request('/api/integrations/slack/connect', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhookUrl: 'https://hooks.slack.com/services/T/B/X' }),
    });
    expect(res.status).toBe(502);
    expect(dbState.tables.get('workspaceIntegrations')).toHaveLength(0);
  });
});

describe('POST /api/integrations/slack/test', () => {
  it('terkirim → 200 dengan status', async () => {
    sendTestSlackMock.mockResolvedValue({ delivered: true, status: 200 });
    const res = await app.request('/api/integrations/slack/test', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ delivered: true, status: 200 });
  });

  it('belum terhubung → 409', async () => {
    sendTestSlackMock.mockRejectedValue(new SlackDeliveryErrorMock('Belum terhubung', 409));
    const res = await app.request('/api/integrations/slack/test', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(409);
  });

  it('pengiriman gagal (non-2xx) → 502', async () => {
    sendTestSlackMock.mockRejectedValue(new SlackDeliveryErrorMock('Slack menjawab 500', 500));
    const res = await app.request('/api/integrations/slack/test', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(502);
  });
});

describe('PATCH/DELETE /api/integrations/slack', () => {
  it('PATCH mengubah isActive', async () => {
    dbState.tables.set('workspaceIntegrations', [
      baseIntegration({
        integrationType: 'slack',
        providerConfig: { webhookUrl: 'https://hooks.slack.com/services/T/B/X' },
      }),
    ]);
    const res = await app.request('/api/integrations/slack', {
      method: 'PATCH',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: false }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { integration: { isActive: boolean } }).integration.isActive).toBe(false);
  });

  it('DELETE menghapus & belum terhubung → 404', async () => {
    dbState.tables.set('workspaceIntegrations', [
      baseIntegration({
        integrationType: 'slack',
        providerConfig: { webhookUrl: 'https://hooks.slack.com/services/T/B/X' },
      }),
    ]);
    const ok = await app.request('/api/integrations/slack', {
      method: 'DELETE',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(ok.status).toBe(200);
    expect(dbState.tables.get('workspaceIntegrations')).toHaveLength(0);

    const missing = await app.request('/api/integrations/slack', {
      method: 'DELETE',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(missing.status).toBe(404);
  });
});

describe('PATCH/DELETE /api/integrations/webhook', () => {
  it('PATCH mengubah isActive', async () => {
    dbState.tables.set('workspaceIntegrations', [
      baseIntegration({ integrationType: 'webhook', providerConfig: { url: 'https://example.com/hook' } }),
    ]);
    const res = await app.request('/api/integrations/webhook', {
      method: 'PATCH',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: false }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { integration: { isActive: boolean } }).integration.isActive).toBe(false);
  });

  it('DELETE menghapus & belum terhubung → 404', async () => {
    dbState.tables.set('workspaceIntegrations', [
      baseIntegration({ integrationType: 'webhook', providerConfig: { url: 'https://example.com/hook' } }),
    ]);
    const ok = await app.request('/api/integrations/webhook', {
      method: 'DELETE',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(ok.status).toBe(200);
    expect(dbState.tables.get('workspaceIntegrations')).toHaveLength(0);

    const missing = await app.request('/api/integrations/webhook', {
      method: 'DELETE',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(missing.status).toBe(404);
  });
});

describe('POST /api/integrations/tally/connect — checklist updateContent', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('updateContent=true → PATCH /forms/:id menimpa blocks + formName = Booking <bisnis>', async () => {
    dbState.tables.set('workspaces', [
      { id: 'ws-1', userId: 'test-user-1', name: 'Klinik Sehat', industry: 'dental' },
    ]);
    dbState.tables.set('workspaceIntegrations', []);
    // getTallyForm (GET) + updateTallyBookingForm (PATCH) + registerWebhook (POST)
    // — semua dijawab oleh stub yang sama.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'xyz123', name: 'Survey' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.request('/api/integrations/tally/connect', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'tly_test_1234567890', formId: 'xyz123', updateContent: true }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      integration: { identifier: string | null; config: { formName: string | null } };
    };
    expect(body.integration.identifier).toBe('Booking Klinik Sehat');
    expect(body.integration.config.formName).toBe('Booking Klinik Sehat');
    // API key tidak pernah bocor ke respons.
    expect(JSON.stringify(body)).not.toContain('tly_test_1234567890');

    // Urutan panggilan: GET /forms/:id → PATCH /forms/:id → POST /webhooks.
    expect(fetchMock.mock.calls).toHaveLength(3);
    const [getUrl] = fetchMock.mock.calls[0];
    expect(String(getUrl)).toBe('https://api.tally.so/forms/xyz123');
    const [patchUrl, patchInit] = fetchMock.mock.calls[1];
    expect(String(patchUrl)).toBe('https://api.tally.so/forms/xyz123');
    expect((patchInit as RequestInit).method).toBe('PATCH');
    const payload = JSON.parse(String((patchInit as RequestInit).body));
    expect(payload.status).toBe('PUBLISHED');
    // dental: 5 base + 1 tambahan + 1 catatan = 7 field → 1 judul + 7×2
    // block + 1 hidden field `phone` (prefill).
    expect(payload.blocks).toHaveLength(1 + 7 * 2 + 1);
    expect(payload.blocks.some((b: { type: string }) => b.type === 'HIDDEN_FIELDS')).toBe(true);
    expect(payload.blocks[0].payload).toMatchObject({ title: 'Booking Klinik Sehat' });
    const [webhookUrl, webhookInit] = fetchMock.mock.calls[2];
    expect(String(webhookUrl)).toBe('https://api.tally.so/webhooks');
    expect((webhookInit as RequestInit).method).toBe('POST');
  });

  it('updateContent=false (default) → tidak ada PATCH, formName tetap milik form', async () => {
    dbState.tables.set('workspaces', [
      { id: 'ws-1', userId: 'test-user-1', name: 'Klinik Sehat', industry: 'dental' },
    ]);
    dbState.tables.set('workspaceIntegrations', []);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'xyz123', name: 'Survey' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.request('/api/integrations/tally/connect', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'tly_test_1234567890', formId: 'xyz123' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      integration: { identifier: string | null; config: { formName: string | null } };
    };
    expect(body.integration.identifier).toBe('Survey');
    expect(body.integration.config.formName).toBe('Survey');

    // Hanya GET /forms/:id + POST /webhooks — tanpa PATCH.
    expect(fetchMock.mock.calls).toHaveLength(2);
    // GET tidak menyertakan method (default fetch) → undefined ≈ GET.
    const methods = fetchMock.mock.calls.map(([, init]) => (init as RequestInit | undefined)?.method ?? 'GET');
    expect(methods).toEqual(['GET', 'POST']);
  });

  it('updateContent=true tapi Tally menolak PATCH → 400, tidak ada webhook terdaftar', async () => {
    dbState.tables.set('workspaces', [
      { id: 'ws-1', userId: 'test-user-1', name: 'Klinik Sehat', industry: 'dental' },
    ]);
    dbState.tables.set('workspaceIntegrations', []);
    const fetchMock = vi
      .fn()
      // GET /forms/:id sukses (validasi form), lalu PATCH ditolak Tally.
      // PATCH dicoba dua kali: percobaan pertama dengan blok prefill phone
      // (fallback internal), kedua tanpa prefill — keduanya ditolak → 400.
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'xyz123', name: 'Survey' }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({ message: 'Forbidden' }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({ message: 'Forbidden' }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.request('/api/integrations/tally/connect', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'tly_test_1234567890', formId: 'xyz123', updateContent: true }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('Forbidden');
    // Connect gagal → integrasi tidak tersimpan, webhook tidak didaftarkan.
    expect(dbState.tables.get('workspaceIntegrations')).toHaveLength(0);
    // GET /forms/:id + PATCH prefill (ditolak) + PATCH fallback (ditolak).
    expect(fetchMock.mock.calls).toHaveLength(3);
  });
});

describe('POST /api/integrations/tally/update-content — sinkronkan konten form', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('layanan katalog → PATCH form dengan DROPDOWN_OPTION + flag serviceDropdown', async () => {
    dbState.tables.set('workspaces', [
      { id: 'ws-1', userId: 'test-user-1', name: 'Klinik Sehat', industry: 'dental' },
    ]);
    dbState.tables.set('workspaceIntegrations', [
      {
        id: 'int-tally-1',
        workspaceId: 'ws-1',
        integrationType: 'tally',
        identifier: 'Booking Klinik Sehat',
        providerConfig: {
          // Tanpa APP_ENCRYPTION_KEY, encrypt/decrypt = plaintext (compat).
          apiKey: 'tly_test_1234567890',
          webhookSecret: 'wh-secret',
          formId: 'xyz123',
          formName: 'Booking Klinik Sehat',
          phonePrefill: true,
          serviceDropdown: false,
        },
        isActive: true,
      },
    ]);
    // Katalog layanan workspace — menjadi opsi dropdown.
    dbState.tables.set('services', [
      { id: 'svc-1', workspaceId: 'ws-1', name: 'Scaling Gigi', isActive: true },
      { id: 'svc-2', workspaceId: 'ws-1', name: 'Bleaching', isActive: true },
    ]);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'xyz123', name: 'Booking Klinik Sehat' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.request('/api/integrations/tally/update-content', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      integration: {
        config: { serviceDropdown: boolean; prefillPhone: boolean; lastContentSyncAt?: string | null };
      };
    };
    expect(body.integration.config.serviceDropdown).toBe(true);
    expect(body.integration.config.prefillPhone).toBe(true);
    // Auto-sync guard: keberhasilan men-stamp lastContentSyncAt.
    expect(typeof body.integration.config.lastContentSyncAt).toBe('string');

    // PATCH /forms/:id berisi DROPDOWN_OPTION per layanan katalog.
    const [patchUrl, patchInit] = fetchMock.mock.calls[0];
    expect(String(patchUrl)).toBe('https://api.tally.so/forms/xyz123');
    expect((patchInit as RequestInit).method).toBe('PATCH');
    const payload = JSON.parse(String((patchInit as RequestInit).body));
    const options = payload.blocks.filter((b: { type: string }) => b.type === 'DROPDOWN_OPTION');
    expect(options.map((o: { payload: { text: string } }) => o.payload.text)).toEqual([
      'Scaling Gigi',
      'Bleaching',
    ]);
    expect(options[0].payload).toMatchObject({ index: 0, isFirst: true, isLast: false });
    expect(options[1].payload).toMatchObject({ index: 1, isFirst: false, isLast: true });
  });
});

describe('ensureTallyFormEnhanced — self-heal form saat tautan dikirim', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('prefill sudah aktif → no-op tanpa panggilan API', async () => {
    dbState.tables.set('workspaceIntegrations', [
      {
        id: 'int-tally-1',
        workspaceId: 'ws-1',
        integrationType: 'tally',
        identifier: 'Booking Klinik',
        providerConfig: {
          apiKey: 'tly_test_1',
          formId: 'xyz123',
          phonePrefill: true,
          serviceDropdown: true,
        },
        isActive: true,
      },
    ]);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await ensureTallyFormEnhanced('ws-1')).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('form belum enhanced → PATCH form + stamp flags (phonePrefill true)', async () => {
    dbState.tables.set('workspaceIntegrations', [
      {
        id: 'int-tally-1',
        workspaceId: 'ws-1',
        integrationType: 'tally',
        identifier: 'Booking Klinik',
        providerConfig: {
          apiKey: 'tly_test_1',
          formId: 'xyz123',
          phonePrefill: false,
          serviceDropdown: false,
        },
        isActive: true,
      },
    ]);
    dbState.tables.set('services', []);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'xyz123', name: 'Booking Klinik' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(await ensureTallyFormEnhanced('ws-1')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.tally.so/forms/xyz123');
    expect((init as RequestInit).method).toBe('PATCH');
    const payload = JSON.parse(String((init as RequestInit).body));
    // Token chat + prefill datang dari blok HIDDEN_FIELDS.
    expect(payload.blocks.some((b: { type: string }) => b.type === 'HIDDEN_FIELDS')).toBe(true);
    // Flags ter-stamp di providerConfig.
    const [updatedRow] = dbState.tables.get('workspaceIntegrations') ?? [];
    const updatedConfig = (updatedRow as { providerConfig: Record<string, unknown> }).providerConfig;
    expect(updatedConfig.phonePrefill).toBe(true);
    expect(updatedConfig.lastContentSyncError).toBeNull();
  });

  it('percobaan baru-baru ini (throttle 1 jam) → skip tanpa panggilan API', async () => {
    dbState.tables.set('workspaceIntegrations', [
      {
        id: 'int-tally-1',
        workspaceId: 'ws-1',
        integrationType: 'tally',
        identifier: 'Booking Klinik',
        providerConfig: {
          apiKey: 'tly_test_1',
          formId: 'xyz123',
          phonePrefill: false,
          contentSyncAttemptedAt: new Date().toISOString(),
        },
        isActive: true,
      },
    ]);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await ensureTallyFormEnhanced('ws-1')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/integrations — konfigurasi publik per tipe', () => {
  it('google-forms → formUrl publik (deterministik dari formId)', async () => {
    dbState.tables.set('workspaceIntegrations', [
      baseIntegration({
        integrationType: 'google-forms',
        providerConfig: { formId: 'form-abc', formName: 'Lead Form' },
      }),
    ]);
    const res = await app.request('/api/integrations', {
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      integrations: { integrationType: string; config: { formUrl: string | null } }[];
    };
    expect(body.integrations[0].config.formUrl).toBe(
      'https://docs.google.com/forms/d/e/form-abc/viewform',
    );
  });

  it('tally → formUrl publik (deterministik dari formId)', async () => {
    dbState.tables.set('workspaceIntegrations', [
      baseIntegration({
        integrationType: 'tally',
        providerConfig: { formId: 'xyz123', formName: 'Survey' },
      }),
    ]);
    const res = await app.request('/api/integrations', {
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      integrations: { integrationType: string; config: { formUrl: string | null } }[];
    };
    expect(body.integrations[0].config.formUrl).toBe('https://tally.so/r/xyz123');
  });

  it('webhook terhubung → url + hasSecret, tanpa nilai secret', async () => {
    dbState.tables.set('workspaceIntegrations', [
      baseIntegration({
        integrationType: 'webhook',
        providerConfig: { url: 'https://example.com/hook', secret: 'top-secret-value' },
      }),
    ]);
    const res = await app.request('/api/integrations', {
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { integrations: { integrationType: string; config: { url: string; hasSecret: boolean } }[] };
    expect(body.integrations[0]).toMatchObject({
      integrationType: 'webhook',
      config: { url: 'https://example.com/hook', hasSecret: true },
    });
    expect(JSON.stringify(body)).not.toContain('top-secret-value');
  });

  it('slack terhubung → hanya host + channel, URL webhook tidak bocor', async () => {
    dbState.tables.set('workspaceIntegrations', [
      baseIntegration({
        integrationType: 'slack',
        providerConfig: {
          webhookUrl: 'https://hooks.slack.com/services/T00000000/B00000000/XXXXXX',
          channel: '#general',
        },
      }),
    ]);
    const res = await app.request('/api/integrations', {
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      integrations: { integrationType: string; config: { webhookUrlHost: string | null; channel: string | null } }[];
    };
    expect(body.integrations[0]).toMatchObject({
      integrationType: 'slack',
      config: { webhookUrlHost: 'hooks.slack.com', channel: '#general' },
    });
    expect(JSON.stringify(body)).not.toContain('XXXXXX');
  });
});

describe('Voice AI (Vapi) — GET /api/integrations/vapi', () => {
  it('menampilkan kesiapan server, daftar nomor, dan pilihan workspace', async () => {
    const res = await app.request('/api/integrations/vapi', {
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      configured: boolean;
      apiKeyConfigured: boolean;
      defaultPhoneNumberId: string | null;
      numbers: { id: string; number: string | null }[];
      selected: unknown;
    };
    expect(body).toMatchObject({
      configured: true,
      apiKeyConfigured: true,
      defaultPhoneNumberId: 'vapi-default-1',
      numbers: [
        { id: 'vapi-telnyx-1', number: '+628211111111' },
        { id: 'vapi-default-1', number: '+15550000000' },
      ],
      selected: null,
    });
  });

  it('menampilkan pilihan workspace bila ada', async () => {
    dbState.tables.set('workspaceIntegrations', [
      baseIntegration({
        integrationType: 'vapi',
        identifier: '+628211111111',
        providerConfig: { vapiPhoneNumberId: 'vapi-telnyx-1', phoneNumber: '+628211111111' },
      }),
    ]);
    const res = await app.request('/api/integrations/vapi', {
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    const body = (await res.json()) as {
      selected: {
        integrationType: string;
        identifier: string | null;
        config: { vapiPhoneNumberId: string | null; phoneNumber: string | null };
      };
    };
    expect(body.selected).toMatchObject({
      integrationType: 'vapi',
      identifier: '+628211111111',
      config: { vapiPhoneNumberId: 'vapi-telnyx-1', phoneNumber: '+628211111111' },
    });
  });

  it('gagal list nomor Vapi → error field terisi, response tetap 200', async () => {
    listOperatorVapiPhoneNumbersMock.mockRejectedValue(new Error('Vapi down'));
    const res = await app.request('/api/integrations/vapi', {
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error: string | null; numbers: unknown[] };
    expect(body.error).toContain('Vapi down');
    expect(body.numbers).toEqual([]);
  });
});

describe('Voice AI (Vapi) — POST /api/integrations/vapi/connect', () => {
  it('nomor valid → integrasi tersimpan (tanpa kredensial bocor)', async () => {
    const res = await app.request('/api/integrations/vapi/connect', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ vapiPhoneNumberId: 'vapi-telnyx-1' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      integration: { integrationType: string; identifier: string | null };
    };
    expect(body.integration).toMatchObject({
      integrationType: 'vapi',
      identifier: '+628211111111',
    });
    const rows = dbState.tables.get('workspaceIntegrations') ?? [];
    expect(rows).toHaveLength(1);
    expect((rows[0] as { providerConfig: Record<string, unknown> }).providerConfig).toEqual({
      vapiPhoneNumberId: 'vapi-telnyx-1',
      phoneNumber: '+628211111111',
    });
    expect(JSON.stringify(body)).not.toContain('vapi_test_key');
  });

  it('nomor tidak ada di akun Vapi → 400', async () => {
    const res = await app.request('/api/integrations/vapi/connect', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ vapiPhoneNumberId: 'vapi-nonexistent' }),
    });
    expect(res.status).toBe(400);
  });

  it('VAPI_API_KEY belum dikonfigurasi → 503', async () => {
    const envModule = (await import('../lib/env.ts')) as { env: Record<string, unknown> };
    const original = envModule.env.VAPI_API_KEY;
    envModule.env.VAPI_API_KEY = undefined;
    try {
      const res = await app.request('/api/integrations/vapi/connect', {
        method: 'POST',
        headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
        body: JSON.stringify({ vapiPhoneNumberId: 'vapi-telnyx-1' }),
      });
      expect(res.status).toBe(503);
    } finally {
      envModule.env.VAPI_API_KEY = original;
    }
  });
});

describe('Voice AI (Vapi) — DELETE /api/integrations/vapi', () => {
  it('menghapus pilihan → kembali ke default server', async () => {
    dbState.tables.set('workspaceIntegrations', [
      baseIntegration({
        integrationType: 'vapi',
        providerConfig: { vapiPhoneNumberId: 'vapi-telnyx-1', phoneNumber: '+628211111111' },
      }),
    ]);
    const res = await app.request('/api/integrations/vapi', {
      method: 'DELETE',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(200);
    expect(dbState.tables.get('workspaceIntegrations')).toHaveLength(0);
  });

  it('belum terhubung → 404', async () => {
    const res = await app.request('/api/integrations/vapi', {
      method: 'DELETE',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(404);
  });
});

describe('Voice AI BYOC — POST /api/integrations/vapi/byoc/search', () => {
  it('key valid → owned + available dari akun Telnyx workspace (key tidak bocor)', async () => {
    searchTelnyxByocMock.mockResolvedValue({
      owned: [{ id: 'tn-1', phoneNumber: '+628211111111' }],
      available: [{ phoneNumber: '+6282199999999', locality: 'Jakarta' }],
    });
    const res = await app.request('/api/integrations/vapi/byoc/search', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'telnyx_key_123456', countryCode: 'ID', areaCode: '21' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { owned: unknown[]; available: unknown[] };
    expect(body.owned).toHaveLength(1);
    expect(body.available).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain('telnyx_key_123456');
    expect(searchTelnyxByocMock).toHaveBeenCalledWith(
      expect.objectContaining({ countryCode: 'ID', areaCode: '21' }),
    );
  });

  it('API key Telnyx ditolak → 401', async () => {
    searchTelnyxByocMock.mockRejectedValue(new TelnyxApiError(401, 'Invalid API key'));
    const res = await app.request('/api/integrations/vapi/byoc/search', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'telnyx_key_123456', countryCode: 'ID' }),
    });
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toContain('telnyx_key_123456');
  });

  it('error lain dari Telnyx → 502', async () => {
    searchTelnyxByocMock.mockRejectedValue(new TelnyxApiError(500, 'boom'));
    const res = await app.request('/api/integrations/vapi/byoc/search', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'telnyx_key_123456', countryCode: 'ID' }),
    });
    expect(res.status).toBe(502);
  });

  it('country code bukan 2 huruf → 400 tanpa panggilan', async () => {
    const res = await app.request('/api/integrations/vapi/byoc/search', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'telnyx_key_123456', countryCode: 'IND' }),
    });
    expect(res.status).toBe(400);
    expect(searchTelnyxByocMock).not.toHaveBeenCalled();
  });

  it('VAPI_API_KEY belum dikonfigurasi → 503', async () => {
    const envModule = (await import('../lib/env.ts')) as { env: Record<string, unknown> };
    const original = envModule.env.VAPI_API_KEY;
    envModule.env.VAPI_API_KEY = undefined;
    try {
      const res = await app.request('/api/integrations/vapi/byoc/search', {
        method: 'POST',
        headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: 'telnyx_key_123456', countryCode: 'ID' }),
      });
      expect(res.status).toBe(503);
      expect(searchTelnyxByocMock).not.toHaveBeenCalled();
    } finally {
      envModule.env.VAPI_API_KEY = original;
    }
  });
});

describe('Voice AI BYOC — POST /api/integrations/vapi/byoc/connect', () => {
  const BYOC_BODY = { apiKey: 'telnyx_key_123456', phoneNumber: '+6282199999999' };
  const CONNECT_RESULT = {
    vapiCredentialId: 'cred-byoc-1',
    vapiPhoneNumberId: 'pn-byoc-1',
    telnyxNumber: '+6282199999999',
    purchased: true,
    registered: true,
  };

  it('sukses → 201, row mode byoc tersimpan, API key & credential id tidak keluar', async () => {
    connectTelnyxByocMock.mockResolvedValue(CONNECT_RESULT);
    const res = await app.request('/api/integrations/vapi/byoc/connect', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify(BYOC_BODY),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      integration: {
        integrationType: string;
        identifier: string | null;
        config: { mode: string; vapiPhoneNumberId: string | null; phoneNumber: string | null };
      };
      purchased: boolean;
      registered: boolean;
    };
    expect(body).toMatchObject({
      integration: {
        integrationType: 'vapi',
        identifier: '+6282199999999',
        config: { mode: 'byoc', vapiPhoneNumberId: 'pn-byoc-1', phoneNumber: '+6282199999999' },
      },
      purchased: true,
      registered: true,
    });
    // Secret & referensi internal TIDAK pernah keluar ke klien.
    expect(JSON.stringify(body)).not.toContain('telnyx_key_123456');
    expect(JSON.stringify(body)).not.toContain('cred-byoc-1');

    const rows = dbState.tables.get('workspaceIntegrations') ?? [];
    expect(rows).toHaveLength(1);
    const stored = (rows[0] as { providerConfig: Record<string, unknown> }).providerConfig;
    expect(stored).toEqual({
      mode: 'byoc',
      vapiPhoneNumberId: 'pn-byoc-1',
      vapiCredentialId: 'cred-byoc-1',
      phoneNumber: '+6282199999999',
    });
    // API key Telnyx TIDAK pernah disimpan di DB.
    expect(JSON.stringify(stored)).not.toContain('telnyx_key_123456');
  });

  it('row sudah ada → credential lama di-reuse (idempotensi retry)', async () => {
    dbState.tables.set('workspaceIntegrations', [
      baseIntegration({
        integrationType: 'vapi',
        identifier: '+628211111111',
        providerConfig: {
          mode: 'byoc',
          vapiPhoneNumberId: 'pn-byoc-0',
          vapiCredentialId: 'cred-old-1',
          phoneNumber: '+628211111111',
        },
      }),
    ]);
    connectTelnyxByocMock.mockResolvedValue(CONNECT_RESULT);
    const res = await app.request('/api/integrations/vapi/byoc/connect', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify(BYOC_BODY),
    });
    expect(res.status).toBe(201);
    expect(connectTelnyxByocMock).toHaveBeenCalledWith(
      expect.objectContaining({ existingCredentialId: 'cred-old-1' }),
    );
  });

  it('tanpa row → existingCredentialId null + nama deterministik per workspace', async () => {
    connectTelnyxByocMock.mockResolvedValue(CONNECT_RESULT);
    await app.request('/api/integrations/vapi/byoc/connect', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify(BYOC_BODY),
    });
    expect(connectTelnyxByocMock).toHaveBeenCalledWith(
      expect.objectContaining({ existingCredentialId: null, credentialName: 'oriole-byoc-ws-1' }),
    );
  });

  it('API key Telnyx ditolak → 401, tidak menyimpan apa pun', async () => {
    connectTelnyxByocMock.mockRejectedValue(new TelnyxApiError(401, 'Invalid API key'));
    const res = await app.request('/api/integrations/vapi/byoc/connect', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify(BYOC_BODY),
    });
    expect(res.status).toBe(401);
    expect(dbState.tables.get('workspaceIntegrations')).toHaveLength(0);
  });

  it('nomor tidak tersedia dibeli → 400, tidak menyimpan apa pun', async () => {
    connectTelnyxByocMock.mockRejectedValue(
      new TelnyxByocNumberUnavailableErrorMock('+6282199999999'),
    );
    const res = await app.request('/api/integrations/vapi/byoc/connect', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify(BYOC_BODY),
    });
    expect(res.status).toBe(400);
    expect(dbState.tables.get('workspaceIntegrations')).toHaveLength(0);
  });

  it('Vapi menolak kredensial → 502, tidak menyimpan apa pun', async () => {
    connectTelnyxByocMock.mockRejectedValue(new VapiCredentialApiError(400, 'bad payload'));
    const res = await app.request('/api/integrations/vapi/byoc/connect', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify(BYOC_BODY),
    });
    expect(res.status).toBe(502);
    expect(dbState.tables.get('workspaceIntegrations')).toHaveLength(0);
  });

  it('phone number tidak valid → 400 sebelum panggilan', async () => {
    const res = await app.request('/api/integrations/vapi/byoc/connect', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'telnyx_key_123456', phoneNumber: 'abc' }),
    });
    expect(res.status).toBe(400);
    expect(connectTelnyxByocMock).not.toHaveBeenCalled();
  });
});

describe('Voice AI inbound — GET /api/integrations/vapi/inbound', () => {
  it('mengembalikan daftar nomor + configured', async () => {
    listInboundNumbersMock.mockResolvedValue([
      {
        id: 'inb-1',
        vapiPhoneNumberId: 'vapi-number-1',
        number: '+14155550123',
        name: 'Main line',
        provider: 'vapi',
        isActive: true,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const res = await app.request('/api/integrations/vapi/inbound', {
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.configured).toBe(true);
    expect(body.numbers).toHaveLength(1);
    expect(listInboundNumbersMock).toHaveBeenCalledWith('ws-1');
  });
});

describe('Voice AI inbound — POST /api/integrations/vapi/inbound/register', () => {
  it('berhasil → 201 + nomor baru', async () => {
    registerInboundNumberForWorkspaceMock.mockResolvedValue({
      id: 'inb-2',
      vapiPhoneNumberId: 'vapi-number-2',
      number: null,
      name: 'Cabang',
      provider: 'vapi',
      isActive: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const res = await app.request('/api/integrations/vapi/inbound/register', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Cabang', areaCode: '21' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.number.vapiPhoneNumberId).toBe('vapi-number-2');
    expect(registerInboundNumberForWorkspaceMock).toHaveBeenCalledWith({
      userId: 'test-user-1',
      workspaceId: 'ws-1',
      name: 'Cabang',
      areaCode: '21',
    });
  });

  it('area code tidak valid → 400 tanpa memanggil Vapi', async () => {
    const res = await app.request('/api/integrations/vapi/inbound/register', {
      method: 'POST',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ areaCode: 'abc!' }),
    });
    expect(res.status).toBe(400);
    expect(registerInboundNumberForWorkspaceMock).not.toHaveBeenCalled();
  });
});

describe('Voice AI inbound — DELETE /api/integrations/vapi/inbound/:id', () => {
  it('berhasil → ok:true + panggil unregister', async () => {
    unregisterInboundNumberForWorkspaceMock.mockResolvedValue(undefined);
    const res = await app.request('/api/integrations/vapi/inbound/inb-1', {
      method: 'DELETE',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(unregisterInboundNumberForWorkspaceMock).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      inboundNumberId: 'inb-1',
    });
  });

  it('nomor tidak ditemukan → 404', async () => {
    unregisterInboundNumberForWorkspaceMock.mockRejectedValue(
      new InboundNumberNotFoundErrorMock('Nomor inbound tidak ditemukan di workspace ini.'),
    );
    const res = await app.request('/api/integrations/vapi/inbound/inb-999', {
      method: 'DELETE',
      headers: { ...AUTH_HEADER, ...WORKSPACE_HEADER },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('tidak ditemukan') });
  });
});
