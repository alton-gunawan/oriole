import { and, eq, gte, notInArray, sql } from 'drizzle-orm';
import { conversations, customerChannels, messages, workspaceChannels } from '@oriole/database';

import { db } from '../db/index.ts';
import { chatIdToWaId, type WahaMessagePayload, type WahaWebhookEvent } from './waha-mapping.ts';
import { WahaApiError, wahaGetMe, wahaGetSession } from '../services/waha.ts';

/**
 * Health state machine channel WhatsApp BYO (unofficial, WAHA).
 *
 * Produk-level states (spec docs/bring-your-own-whatsapp.md §7) dipetakan dari
 * sinyal WAHA (session.status webhook + probe watchdog + error outbound):
 *
 *   connecting   STARTING / SCAN_QR_CODE (pairing pertama)
 *   qr-expired   QR TTL habis (dipersist route refresh-qr)
 *   connected    WORKING + me.id
 *   restricted   session.status data.reachoutTimelock.isActive (463 timelock)
 *   disconnected FAILED / STOPPED / gateway tak terjangkau saat probe
 *   banned       402/403/463 di luar jendela timelock / body menyebut banned
 *
 * Watchdog (Inngest cron 5 menit) memanggil probeWahaChannelHealth; webhook
 * adapter memanggil applyWahaSessionStatus / applyWahaMessageAck; guard
 * outbound (services/whatsapp.ts) memanggil updateWahaHealth + helpers kuota.
 */

export type WahaHealthState =
  | 'connecting'
  | 'qr-expired'
  | 'connected'
  | 'restricted'
  | 'disconnected'
  | 'banned';

export const WAHA_HEALTH_STATES: WahaHealthState[] = [
  'connecting',
  'qr-expired',
  'connected',
  'restricted',
  'disconnected',
  'banned',
];

export interface WahaHealth {
  state: WahaHealthState;
  lastSeenAt: string | null;
  lastStatusAt: string | null;
  /** Waktu timelock 463 berakhir (ISO) — null = tidak sedang dibatasi. */
  reachoutTimelockUntil: string | null;
  lastError: { code: number; message: string; at: string } | null;
  /**
   * Status session mentah terakhir dari gateway (WORKING / FAILED / …).
   * Dipakai UI untuk membedakan 'FAILED tapi masih ter-pair' (LID Connection
   * Failure — sembuh dengan re-pairing) dari STOPPED / gateway tak terjangkau
   * (health state yang sama 'disconnected'). null = belum pernah ada status.
   */
  lastStatus: string | null;
}

export function defaultWahaHealth(): WahaHealth {
  return {
    state: 'connecting',
    lastSeenAt: null,
    lastStatusAt: null,
    reachoutTimelockUntil: null,
    lastError: null,
    lastStatus: null,
  };
}

function isWahaHealthState(value: unknown): value is WahaHealthState {
  return typeof value === 'string' && (WAHA_HEALTH_STATES as string[]).includes(value);
}

/** Parse defensif providerConfig.health — field rusak/salah tipe jatuh ke default. */
export function readWahaHealth(providerConfig: Record<string, unknown>): WahaHealth {
  const raw = (providerConfig.health ?? {}) as Record<string, unknown>;
  const health = defaultWahaHealth();
  if (isWahaHealthState(raw.state)) health.state = raw.state;
  if (typeof raw.lastSeenAt === 'string') health.lastSeenAt = raw.lastSeenAt;
  if (typeof raw.lastStatusAt === 'string') health.lastStatusAt = raw.lastStatusAt;
  if (typeof raw.reachoutTimelockUntil === 'string') health.reachoutTimelockUntil = raw.reachoutTimelockUntil;
  if (typeof raw.lastStatus === 'string') health.lastStatus = raw.lastStatus;
  if (raw.lastError && typeof raw.lastError === 'object') {
    const error = raw.lastError as Record<string, unknown>;
    health.lastError = {
      code: typeof error.code === 'number' ? error.code : 0,
      message: typeof error.message === 'string' ? error.message : '',
      at: typeof error.at === 'string' ? error.at : '',
    };
  }
  return health;
}

/**
 * Status session WAHA → health state. `current` dipakai agar status
 * transisi (STARTING/STOPPING) tidak menurunkan session yang sudah connected.
 */
