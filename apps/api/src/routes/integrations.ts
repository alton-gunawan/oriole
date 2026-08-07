import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { workspaceIntegrations } from '@oriole/database';

import { db } from '../db/index.ts';
import { requireAuth } from '../middleware/auth.ts';
import { requireWorkspace, type WorkspaceVariables } from '../middleware/workspace.ts';
import {
  getNotionUser,
  listNotionDatabases,
  NotionApiError,
  syncContactsToNotion,
  type NotionConfig,
} from '../lib/notion.ts';
import {
  getFormMetadata,
  syncFormResponsesToContacts,
  type GoogleFormsConfig,
} from '../lib/google-forms.ts';
import {
  getGoogleCalendar,
  listGoogleCalendars,
  syncBookingsToCalendar,
  type GoogleCalendarConfig,
} from '../lib/google-calendar.ts';
import {
  GoogleApiError,
  parseServiceAccount,
} from '../lib/google-auth.ts';
import {
  sendTestWebhook,
  WebhookDeliveryError,
  type OutgoingWebhookConfig,
} from '../lib/outgoing-webhooks.ts';

/** Panjang minimum token integrasi Notion (secret_... jauh lebih panjang). */
const NOTION_TOKEN_MIN = 10;

const notionDatabasesSchema = z.object({
  token: z.string().trim().min(NOTION_TOKEN_MIN, 'Token integrasi terlalu pendek'),
});

const notionConnectSchema = z.object({
  token: z.string().trim().min(NOTION_TOKEN_MIN, 'Token integrasi terlalu pendek'),
  databaseId: z.string().trim().min(1, 'Database wajib dipilih'),
  databaseName: z.string().trim().max(200).optional().nullable(),
});

const notionPatchSchema = z.object({
  isActive: z.boolean(),
});

/** Kredensial service account Google (JSON key) — dipakai Forms & Calendar. */
const serviceAccountSchema = z.object({
  serviceAccountJson: z.string().trim().min(50, 'Kredensial service account terlalu pendek'),
});

const formConnectSchema = serviceAccountSchema.extend({
  formId: z.string().trim().min(1, 'ID form wajib diisi').max(200),
});

const calendarConnectSchema = serviceAccountSchema.extend({
  calendarId: z.string().trim().min(1, 'Kalender wajib dipilih').max(400),
  calendarName: z.string().trim().max(200).optional().nullable(),
});

const webhookConnectSchema = z.object({
  url: z
    .string()
    .trim()
    .url('URL tidak valid')
    .refine((value) => value.startsWith('http://') || value.startsWith('https://'), {
      message: 'URL harus http(s)',
    })
    .max(2_000),
  secret: z.string().trim().min(8, 'Secret minimal 8 karakter').max(256).optional().nullable(),
});

const isActivePatchSchema = z.object({ isActive: z.boolean() });

type IntegrationRow = typeof workspaceIntegrations.$inferSelect;

