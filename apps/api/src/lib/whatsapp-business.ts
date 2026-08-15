import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { whatsappConnections, workspaces } from '@oriole/database';

import { db } from '../db/index.ts';
import { decryptSecret, encryptSecret } from './crypto.ts';
import { env } from './env.ts';
import { webhookBaseUrl } from './webhook-url.ts';
import {
  buildMetaWhatsappSignupUrl,
  exchangeWhatsappCode,
  getWabaInfo,
  getWabaPhoneNumbers,
  MetaWhatsAppApiError,
  registerPhoneNumber,
  resolveWabaIdByToken,
  subscribeAppToWaba,
} from '../services/meta-whatsapp.ts';

/**
 * Koneksi WhatsApp Business per tenant (Meta Embedded Signup — Tech Provider).
 *
 * Lifecycle: not_connected → connecting → connected / error → disconnected,
 * plus refresh (sync metadata) dan reconnect (jalankan ulang signup).
 * Business token per tenant dienkripsi at-rest (encryptSecret) dan TIDAK
 * pernah diserialisasi ke frontend — semua query di-scope `workspaceId`.
 */

export class WhatsAppBusinessError extends Error {}

export type WhatsAppBusinessStatus =
  | 'not_connected'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'disconnected';

/** Konfigurasi Meta App platform (Tech Provider) — null bila belum disetel. */
export interface MetaWhatsAppPlatformConfig {
  appId: string;
  appSecret: string;
  configId: string;
  verifyToken: string;
  systemUserToken: string;
}

export function metaWhatsAppPlatformConfig(): MetaWhatsAppPlatformConfig | null {
  const { META_WHATSAPP_APP_ID, META_WHATSAPP_APP_SECRET, META_WHATSAPP_CONFIG_ID, META_WHATSAPP_VERIFY_TOKEN, META_WHATSAPP_SYSTEM_USER_TOKEN } = env;
  if (
    !META_WHATSAPP_APP_ID ||
    !META_WHATSAPP_APP_SECRET ||
    !META_WHATSAPP_CONFIG_ID ||
    !META_WHATSAPP_VERIFY_TOKEN ||
    !META_WHATSAPP_SYSTEM_USER_TOKEN
  ) {
    return null;
  }
  return {
    appId: META_WHATSAPP_APP_ID,
    appSecret: META_WHATSAPP_APP_SECRET,
    configId: META_WHATSAPP_CONFIG_ID,
    verifyToken: META_WHATSAPP_VERIFY_TOKEN,
    systemUserToken: META_WHATSAPP_SYSTEM_USER_TOKEN,
  };
}

export interface PublicWhatsAppBusinessConnection {
  status: WhatsAppBusinessStatus;
  wabaId: string | null;
  phoneNumberId: string | null;
  displayPhoneNumber: string | null;
  businessName: string | null;
  /** Status AI assistant workspace (workspaces.aiEnabled) — ditampilkan di card. */
  aiAssistantEnabled: boolean;
  errorMessage: string | null;
  connectedAt: string | null;
  lastSyncAt: string | null;
  disconnectedAt: string | null;
  /** true bila Meta App platform sudah dikonfigurasi (env lengkap). */
  platformConfigured: boolean;
}

type ConnectionRow = typeof whatsappConnections.$inferSelect;

function mapStatus(row: ConnectionRow | null, aiAssistantEnabled: boolean): PublicWhatsAppBusinessConnection {
  return {
    status: (row?.status ?? 'not_connected') as WhatsAppBusinessStatus,
    wabaId: row?.wabaId ?? null,
    phoneNumberId: row?.phoneNumberId ?? null,
    displayPhoneNumber: row?.displayPhoneNumber ?? null,
    businessName: row?.businessName ?? null,
    aiAssistantEnabled,
    errorMessage: row?.errorMessage ?? null,
    connectedAt: row?.connectedAt ? row.connectedAt.toISOString() : null,
    lastSyncAt: row?.lastSyncAt ? row.lastSyncAt.toISOString() : null,
    disconnectedAt: row?.disconnectedAt ? row.disconnectedAt.toISOString() : null,
    platformConfigured: metaWhatsAppPlatformConfig() !== null,
  };
}

async function loadConnection(workspaceId: string): Promise<ConnectionRow | null> {
  const [row] = await db
    .select()
    .from(whatsappConnections)
    .where(eq(whatsappConnections.workspaceId, workspaceId))
    .limit(1);
  return row ?? null;
}

/** Status publik koneksi WhatsApp Business sebuah tenant (tanpa secret). */
export async function getWhatsAppBusinessConnection(
  workspaceId: string,
): Promise<PublicWhatsAppBusinessConnection> {
  const [row, ai] = await Promise.all([
    loadConnection(workspaceId),
    db
      .select({ aiEnabled: workspaces.aiEnabled })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1),
  ]);
  return mapStatus(row, ai[0]?.aiEnabled ?? false);
}

