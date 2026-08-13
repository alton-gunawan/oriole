import { and, eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { VapiClient } from '@vapi-ai/server-sdk';
import { workspaceIntegrations } from '@oriole/database';

import { db } from '../db/index.ts';
import { env } from '../lib/env.ts';
import { captureIntegrationEvent } from '../lib/analytics.ts';
import { decryptSecret, encryptSecret } from '../lib/crypto.ts';
import { connectTelnyxByoc, searchTelnyxByoc, TelnyxByocNumberUnavailableError } from '../lib/telnyx-byoc.ts';
import {
  InboundNumberNotFoundError,
  listInboundNumbers,
  registerInboundNumberForWorkspace,
  unregisterInboundNumberForWorkspace,
} from '../lib/vapi-inbound.ts';
import { createTelnyxClient, TelnyxApiError } from '../services/telnyx.ts';
import { VapiCredentialApiError } from '../services/vapi-credential.ts';
import { listOperatorVapiPhoneNumbers, type VapiPhoneNumberInfo } from '../services/vapi.ts';
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
  getTallyForm,
  listTallyForms,
  registerTallyWebhook,
  removeTallyWebhook,
  tallyWebhookUrl,
  TallyApiError,
  type TallyConfig,
} from '../lib/tally.ts';
import {
  getFormMetadata,
  syncFormResponsesToContacts,
  type GoogleFormsConfig,
} from '../lib/google-forms.ts';
import { googleFormUrl, tallyFormUrl, type FormIntegrationType } from '../lib/form-links.ts';
import { dispatchFormInvitation, FormSendError } from '../lib/form-send.ts';
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
import { isPaddlePaymentsConfigured } from '../lib/paddle-payments.ts';
import {
  buildSlackMessage,
  deliverSlackMessage,
  sendTestSlack,
  SlackDeliveryError,
  type SlackConfig,
} from '../lib/slack.ts';
import { availableVideoProviders, type VideoConfig } from '../lib/video.ts';

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

const videoConnectSchema = z.object({
  provider: z.enum(['zoom', 'meet']),
});

