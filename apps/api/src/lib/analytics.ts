import { PostHog } from 'posthog-node';

import { env } from './env.ts';

/**
 * PostHog analytics (server-side) — satu titik masuk untuk semua event
 * bisnis yang dicapture dari HTTP routes maupun Inngest jobs.
 *
 * Desain:
 * - Tanpa `POSTHOG_PUBLIC_KEY` di env → sink no-op, semua helper diam
 *   (API berjalan normal, nol biaya, nol network).
 * - Nilai key = project API key (`phc_...`, Project Settings → API keys) —
 *   key yang SAMA dengan token web SDK. BUKAN personal API key (`phx_...`).
 * - Sink di-abstraksi (`AnalyticsSink`) agar test bisa memeriksa event
 *   tanpa benar-benar mengirim ke PostHog (lihat setAnalyticsSinkForTests).
 * - PRIVASI: helper di bawah ini TIDAK pernah menerima PII (nomor telepon,
 *   email, nama customer, isi pesan). Yang dikirim hanya id internal +
 *   metadata non-sensitif.
 */

/** Payload satu event — subset `EventMessage` posthog-node. */
export interface AnalyticsEventPayload {
  event: string;
  distinctId: string;
  properties?: Record<string, unknown>;
  groups?: Record<string, string>;
  timestamp?: Date;
}

/**
 * Snapshot hasil evaluasi feature flag (subset `FeatureFlagEvaluations`
 * posthog-node) — dipakai agar sink fiktif di test bisa mengimplementasikan
 * kontrak yang sama tanpa klien PostHog sungguhan.
 */
export interface FlagsSnapshot {
  /** true bila flag aktif; false bila flag ada tapi nonaktif. */
  isEnabled(key: string): boolean;
  /** Nilai flag (boolean untuk on/off, string untuk multi-variant). */
  getFlag(key: string): string | boolean | undefined;
  /** Payload JSON flag (dipakai eksperimen A/B). */
  getFlagPayload(key: string): unknown;
}

