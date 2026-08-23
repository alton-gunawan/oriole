import { execSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { loadRootEnv } from '@oriole/config';
import { createDb, workspaceChannels } from '@oriole/database';

import { telegramSetWebhook } from '../lib/telegram.ts';

/**
 * dev-services — KHUSUS DEVELOPMENT.
 *
 * Dipanggil otomatis oleh `pnpm dev` (root) sebelum turbo menjalankan
 * web + api. Menghidupkan layanan pendukung pipeline inbound messaging:
 *
 *   1. Cloudflare quick tunnel → URL HTTPS publik untuk webhook Telegram
 *      (Telegram menolak http/localhost).
 *   1b. Named tunnel dari `~/.cloudflared/config.yml` (conductor.my.id →
 *      localhost:5173, api.conductor.my.id → localhost:3000) — landing page
 *      & API bisa diakses publik. Dilewati bila cloudflared tidak ada.
 *   2. Sinkronkan `WEBHOOK_BASE_URL` di root `.env` — URL quick tunnel
 *      BERUBAH setiap restart, jadi harus di-update + webhook didaftarkan
 *      ulang agar bot tetap menerima update.
 *   3. Daftarkan ulang webhook Telegram (setWebhook) untuk semua channel
 *      workspace, memakai secret lama yang tersimpan (tidak direset).
 *   4. Inngest Dev Server (localhost:8288) — `inngest.send()` webhook
 *      butuh Dev Server ini di development (tanpa INNGEST_EVENT_KEY).
 *
 * Jebakan DNS quick tunnel: hostname baru butuh waktu hingga ~1 menit untuk
 * propagate ke resolver publik. setWebhook yang dipanggil terlalu cepat
 * membuat resolver Telegram meng-cache NXDOMAIN (negative cache) sehingga
 * hostname itu GAGAL SELAMANYA walau DNS sudah sehat — satu-satunya obat
 * adalah rotasi ke URL tunnel baru. Script ini:
 *   - menunggu DNS hangat (lokal + 8.8.8.8 + 1.1.1.1) sebelum setWebhook
 *     pertama, lalu
 *   - merotasi tunnel (URL baru) bila setWebhook tetap gagal karena DNS.
 *
 * Guard:
 *   - NODE_ENV=production → skip semua (script ini untuk dev saja).
 *   - WEBHOOK_BASE_URL permanen (domain publik, bukan trycloudflare) →
 *     tunnel otomatis dilewati, URL Anda tidak diganggu.
 *   - Tidak pernah hard-fail `pnpm dev`: error dicatat sebagai warning.
 *
 * State disimpan di `node_modules/.cache/oriole/` (gitignored) agar run
 * berikutnya me-reuse tunnel yang masih hidup alih-alih membuat duplikat.
 */

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const CACHE_DIR = join(ROOT, 'node_modules', '.cache', 'oriole');
const TUNNEL_STATE_FILE = join(CACHE_DIR, 'tunnel.json');
const INNGEST_LOG = join(CACHE_DIR, 'inngest.log');
const TUNNEL_TARGET = process.env.TUNNEL_TARGET ?? 'http://localhost:3000';
const API_INNGEST_URL = 'http://localhost:3000/api/inngest';
const INNGEST_DEV_PORT = 8288;
const MAX_TUNNEL_GENERATIONS = 3;
const NAMED_TUNNEL_ID = 'e28977ac-73e8-430e-85fa-1ff1ff1485d7';
const NAMED_TUNNEL_STATE_FILE = join(CACHE_DIR, 'named-tunnel.json');
const NAMED_TUNNEL_LOG = join(CACHE_DIR, 'named-tunnel.log');

interface TunnelState {
  pid: number | null;
  url: string;
  port: number;
  /** Log milik generasi tunnel ini — unik per spawn agar proses lama yang
   *  tidak bisa dimatikan tidak mengotori log tunnel baru. */
  log: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveFn) => setTimeout(resolveFn, ms));
}