export function wahaStatusToState(
  status: string | null | undefined,
  current: WahaHealthState,
): WahaHealthState | null {
  switch (status) {
    case 'WORKING':
      return 'connected';
    case 'SCAN_QR_CODE':
      return 'connecting';
    case 'FAILED':
    case 'STOPPED':
      return 'disconnected';
    case 'STARTING':
    case 'STOPPING':
    case 'STARTED':
      return current === 'connected' ? 'connected' : 'connecting';
    default:
      return null; // status tidak dikenal → jangan ubah apa pun
  }
}

/** ack WAHA (message.ack) → status pesan di tabel messages. */
export function ackToMessageStatus(
  ack: number | null | undefined,
): 'sent' | 'delivered' | 'failed' | null {
  if (typeof ack !== 'number') return null;
  if (ack < 0) return 'failed';
  if (ack >= 2) return 'delivered';
  if (ack >= 1) return 'sent';
  return null; // 0 = pending — belum ada info berguna
}

export interface WahaChannelRow {
  workspaceId: string;
  identifier: string | null;
  isActive: boolean;
  providerConfig: Record<string, unknown>;
}

async function loadWahaChannel(workspaceId: string): Promise<WahaChannelRow | null> {
  const [channel] = await db
    .select()
    .from(workspaceChannels)
    .where(
      and(
        eq(workspaceChannels.workspaceId, workspaceId),
        eq(workspaceChannels.channelType, 'whatsapp'),
      ),
    )
    .limit(1);
  if (!channel) return null;
  return {
    workspaceId: channel.workspaceId,
    identifier: channel.identifier,
    isActive: channel.isActive,
    providerConfig: (channel.providerConfig ?? {}) as Record<string, unknown>,
  };
}

/** Upsert providerConfig channel whatsapp (health dikontrol dari sini). */
export async function saveWahaProviderConfig(input: {
  workspaceId: string;
  providerConfig: Record<string, unknown>;
  identifier?: string | null;
  isActive?: boolean;
}): Promise<void> {
  const prev = await loadWahaChannel(input.workspaceId);
  const identifier = input.identifier !== undefined ? input.identifier : (prev?.identifier ?? null);
  const isActive = input.isActive ?? prev?.isActive ?? true;
  await db
    .insert(workspaceChannels)
    .values({
      workspaceId: input.workspaceId,
      channelType: 'whatsapp',
      identifier,
      providerConfig: input.providerConfig,
      isActive,
    })
    .onConflictDoUpdate({
      target: [workspaceChannels.workspaceId, workspaceChannels.channelType],
      set: {
        identifier,
        providerConfig: input.providerConfig,
        isActive,
        updatedAt: new Date(),
      },
    })
    .returning({ id: workspaceChannels.id });
}

export interface WahaHealthPatch {
  state?: WahaHealthState;
  lastSeenAt?: string | null;
  lastStatusAt?: string | null;
  reachoutTimelockUntil?: string | null;
  lastError?: WahaHealth['lastError'] | null;
  lastStatus?: string | null;
}

/** Baca → merge → simpan health. Mengembalikan health baru (null bila channel hilang). */
export async function updateWahaHealth(
  workspaceId: string,
  patch: WahaHealthPatch,
): Promise<WahaHealth | null> {
  const channel = await loadWahaChannel(workspaceId);
  if (!channel) return null;
  const health = { ...readWahaHealth(channel.providerConfig), ...patch };
  await saveWahaProviderConfig({
    workspaceId,
    providerConfig: { ...channel.providerConfig, health },
    identifier: channel.identifier,
    isActive: channel.isActive,
  });
  return health;
}

/* ────────────────────────────────────────────────────────────
 * Webhook — event session.status / message.ack / activity
 * ──────────────────────────────────────────────────────────── */

interface WahaSessionStatusPayload {
  status?: string | null;
  statuses?: unknown[];
  data?: { reachoutTimelock?: { isActive?: boolean; timeEnforcementEnds?: number | null } | null } | null;
}

/**
 * Terapkan event `session.status` (webhook real-time):
 *  - WORKING → connected + identifier = me.id (nomor sendiri)
 *  - reachoutTimelock.isActive → restricted (timelock disimpan)
 *  - reachoutTimelock.isActive=false → kembali connected + timelock dibersihkan
 *  - FAILED/STOPPED → disconnected
 */
