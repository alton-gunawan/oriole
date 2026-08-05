/**
 * Asumsi struktur payload webhook CALL-E berdasarkan
 * https://docs.heycall-e.com/#/webhooks — event dikirim TANPA signature,
 * hanya setelah hasil panggilan difinalisasi. Idempotency via header
 * `CALL-E-Event-Id` / `body.id`.
 *
 * Index signature agar bisa disimpan apa adanya ke kolom jsonb.
 * Sesuaikan field ini dengan contoh payload aktual saat integrasi nyata.
 */
export interface CalleWebhookPayload {
  id: string;
  type?: string;
  createdAt?: string;
  data?: {
    callId?: string;
    phone?: string;
    status?: string;
    result?: Record<string, unknown> | null;
    /** user_id pemilik panggilan (dikirim via custom data saat call dibuat). */
    userId?: string;
    /** workspace_id active project saat panggilan dibuat. */
    workspaceId?: string;
    /** booking_id booking yang dicoba dihubungi (via custom data). */
    bookingId?: string;
  };
  [key: string]: unknown;
}

/** Data yang di-queue ke Inngest untuk event calle/event.received. */
export interface CalleEventData {
  eventId: string;
  eventType?: string;
  payload: CalleWebhookPayload;
}
