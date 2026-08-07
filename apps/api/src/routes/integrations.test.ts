import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

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
  },
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

// ── Fake Drizzle db ─────────────────────────────────────────────
const { dbState } = vi.hoisted(() => ({
  dbState: {
    tables: new Map<string, Record<string, unknown>[]>(),
    seq: 1,
  },
}));

vi.mock('../db/index.ts', async () => {
  const { workspaces, workspaceIntegrations } = await import('@oriole/database');
  const tableNames = new WeakMap<object, string>();
  tableNames.set(workspaces, 'workspaces');
  tableNames.set(workspaceIntegrations, 'workspaceIntegrations');

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
        values: (values: Record<string, unknown>) => ({
          onConflictDoUpdate: () => ({
            returning: async () => {
              const name = tableNames.get(table) ?? 'unknown';
              const rows = dbState.tables.get(name) ?? [];
              const idx = rows.findIndex(
                (r) =>
                  r.workspaceId === values.workspaceId &&
                  r.integrationType === values.integrationType,
              );
              if (idx >= 0) {
                const merged = { ...rows[idx], ...values, updatedAt: NOW };
                rows[idx] = merged;
                return [merged];
              }
              const row = { ...values, id: `int-${dbState.seq++}`, createdAt: NOW, updatedAt: NOW };
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
        where: () => ({
          returning: async () => {
            const name = tableNames.get(table) ?? 'unknown';
            const rows = dbState.tables.get(name) ?? [];
            const idx = rows.findIndex((r) => r.workspaceId === 'ws-1');
            if (idx < 0) return [];
            const [deleted] = rows.splice(idx, 1);
            return [{ id: deleted.id }];
          },
        }),
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

describe('GET /api/integrations — konfigurasi publik per tipe', () => {
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
});