export async function applyWahaSessionStatus(
  workspaceId: string,
  event: WahaWebhookEvent,
): Promise<WahaHealth | null> {
  const channel = await loadWahaChannel(workspaceId);
  if (!channel) return null;

  const health = readWahaHealth(channel.providerConfig);
  const payload = (event.payload ?? {}) as WahaSessionStatusPayload;
  const status = typeof payload.status === 'string' ? payload.status : null;
  const now = new Date().toISOString();

  const next = wahaStatusToState(status, health.state);
  const patch: WahaHealthPatch = { lastStatusAt: now };
  // Simpan status mentah apa adanya (WORKING/FAILED/…) — UI memakainya untuk
  // hint re-pairing LID saat session FAILED tapi nomor masih ter-pair.
  if (status) patch.lastStatus = status;
  if (next) patch.state = next;

  // Timelock hanya boleh menimpa state bila session TIDAK sedang disconnected
  // (FAILED/STOPPED) — session mati tidak boleh disembunyikan jadi 'restricted'.
  const currentOrNext = patch.state ?? health.state;
  const timelock = payload.data?.reachoutTimelock ?? null;
  if (timelock && typeof timelock === 'object') {
    if (
      timelock.isActive &&
      typeof timelock.timeEnforcementEnds === 'number' &&
      currentOrNext !== 'disconnected'
    ) {
      patch.state = 'restricted';
      patch.reachoutTimelockUntil = new Date(timelock.timeEnforcementEnds * 1000).toISOString();
    } else if (timelock.isActive === false) {
      patch.reachoutTimelockUntil = null;
      if (currentOrNext === 'restricted') patch.state = 'connected';
    }
  }

  const nextHealth = { ...health, ...patch };
  const meId = nextHealth.state === 'connected' && event.me?.id ? chatIdToWaId(event.me.id) : null;
  await saveWahaProviderConfig({
    workspaceId,
    providerConfig: { ...channel.providerConfig, health: nextHealth },
    identifier: meId ?? channel.identifier,
    isActive: channel.isActive,
  });
  return nextHealth;
}

/**
 * Heartbeat atomik: update hanya `provider_config.health.lastSeenAt` via
 * jsonb_set (single UPDATE) — TIDAK menulis ulang seluruh providerConfig.
 * Ini mencegah race ack-storm (WAHA mengirim 1 ack per pesan keluar) menimpa
 * transisi state (banned/restricted) yang sedang ditulis jalur lain.
 */
export async function touchWahaHeartbeat(workspaceId: string): Promise<void> {
  await db
    .update(workspaceChannels)
    .set({
      providerConfig: sql`jsonb_set(${workspaceChannels.providerConfig}, '{health,lastSeenAt}', to_jsonb(${new Date().toISOString()}::text), true)`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(workspaceChannels.workspaceId, workspaceId),
        eq(workspaceChannels.channelType, 'whatsapp'),
      ),
    );
}

/** Heartbeat: event apa pun dari WAHA = gateway hidup → refresh lastSeenAt. */
export async function applyWahaMessageSeen(workspaceId: string): Promise<void> {
  await touchWahaHeartbeat(workspaceId);
}

/**
 * Event `message.ack`: update status pesan keluar (sent/delivered/failed)
 * di unified inbox + heartbeat lastSeenAt. Id WAHA sama dengan yang disimpan
 * saat sendText (providerMessageId) — pencocokan lewat percakapan workspace.
 */
export async function applyWahaMessageAck(
  workspaceId: string,
  payload: WahaMessagePayload,
): Promise<void> {
  const status = ackToMessageStatus(payload.ack);
  if (status && typeof payload.id === 'string' && payload.id.length > 0) {
    await db
      .update(messages)
      .set({ status })
      .from(conversations)
      .where(
        and(
          eq(messages.conversationId, conversations.id),
          eq(conversations.workspaceId, workspaceId),
          eq(messages.providerMessageId, payload.id),
          eq(messages.direction, 'outbound'),
        ),
      );
  }
  await applyWahaMessageSeen(workspaceId);
}

/* ────────────────────────────────────────────────────────────
 * Watchdog — probe berkala semua channel waha
 * ──────────────────────────────────────────────────────────── */