function isPortOpen(port: number, host = '127.0.0.1', timeoutMs = 700): Promise<boolean> {
  return new Promise((resolveFn) => {
    const sock = createConnection({ port, host });
    const done = (ok: boolean): void => {
      sock.destroy();
      resolveFn(ok);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    setTimeout(() => done(false), timeoutMs);
  });
}

function isPidAlive(pid: number, expectedName?: string): boolean {
  try {
    process.kill(pid, 0);
    if (!expectedName) return true;
    const comm = execSync(`ps -p ${pid} -o comm=`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return comm.toLowerCase().includes(expectedName.toLowerCase());
  } catch {
    return false;
  }
}

function hasBinary(name: string): boolean {
  try {
    execSync(`command -v ${name}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function readTunnelState(): TunnelState | null {
  try {
    if (!existsSync(TUNNEL_STATE_FILE)) return null;
    const parsed = JSON.parse(readFileSync(TUNNEL_STATE_FILE, 'utf8')) as Partial<TunnelState>;
    if (
      typeof parsed.url !== 'string' ||
      typeof parsed.port !== 'number' ||
      typeof parsed.log !== 'string'
    )
      return null;
    return {
      pid: typeof parsed.pid === 'number' ? parsed.pid : null,
      url: parsed.url,
      port: parsed.port,
      log: parsed.log,
    };
  } catch {
    return null;
  }
}

function writeTunnelState(state: TunnelState): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(TUNNEL_STATE_FILE, JSON.stringify(state, null, 2));
  } catch {
    // State hanya optimasi reuse — gagal menulis bukan masalah fatal.
  }
}

/** URL HTTPS permanen (bukan quick tunnel trycloudflare) → jangan diganggu. */
function looksLikePermanentUrl(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    const host = u.hostname.toLowerCase();
    if (u.protocol !== 'https:') return false;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
    if (host.endsWith('.local') || host.endsWith('.localhost')) return false;
    if (host.endsWith('.trycloudflare.com')) return false;
    return true;
  } catch {
    return false;
  }
}

async function waitForTunnelUrl(logPath: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    const match = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match) return match[0];
    await sleep(500);
  }
  throw new Error(`Tidak ada URL tunnel dalam ${timeoutMs / 1000}s (lihat ${logPath})`);
}

/** Ganti baris WEBHOOK_BASE_URL di root .env (atau tambahkan bila belum ada). */
function syncEnvWebhookBaseUrl(url: string): void {
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, 'utf8');
  const linePattern = /^WEBHOOK_BASE_URL=.*$/m;
  const next = linePattern.test(content)
    ? content.replace(linePattern, `WEBHOOK_BASE_URL=${url}`)
    : `${content.trimEnd()}\n\n# Di-update otomatis oleh \`pnpm dev:services\` (dev) saat URL tunnel berganti.\nWEBHOOK_BASE_URL=${url}\n`;
  if (next !== content) writeFileSync(envPath, next);
}

/** Cek apakah hostname bisa di-resolve lewat resolver tertentu (tanpa shell out). */
async function resolveVia(hostname: string, servers: string[]): Promise<boolean> {
  const previous = dns.getServers();
  dns.setServers(servers);
  try {
    await dns.resolve4(hostname);
    return true;
  } catch {
    return false;
  } finally {
    dns.setServers(previous);
  }
}

/**
 * Tunggu DNS hangat: hostname tunnel harus resolve di resolver LOKAL dan
 * resolver publik (8.8.8.8, 1.1.1.1) — proxy sinyal bahwa resolver Telegram
 * akan melihatnya juga. Ditambah jeda settle agar edge routing stabil.
 * Kegagalan di sini TIDAK mematikan alur (retry + rotasi menangani sisanya),
 * tapi mencegah setWebhook pertama melihat NXDOMAIN (yang bisa meng-cache
 * kegagalan permanen di sisi Telegram).
 */
async function waitForDnsWarm(url: string, timeoutMs = 60_000): Promise<boolean> {
  const hostname = new URL(url).hostname;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let localOk = false;
    try {
      await dns.lookup(hostname);
      localOk = true;
    } catch {
      localOk = false;
    }
    const publicOk = (await resolveVia(hostname, ['8.8.8.8'])) && (await resolveVia(hostname, ['1.1.1.1']));
    if (localOk && publicOk) {
      await sleep(8_000);
      return true;
    }
    await sleep(1_500);
  }
  return false;
}

/**
 * setWebhook dengan retry — lapis pengaman setelah waitForDnsWarm.
 */
async function setWebhookWithRetry(
  token: string,
  url: string,
  secret: string,
  attempts = 6,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await telegramSetWebhook({ token, url, secretToken: secret });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        console.warn(`   ⚠️ setWebhook percobaan ${attempt}/${attempts} gagal: ${(error as Error).message} — coba lagi…`);
        await sleep(3_000);
      }
    }
  }
  throw lastError;
}