/** Decrypt business token tenant — dipakai outbound (services/whatsapp). */
export async function getWhatsAppBusinessToken(workspaceId: string): Promise<string | null> {
  const row = await loadConnection(workspaceId);
  if (!row?.accessTokenEncrypted || row.status !== 'connected') return null;
  const token = decryptSecret(row.accessTokenEncrypted);
  return token.length > 0 ? token : null;
}

function generatePin(): string {
  // 6 digit — PIN two-step verification nomor (Register API).
  return String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

/** URL callback Meta (server → tukar code) — dipakai sebagai redirect_uri.
 *  Base publik dari WEBHOOK_BASE_URL (fallback API_URL) — di produksi API_URL
 *  bisa berupa alamat internal Docker yang tidak bisa dijangkau Meta. */
export function whatsappBusinessCallbackUrl(): string {
  return `${webhookBaseUrl()}/api/whatsapp-business/connect/callback`;
}

/** URL kembali ke frontend setelah callback selesai. */
function frontendReturnUrl(result: 'connected' | 'error' | 'already', message?: string): string {
  const params = new URLSearchParams({ whatsapp: result });
  if (message) params.set('reason', message);
  return `${env.APP_URL}/integrations?${params.toString()}`;
}

export { frontendReturnUrl };

/**
 * Mulai Embedded Signup: buat state CSRF, tandai `connecting`, return URL
 * dialog Meta. State disimpan satu-kali-pakai di baris koneksi.
 */
export async function startWhatsAppBusinessConnect(workspaceId: string): Promise<{ signupUrl: string }> {
  const platform = metaWhatsAppPlatformConfig();
  if (!platform) {
    throw new WhatsAppBusinessError('Meta WhatsApp Business belum dikonfigurasi di platform.');
  }
  const state = randomBytes(24).toString('base64url');
  const signupUrl = buildMetaWhatsappSignupUrl({
    version: env.META_GRAPH_API_VERSION,
    appId: platform.appId,
    configId: platform.configId,
    state,
    redirectUri: whatsappBusinessCallbackUrl(),
  });

  await db
    .insert(whatsappConnections)
    .values({
      workspaceId,
      status: 'connecting',
      signupState: state,
      errorMessage: null,
    })
    .onConflictDoUpdate({
      target: [whatsappConnections.workspaceId],
      set: {
        status: 'connecting',
        signupState: state,
        errorMessage: null,
        disconnectedAt: null,
        updatedAt: new Date(),
      },
    });

  return { signupUrl };
}

/** Hasil penyelesaian onboarding — workspace pemilik (untuk redirect UI). */
export interface CompleteConnectResult {
  workspaceId: string;
  alreadyConnected: boolean;
}

/**
 * Selesaikan onboarding dari callback Meta: verifikasi state → tukar code →
 * resolve WABA & nomor → subscribe webhook → register nomor → simpan.
 * Idempoten terhadap retry: state yang sudah dipakai → `alreadyConnected`.
 */
export async function completeWhatsAppBusinessConnect(input: {
  code: string;
  state: string;
}): Promise<CompleteConnectResult> {
  const platform = metaWhatsAppPlatformConfig();
  if (!platform) {
    throw new WhatsAppBusinessError('Meta WhatsApp Business belum dikonfigurasi di platform.');
  }

  const [row] = await db
    .select()
    .from(whatsappConnections)
    .where(eq(whatsappConnections.signupState, input.state))
    .limit(1);
  if (!row) {
    throw new WhatsAppBusinessError('State signup tidak valid atau sudah digunakan.');
  }

  try {
    // 1. Tukar code → business token (system user token per tenant).
    const businessToken = await exchangeWhatsappCode({
      appId: platform.appId,
      appSecret: platform.appSecret,
      code: input.code,
    });

    // 2. Resolve WABA ID terbaru yang dishare (via system user token platform).
    const wabaId = await resolveWabaIdByToken({
      systemUserToken: platform.systemUserToken,
      businessToken,
    });
    if (!wabaId) {
      throw new WhatsAppBusinessError('WABA tidak ditemukan untuk token hasil signup.');
    }

    // 3. Ambil info bisnis + daftar nomor.
    const [waba, phones] = await Promise.all([
      getWabaInfo({ businessToken, wabaId }),
      getWabaPhoneNumbers({ businessToken, wabaId }),
    ]);
    const phone = phones.find((p) => p.id && p.displayPhoneNumber) ?? phones[0];
    if (!phone?.id) {
      throw new WhatsAppBusinessError('Nomor WhatsApp tidak ditemukan pada WABA.');
    }

    // 4. Subscribe app ke webhook WABA + register nomor (PIN acak, terenkripsi).
    await subscribeAppToWaba({ businessToken, wabaId });
    const pin = generatePin();
    await registerPhoneNumber({ businessToken, phoneNumberId: phone.id, pin });

    await db
      .update(whatsappConnections)
      .set({
        wabaId,
        phoneNumberId: phone.id,
        displayPhoneNumber: phone.displayPhoneNumber,
        businessName: waba.name ?? row.businessName,
        status: 'connected',
        errorMessage: null,
        accessTokenEncrypted: encryptSecret(businessToken),
        signupState: null,
        metadata: {
          verifiedName: phone.verifiedName,
          qualityRating: phone.qualityRating,
          nameStatus: phone.nameStatus,
          codeVerificationStatus: phone.codeVerificationStatus,
          pinEncrypted: encryptSecret(pin),
        },
        connectedAt: new Date(),
        lastSyncAt: new Date(),
        disconnectedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(whatsappConnections.id, row.id));

    return { workspaceId: row.workspaceId, alreadyConnected: false };
  } catch (error) {
    const message =
      error instanceof MetaWhatsAppApiError || error instanceof WhatsAppBusinessError
        ? error.message
        : 'Gagal menyelesaikan koneksi WhatsApp Business.';
    await db
      .update(whatsappConnections)
      .set({ status: 'error', errorMessage: message, signupState: null, updatedAt: new Date() })
      .where(eq(whatsappConnections.id, row.id));
    throw error;
  }
}

/** Putuskan koneksi: hapus token (secret), pertahankan metadata untuk reconnect. */
export async function disconnectWhatsAppBusiness(workspaceId: string): Promise<void> {
  const row = await loadConnection(workspaceId);
  if (!row || row.status === 'disconnected') return;
  await db
    .update(whatsappConnections)
    .set({
      status: 'disconnected',
      accessTokenEncrypted: null,
      signupState: null,
      errorMessage: null,
      disconnectedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(whatsappConnections.id, row.id));
}

/**
 * Refresh/sync metadata + pastikan webhook tetap subscribe. Token yang
 * kedaluwarsa → status error dengan pesan ajakan reconnect.
 */
export async function refreshWhatsAppBusiness(workspaceId: string): Promise<PublicWhatsAppBusinessConnection> {
  const row = await loadConnection(workspaceId);
  if (!row?.accessTokenEncrypted || !row.wabaId) {
    throw new WhatsAppBusinessError('Belum ada koneksi WhatsApp Business aktif.');
  }
  const businessToken = decryptSecret(row.accessTokenEncrypted);
  if (!businessToken) {
    throw new WhatsAppBusinessError('Token koneksi tidak tersedia — hubungkan ulang.');
  }

  try {
    const [waba, phones] = await Promise.all([
      getWabaInfo({ businessToken, wabaId: row.wabaId }),
      getWabaPhoneNumbers({ businessToken, wabaId: row.wabaId }),
    ]);
    const phone = phones.find((p) => p.id) ?? phones[0];
    await subscribeAppToWaba({ businessToken, wabaId: row.wabaId });

    await db
      .update(whatsappConnections)
      .set({
        status: 'connected',
        errorMessage: null,
        businessName: waba.name ?? row.businessName,
        displayPhoneNumber: phone?.displayPhoneNumber ?? row.displayPhoneNumber,
        phoneNumberId: phone?.id ?? row.phoneNumberId,
        metadata: {
          ...(row.metadata ?? {}),
          verifiedName: phone?.verifiedName,
          qualityRating: phone?.qualityRating,
          nameStatus: phone?.nameStatus,
        },
        lastSyncAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(whatsappConnections.id, row.id));
  } catch (error) {
    const message =
      error instanceof MetaWhatsAppApiError ? error.message : 'Gagal sinkronisasi metadata WhatsApp.';
    await db
      .update(whatsappConnections)
      .set({ status: 'error', errorMessage: message, updatedAt: new Date() })
      .where(eq(whatsappConnections.id, row.id));
    throw new WhatsAppBusinessError(message);
  }
  return getWhatsAppBusinessConnection(workspaceId);
}

/**
 * Resolve workspace dari phone_number_id (webhook masuk) — tenant isolation.
 * Return null bila nomor tidak dikenal platform (drop event).
 */
export async function resolveWorkspaceByPhoneNumberId(phoneNumberId: string): Promise<string | null> {
  const [row] = await db
    .select({ workspaceId: whatsappConnections.workspaceId })
    .from(whatsappConnections)
    .where(
      and(
        eq(whatsappConnections.phoneNumberId, phoneNumberId),
        eq(whatsappConnections.status, 'connected'),
      ),
    )
    .limit(1);
  return row?.workspaceId ?? null;
}

/**
 * Cek status koneksi (token masih valid?) — dipanggil UI untuk "connection
 * status checking" dan setelah reconnect.
 */
export async function checkWhatsAppBusinessStatus(workspaceId: string): Promise<PublicWhatsAppBusinessConnection> {
  const row = await loadConnection(workspaceId);
  if (!row?.accessTokenEncrypted || row.status !== 'connected') {
    return mapStatus(row, false);
  }
  const businessToken = decryptSecret(row.accessTokenEncrypted);
  if (!businessToken || !row.wabaId) {
    return mapStatus(row, false);
  }
  try {
    await getWabaPhoneNumbers({ businessToken, wabaId: row.wabaId });
    return mapStatus(row, false);
  } catch {
    await db
      .update(whatsappConnections)
      .set({
        status: 'error',
        errorMessage: 'Token WhatsApp kedaluwarsa — hubungkan ulang.',
        updatedAt: new Date(),
      })
      .where(eq(whatsappConnections.id, row.id));
    return getWhatsAppBusinessConnection(workspaceId);
  }
}