const slackConnectSchema = z.object({
  // Slack Incoming Webhook — satu-satunya format yang diterima (cegah
  // nyasar ke URL lain yang bukan webhook Slack).
  webhookUrl: z
    .string()
    .trim()
    .url('URL tidak valid')
    .refine(
      (value) => value.startsWith('https://hooks.slack.com/services/'),
      { message: 'URL harus Slack Incoming Webhook (https://hooks.slack.com/services/…)' },
    )
    .max(500),
  /** Label channel opsional (mis. "#general") — hanya untuk tampilan, bukan kirim. */
  channel: z.string().trim().max(100).optional().nullable(),
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

/**
 * API key Tally (Bearer token) — satu-satunya autentikasi Tally (tidak ada
 * OAuth). Key divalidasi saat preview/connect, disimpan terenkripsi di
 * providerConfig. Dapatkan di https://tally.so/settings/api-keys.
 */
const tallyTokenSchema = z.object({
  apiKey: z.string().trim().min(10, 'API key Tally terlalu pendek').max(500),
});

const tallyConnectSchema = tallyTokenSchema.extend({
  formId: z.string().trim().min(1, 'Form wajib dipilih').max(100),
  formName: z.string().trim().max(200).optional().nullable(),
});

const isActivePatchSchema = z.object({ isActive: z.boolean() });

/** Pilih nomor keluar Voice AI (id nomor Vapi server) untuk workspace ini. */
const vapiConnectSchema = z.object({
  vapiPhoneNumberId: z.string().trim().min(1, 'Nomor wajib dipilih'),
});

/** BYOC — cari nomor di akun Telnyx milik workspace (key divalidasi, tidak disimpan). */
const vapiByocSearchSchema = z.object({
  apiKey: z.string().trim().min(10, 'API key Telnyx terlalu pendek').max(300),
  countryCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, 'Kode negara harus 2 huruf (ISO 3166-1 alpha-2)')
    .default('ID'),
  areaCode: z.string().trim().regex(/^[0-9]{1,10}$/, 'Kode area tidak valid').optional().nullable(),
});

/** BYOC — sambungkan nomor pilihan milik workspace (beli bila perlu). */
const vapiByocConnectSchema = z.object({
  apiKey: z.string().trim().min(10, 'API key Telnyx terlalu pendek').max(300),
  phoneNumber: z.string().trim().min(6, 'Nomor telepon tidak valid').max(20),
});

/** Daftarkan nomor inbound (label opsional + kode area opsional). */
const vapiInboundRegisterSchema = z.object({
  name: z.string().trim().max(100).optional().nullable(),
  areaCode: z.string().trim().regex(/^[0-9]{1,10}$/, 'Kode area tidak valid').optional().nullable(),
});

/** Konfigurasi internal integrasi 'vapi' — hanya referensi non-secret. */
interface VapiIntegrationConfig {
  vapiPhoneNumberId?: string;
  phoneNumber?: string | null;
  /** 'byoc' = nomor dari akun Telnyx workspace sendiri; lain/kosong = operator. */
  mode?: 'byoc' | 'operator';
  /** Referensi internal kredensial Telnyx di sisi Vapi (BYOC) — TIDAK di-expose. */
  vapiCredentialId?: string;
}

/** Kirim tautan form (Google Forms / Typeform) ke satu customer via channel. */
const formSendSchema = z.object({
  integrationType: z.enum(['google-forms', 'tally']),
  contactId: z.string().uuid('ID kontak tidak valid'),
  channel: z.enum(['whatsapp', 'telegram', 'email']),
});

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
          // URL publik untuk dikirim ke customer (deterministik dari formId).
          formUrl: formsConfig.formId ? googleFormUrl(formsConfig.formId) : null,
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
    case 'tally': {
      const tallyConfig = config as Partial<TallyConfig>;
      return {
        id: row.id,
        integrationType: row.integrationType,
        identifier: row.identifier ?? tallyConfig.formName ?? null,
        isActive: row.isActive,
        lastSyncAt: row.lastSyncAt ? row.lastSyncAt.toISOString() : null,
        config: {
          formId: tallyConfig.formId ?? null,
          formName: tallyConfig.formName ?? null,
          webhookUrl: tallyConfig.webhookUrl ?? null,
          // URL publik untuk dikirim ke customer (deterministik dari formId).
          formUrl: tallyConfig.formId ? tallyFormUrl(tallyConfig.formId) : null,
          // Keberadaan secret di-expose (untuk badge), nilai aslinya tidak.
          hasWebhookSecret:
            typeof tallyConfig.webhookSecret === 'string' && tallyConfig.webhookSecret.length > 0,
          // Marker migrasi dari Typeform (migration 0022) — UI menampilkan banner.
          migratedFrom: tallyConfig.migratedFrom === 'typeform' ? 'typeform' : null,
        },
      };
    }
    case 'payments':
      // Kredensial server-side (env PADDLE_*) — tidak ada config privat.
      return {
        id: row.id,
        integrationType: row.integrationType,
        identifier: row.identifier ?? 'Paddle',
        isActive: row.isActive,
        lastSyncAt: row.lastSyncAt ? row.lastSyncAt.toISOString() : null,
        config: {},
      };
    case 'slack': {
      const slackConfig = config as Partial<SlackConfig>;
      return {
        id: row.id,
        integrationType: row.integrationType,
        identifier: row.identifier ?? null,
        isActive: row.isActive,
        lastSyncAt: row.lastSyncAt ? row.lastSyncAt.toISOString() : null,
        config: {
          // URL webhook TIDAK pernah di-expose — SECRET (siapa pun yang
          // memegangnya bisa memposting ke channel). Hanya host + label
          // channel yang tampil.
          webhookUrlHost:
            typeof slackConfig.webhookUrl === 'string'
              ? new URL(slackConfig.webhookUrl).host
              : null,
          channel: slackConfig.channel ?? null,
        },
      };
    }
    case 'video': {
      const videoConfig = config as Partial<VideoConfig>;
      return {
        id: row.id,
        integrationType: row.integrationType,
        identifier: row.identifier ?? null,
        isActive: row.isActive,
        lastSyncAt: row.lastSyncAt ? row.lastSyncAt.toISOString() : null,
        config: { provider: videoConfig.provider ?? null },
      };
    }
    case 'vapi': {
      // Voice AI — nomor keluar pilihan workspace. Kredensial Vapi/Telnyx
      // server-side (env) / credential BYOC di Vapi — tidak pernah keluar.
      // Hanya nomor + mode yang diekspos (vapiCredentialId tetap internal).
      const vapiConfig = config as Partial<VapiIntegrationConfig>;
      return {
        id: row.id,
        integrationType: row.integrationType,
        identifier: row.identifier ?? vapiConfig.phoneNumber ?? null,
        isActive: row.isActive,
        lastSyncAt: row.lastSyncAt ? row.lastSyncAt.toISOString() : null,
        config: {
          vapiPhoneNumberId: vapiConfig.vapiPhoneNumberId ?? null,
          phoneNumber: vapiConfig.phoneNumber ?? null,
          mode: vapiConfig.mode === 'byoc' ? 'byoc' : 'operator',
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
  // Analitik: integrasi terhubung/terhubung-ulang (workspace-scoped).
  // Properti hanya integrationType — kredensial privat tidak pernah keluar.
  captureIntegrationEvent('integration.connected', {
    workspaceId: input.workspaceId,
    integrationType: input.integrationType,
  });
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
          // Token dienkripsi at-rest (AES-256-GCM); tanpa APP_ENCRYPTION_KEY
          // encryptSecret fallback ke plaintext (mode kompatibilitas).
          providerConfig: { token: encryptSecret(token), databaseId, databaseName: name },
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
    const workspaceId = c.get('workspaceId');
    try {
      const result = await deleteIntegration(workspaceId, 'notion');
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
  /* ── Kirim tautan form ke customer (via channel terhubung) ── */
  .post(
    '/forms/send',
    requireAuth,
    requireWorkspace,
    zValidator('json', formSendSchema),
    async (c) => {
      const workspaceId = c.get('workspaceId');
      const { integrationType, contactId, channel } = c.req.valid('json');

      const [integration] = await db
        .select()
        .from(workspaceIntegrations)
        .where(
          and(
            eq(workspaceIntegrations.workspaceId, workspaceId),
            eq(workspaceIntegrations.integrationType, integrationType),
          ),
        )
        .limit(1);
      if (!integration) {
        return c.json({ error: 'Form belum terhubung ke project ini.' }, 404);
      }
      if (!integration.isActive) {
        return c.json({ error: 'Integrasi form sedang dijeda (nonaktif).' }, 409);
      }
      const config = integration.providerConfig as Record<string, unknown>;
      const formId = typeof config.formId === 'string' ? config.formId : null;
      if (!formId) {
        return c.json({ error: 'Konfigurasi form tidak lengkap (formId hilang).' }, 400);
      }
      const formName = typeof config.formName === 'string' ? config.formName : null;

      try {
        const result = await dispatchFormInvitation({
          workspaceId,
          integrationType: integrationType as FormIntegrationType,
          formId,
          formName,
          contactId,
          channel,
        });
        return c.json(result, 201);
      } catch (err) {
        if (err instanceof FormSendError) {
          return c.json({ error: err.message }, err.status);
        }
        console.error('[integrations] kirim form gagal:', err);
        return c.json({ error: 'Gagal mengirim form. Coba lagi.' }, 502);
      }
    },
  )
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
   * Tally — submission form → kontak (webhook real-time)
   * ══════════════════════════════════════════════════════════ */

  /* ── Pratinjau: validasi API key + daftar form akun (TIDAK disimpan) ── */
  .post(
    '/tally/preview',
    requireAuth,
    requireWorkspace,
    zValidator('json', tallyTokenSchema),
    async (c) => {
      const { apiKey } = c.req.valid('json');
      try {
        const forms = await listTallyForms(apiKey);
        return c.json({ forms });
      } catch (err) {
        if (err instanceof TallyApiError) {
          return c.json({ error: `Tally menolak: ${err.message}` }, 400);
        }
        console.error('[integrations] preview tally gagal:', err);
        return c.json({ error: 'Gagal menghubungi Tally. Coba lagi.' }, 502);
      }
    },
  )
  /* ── Hubungkan form: validasi + daftarkan webhook ke Tally ── */
  .post(
    '/tally/connect',
    requireAuth,
    requireWorkspace,
    zValidator('json', tallyConnectSchema),
    async (c) => {
      const workspaceId = c.get('workspaceId');
      const { apiKey, formId, formName } = c.req.valid('json');
      try {
        const form = await getTallyForm(apiKey, formId);
        const name = formName ?? form.title;
        const webhookSecret = randomBytes(32).toString('base64url');
        const webhookUrl = tallyWebhookUrl(workspaceId);
        // Daftarkan webhook SEKARANG — gagal berarti key/form tidak valid
        // atau URL tidak bisa diterima Tally (mis. bukan https).
        const webhook = await registerTallyWebhook(apiKey, formId, webhookUrl, webhookSecret);

        const integration = await upsertIntegration({
          workspaceId,
          integrationType: 'tally',
          identifier: name,
          providerConfig: {
            // API key dienkripsi at-rest (AES-256-GCM).
            apiKey: encryptSecret(apiKey),
            webhookSecret,
            formId,
            formName: name,
            webhookUrl,
            webhookId: webhook.id || null,
          },
        });
        return c.json({ integration }, 201);
      } catch (err) {
        if (err instanceof TallyApiError) {
          return c.json({ error: `Tally menolak: ${err.message}` }, 400);
        }
        console.error('[integrations] connect tally gagal:', err);
        return c.json({ error: 'Gagal menghubungkan Tally. Coba lagi.' }, 502);
      }
    },
  )
  /* ── Daftarkan ulang webhook ke Tally (mis. dihapus dari sisi Tally) ── */
  .post('/tally/rewebhook', requireAuth, requireWorkspace, async (c) => {
    const workspaceId = c.get('workspaceId');
    try {
      const [integration] = await db
        .select()
        .from(workspaceIntegrations)
        .where(
          and(
            eq(workspaceIntegrations.workspaceId, workspaceId),
            eq(workspaceIntegrations.integrationType, 'tally'),
          ),
        )
        .limit(1);
      if (!integration) {
        return c.json({ error: 'Integrasi Tally belum terhubung.' }, 404);
      }
      const config = integration.providerConfig as unknown as TallyConfig;
      const apiKey = decryptSecret(config.apiKey ?? '');
      if (!apiKey) {
        return c.json(
          { error: 'API key Tally tidak tersedia. Lepas lalu hubungkan ulang.' },
          401,
        );
      }
      const webhook = await registerTallyWebhook(
        apiKey,
        config.formId,
        config.webhookUrl ?? tallyWebhookUrl(workspaceId),
        config.webhookSecret,
      );
      // Simpan webhookId terbaru agar disconnect tetap bisa mencabutnya.
      await db
        .update(workspaceIntegrations)
        .set({
          providerConfig: { ...config, webhookId: webhook.id || config.webhookId },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(workspaceIntegrations.workspaceId, workspaceId),
            eq(workspaceIntegrations.integrationType, 'tally'),
          ),
        );
      return c.json({ integration: toPublicIntegration(integration) });
    } catch (err) {
      if (err instanceof TallyApiError) {
        return c.json({ error: `Tally menolak: ${err.message}` }, 400);
      }
      console.error('[integrations] rewebhook tally gagal:', err);
      return c.json({ error: 'Gagal mendaftarkan ulang webhook Tally. Coba lagi.' }, 502);
    }
  })
  /* ── Aktif / nonaktifkan integrasi ── */
  .patch(
    '/tally',
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
            eq(workspaceIntegrations.integrationType, 'tally'),
          ),
        )
        .returning();
      if (!row) return c.json({ error: 'Integrasi Tally belum terhubung.' }, 404);
      return c.json({ integration: toPublicIntegration(row) });
    },
  )
  /* ── Lepas integrasi: cabut webhook (best-effort) lalu hapus baris ── */
  .delete('/tally', requireAuth, requireWorkspace, async (c) => {
    const workspaceId = c.get('workspaceId');
    try {
      const [integration] = await db
        .select()
        .from(workspaceIntegrations)
        .where(
          and(
            eq(workspaceIntegrations.workspaceId, workspaceId),
            eq(workspaceIntegrations.integrationType, 'tally'),
          ),
        )
        .limit(1);
      if (integration) {
        const config = integration.providerConfig as unknown as TallyConfig;
        const apiKey = decryptSecret(config.apiKey ?? '');
        if (apiKey && config.webhookId) {
          try {
            await removeTallyWebhook(apiKey, config.webhookId);
          } catch (err) {
            // Key dicabut / webhook sudah tidak ada — jangan gagalkan lepas.
            console.warn('[integrations] hapus webhook tally gagal (dilanjutkan):', err);
          }
        }
      }
      const result = await deleteIntegration(workspaceId, 'tally');
      return c.json({ ok: true, id: result.id });
    } catch (err) {
      if (err instanceof IntegrationNotFoundError) return c.json({ error: err.message }, 404);
      console.error('[integrations] disconnect tally gagal:', err);
      return c.json({ error: 'Gagal melepas integrasi Tally. Coba lagi.' }, 502);
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
  })

  /* ══════════════════════════════════════════════════════════
   * Slack — notifikasi booking ke channel tim (Incoming Webhook)
   * Kirim pesan Slack (blocks) saat booking dibuat/diubah/dibatalkan.
   * URL webhook = secret; connect memvalidasi dengan ping uji langsung.
   * ══════════════════════════════════════════════════════════ */

  /* ── Hubungkan Slack: validasi URL dengan ping uji, lalu upsert ── */
  .post(
    '/slack/connect',
    requireAuth,
    requireWorkspace,
    zValidator('json', slackConnectSchema),
    async (c) => {
      const workspaceId = c.get('workspaceId');
      const { webhookUrl, channel } = c.req.valid('json');
      try {
        // Validasi SEKARANG: kirim ping uji — URL tidak valid / channel
        // tidak bisa dijangkau → ditolak sebelum disimpan.
        await deliverSlackMessage(webhookUrl, buildSlackMessage('ping', {}));
      } catch (err) {
        if (err instanceof SlackDeliveryError) {
          return c.json({ error: `Slack menolak: ${err.message}` }, 502);
        }
        console.error('[integrations] test slack gagal saat connect:', err);
        return c.json({ error: 'Gagal mengirim pesan uji ke Slack. Coba lagi.' }, 502);
      }

      const integration = await upsertIntegration({
        workspaceId,
        integrationType: 'slack',
        identifier: channel?.trim() || null,
        providerConfig: { webhookUrl, channel: channel?.trim() || null },
      });
      return c.json({ integration }, 201);
    },
  )
  /* ── Kirim ping uji ke Slack (sinkron, feedback langsung) ── */
  .post('/slack/test', requireAuth, requireWorkspace, async (c) => {
    try {
      const result = await sendTestSlack(c.get('workspaceId'));
      return c.json({ ...result, sentAt: new Date().toISOString() });
    } catch (err) {
      if (err instanceof SlackDeliveryError) {
        // Belum terhubung → 409; kegagalan pengiriman (network / non-2xx) → 502.
        if (err.status === 409) return c.json({ error: err.message }, 409);
        return c.json({ error: `Slack gagal: ${err.message}` }, 502);
      }
      console.error('[integrations] test slack gagal:', err);
      return c.json({ error: 'Gagal mengirim pesan uji ke Slack. Coba lagi.' }, 502);
    }
  })
  /* ── Aktif / nonaktifkan Slack ── */
  .patch(
    '/slack',
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
            eq(workspaceIntegrations.integrationType, 'slack'),
          ),
        )
        .returning();
      if (!row) return c.json({ error: 'Integrasi Slack belum terhubung.' }, 404);
      return c.json({ integration: toPublicIntegration(row) });
    },
  )
  /* ── Lepas Slack ── */
  .delete('/slack', requireAuth, requireWorkspace, async (c) => {
    try {
      const result = await deleteIntegration(c.get('workspaceId'), 'slack');
      return c.json({ ok: true, id: result.id });
    } catch (err) {
      if (err instanceof IntegrationNotFoundError) return c.json({ error: err.message }, 404);
      throw err;
    }
  })

  /* ══════════════════════════════════════════════════════════
   * Payments — Global Payments (Paddle, Merchant of Record)
   * Kredensial server-side (env PADDLE_API_KEY) — user cukup one-click
   * connect, tanpa memasukkan secret apa pun. Payment link dibuat via
   * route /api/payments (checkout one-time Paddle).
   * ══════════════════════════════════════════════════════════ */

  /* ── Hubungkan Payments (one-click) ── */
  .post('/payments/connect', requireAuth, requireWorkspace, async (c) => {
    if (!isPaddlePaymentsConfigured()) {
      return c.json(
        { error: 'PADDLE_API_KEY belum dikonfigurasi di server — Payments dinonaktifkan. Hubungi administrator project.' },
        503,
      );
    }
    const integration = await upsertIntegration({
      workspaceId: c.get('workspaceId'),
      integrationType: 'payments',
      identifier: 'Paddle',
      providerConfig: {},
    });
    return c.json({ integration }, 201);
  })
  /* ── Aktif / nonaktifkan Payments ── */
  .patch(
    '/payments',
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
            eq(workspaceIntegrations.integrationType, 'payments'),
          ),
        )
        .returning();
      if (!row) return c.json({ error: 'Integrasi Payments belum terhubung.' }, 404);
      return c.json({ integration: toPublicIntegration(row) });
    },
  )
  /* ── Lepas Payments (link lama tetap tampil, pembuatan baru ditutup) ── */
  .delete('/payments', requireAuth, requireWorkspace, async (c) => {
    try {
      const result = await deleteIntegration(c.get('workspaceId'), 'payments');
      return c.json({ ok: true, id: result.id });
    } catch (err) {
      if (err instanceof IntegrationNotFoundError) return c.json({ error: err.message }, 404);
      throw err;
    }
  })

  /* ══════════════════════════════════════════════════════════
   * Video calls — link otomatis untuk setiap booking
   * Provider: zoom (meeting dibuat server-side, env ZOOM_*) atau
   * meet (hangoutLink dari event Google Calendar).
   * ══════════════════════════════════════════════════════════ */

  /* ── Daftar provider yang tersedia + kesiapan server ── */
  .get('/video/providers', requireAuth, requireWorkspace, async (c) => {
    return c.json({ providers: availableVideoProviders() });
  })
  /* ── Hubungkan Video calls (pilih provider) ── */
  .post(
    '/video/connect',
    requireAuth,
    requireWorkspace,
    zValidator('json', videoConnectSchema),
    async (c) => {
      const workspaceId = c.get('workspaceId');
      const { provider } = c.req.valid('json');

      if (provider === 'zoom' && !availableVideoProviders().find((p) => p.provider === 'zoom')?.ready) {
        return c.json(
          { error: 'Zoom belum dikonfigurasi di server (ZOOM_ACCOUNT_ID / ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET). Hubungi administrator project.' },
          503,
        );
      }
      if (provider === 'meet') {
        const [calendar] = await db
          .select({ isActive: workspaceIntegrations.isActive })
          .from(workspaceIntegrations)
          .where(
            and(
              eq(workspaceIntegrations.workspaceId, workspaceId),
              eq(workspaceIntegrations.integrationType, 'google-calendar'),
            ),
          )
          .limit(1);
        if (!calendar?.isActive) {
          return c.json(
            { error: 'Google Meet butuh integrasi Google Calendar terhubung lebih dulu (link Meet dibuat di event kalender).' },
            409,
          );
        }
      }

      const integration = await upsertIntegration({
        workspaceId,
        integrationType: 'video',
        identifier: provider === 'zoom' ? 'Zoom' : 'Google Meet',
        providerConfig: { provider },
      });
      return c.json({ integration }, 201);
    },
  )
  /* ── Aktif / nonaktifkan Video calls ── */
  .patch(
    '/video',
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
            eq(workspaceIntegrations.integrationType, 'video'),
          ),
        )
        .returning();
      if (!row) return c.json({ error: 'Integrasi Video calls belum terhubung.' }, 404);
      return c.json({ integration: toPublicIntegration(row) });
    },
  )
  /* ── Lepas Video calls (booking lama tetap punya link) ── */
  .delete('/video', requireAuth, requireWorkspace, async (c) => {
    try {
      const result = await deleteIntegration(c.get('workspaceId'), 'video');
      return c.json({ ok: true, id: result.id });
    } catch (err) {
      if (err instanceof IntegrationNotFoundError) return c.json({ error: err.message }, 404);
      throw err;
    }
  })

  /* ══════════════════════════════════════════════════════════
   * Voice AI (Vapi) — nomor keluar panggilan per workspace
   * Kredensial Vapi/Telnyx server-side (env VAPI_* / TELNYX_*). Integrasi
   * 'vapi' hanya menyimpan pilihan NOMOR (phoneNumberId Vapi) — carrier
   * (Telnyx BYO / nomor Vapi) tidak terlihat di UI. Tanpa integrasi,
   * panggilan memakai default server (VAPI_PHONE_NUMBER_ID).
   * ══════════════════════════════════════════════════════════ */

  /* ── Status: kesiapan server, daftar nomor, pilihan workspace ── */
  .get('/vapi', requireAuth, requireWorkspace, async (c) => {
    const workspaceId = c.get('workspaceId');

    let numbers: VapiPhoneNumberInfo[] = [];
    let listError: string | null = null;
    if (env.VAPI_API_KEY) {
      try {
        // Picker "Server numbers" hanya menampilkan nomor OPERATOR — nomor
        // BYOC (prefix oriole-byoc-) milik workspace lain tidak boleh tampil.
        numbers = await listOperatorVapiPhoneNumbers();
      } catch (err) {
        listError = err instanceof Error ? err.message : 'Gagal menghubungi Vapi';
      }
    }

    const [row] = await db
      .select()
      .from(workspaceIntegrations)
      .where(
        and(
          eq(workspaceIntegrations.workspaceId, workspaceId),
          eq(workspaceIntegrations.integrationType, 'vapi'),
        ),
      )
      .limit(1);

    return c.json({
      // Panggilan keluar aktif butuh key + nomor default server.
      configured: Boolean(env.VAPI_API_KEY && env.VAPI_PHONE_NUMBER_ID),
      apiKeyConfigured: Boolean(env.VAPI_API_KEY),
      defaultPhoneNumberId: env.VAPI_PHONE_NUMBER_ID ?? null,
      numbers,
      selected: row ? toPublicIntegration(row) : null,
      error: listError,
    });
  })
  /* ── Pilih nomor keluar workspace (one-click; kredensial server-side) ── */
  .post(
    '/vapi/connect',
    requireAuth,
    requireWorkspace,
    zValidator('json', vapiConnectSchema),
    async (c) => {
      const workspaceId = c.get('workspaceId');
      const { vapiPhoneNumberId } = c.req.valid('json');

      if (!env.VAPI_API_KEY) {
        return c.json(
          { error: 'VAPI_API_KEY belum dikonfigurasi di server — Voice AI dinonaktifkan. Hubungi administrator project.' },
          503,
        );
      }
      let numbers: VapiPhoneNumberInfo[];
      try {
        numbers = await listOperatorVapiPhoneNumbers();
      } catch (err) {
        console.error('[integrations] list vapi numbers gagal:', err);
        return c.json({ error: 'Gagal memuat daftar nomor dari Vapi. Coba lagi.' }, 502);
      }
      const selected = numbers.find((n) => n.id === vapiPhoneNumberId);
      if (!selected) {
        return c.json({ error: 'Nomor tidak ditemukan di akun Vapi server.' }, 400);
      }

      const integration = await upsertIntegration({
        workspaceId,
        integrationType: 'vapi',
        identifier: selected.number ?? selected.name ?? 'Vapi',
        providerConfig: { vapiPhoneNumberId, phoneNumber: selected.number ?? null },
      });
      return c.json({ integration }, 201);
    },
  )
  /* ── Kembalikan ke nomor default server (VAPI_PHONE_NUMBER_ID) ── */
  .delete('/vapi', requireAuth, requireWorkspace, async (c) => {
    try {
      const result = await deleteIntegration(c.get('workspaceId'), 'vapi');
      return c.json({ ok: true, id: result.id });
    } catch (err) {
      if (err instanceof IntegrationNotFoundError) return c.json({ error: err.message }, 404);
      throw err;
    }
  })

  /* ══════════════════════════════════════════════════════════
   * Voice AI — Bring your own carrier (BYOC), fase-2
   * Workspace menempel API key Telnyx milik MEREKA (dipakai sekali, TIDAK
   * disimpan) → backend membuat kredensial Telnyx di sisi Vapi operator,
   * membeli nomor pilihan bila belum dimiliki, dan mendaftarkannya. Semua
   * idempotent (adopsi credential by name / list-then-create nomor).
   * ══════════════════════════════════════════════════════════ */

  /* ── BYOC: cari nomor di akun Telnyx workspace (key divalidasi, read-only) ── */
  .post(
    '/vapi/byoc/search',
    requireAuth,
    requireWorkspace,
    zValidator('json', vapiByocSearchSchema),
    async (c) => {
      if (!env.VAPI_API_KEY) {
        return c.json(
          { error: 'VAPI_API_KEY belum dikonfigurasi di server — Voice AI dinonaktifkan. Hubungi administrator project.' },
          503,
        );
      }
      const { apiKey, countryCode, areaCode } = c.req.valid('json');
      try {
        const result = await searchTelnyxByoc({
          telnyx: createTelnyxClient(apiKey),
          countryCode,
          areaCode: areaCode ?? undefined,
        });
        return c.json(result);
      } catch (err) {
        if (err instanceof TelnyxApiError) {
          if (err.status === 401 || err.status === 403) {
            return c.json(
              { error: 'API key Telnyx ditolak. Periksa kembali key Anda di portal.telnyx.com.' },
              401,
            );
          }
          return c.json({ error: `Telnyx menolak: ${err.message}` }, 502);
        }
        console.error('[integrations] byoc search gagal:', err);
        return c.json({ error: 'Gagal menghubungi Telnyx. Coba lagi.' }, 502);
      }
    },
  )
  /* ── BYOC: sambungkan nomor pilihan (credential Vapi + beli bila perlu + daftar) ── */
  .post(
    '/vapi/byoc/connect',
    requireAuth,
    requireWorkspace,
    zValidator('json', vapiByocConnectSchema),
    async (c) => {
      const workspaceId = c.get('workspaceId');
      const vapiKey = env.VAPI_API_KEY;
      if (!vapiKey) {
        return c.json(
          { error: 'VAPI_API_KEY belum dikonfigurasi di server — Voice AI dinonaktifkan. Hubungi administrator project.' },
          503,
        );
      }
      const { apiKey, phoneNumber } = c.req.valid('json');

      // Idempotensi: reuse credential dari baris integrasi yang sudah ada
      // (attempt retry / connect ulang tidak membuat credential ganda).
      const [row] = await db
        .select({ providerConfig: workspaceIntegrations.providerConfig })
        .from(workspaceIntegrations)
        .where(
          and(
            eq(workspaceIntegrations.workspaceId, workspaceId),
            eq(workspaceIntegrations.integrationType, 'vapi'),
          ),
        )
        .limit(1);
      const existingConfig = row?.providerConfig as Partial<VapiIntegrationConfig> | null;
      const existingCredentialId = existingConfig?.vapiCredentialId ?? null;

      try {
        const result = await connectTelnyxByoc({
          telnyx: createTelnyxClient(apiKey),
          vapi: new VapiClient({ token: vapiKey }),
          apiKey,
          existingCredentialId,
          credentialName: `oriole-byoc-${workspaceId}`,
          phoneNumber,
        });
        const integration = await upsertIntegration({
          workspaceId,
          integrationType: 'vapi',
          identifier: result.telnyxNumber,
          providerConfig: {
            mode: 'byoc',
            vapiPhoneNumberId: result.vapiPhoneNumberId,
            vapiCredentialId: result.vapiCredentialId,
            phoneNumber: result.telnyxNumber,
          },
        });
        return c.json(
          { integration, purchased: result.purchased, registered: result.registered },
          201,
        );
      } catch (err) {
        if (err instanceof TelnyxApiError) {
          if (err.status === 401 || err.status === 403) {
            return c.json(
              { error: 'API key Telnyx ditolak. Periksa kembali key Anda di portal.telnyx.com.' },
              401,
            );
          }
          return c.json({ error: `Telnyx menolak: ${err.message}` }, 502);
        }
        if (err instanceof VapiCredentialApiError) {
          return c.json({ error: `Vapi menolak kredensial: ${err.message}` }, 502);
        }
        if (err instanceof TelnyxByocNumberUnavailableError) {
          return c.json({ error: err.message }, 400);
        }
        console.error('[integrations] byoc connect gagal:', err);
        return c.json({ error: 'Gagal menyiapkan nomor BYO. Coba lagi.' }, 502);
      }
    },
  )

  /* ══════════════════════════════════════════════════════════
   * Voice AI — panggilan MASUK (inbound) per workspace
   * Customer menelepon nomor ini → agen resepsionis AI menjawab dan bisa
   * membuat booking langsung (tool check_availability / create_booking,
   * lihat lib/vapi-inbound.ts). Nomor dibuat di Vapi (provider 'vapi');
   * kredensial server-side (env VAPI_*). Tanpa VAPI_API_KEY → 503 jelas.
   * ══════════════════════════════════════════════════════════ */

  /* ── Daftar nomor inbound workspace ── */
  .get('/vapi/inbound', requireAuth, requireWorkspace, async (c) => {
    return c.json({
      configured: Boolean(env.VAPI_API_KEY),
      numbers: await listInboundNumbers(c.get('workspaceId')),
    });
  })
  /* ── Daftarkan nomor inbound baru (Vapi menyediakan nomor) ── */
  .post(
    '/vapi/inbound/register',
    requireAuth,
    requireWorkspace,
    zValidator('json', vapiInboundRegisterSchema),
    async (c) => {
      const workspaceId = c.get('workspaceId');
      if (!env.VAPI_API_KEY) {
        return c.json(
          { error: 'VAPI_API_KEY belum dikonfigurasi di server — Voice AI dinonaktifkan. Hubungi administrator project.' },
          503,
        );
      }
      const { name, areaCode } = c.req.valid('json');
      try {
        const number = await registerInboundNumberForWorkspace({
          userId: c.get('userId') ?? null,
          workspaceId,
          name,
          areaCode,
        });
        return c.json({ number }, 201);
      } catch (err) {
        console.error('[integrations] register inbound gagal:', err);
        return c.json({ error: 'Gagal mendaftarkan nomor inbound di Vapi. Coba lagi.' }, 502);
      }
    },
  )
  /* ── Lepas nomor inbound (hapus dari Vapi + mapping lokal) ── */
  .delete('/vapi/inbound/:id', requireAuth, requireWorkspace, async (c) => {
    try {
      await unregisterInboundNumberForWorkspace({
        workspaceId: c.get('workspaceId'),
        inboundNumberId: c.req.param('id'),
      });
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof InboundNumberNotFoundError) {
        return c.json({ error: err.message }, 404);
      }
      console.error('[integrations] unregister inbound gagal:', err);
      return c.json({ error: 'Gagal melepas nomor inbound. Coba lagi.' }, 502);
    }
  });