/** Error DNS dari Telegram ("Failed to resolve host" / bad webhook). */
function isDnsError(error: unknown): boolean {
  return /resolve host|bad webhook|Name or service not known/i.test((error as Error).message ?? '');
}

/**
 * Deteksi tunnel yang MATI padahal proses cloudflared-nya masih hidup.
 *
 * Quick tunnel (trycloudflare.com) bersifat ephemeral: begitu koneksinya
 * terputus cukup lama (laptop sleep / ganti jaringan), Cloudflare menghapus
 * registrasi URL-nya. cloudflared tidak pernah bisa mendaftarkan ulang URL
 * yang sama — ia hanya mencatat `ERR ... "Unauthorized: Tunnel not found"`
 * berulang-ulang. `isPidAlive` saja TIDAK cukup: pid hidup ≠ tunnel sehat.
 *
 * Setiap spawn memakai file log SENDIRI (lihat `newTunnelLogPath`), sehingga
 * keberadaan signature "Tunnel not found" di ekor log benar-benar milik
 * generasi tunnel tersebut — bukti kuat URL sudah mati dan wajib diganti.
 */
function isTunnelLogHealthy(logPath: string): boolean {
  try {
    if (!existsSync(logPath)) return true;
    const log = readFileSync(logPath, 'utf8');
    return !/Tunnel not found/i.test(log.slice(-16_384));
  } catch {
    // Log tak terbaca → asumsikan sehat (jangan salah buang tunnel).
    return true;
  }
}

/**
 * Path log baru per-generasi tunnel — unik agar tunnel lama (yang mungkin
 * TIDAK bisa dimatikan, mis. dijalankan sebagai root lewat `sudo`) tidak
 * menimpa output tunnel baru di file yang sama.
 */
function newTunnelLogPath(): string {
  return join(CACHE_DIR, `tunnel-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}.log`);
}

/** Hentikan semua proses cloudflared quick tunnel milik dev-services. */
function killTunnelProcesses(): void {
  try {
    execSync(`pkill -f "cloudflared tunnel --url ${TUNNEL_TARGET}"`, { stdio: 'ignore' });
  } catch {
    // Tidak ada proses cloudflared — lanjut.
  }
}

/**
 * Pastikan ada quick tunnel yang hidup. Mengembalikan base URL webhook,
 * atau null bila tunnel tidak dapat dijalankan (mis. cloudflared belum
 * diinstall — warning, `pnpm dev` tetap lanjut).
 */
