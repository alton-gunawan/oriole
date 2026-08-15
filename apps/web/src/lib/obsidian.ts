import { apiFetch } from './api';
import type { ContactRecord, ContactsListResponse } from './contacts';

/**
 * Integrasi Obsidian — mirror kontak bisnis ke vault Obsidian lokal sebagai
 * catatan markdown (plugin "Local REST API"). Sinkronisasi berjalan dari
 * BROWSER (localhost vault tidak bisa dijangkau API server di production),
 * jadi konfigurasi disimpan per-perangkat di localStorage.
 */

export interface ObsidianConfig {
  /** Base URL vault — HTTP (plugin: Enable HTTP server) atau HTTPS 27124. */
  url: string;
  /** API key dari Settings → Local REST API. */
  apiKey: string;
  /** Folder tujuan di dalam vault (dibuat otomatis bila belum ada). */
  folderPath: string;
}

const CONFIG_KEY = 'oriole.obsidian.config';
const LAST_SYNC_KEY = 'oriole.obsidian.lastSyncAt';

export class ObsidianError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ObsidianError';
  }
}

/* ── Penyimpanan lokal per-perangkat ───────────────────────── */

export function loadObsidianConfig(): ObsidianConfig | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ObsidianConfig;
    if (!parsed.url?.trim() || !parsed.apiKey?.trim()) return null;
    return { url: parsed.url.trim(), apiKey: parsed.apiKey.trim(), folderPath: parsed.folderPath?.trim() || 'Oriole' };
  } catch {
    return null;
  }
}

export function saveObsidianConfig(config: ObsidianConfig): void {
  localStorage.setItem(
    CONFIG_KEY,
    JSON.stringify({ ...config, url: config.url.trim(), apiKey: config.apiKey.trim(), folderPath: config.folderPath.trim() || 'Oriole' }),
  );
}

export function clearObsidianConfig(): void {
  localStorage.removeItem(CONFIG_KEY);
  localStorage.removeItem(LAST_SYNC_KEY);
}

export function getObsidianLastSyncAt(): string | null {
  return localStorage.getItem(LAST_SYNC_KEY);
}

export function setObsidianLastSyncAt(iso: string): void {
  localStorage.setItem(LAST_SYNC_KEY, iso);
}

/* ── Klien API Local REST ──────────────────────────────────── */

async function obsidianFetch<T>(
  config: ObsidianConfig,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${config.url.replace(/\/+$/, '')}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
    });
  } catch {
    // TypeError: server mati / CORS memblokir — keduanya tampil sama di fetch.
    throw new ObsidianError(
      'Tidak bisa menjangkau Obsidian. Pastikan plugin Local REST API aktif, HTTP server dinyalakan, dan CORS mengizinkan origin ini.',
    );
  }
  if (res.status === 401) {
    throw new ObsidianError('API key ditolak Obsidian.');
  }
  if (!res.ok) {
    throw new ObsidianError(`Obsidian merespons status ${res.status}.`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface ObsidianServerInfo {
  authenticated: boolean;
  apiVersion?: string;
  obsidianVersion?: string;
  author?: string;
  pluginVersion?: string;
}

/** Cek koneksi: GET / (tanpa auth). `authenticated=false` = API key salah. */
export async function testObsidianConnection(config: ObsidianConfig): Promise<ObsidianServerInfo> {
  const info = await obsidianFetch<ObsidianServerInfo>(config, '/');
  if (!info.authenticated) {
    throw new ObsidianError('API key ditolak Obsidian.');
  }
  return info;
}

/* ── Kontak → catatan markdown ─────────────────────────────── */

/** Nama file aman: buang karakter terlarang di nama file vault. */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\\.+$/g, '');
  return cleaned || 'Kontak';
}

/**
 * Nama file unik per kontak: akhiran digit telepon (atau potongan id) mencegah
 * dua kontak yang namanya sama setelah sanitasi menimpa catatan satu sama lain.
 */
function uniqueContactFileName(contact: ContactRecord): string {
  const base = sanitizeFileName(contact.name);
  const phoneDigits = (contact.phone ?? '').replace(/\D/g, '');
  const suffix = phoneDigits ? phoneDigits.slice(-8) : contact.id.slice(0, 8);
  return `${base} - ${suffix}.md`;
}

/** Susun isi catatan markdown (frontmatter + ringkasan) dari satu kontak. */
export function buildContactNote(contact: ContactRecord): string {
  const quote = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const frontmatter = [
    '---',
    `name: "${quote(contact.name)}"`,
    `phone: "${quote(contact.phone)}"`,
    contact.email ? `email: "${quote(contact.email)}"` : null,
    `created: "${contact.createdAt}"`,
    '---',
    '',
    `# ${contact.name}`,
    '',
  ];
  const body: string[] = [];
  if (contact.phone) body.push(`- **Telepon:** ${contact.phone}`);
  if (contact.email) body.push(`- **Email:** ${contact.email}`);
  if (contact.notes) body.push('', contact.notes, '');
  return [...frontmatter, ...body].filter((line) => line !== null).join('\n');
}

function encodeVaultPath(folderPath: string, fileName: string): string {
  const segments = folderPath
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map(encodeURIComponent);
  return [...segments, encodeURIComponent(fileName)].join('/');
}

/**
 * Tulis semua kontak ke vault sebagai catatan markdown (PUT = create atau
 * overwrite). Folder dibuat otomatis oleh plugin bila belum ada.
 */
export async function syncContactsToObsidian(
  config: ObsidianConfig,
  contacts: ContactRecord[],
): Promise<{ written: number; total: number }> {
  let written = 0;
  for (const contact of contacts) {
    const path = encodeVaultPath(config.folderPath, uniqueContactFileName(contact));
    await obsidianFetch<unknown>(config, `/vault/${path}`, {
      method: 'PUT',
      body: JSON.stringify({ content: buildContactNote(contact) }),
    });
    written += 1;
  }
  return { written, total: contacts.length };
}

/** Ambil SEMUA kontak workspace (loop pagination kursor, page 200). */
export async function fetchAllContacts(): Promise<ContactRecord[]> {
  const all: ContactRecord[] = [];
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams({ limit: '200' });
    if (cursor) params.set('cursor', cursor);
    const response = await apiFetch<ContactsListResponse>(`/contacts?${params.toString()}`);
    all.push(...response.contacts);
    cursor = response.nextCursor;
  } while (cursor);
  return all;
}