export interface AnalyticsSink {
  capture(payload: AnalyticsEventPayload): void;
  captureException(error: unknown, distinctId: string, properties?: Record<string, unknown>): void;
  /**
   * Evaluasi feature flag (opsional — sink tanpa dukungan flag hanya
   * membuat helper fallback ke default). Options: `groups` + subset flag
   * yang diinginkan agar satu request hanya satu panggilan /flags.
   */
  evaluateFlags?(
    distinctId: string,
    options?: { groups?: Record<string, string>; flagKeys?: string[] },
  ): Promise<FlagsSnapshot>;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * Sink default: klien PostHog sungguhan (lazy — hanya dibuat saat ada key).
 * `undefined` = belum diinisialisasi; `null` = nonaktif (tanpa key).
 * Pemanggil memakai optional chaining (`getSink()?.capture()`), jadi
 * nonaktif cukup direpresentasikan null — tidak perlu no-op sink terpisah.
 */
let sink: AnalyticsSink | null | undefined;

function createPostHogSink(): AnalyticsSink {
  const client = new PostHog(env.POSTHOG_PUBLIC_KEY as string, {
    host: env.POSTHOG_HOST,
    // flushAt/flushInterval default posthog-node (20 event / 3 detik) cukup
    // untuk request lifecycle — middleware memanggil flush() per-request.
  });
  return {
    capture: (payload) => client.capture(payload),
    captureException: (error, distinctId, properties) =>
      client.captureException(error, distinctId, properties),
    // evaluateFlags (v5.48+) — satu panggilan /flags per request, snapshot
    // memakai isEnabled/getFlag/getFlagPayload. getFeatureFlag lama sudah
    // deprecated di SDK ini.
    evaluateFlags: (distinctId, options) =>
      client.evaluateFlags(distinctId, {
        groups: options?.groups,
        flagKeys: options?.flagKeys,
      }),
    async flush() {
      await client.flush();
    },
    async shutdown() {
      // v5 menamai shutdown `_shutdown` (flush antrian + hentikan timer).
      await client._shutdown();
    },
  };
}

/** Sink aktif — dibuat sekali, di-cache. null = analitik nonaktif. */
export function getSink(): AnalyticsSink | null {
  if (sink === undefined) {
    sink = env.POSTHOG_PUBLIC_KEY ? createPostHogSink() : null;
  }
  return sink;
}

/**
 * Test hook: ganti sink dengan fake (rekam event) atau kosongkan cache.
 * `undefined` → buat ulang dari env; `null` → nonaktif paksa.
 */
export function setAnalyticsSinkForTests(next?: AnalyticsSink | null): void {
  sink = next === undefined ? undefined : next;
}

/** True bila POSTHOG_PUBLIC_KEY disetel (untuk log/guard, bukan aliran data). */
export const isAnalyticsEnabled = Boolean(env.POSTHOG_PUBLIC_KEY);

/** Capture satu event bebas. No-op bila analitik nonaktif. */
export function captureEvent(payload: AnalyticsEventPayload): void {
  getSink()?.capture(payload);
}

/** Capture exception untuk error tracking (server-side). */
export function captureException(
  error: unknown,
  distinctId: string,
  properties?: Record<string, unknown>,
): void {
  getSink()?.captureException(error, distinctId, properties);
}

/** Flush antrian event (dipanggil middleware setelah response). */
export async function flushAnalytics(): Promise<void> {
  await getSink()?.flush();
}

/**
 * Evaluasi satu feature flag (server-side) dengan fallback aman.
 *
 * Semantik fallback: hanya nilai flag yang DEFINED (boolean/string) yang
 * menimpa default. Flag yang belum dibuat / PostHog down / tanpa key →
 * `fallback`. Ini penting untuk kill-switch: flag yang belum dibuat TIDAK
 * boleh diam-diam mematikan fitur.
 *
 * `evaluateFlags` memakai cache internal posthog-node; satu pemanggilan
 * mengevaluasi semua flag (opsional dibatasi `flagKeys`). Error apa pun
 * (network, timeout) → fallback, fitur tetap berjalan.
 */
export async function getFeatureFlagValue(
  key: string,
  distinctId: string,
  options: { groups?: Record<string, string>; fallback?: boolean } = {},
): Promise<boolean> {
  const sink = getSink();
  if (!sink?.evaluateFlags) return options.fallback ?? false;
  try {
    const flags = await sink.evaluateFlags(distinctId, {
      groups: options.groups,
      flagKeys: [key],
    });
    const value = flags.getFlag(key);
    return typeof value === 'boolean' ? value : (options.fallback ?? false);
  } catch {
    return options.fallback ?? false;
  }
}

/** Flush + hentikan klien (dipanggil saat proses di-shutdown). */
export async function shutdownAnalytics(): Promise<void> {
  await getSink()?.shutdown();
}

/* ────────────────────────────────────────────────────────────
 * Helper domain — event bisnis dengan properti terkontrol (no-PII).
 * Semua helper mengikat event ke group `workspace` agar PostHog bisa
 * meng-agregasi per project (dashboard per workspace).
 * ──────────────────────────────────────────────────────────── */

export interface BookingAnalyticsInput {
  workspaceId: string;
  bookingId: string;
  /** Pemilik workspace (routes auth) — dipakai sebagai distinctId. */
  userId?: string;
  source?: string | null;
  goalType?: string | null;
  status?: string | null;
}

/** Event lifecycle booking: booking.created / completed / cancelled / updated / deleted. */
export function captureBookingEvent(event: string, input: BookingAnalyticsInput): void {
  captureEvent({
    event,
    distinctId: input.userId ?? `workspace:${input.workspaceId}`,
    properties: {
      booking_id: input.bookingId,
      source: input.source ?? null,
      goal_type: input.goalType ?? null,
      status: input.status ?? null,
    },
    groups: { workspace: input.workspaceId },
  });
}

export interface CallAnalyticsInput {
  workspaceId: string;
  bookingId?: string | null;
  callId?: string | null;
  status?: string | null;
  goalType?: string | null;
  durationSeconds?: number | null;
  /** Alasan panggilan berakhir dari provider (endedReason Vapi) — kunci
   *  analitik AI call: membedakan "customer tidak menjawab" vs
   *  "panggilan diselesaikan" vs "error teknis". Bukan PII (nilai enum). */
  endedReason?: string | null;
}

/** Event panggilan AI (Vapi): call.completed / call.failed / call.triggered. */
export function captureCallEvent(event: string, input: CallAnalyticsInput): void {
  captureEvent({
    event,
    distinctId: `workspace:${input.workspaceId}`,
    properties: {
      workspace_id: input.workspaceId,
      booking_id: input.bookingId ?? null,
      call_id: input.callId ?? null,
      status: input.status ?? null,
      goal_type: input.goalType ?? null,
      duration_seconds: input.durationSeconds ?? null,
      ended_reason: input.endedReason ?? null,
    },
    groups: { workspace: input.workspaceId },
  });
}

export interface PaymentAnalyticsInput {
  workspaceId?: string | null;
  userId?: string;
  paymentLinkId?: string | null;
  bookingId?: string | null;
  status?: string | null;
  amountMinor?: number | null;
  currency?: string | null;
}

/** Event pembayaran: payment.checkout_created / payment.completed / payment.canceled. */
export function capturePaymentEvent(event: string, input: PaymentAnalyticsInput): void {
  captureEvent({
    event,
    distinctId: input.userId ?? (input.workspaceId ? `workspace:${input.workspaceId}` : 'system'),
    properties: {
      workspace_id: input.workspaceId ?? null,
      payment_link_id: input.paymentLinkId ?? null,
      booking_id: input.bookingId ?? null,
      status: input.status ?? null,
      amount_minor: input.amountMinor ?? null,
      currency: input.currency ?? null,
    },
    groups: input.workspaceId ? { workspace: input.workspaceId } : undefined,
  });
}

export interface WorkspaceAnalyticsInput {
  userId: string;
  workspaceId: string;
  templateCategory?: string | null;
  industry?: string | null;
}

/** Event lifecycle workspace: workspace.created. */
export function captureWorkspaceEvent(event: string, input: WorkspaceAnalyticsInput): void {
  captureEvent({
    event,
    distinctId: input.userId,
    properties: {
      workspace_id: input.workspaceId,
      template_category: input.templateCategory ?? null,
      industry: input.industry ?? null,
    },
    groups: { workspace: input.workspaceId },
  });
}

export interface IntegrationAnalyticsInput {
  workspaceId: string;
  integrationType: string;
}

/** Event integrasi terhubung (notion / google-forms / slack / payments / …). */
export function captureIntegrationEvent(event: string, input: IntegrationAnalyticsInput): void {
  captureEvent({
    event,
    distinctId: `workspace:${input.workspaceId}`,
    properties: {
      workspace_id: input.workspaceId,
      integration_type: input.integrationType,
    },
    groups: { workspace: input.workspaceId },
  });
}

/* ────────────────────────────────────────────────────────────
 * Agregasi analytics MURNI (tanpa akses DB) — dipakai route
 * /api/analytics/overview (halaman Analytics frontend). Semua
 * fungsi menerima baris mentah dan mengembalikan data siap-chart;
 * dipisahkan dari route agar bisa di-unit-test tanpa database.
 *
 * Kunci bulan memakai format `YYYY-MM` (lokal, bukan timezone DB) —
 * konsisten dengan label bulan di frontend (Intl).
 * ──────────────────────────────────────────────────────────── */

export interface BookingRow {
  status: string;
  createdAt: Date;
}

export interface CallRow {
  status: string | null;
  createdAt: Date;
}

export interface MessageRow {
  channel: string;
  direction: string;
}

export interface ConversationRow {
  state: Record<string, unknown> | null;
}

/** Kunci bulan lokal: `YYYY-MM` dari sebuah Date. */
export function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** Deret 12 bulan terakhir (termasuk bulan berjalan), urut naik. */
export function lastTwelveMonths(now = new Date()): string[] {
  const months: string[] = [];
  for (let i = 11; i >= 0; i--) {
    months.push(monthKey(new Date(now.getFullYear(), now.getMonth() - i, 1)));
  }
  return months;
}

/** Booking per bulan (12 bulan terakhir), bulan kosong diisi 0. */
export function aggregateBookingsByMonth(
  rows: BookingRow[],
  now = new Date(),
): { month: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = monthKey(row.createdAt);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return lastTwelveMonths(now).map((month) => ({ month, count: counts.get(month) ?? 0 }));
}

/** Distribusi status booking. */
export function aggregateBookingStatus(
  rows: BookingRow[],
): { status: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  }
  return [...counts.entries()].map(([status, count]) => ({ status, count }));
}