/** Semua channel whatsapp provider 'waha' — untuk cron watchdog. */
export async function listWahaChannels(): Promise<WahaChannelRow[]> {
  const rows = await db
    .select()
    .from(workspaceChannels)
    .where(
      and(
        eq(workspaceChannels.channelType, 'whatsapp'),
        sql`${workspaceChannels.providerConfig}->>'provider' = 'waha'`,
      ),
    );
  return rows.map((row) => ({
    workspaceId: row.workspaceId,
    identifier: row.identifier,
    isActive: row.isActive,
    providerConfig: (row.providerConfig ?? {}) as Record<string, unknown>,
  }));
}

export interface WahaProbeResult {
  state: WahaHealthState | null;
  reason?: string;
}

/**
 * Probe satu channel: GET /api/sessions/{name} (+ me bila WORKING).
 *  - Session WORKING → connected (identifier dari me.id)
 *  - Session FAILED/STOPPED → disconnected
 *  - Gateway tak terjangkau / error → disconnected (fail-safe: outbound BYO
 *    tidak mungkin terkirim kalau gateway kita tidak bisa dihubungi).
 *  - Channel dijeda user (isActive false) / konfigurasi tidak lengkap → skip.
 */
export async function probeWahaChannelHealth(channel: WahaChannelRow): Promise<WahaProbeResult> {
  if (!channel.isActive) return { state: null, reason: 'paused' };
  const config = channel.providerConfig;
  const baseUrl = typeof config.baseUrl === 'string' ? config.baseUrl : '';
  const gatewayApiKey = typeof config.gatewayApiKey === 'string' ? config.gatewayApiKey : '';
  const sessionName = typeof config.sessionName === 'string' ? config.sessionName : '';
  if (!baseUrl || !gatewayApiKey || !sessionName) return { state: null, reason: 'incomplete' };

  try {
    const session = await wahaGetSession(baseUrl, gatewayApiKey, sessionName);
    const me =
      session.status === 'WORKING'
        ? await wahaGetMe(baseUrl, gatewayApiKey, sessionName).catch(() => null)
        : null;

    const channelRow = await loadWahaChannel(channel.workspaceId);
    if (!channelRow) return { state: null, reason: 'gone' };

    const health = readWahaHealth(channelRow.providerConfig);
    const next = wahaStatusToState(session.status, health.state);
    const nextHealth = {
      ...health,
      ...(next ? { state: next } : {}),
      // Status mentah (WORKING/FAILED/…) ikut disimpan untuk hint LID re-pair.
      lastStatus: session.status ?? health.lastStatus,
      lastStatusAt: new Date().toISOString(),
    };
    const meId = next === 'connected' && me?.id ? chatIdToWaId(me.id) : null;
    await saveWahaProviderConfig({
      workspaceId: channel.workspaceId,
      providerConfig: { ...channelRow.providerConfig, health: nextHealth },
      identifier: meId ?? channelRow.identifier,
      isActive: channelRow.isActive,
    });
    return { state: next ?? health.state };
  } catch (error) {
    const nowIso = new Date().toISOString();
    const lastError = {
      code: error instanceof WahaApiError ? (error.status ?? 0) : 0,
      message: 'Gateway WAHA tidak terjangkau',
      at: nowIso,
    };
    const channelRow = await loadWahaChannel(channel.workspaceId);
    const current = channelRow ? readWahaHealth(channelRow.providerConfig).state : null;
    if (current === 'connected' || current === 'restricted') {
      // Session yang tadinya jalan tiba-tiba tidak terjangkau → disconnected.
      // lastStatus di-null-kan: status mentah lama (mis. FAILED) tidak boleh
      // tertinggal — UI memakainya untuk hint re-pair LID, dan gateway mati
      // bukan kasus LID (re-pairing tidak menolong saat gateway tak terjangkau).
      await updateWahaHealth(channel.workspaceId, {
        state: 'disconnected',
        lastStatus: null,
        lastStatusAt: nowIso,
        lastError,
      });
      return { state: 'disconnected', reason: 'unreachable' };
    }
    // Masih pairing (connecting/qr-expired): satu kegagalan probe tidak boleh
    // menampilkan 'disconnected' — cukup catat lastError, state tetap.
    if (channelRow) {
      await updateWahaHealth(channel.workspaceId, { lastStatusAt: nowIso, lastError });
    }
    return { state: current ?? null, reason: 'unreachable' };
  }
}

