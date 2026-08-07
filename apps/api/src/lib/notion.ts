import { and, eq } from 'drizzle-orm';
import { contacts as contactsTable, workspaceIntegrations } from '@oriole/database';

import { db } from '../db/index.ts';

/* ────────────────────────────────────────────────────────────
 * Notion integration — Notion berfungsi sebagai database
 * eksternal untuk aplikasi: kontak project di-sync menjadi
 * baris (page) di sebuah database Notion milik user.
 * ──────────────────────────────────────────────────────────── */

const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_API_VERSION = '2022-06-28';

/** Konfigurasi privat integrasi Notion (disimpan di providerConfig). */
export interface NotionConfig {
  token: string;
  databaseId: string;
  databaseName?: string | null;
}

export class NotionApiError extends Error {
  constructor(
    message: string,
    /** Status HTTP dari API Notion (401/404/429/...). */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'NotionApiError';
  }
}

async function notionFetch<T>(
  token: string,
  path: string,
  init: RequestInit = {},
  attempt = 0,
): Promise<T> {
  const res = await fetch(`${NOTION_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_API_VERSION,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  // Rate limit Notion (~3 req/s per integrasi): retry singkat dengan backoff.
  if (res.status === 429 && attempt < 2) {
    await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    return notionFetch<T>(token, path, init, attempt + 1);
  }
  if (!res.ok) {
    let message = `Notion API ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string; code?: string };
      message = body.message ?? body.code ?? message;
    } catch {
      // body bukan JSON — pakai pesan default.
    }
    throw new NotionApiError(message, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

interface NotionUser {
  id: string;
  name?: string | null;
}

/** Validasi token integrasi (Internal Integration Secret) via GET /users/me. */
export async function getNotionUser(token: string): Promise<{ id: string; name: string | null }> {
  const user = await notionFetch<NotionUser>(token, '/users/me');
  return { id: user.id, name: user.name ?? null };
}

export interface NotionDatabaseOption {
  id: string;
  title: string;
  url: string;
}

interface NotionSearchResult<T> {
  results: T[];
  has_more: boolean;
  next_cursor: string | null;
}

/** Daftar database yang bisa diakses token (POST /v1/search, filter database) — semua halaman. */
export async function listNotionDatabases(token: string): Promise<NotionDatabaseOption[]> {
  const rows: { id: string; url: string; title?: { plain_text?: string }[] }[] = [];
  let cursor: string | null = null;
  do {
    const result: NotionSearchResult<{ id: string; url: string; title?: { plain_text?: string }[] }> =
      await notionFetch<NotionSearchResult<{ id: string; url: string; title?: { plain_text?: string }[] }>>(
        token,
        '/search',
        {
          method: 'POST',
          body: JSON.stringify({
            filter: { property: 'object', value: 'database' },
            page_size: 100,
            ...(cursor ? { start_cursor: cursor } : {}),
          }),
        },
      );
    rows.push(...result.results);
    cursor = result.has_more ? result.next_cursor : null;
  } while (cursor);
  return rows.map((db) => ({
    id: db.id,
    title: db.title?.[0]?.plain_text?.trim() || 'Untitled',
    url: db.url,
  }));
}

interface NotionProperty {
  id: string;
  name: string;
  type: string;
}

export interface NotionDatabaseSchema {
  /** Properti database: key = property id. */
  properties: Record<string, NotionProperty>;
}

/** Ambil skema properti database (GET /v1/databases/:id). */
export async function getNotionDatabaseSchema(
  token: string,
  databaseId: string,
): Promise<NotionDatabaseSchema> {
  const database = await notionFetch<{
    title?: { plain_text?: string }[];
    properties: Record<string, NotionProperty>;
  }>(token, `/databases/${databaseId}`);
  return { properties: database.properties ?? {} };
}

interface NotionPage {
  id: string;
  properties: Record<string, unknown>;
}

/** Semua page dalam database (POST /v1/databases/:id/query) — semua halaman. */
export async function queryNotionPages(
  token: string,
  databaseId: string,
): Promise<NotionPage[]> {
  const rows: NotionPage[] = [];
  let cursor: string | null = null;
  do {
    const result: NotionSearchResult<NotionPage> = await notionFetch<NotionSearchResult<NotionPage>>(
      token,
      `/databases/${databaseId}/query`,
      {
        method: 'POST',
        body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
      },
    );
    rows.push(...(result.results ?? []));
    cursor = result.has_more ? result.next_cursor : null;
  } while (cursor);
  return rows;
}

/* ── Mapping kontak → properti Notion ─────────────────────── */

/** Row kontak yang relevan untuk sync (subset kolom contacts). */
export interface ContactSyncRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  notes: string | null;
  createdAt: Date;
}

/** Ambil teks dari properti page (title/rich_text). */
function extractPageText(properties: Record<string, unknown>, propertyName: string): string {
  const raw = properties[propertyName];
  if (!raw || typeof raw !== 'object') return '';
  const value = raw as { title?: { plain_text?: string }[]; rich_text?: { plain_text?: string }[] };
  const text = value.title?.[0]?.plain_text ?? value.rich_text?.[0]?.plain_text;
  return text?.trim() ?? '';
}

/** Properti title database (wajib ada di semua database Notion). */
function findTitleProperty(schema: NotionDatabaseSchema): NotionProperty | undefined {
  return Object.values(schema.properties).find((prop) => prop.type === 'title');
}