/** Serialisasi publik — kredensial privat (providerConfig) TIDAK pernah keluar. */
function toPublicIntegration(row: IntegrationRow) {
  const config = row.providerConfig as Record<string, unknown>;
  switch (row.integrationType) {
    case 'notion': {
      const notionConfig = config as Partial<NotionConfig>;
      return {
        id: row.id,
        integrationType: row.integrationType,
        identifier: row.identifier,
        isActive: row.isActive,
        lastSyncAt: row.lastSyncAt ? row.lastSyncAt.toISOString() : null,
        config: {
          databaseId: notionConfig.databaseId ?? null,
          databaseName: notionConfig.databaseName ?? null,
        },
      };
    }
    case 'google-forms': {
      const formsConfig = config as Partial<GoogleFormsConfig>;
      return {
        id: row.id,
        integrationType: row.integrationType,
        identifier: row.identifier ?? formsConfig.formName ?? null,
        isActive: row.isActive,
        lastSyncAt: row.lastSyncAt ? row.lastSyncAt.toISOString() : null,
        config: {
          formId: formsConfig.formId ?? null,
          formName: formsConfig.formName ?? null,
          serviceAccountEmail: formsConfig.serviceAccountEmail ?? null,
        },
      };
    }
    case 'google-calendar': {
      const calendarConfig = config as Partial<GoogleCalendarConfig>;
      return {
        id: row.id,
        integrationType: row.integrationType,
        identifier: row.identifier ?? calendarConfig.calendarName ?? null,
        isActive: row.isActive,
        lastSyncAt: row.lastSyncAt ? row.lastSyncAt.toISOString() : null,
        config: {
          calendarId: calendarConfig.calendarId ?? null,
          calendarName: calendarConfig.calendarName ?? null,
          serviceAccountEmail: calendarConfig.serviceAccountEmail ?? null,
        },
      };
    }
    case 'webhook': {
      const webhookConfig = config as Partial<OutgoingWebhookConfig>;
      return {
        id: row.id,
        integrationType: row.integrationType,
        identifier: row.identifier ?? webhookConfig.url ?? null,
        isActive: row.isActive,
        lastSyncAt: row.lastSyncAt ? row.lastSyncAt.toISOString() : null,
        config: {
          url: webhookConfig.url ?? null,
          // Keberadaan secret di-expose (untuk badge), nilai aslinya tidak.
          hasSecret: typeof webhookConfig.secret === 'string' && webhookConfig.secret.length > 0,
        },
      };
    }
    default:
      return {
        id: row.id,
        integrationType: row.integrationType,
        identifier: row.identifier,
        isActive: row.isActive,
        lastSyncAt: row.lastSyncAt ? row.lastSyncAt.toISOString() : null,
        config: {},
      };
  }
}

/** NotionApiError → status HTTP yang sesuai (token/database tidak valid, dll). */
function notionErrorStatus(err: NotionApiError): 400 | 401 | 409 | 429 | 502 {
  if (err.status === 401) return 401;
  if (err.status === 404) return 400;
  if (err.status === 409) return 409;
  if (err.status === 429) return 429;
  return 502;
}

/** GoogleApiError → status HTTP yang sesuai. */
function googleErrorStatus(err: GoogleApiError): 400 | 401 | 403 | 409 | 429 | 502 {
  if (err.status === 401 || err.status === 403) return err.status;
  if (err.status === 404) return 400;
  if (err.status === 429) return 429;
  return 502;
}

/** Upsert satu integrasi (unik per workspace+type) lalu kembalikan publik. */
async function upsertIntegration(input: {
  workspaceId: string;
  integrationType: string;
  identifier: string | null;
  providerConfig: Record<string, unknown>;
}): Promise<ReturnType<typeof toPublicIntegration>> {
  const [row] = await db
    .insert(workspaceIntegrations)
    .values({
      workspaceId: input.workspaceId,
      integrationType: input.integrationType,
      identifier: input.identifier,
      providerConfig: input.providerConfig,
      isActive: true,
    })
    .onConflictDoUpdate({
      target: [workspaceIntegrations.workspaceId, workspaceIntegrations.integrationType],
      set: {
        identifier: input.identifier,
        providerConfig: input.providerConfig,
        isActive: true,
        updatedAt: new Date(),
      },
    })
    .returning();
  return toPublicIntegration(row);
}

/** Hapus integrasi; 404 bila belum terhubung. */
async function deleteIntegration(workspaceId: string, integrationType: string): Promise<{ id: string }> {
  const [deleted] = await db
    .delete(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, workspaceId),
        eq(workspaceIntegrations.integrationType, integrationType),
      ),
    )
    .returning({ id: workspaceIntegrations.id });
  if (!deleted) throw new IntegrationNotFoundError(integrationType);
  return { id: deleted.id };
}

class IntegrationNotFoundError extends Error {
  constructor(readonly integrationType: string) {
    super(`Integrasi ${integrationType} belum terhubung`);
    this.name = 'IntegrationNotFoundError';
  }
}