/* ────────────────────────────────────────────────────────────
 * Outbound safety — banned/restricted blocks + kuota harian
 * ──────────────────────────────────────────────────────────── */

/** Kuota harian v1 (spec §6): ≤20 pesan ke kontak baru, total ≤200. */
export const WAHA_DAILY_NEW_CONTACT_CAP = 20;
export const WAHA_DAILY_TOTAL_CAP = 200;

function startOfToday(): Date {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now;
}

/** Apakah wa_id ini pernah terhubung (punya baris customerChannels = pernah chat)? */
export async function hasWahaCustomerChannel(workspaceId: string, waId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: customerChannels.id })
    .from(customerChannels)
    .where(
      and(
        eq(customerChannels.workspaceId, workspaceId),
        eq(customerChannels.channelType, 'whatsapp'),
        eq(customerChannels.identifier, waId),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Total pesan keluar WhatsApp hari ini (via percakapan workspace). */
export async function countTodayWahaOutbound(workspaceId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(
      and(
        eq(conversations.workspaceId, workspaceId),
        eq(conversations.channelType, 'whatsapp'),
        eq(messages.direction, 'outbound'),
        gte(messages.createdAt, startOfToday()),
      ),
    );
  return row?.count ?? 0;
}

/**
 * Pesan keluar hari ini ke kontak BARU (externalId yang belum pernah punya
 * baris customerChannels = belum pernah menghubungi bisnis). Ini yang di-cap
 * kecil (20/hari) — menjangkau orang baru lewat BYO adalah sumber ban.
 */
export async function countTodayNewContactWahaOutbound(workspaceId: string): Promise<number> {
  const knownIdentifiers = db
    .select({ identifier: customerChannels.identifier })
    .from(customerChannels)
    .where(
      and(
        eq(customerChannels.workspaceId, workspaceId),
        eq(customerChannels.channelType, 'whatsapp'),
      ),
    );
  const [row] = await db
    .select({ count: sql<number>`count(distinct ${conversations.externalId})::int` })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(
      and(
        eq(conversations.workspaceId, workspaceId),
        eq(conversations.channelType, 'whatsapp'),
        eq(messages.direction, 'outbound'),
        gte(messages.createdAt, startOfToday()),
        notInArray(conversations.externalId, knownIdentifiers),
      ),
    );
  return row?.count ?? 0;
}

export interface WahaOutboundErrorInfo {
  status?: number;
  message?: string;
}

/**
 * Catat kegagalan pengiriman BYO dan terjemahkan ke health:
 *  - 463 → restricted (reachout timelock); 463 di luar jendela timelock → banned
 *  - 402/403 atau body menyebut banned/blocked → banned (auto-pause outbound)
 *  - lainnya → hanya lastError (state tidak berubah; watchdog yang menangani)
 */
export async function markWahaOutboundFailure(
  workspaceId: string,
  info: WahaOutboundErrorInfo,
): Promise<void> {
  const channel = await loadWahaChannel(workspaceId);
  if (!channel) return;

  const health = readWahaHealth(channel.providerConfig);
  const now = new Date().toISOString();
  const message = (info.message ?? 'Gagal mengirim pesan').slice(0, 300);
  const patch: WahaHealthPatch = {
    lastError: { code: info.status ?? 0, message, at: now },
    lastStatusAt: now,
  };

  const status = info.status;
  if (status === 463) {
    const until = health.reachoutTimelockUntil ? new Date(health.reachoutTimelockUntil).getTime() : 0;
    if (until > 0 && until < Date.now()) {
      // 463 muncul di luar jendela timelock → nomor tampak dibanned.
      patch.state = 'banned';
      patch.reachoutTimelockUntil = null;
    } else {
      patch.state = 'restricted';
      if (!health.reachoutTimelockUntil) {
        patch.reachoutTimelockUntil = new Date(Date.now() + 24 * 3_600_000).toISOString();
      }
    }
  } else if (status === 402 || status === 403 || /banned|blocked|temporarily unavailable/i.test(message)) {
    patch.state = 'banned';
  }

  await saveWahaProviderConfig({
    workspaceId,
    providerConfig: { ...channel.providerConfig, health: { ...health, ...patch } },
    identifier: channel.identifier,
    isActive: channel.isActive,
  });
}