function findProperty(schema: NotionDatabaseSchema, name: string): NotionProperty | undefined {
  return Object.values(schema.properties).find((prop) => prop.name.toLowerCase() === name.toLowerCase());
}

/**
 * Susun payload `properties` untuk create/update page dari satu kontak.
 * Field dipetakan ke properti berdasarkan nama (Name/Phone/Email/Notes/Created);
 * properti yang tidak ada di database dilewati. Hanya title yang wajib.
 */
export function buildContactPagePayload(
  schema: NotionDatabaseSchema,
  contact: ContactSyncRow,
): { properties: Record<string, unknown> } {
  const properties: Record<string, unknown> = {};
  // Setiap database Notion punya tepat satu properti title.
  const titleProp = findTitleProperty(schema);

  if (titleProp) {
    properties[titleProp.name] = { title: [{ text: { content: contact.name } }] };
  }

  const phoneProp = findProperty(schema, 'Phone');
  if (phoneProp?.type === 'rich_text' && contact.phone?.trim()) {
    properties[phoneProp.name] = { rich_text: [{ text: { content: contact.phone } }] };
  }

  const emailProp = findProperty(schema, 'Email');
  if (emailProp?.type === 'rich_text' && contact.email?.trim()) {
    properties[emailProp.name] = { rich_text: [{ text: { content: contact.email } }] };
  }

  const notesProp = findProperty(schema, 'Notes');
  if (notesProp?.type === 'rich_text' && contact.notes?.trim()) {
    properties[notesProp.name] = { rich_text: [{ text: { content: contact.notes } }] };
  }

  const createdProp = findProperty(schema, 'Created') ?? findProperty(schema, 'Created at');
  if (createdProp?.type === 'date') {
    properties[createdProp.name] = { date: { start: contact.createdAt.toISOString() } };
  }

  return { properties };
}

/** Normalisasi nomor telepon untuk dedup — abaikan spasi/tanda baca/+. */
const normalizePhone = (value: string): string => value.replace(/\D/g, '');

/**
 * Kunci unik kontak untuk dedup: nomor telepon (ternormalisasi) bila properti
 * Phone tersedia, selain itu judul (nama). Dipakai mapping page lama → kontak.
 */
export function contactSyncKey(schema: NotionDatabaseSchema, contact: ContactSyncRow): string {
  const phoneProp = findProperty(schema, 'Phone');
  if (phoneProp?.type === 'rich_text' && contact.phone?.trim()) {
    return `phone:${normalizePhone(contact.phone)}`;
  }
  return `title:${contact.name.trim()}`;
}

function buildExistingMap(pages: NotionPage[], schema: NotionDatabaseSchema): Map<string, string> {
  const map = new Map<string, string>();
  const phoneProp = findProperty(schema, 'Phone');
  const titleProp = findTitleProperty(schema);
  for (const page of pages) {
    const title = titleProp ? extractPageText(page.properties, titleProp.name) : '';
    const phone = phoneProp ? extractPageText(page.properties, phoneProp.name) : '';
    const key = phone ? `phone:${normalizePhone(phone)}` : title ? `title:${title}` : '';
    if (key && !map.has(key)) map.set(key, page.id);
  }
  return map;
}

export interface NotionSyncResult {
  created: number;
  updated: number;
  total: number;
}

/**
 * Sinkronkan semua kontak workspace ke database Notion terhubung:
 * buat page baru untuk kontak yang belum ada, update yang sudah ada
 * (dedup via nomor telepon / nama). Memperbarui lastSyncAt bila berhasil.
 */
export async function syncContactsToNotion(workspaceId: string): Promise<NotionSyncResult> {
  const [integration] = await db
    .select()
    .from(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, workspaceId),
        eq(workspaceIntegrations.integrationType, 'notion'),
      ),
    )
    .limit(1);
  if (!integration) throw new NotionApiError('Integrasi Notion belum terhubung', 409);

  const config = integration.providerConfig as unknown as NotionConfig;
  if (!config.token || !config.databaseId) {
    throw new NotionApiError('Konfigurasi Notion tidak lengkap', 400);
  }

  const contacts = await db
    .select({
      id: contactsTable.id,
      name: contactsTable.name,
      phone: contactsTable.phone,
      email: contactsTable.email,
      notes: contactsTable.notes,
      createdAt: contactsTable.createdAt,
    })
    .from(contactsTable)
    .where(eq(contactsTable.workspaceId, workspaceId));

  const schema = await getNotionDatabaseSchema(config.token, config.databaseId);
  const pages = await queryNotionPages(config.token, config.databaseId);
  const existing = buildExistingMap(pages, schema);

  let created = 0;
  let updated = 0;
  for (const contact of contacts) {
    const payload = buildContactPagePayload(schema, contact);
    const key = contactSyncKey(schema, contact);
    const existingPageId = key ? existing.get(key) : undefined;

    if (existingPageId) {
      await notionFetch(config.token, `/pages/${existingPageId}`, {
        method: 'PATCH',
        body: JSON.stringify({ properties: payload.properties }),
      });
      updated += 1;
    } else {
      await notionFetch(config.token, '/pages', {
        method: 'POST',
        body: JSON.stringify({
          parent: { database_id: config.databaseId },
          properties: payload.properties,
        }),
      });
      created += 1;
    }
  }

  await db
    .update(workspaceIntegrations)
    .set({ lastSyncAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, workspaceId),
        eq(workspaceIntegrations.integrationType, 'notion'),
      ),
    );

  return { created, updated, total: contacts.length };
}