export const integrationsRoutes = new Hono<{ Variables: WorkspaceVariables }>()
  /* ── Daftar integrasi terhubung workspace (tanpa kredensial) ── */
  .get('/', requireAuth, requireWorkspace, async (c) => {
    const workspaceId = c.get('workspaceId');
    const rows = await db
      .select()
      .from(workspaceIntegrations)
      .where(eq(workspaceIntegrations.workspaceId, workspaceId))
      .orderBy(workspaceIntegrations.createdAt);
    return c.json({ integrations: rows.map(toPublicIntegration) });
  })

  /* ══════════════════════════════════════════════════════════
   * Notion
   * ══════════════════════════════════════════════════════════ */

  /* ── Cari database Notion yang bisa diakses token (token TIDAK disimpan) ── */
  .post(
    '/notion/databases',
    requireAuth,
    requireWorkspace,
    zValidator('json', notionDatabasesSchema),
    async (c) => {
      const { token } = c.req.valid('json');
      try {
        const user = await getNotionUser(token);
        const databases = await listNotionDatabases(token);
        return c.json({
          user: { id: user.id, name: user.name },
          databases,
        });
      } catch (err) {
        if (err instanceof NotionApiError) {
          return c.json({ error: `Token ditolak Notion: ${err.message}` }, notionErrorStatus(err));
        }
        console.error('[integrations] list notion databases gagal:', err);
        return c.json({ error: 'Gagal menghubungi Notion. Coba lagi.' }, 502);
      }
    },
  )
  /* ── Hubungkan database Notion ke project (upsert per workspace+type) ── */
  .post(
    '/notion/connect',
    requireAuth,
    requireWorkspace,
    zValidator('json', notionConnectSchema),
    async (c) => {
      const workspaceId = c.get('workspaceId');
      const { token, databaseId, databaseName } = c.req.valid('json');
      try {
        await getNotionUser(token);
        const databases = await listNotionDatabases(token);
        const selected = databases.find((db) => db.id === databaseId);
        if (!selected) {
          return c.json({ error: 'Database tidak ditemukan di akun Notion ini.' }, 400);
        }
        const name = databaseName ?? selected.title;

        const integration = await upsertIntegration({
          workspaceId,
          integrationType: 'notion',
          identifier: name,
          providerConfig: { token, databaseId, databaseName: name },
        });

        return c.json({ integration }, 201);
      } catch (err) {
        if (err instanceof NotionApiError) {
          return c.json({ error: `Token ditolak Notion: ${err.message}` }, notionErrorStatus(err));
        }
        console.error('[integrations] connect notion gagal:', err);
        return c.json({ error: 'Gagal menghubungkan Notion. Coba lagi.' }, 502);
      }
    },
  )
  /* ── Aktif / nonaktifkan integrasi ── */
  .patch(
    '/notion',
    requireAuth,
    requireWorkspace,
    zValidator('json', notionPatchSchema),
    async (c) => {
      const workspaceId = c.get('workspaceId');
      const { isActive } = c.req.valid('json');
      const [row] = await db
        .update(workspaceIntegrations)
        .set({ isActive, updatedAt: new Date() })
        .where(
          and(
            eq(workspaceIntegrations.workspaceId, workspaceId),
            eq(workspaceIntegrations.integrationType, 'notion'),
          ),
        )
        .returning();
      if (!row) return c.json({ error: 'Integrasi Notion belum terhubung.' }, 404);
      return c.json({ integration: toPublicIntegration(row) });
    },
  )
  /* ── Lepas integrasi ── */
  .delete('/notion', requireAuth, requireWorkspace, async (c) => {
    try {
      const result = await deleteIntegration(c.get('workspaceId'), 'notion');
      return c.json({ ok: true, id: result.id });
    } catch (err) {
      if (err instanceof IntegrationNotFoundError) return c.json({ error: err.message }, 404);
      throw err;
    }
  })
  /* ── Sinkronkan kontak project → database Notion (manual) ── */
  .post('/notion/sync', requireAuth, requireWorkspace, async (c) => {
    const workspaceId = c.get('workspaceId');
    try {
      const result = await syncContactsToNotion(workspaceId);
      return c.json({ ...result, lastSyncAt: new Date().toISOString() });
    } catch (err) {
      if (err instanceof NotionApiError) {
        const status = notionErrorStatus(err);
        if (status === 409) return c.json({ error: err.message }, 409);
        if (status === 400) return c.json({ error: err.message }, 400);
        return c.json({ error: `Sinkronisasi gagal: ${err.message}` }, status);
      }
      console.error('[integrations] sync notion gagal:', err);
      return c.json({ error: 'Sinkronisasi gagal. Coba lagi.' }, 502);
    }
  })

  /* ══════════════════════════════════════════════════════════
   * Google Forms — submission form → kontak
   * ══════════════════════════════════════════════════════════ */

  /* ── Pratinjau form: validasi kredensial + daftar pertanyaan (TIDAK disimpan) ── */
  .post(
    '/forms/preview',
    requireAuth,
    requireWorkspace,
    zValidator('json', formConnectSchema),
    async (c) => {
      const { serviceAccountJson, formId } = c.req.valid('json');
      try {
        const serviceAccount = parseServiceAccount(serviceAccountJson);
        const form = await getFormMetadata(serviceAccount, formId);
        return c.json({
          form: { formId: form.formId, title: form.title, questions: form.questions },
          serviceAccountEmail: serviceAccount.clientEmail,
        });
      } catch (err) {
        if (err instanceof GoogleApiError) {
          return c.json({ error: `Google menolak: ${err.message}` }, googleErrorStatus(err));
        }
        console.error('[integrations] preview google forms gagal:', err);
        return c.json({ error: 'Gagal menghubungi Google. Coba lagi.' }, 502);
      }
    },
  )
  /* ── Hubungkan form ke project (upsert per workspace+type) ── */
  .post(
    '/forms/connect',
    requireAuth,
    requireWorkspace,
    zValidator('json', formConnectSchema),
    async (c) => {
      const workspaceId = c.get('workspaceId');
      const { serviceAccountJson, formId } = c.req.valid('json');
      try {
        const serviceAccount = parseServiceAccount(serviceAccountJson);
        const form = await getFormMetadata(serviceAccount, formId);

        const integration = await upsertIntegration({
          workspaceId,
          integrationType: 'google-forms',
          identifier: form.title,
          providerConfig: {
            serviceAccountJson,
            serviceAccountEmail: serviceAccount.clientEmail,
            formId,
            formName: form.title,
            lastSubmittedAt: null,
          },
        });
        return c.json({ integration }, 201);
      } catch (err) {
        if (err instanceof GoogleApiError) {
          return c.json({ error: `Google menolak: ${err.message}` }, googleErrorStatus(err));
        }
        console.error('[integrations] connect google forms gagal:', err);
        return c.json({ error: 'Gagal menghubungkan Google Forms. Coba lagi.' }, 502);
      }
    },
  )
  /* ── Sinkronkan response form → kontak (manual) ── */
  .post('/forms/sync', requireAuth, requireWorkspace, async (c) => {
    const workspaceId = c.get('workspaceId');
    try {
      const result = await syncFormResponsesToContacts(workspaceId);
      return c.json({ ...result, lastSyncAt: new Date().toISOString() });
    } catch (err) {
      if (err instanceof GoogleApiError) {
        if (err.status === 409) return c.json({ error: err.message }, 409);
        if (err.status === 400) return c.json({ error: err.message }, 400);
        return c.json({ error: `Sinkronisasi gagal: ${err.message}` }, googleErrorStatus(err));
      }
      console.error('[integrations] sync google forms gagal:', err);
      return c.json({ error: 'Sinkronisasi gagal. Coba lagi.' }, 502);
    }
  })
  /* ── Aktif / nonaktifkan form ── */
  .patch(
    '/forms',
    requireAuth,
    requireWorkspace,
    zValidator('json', isActivePatchSchema),
    async (c) => {
      const workspaceId = c.get('workspaceId');
      const { isActive } = c.req.valid('json');
      const [row] = await db
        .update(workspaceIntegrations)
        .set({ isActive, updatedAt: new Date() })
        .where(
          and(
            eq(workspaceIntegrations.workspaceId, workspaceId),
            eq(workspaceIntegrations.integrationType, 'google-forms'),
          ),
        )
        .returning();
      if (!row) return c.json({ error: 'Integrasi Google Forms belum terhubung.' }, 404);
      return c.json({ integration: toPublicIntegration(row) });
    },
  )
  /* ── Lepas form ── */
  .delete('/forms', requireAuth, requireWorkspace, async (c) => {
    try {
      const result = await deleteIntegration(c.get('workspaceId'), 'google-forms');
      return c.json({ ok: true, id: result.id });
    } catch (err) {
      if (err instanceof IntegrationNotFoundError) return c.json({ error: err.message }, 404);
      throw err;
    }
  })

  /* ══════════════════════════════════════════════════════════
   * Google Calendar — booking → event kalender
   * ══════════════════════════════════════════════════════════ */

  /* ── Daftar kalender yang bisa diakses service account (TIDAK disimpan) ── */
  .post(
    '/calendar/calendars',
    requireAuth,
    requireWorkspace,
    zValidator('json', serviceAccountSchema),
    async (c) => {
      const { serviceAccountJson } = c.req.valid('json');
      try {
        const serviceAccount = parseServiceAccount(serviceAccountJson);
        const calendars = await listGoogleCalendars(serviceAccount);
        return c.json({ calendars, serviceAccountEmail: serviceAccount.clientEmail });
      } catch (err) {
        if (err instanceof GoogleApiError) {
          return c.json({ error: `Google menolak: ${err.message}` }, googleErrorStatus(err));
        }
        console.error('[integrations] list google calendars gagal:', err);
        return c.json({ error: 'Gagal menghubungi Google. Coba lagi.' }, 502);
      }
    },
  )
  /* ── Hubungkan kalender ke project ── */
  .post(
    '/calendar/connect',
    requireAuth,
    requireWorkspace,
    zValidator('json', calendarConnectSchema),
    async (c) => {
      const workspaceId = c.get('workspaceId');
      const { serviceAccountJson, calendarId, calendarName } = c.req.valid('json');
      try {
        const serviceAccount = parseServiceAccount(serviceAccountJson);
        const calendar = await getGoogleCalendar(serviceAccount, calendarId);
        const name = calendarName ?? calendar.summary;

        const integration = await upsertIntegration({
          workspaceId,
          integrationType: 'google-calendar',
          identifier: name,
          providerConfig: {
            serviceAccountJson,
            serviceAccountEmail: serviceAccount.clientEmail,
            calendarId,
            calendarName: name,
            eventIds: {},
          },
        });
        return c.json({ integration }, 201);
      } catch (err) {
        if (err instanceof GoogleApiError) {
          return c.json({ error: `Google menolak: ${err.message}` }, googleErrorStatus(err));
        }
        console.error('[integrations] connect google calendar gagal:', err);
        return c.json({ error: 'Gagal menghubungkan Google Calendar. Coba lagi.' }, 502);
      }
    },
  )
  /* ── Sinkronkan semua booking → kalender (manual / setelah koneksi) ── */
  .post('/calendar/sync', requireAuth, requireWorkspace, async (c) => {
    const workspaceId = c.get('workspaceId');
    try {
      const result = await syncBookingsToCalendar(workspaceId);
      return c.json({ ...result, lastSyncAt: new Date().toISOString() });
    } catch (err) {
      if (err instanceof GoogleApiError) {
        if (err.status === 409) return c.json({ error: err.message }, 409);
        if (err.status === 400) return c.json({ error: err.message }, 400);
        return c.json({ error: `Sinkronisasi gagal: ${err.message}` }, googleErrorStatus(err));
      }
      console.error('[integrations] sync google calendar gagal:', err);
      return c.json({ error: 'Sinkronisasi gagal. Coba lagi.' }, 502);
    }
  })
  /* ── Aktif / nonaktifkan kalender ── */
  .patch(
    '/calendar',
    requireAuth,
    requireWorkspace,
    zValidator('json', isActivePatchSchema),
    async (c) => {
      const workspaceId = c.get('workspaceId');
      const { isActive } = c.req.valid('json');
      const [row] = await db
        .update(workspaceIntegrations)
        .set({ isActive, updatedAt: new Date() })
        .where(
          and(
            eq(workspaceIntegrations.workspaceId, workspaceId),
            eq(workspaceIntegrations.integrationType, 'google-calendar'),
          ),
        )
        .returning();
      if (!row) return c.json({ error: 'Integrasi Google Calendar belum terhubung.' }, 404);
      return c.json({ integration: toPublicIntegration(row) });
    },
  )
  /* ── Lepas kalender ── */
  .delete('/calendar', requireAuth, requireWorkspace, async (c) => {
    try {
      const result = await deleteIntegration(c.get('workspaceId'), 'google-calendar');
      return c.json({ ok: true, id: result.id });
    } catch (err) {
      if (err instanceof IntegrationNotFoundError) return c.json({ error: err.message }, 404);
      throw err;
    }
  })

  /* ══════════════════════════════════════════════════════════
   * Outgoing webhook — notifikasi event ke endpoint user
   * ══════════════════════════════════════════════════════════ */

  /* ── Hubungkan endpoint webhook (upsert; secret baru menggantikan lama) ── */
  .post(
    '/webhook/connect',
    requireAuth,
    requireWorkspace,
    zValidator('json', webhookConnectSchema),
    async (c) => {
      const workspaceId = c.get('workspaceId');
      const { url, secret } = c.req.valid('json');
      const integration = await upsertIntegration({
        workspaceId,
        integrationType: 'webhook',
        identifier: url,
        providerConfig: { url, secret: secret?.trim() || null },
      });
      return c.json({ integration }, 201);
    },
  )
  /* ── Kirim ping uji ke endpoint (sinkron, feedback langsung) ── */
  .post('/webhook/test', requireAuth, requireWorkspace, async (c) => {
    try {
      const result = await sendTestWebhook(c.get('workspaceId'));
      return c.json({ ...result, sentAt: new Date().toISOString() });
    } catch (err) {
      if (err instanceof WebhookDeliveryError) {
        // Belum terhubung → 409; kegagalan pengiriman (network / non-2xx) → 502.
        if (err.status === 409) return c.json({ error: err.message }, 409);
        return c.json({ error: `Webhook gagal: ${err.message}` }, 502);
      }
      console.error('[integrations] test webhook gagal:', err);
      return c.json({ error: 'Gagal mengirim webhook uji. Coba lagi.' }, 502);
    }
  })
  /* ── Aktif / nonaktifkan webhook ── */
  .patch(
    '/webhook',
    requireAuth,
    requireWorkspace,
    zValidator('json', isActivePatchSchema),
    async (c) => {
      const workspaceId = c.get('workspaceId');
      const { isActive } = c.req.valid('json');
      const [row] = await db
        .update(workspaceIntegrations)
        .set({ isActive, updatedAt: new Date() })
        .where(
          and(
            eq(workspaceIntegrations.workspaceId, workspaceId),
            eq(workspaceIntegrations.integrationType, 'webhook'),
          ),
        )
        .returning();
      if (!row) return c.json({ error: 'Webhook belum terhubung.' }, 404);
      return c.json({ integration: toPublicIntegration(row) });
    },
  )
  /* ── Lepas webhook ── */
  .delete('/webhook', requireAuth, requireWorkspace, async (c) => {
    try {
      const result = await deleteIntegration(c.get('workspaceId'), 'webhook');
      return c.json({ ok: true, id: result.id });
    } catch (err) {
      if (err instanceof IntegrationNotFoundError) return c.json({ error: err.message }, 404);
      throw err;
    }
  });