/**
 * Funnel konversi: created → confirmed → completed.
 * Status bersifat eksklusif (satu booking satu status), jadi "confirmed"
 * dihitung sebagai booking yang pernah/berada di tahap konfirmasi
 * (confirmed + completed) — turun secara alami menuju completed.
 */
export function buildFunnel(
  rows: BookingRow[],
): { step: 'created' | 'confirmed' | 'completed'; count: number }[] {
  const byStatus = aggregateBookingStatus(rows);
  const total = byStatus.reduce((acc, row) => acc + row.count, 0);
  const confirmed = byStatus.find((row) => row.status === 'confirmed')?.count ?? 0;
  const completed = byStatus.find((row) => row.status === 'completed')?.count ?? 0;
  return [
    { step: 'created', count: total },
    { step: 'confirmed', count: confirmed + completed },
    { step: 'completed', count: completed },
  ];
}

/** Distribusi hasil panggilan CALL-E (status provider; null → 'unknown'). */
export function aggregateCallOutcomes(
  rows: CallRow[],
): { status: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = row.status ?? 'unknown';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([status, count]) => ({ status, count }));
}

/** Pesan per channel, dipecah inbound/outbound. */
export function aggregateMessagesByChannel(
  rows: MessageRow[],
): { channel: string; inbound: number; outbound: number }[] {
  const map = new Map<string, { inbound: number; outbound: number }>();
  for (const row of rows) {
    const entry = map.get(row.channel) ?? { inbound: 0, outbound: 0 };
    if (row.direction === 'inbound') entry.inbound += 1;
    else entry.outbound += 1;
    map.set(row.channel, entry);
  }
  return [...map.entries()].map(([channel, counts]) => ({ channel, ...counts }));
}

/** Jumlah percakapan yang butuh perhatian staf/AI. */
export function countNeedsAttention(rows: ConversationRow[]): number {
  return rows.filter((row) => (row.state ?? {}).needsAttention === true).length;
}

/** Jumlah baris pada bulan berjalan (dipakai stat "bulan ini"). */
export function countThisMonth(rows: { createdAt: Date }[], now = new Date()): number {
  return rows.filter((row) => monthKey(row.createdAt) === monthKey(now)).length;
}