async function ensureTunnel(): Promise<string | null> {
  const currentBase = (process.env.WEBHOOK_BASE_URL ?? '').replace(/\/+$/, '');

  // URL permanen milik user → jangan sentuh.
  if (currentBase && looksLikePermanentUrl(currentBase)) {
    console.log(`[dev-services] WEBHOOK_BASE_URL permanen terdeteksi (${currentBase}) → tunnel otomatis dilewati.`);
    return currentBase;
  }

  if (!hasBinary('cloudflared')) {
    console.warn('[dev-services] cloudflared tidak ditemukan. Install dengan `brew install cloudflared`, lalu jalankan ulang `pnpm dev`. Tunnel & webhook Telegram dilewati.');
    return null;
  }

  // Tunnel lama yang pid-nya masih hidup TAPI sudah mati di sisi Cloudflare
  // ("Tunnel not found") TIDAK boleh di-reuse — URL-nya sudah hilang selamanya.
  // Proses lama dicoba dimatikan (best-effort; bisa gagal bila root-owned),
  // lalu state dibuang dan tunnel baru dibuat dengan log + URL baru.
  const state = readTunnelState();
  if (state && state.port === 3000 && state.pid != null && isPidAlive(state.pid, 'cloudflared')) {
    if (isTunnelLogHealthy(state.log)) {
      syncEnvWebhookBaseUrl(state.url);
      console.log(`[dev-services] Tunnel masih hidup (reuse): ${state.url}`);
      return state.url;
    }
    console.warn('[dev-services] Tunnel lama mati di Cloudflare ("Tunnel not found") → dibuat ulang dengan URL baru.');
    killTunnelProcesses();
  }

  // State basi / tidak ada → buang sisa state lama sebelum spawn baru.
  try {
    if (existsSync(TUNNEL_STATE_FILE)) unlinkSync(TUNNEL_STATE_FILE);
  } catch {
    // Abaikan — spawn baru akan menimpa state.
  }

  // Spawn tunnel baru dengan log PER-GENERASI. Log tidak di-share dengan proses
  // lama (yang mungkin root-owned dan tidak bisa dimatikan) — masing-masing
  // menulis ke file sendiri, sehingga waitForTunnelUrl & health check hanya
  // melihat output generasi ini dan tidak pernah "menemukan" URL mati lama.
  mkdirSync(CACHE_DIR, { recursive: true });
  const logPath = newTunnelLogPath();
  const outFd = openSync(logPath, 'w');
  // `--protocol http2` (TCP) + `--edge-ip-version 4`: di beberapa jaringan
  // (termasuk dev machine ini) outbound UDP/QUIC (port 7844) diblokir sehingga
  // quick tunnel yang register via QUIC mati dalam hitungan detik — HTTP/2
  // via TCP selalu tersedia dan lebih tahan terhadap NAT/firewall.
  const child = spawn(
    'cloudflared',
    ['tunnel', '--url', TUNNEL_TARGET, '--no-autoupdate', '--protocol', 'http2', '--edge-ip-version', '4'],
    { detached: true, stdio: ['ignore', outFd, outFd], cwd: ROOT },
  );
  child.unref();

  try {
    const url = await waitForTunnelUrl(logPath, 45_000);
    writeTunnelState({ pid: child.pid ?? null, url, port: 3000, log: logPath });
    syncEnvWebhookBaseUrl(url);
    console.log(`[dev-services] Tunnel baru siap: ${url}`);
    return url;
  } catch (error) {
    console.warn(`[dev-services] Gagal memulai tunnel: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Matikan tunnel saat ini (state + proses) lalu buat yang baru dengan URL
 * berbeda. Dipakai ketika webhook gagal karena DNS ter-poison — hostname
 * lama tidak bisa diselamatkan.
 */
async function rotateTunnel(): Promise<string | null> {
  console.warn('[dev-services] Rotasi tunnel (URL lama ter-poison DNS)…');
  killTunnelProcesses();
  try {
    if (existsSync(TUNNEL_STATE_FILE)) unlinkSync(TUNNEL_STATE_FILE);
  } catch {
    // Abaikan — ensureTunnel akan menimpa state baru.
  }
  await sleep(2_000);
  return ensureTunnel();
}

/**
 * Daftarkan ulang webhook Telegram untuk semua channel (secret lama
 * dipertahankan). Mengembalikan false bila setWebhook gagal karena DNS —
 * pemanggil harus merotasi tunnel dan mencoba lagi.
 */
async function registerTelegramWebhooks(baseUrl: string): Promise<boolean> {
  if (!(await waitForDnsWarm(baseUrl))) {
    console.warn(`[dev-services] DNS ${new URL(baseUrl).hostname} belum stabil setelah 60s — webhook tetap dicoba (retry), bisa jadi perlu rotasi.`);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.warn('[dev-services] DATABASE_URL tidak ada di .env → webhook Telegram tidak didaftarkan ulang.');
    return true;
  }

  try {
    const db = createDb(databaseUrl);
    const channels = await db
      .select()
      .from(workspaceChannels)
      .where(eq(workspaceChannels.channelType, 'telegram'));

    if (channels.length === 0) {
      console.log('[dev-services] Tidak ada channel Telegram di database → webhook dilewati.');
      return true;
    }

    for (const channel of channels) {
      const config = (channel.providerConfig ?? {}) as Record<string, unknown>;
      const token = config.botToken;
      if (typeof token !== 'string' || token.length === 0) continue;

      // Secret lama dipertahankan agar webhook yang sedang terdaftar tidak
      // patah; hanya generate + simpan bila memang belum ada.
      let secret = typeof config.webhookSecret === 'string' ? config.webhookSecret : '';
      if (!secret) {
        secret = randomUUID();
        await db
          .update(workspaceChannels)
          .set({ providerConfig: { ...config, webhookSecret: secret }, updatedAt: new Date() })
          .where(eq(workspaceChannels.id, channel.id));
      }

      const url = `${baseUrl}/api/webhooks/telegram/${channel.workspaceId}`;
      try {
        await setWebhookWithRetry(token, url, secret);
        console.log(`   ✅ Webhook Telegram ${channel.identifier ?? channel.workspaceId} → ${url}`);
      } catch (error) {
        if (isDnsError(error)) {
          console.warn(`[dev-services] Webhook Telegram gagal karena DNS (${(error as Error).message}) — tunnel akan dirotasi.`);
          return false;
        }
        console.warn(`[dev-services] Gagal setWebhook ${channel.identifier ?? channel.workspaceId}: ${(error as Error).message} — dilanjutkan.`);
      }
    }
    return true;
  } catch (error) {
    console.warn(`[dev-services] Gagal membaca channel dari database: ${(error as Error).message}`);
    return true;
  }
}

/**
 * Named tunnel produksi-dev: `cloudflared tunnel run` untuk
 * `~/.cloudflared/config.yml` (conductor.my.id + api.conductor.my.id).
 *
 * Dipisah dari quick tunnel: URL-nya permanen, tidak perlu sync .env atau
 * webhook — hanya perlu proses cloudflared-nya hidup. State pid disimpan
 * agar `pnpm dev` berikutnya me-reuse proses yang masih hidup.
 */
async function ensureNamedTunnel(): Promise<void> {
  if (!hasBinary('cloudflared')) {
    console.warn('[dev-services] cloudflared tidak ditemukan — tunnel conductor.my.id tidak dijalankan. Install dengan `brew install cloudflared`.');
    return;
  }

  // Proses yang masih hidup → reuse (log dibiarkan, append di spawn baru).
  const state = readNamedTunnelState();
  if (state?.pid != null && isPidAlive(state.pid, 'cloudflared')) {
    console.log('[dev-services] Tunnel conductor.my.id sudah berjalan — dilewati.');
    return;
  }
  try {
    if (existsSync(NAMED_TUNNEL_STATE_FILE)) unlinkSync(NAMED_TUNNEL_STATE_FILE);
  } catch {
    // Abaikan — state baru akan ditimpa.
  }

  mkdirSync(CACHE_DIR, { recursive: true });
  const outFd = openSync(NAMED_TUNNEL_LOG, 'w'); // 'w': log per-spawn, jangan baca baris generasi lama.
  const child = spawn('cloudflared', ['tunnel', 'run', NAMED_TUNNEL_ID], {
    detached: true,
    stdio: ['ignore', outFd, outFd],
    cwd: ROOT,
  });
  child.unref();
  writeNamedTunnelState({ pid: child.pid ?? null });

  // Proses hidup ≠ koneksi edge terdaftar; tunggu signature di log.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!isPidAlive(child.pid ?? -1, 'cloudflared')) break; // gagal cepat (mis. kredensial hilang) → langsung warn.
    const log = existsSync(NAMED_TUNNEL_LOG) ? readFileSync(NAMED_TUNNEL_LOG, 'utf8') : '';
    if (/Registered tunnel connection/i.test(log)) {
      console.log('[dev-services] Tunnel conductor.my.id siap (landing → localhost:5173, api → localhost:3000).');
      return;
    }
    await sleep(500);
  }
  console.warn(`[dev-services] Tunnel conductor.my.id belum connect setelah 30s — cek ${NAMED_TUNNEL_LOG}`);
}

interface NamedTunnelState {
  pid: number | null;
}

function readNamedTunnelState(): NamedTunnelState | null {
  try {
    if (!existsSync(NAMED_TUNNEL_STATE_FILE)) return null;
    const parsed = JSON.parse(readFileSync(NAMED_TUNNEL_STATE_FILE, 'utf8')) as Partial<NamedTunnelState>;
    return typeof parsed.pid === 'number' ? { pid: parsed.pid } : null;
  } catch {
    return null;
  }
}

function writeNamedTunnelState(state: NamedTunnelState): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(NAMED_TUNNEL_STATE_FILE, JSON.stringify(state));
  } catch {
    // State hanya optimasi reuse — gagal menulis bukan masalah fatal.
  }
}

/** Pastikan Inngest Dev Server (localhost:8288) hidup. */
async function ensureInngestDev(): Promise<void> {
  if (await isPortOpen(INNGEST_DEV_PORT)) {
    console.log('[dev-services] Inngest Dev Server sudah berjalan (http://localhost:8288).');
    return;
  }

  const bin = join(ROOT, 'apps', 'api', 'node_modules', '.bin', 'inngest-cli');
  if (!existsSync(bin)) {
    console.warn('[dev-services] inngest-cli tidak ditemukan — jalankan `pnpm dev:inngest` manual.');
    return;
  }

  mkdirSync(CACHE_DIR, { recursive: true });
  const outFd = openSync(INNGEST_LOG, 'a');
  const child = spawn(bin, ['dev', '-u', API_INNGEST_URL], {
    detached: true,
    stdio: ['ignore', outFd, outFd],
    cwd: join(ROOT, 'apps', 'api'),
  });
  child.unref();

  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (await isPortOpen(INNGEST_DEV_PORT)) {
      console.log('[dev-services] Inngest Dev Server berjalan di http://localhost:8288.');
      return;
    }
    await sleep(500);
  }
  console.warn(`[dev-services] Inngest Dev Server belum merespons dalam 25s — cek ${INNGEST_LOG}`);
}

async function main(): Promise<void> {
  loadRootEnv();

  if (process.env.NODE_ENV === 'production') {
    console.log('[dev-services] NODE_ENV=production → dilewati (script khusus development).');
    return;
  }
  if (process.platform === 'win32') {
    console.warn('[dev-services] Tidak didukung di Windows — jalankan `cloudflared tunnel --url http://localhost:3000` dan `pnpm dev:inngest` secara manual.');
    return;
  }

  // Rotasi otomatis hingga MAX_TUNNEL_GENERATIONS bila webhook gagal DNS.
  let baseUrl = await ensureTunnel();
  let generation = 0;
  while (baseUrl && generation < MAX_TUNNEL_GENERATIONS) {
    const ok = await registerTelegramWebhooks(baseUrl);
    if (ok) break;
    generation++;
    baseUrl = await rotateTunnel();
  }

  await ensureNamedTunnel();
  await ensureInngestDev();
  console.log('\n[dev-services] Selesai.');
}

main().catch((error) => {
  console.error('[dev-services] Error fatal:', error);
  process.exit(1);
});
