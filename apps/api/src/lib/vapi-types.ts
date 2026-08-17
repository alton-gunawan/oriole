import { z } from 'zod';

/**
 * Tipe payload webhook Vapi (server events).
 * Semua event dikirim sebagai POST ke server URL dengan bentuk:
 *   { "message": { "type": "...", "call": { ... }, ... } }
 * Lihat https://docs.vapi.ai/server-url/events
 */

/** Event yang kita proses: status-update (live) & end-of-call-report (terminal). */
export const VAPI_EVENT_TYPES = ['status-update', 'end-of-call-report'] as const;

export interface VapiCallMetadata {
  bookingId?: string;
  workspaceId?: string;
  userId?: string;
  goalType?: string;
}

export interface VapiWebhookMessage {
  type?: string;
  /** Status terbaru (event status-update). */
  status?: string;
  /** Alasan panggilan berakhir (event end-of-call-report). */
  endedReason?: string;
  call?: {
    id?: string;
    name?: string;
    status?: string;
    startedAt?: string;
    endedAt?: string;
    /** Id nomor Vapi yang menerima panggilan — dipakai resolve workspace inbound. */
    phoneNumberId?: string;
    /** Id asisten permanen yang dipakai call — fallback resolve workspace (Playground). */
    assistantId?: string;
    customer?: { number?: string } | null;
    metadata?: VapiCallMetadata | null;
    [key: string]: unknown;
  };
  /** Nomor telepon yang menerima panggilan (event assistant-request inbound). */
  phoneNumber?: {
    id?: string;
    number?: string;
    [key: string]: unknown;
  } | null;
  /** Tool calls yang diminta agen (event tool-calls). */
  toolCalls?: {
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
    [key: string]: unknown;
  }[];
  artifact?: {
    transcript?: string;
    recordingUrl?: string;
    messages?: unknown[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface VapiWebhookPayload {
  message?: VapiWebhookMessage;
  [key: string]: unknown;
}

/** Data yang di-queue ke Inngest untuk event vapi/event.received. */
export interface VapiEventData {
  eventId: string;
  eventType?: string;
  payload: VapiWebhookPayload;
}

/**
 * Validasi dalam payload webhook Vapi. Field yang dipakai downstream
 * (Inngest: upsert calleCalls, tandai booking completed) harus berbentuk
 * yang diketahui — field asing dibuang agar data yang disimpan selalu bersih.
 */
export const vapiWebhookPayloadSchema = z.object({
  message: z
    .object({
      type: z.string().optional(),
      status: z.string().optional(),
      endedReason: z.string().optional(),
      call: z
        .object({
          id: z.string().optional(),
          name: z.string().optional(),
          status: z.string().optional(),
          startedAt: z.string().optional(),
          endedAt: z.string().optional(),
          phoneNumberId: z.string().optional(),
          assistantId: z.string().optional(),
          customer: z
            .object({ number: z.string().optional() })
            .nullable()
            .optional(),
          metadata: z
            .object({
              bookingId: z.string().optional(),
              workspaceId: z.string().optional(),
              userId: z.string().optional(),
              goalType: z.string().optional(),
            })
            .nullable()
            .optional(),
        })
        .optional(),
      phoneNumber: z
        .object({ id: z.string().optional(), number: z.string().optional() })
        .nullable()
        .optional(),
      toolCalls: z
        .array(
          z.object({
            id: z.string().optional(),
            type: z.string().optional(),
            function: z
              .object({ name: z.string().optional(), arguments: z.string().optional() })
              .optional(),
          }),
        )
        .optional(),
      artifact: z
        .object({
          transcript: z.string().optional(),
          recordingUrl: z.string().optional(),
          messages: z.array(z.unknown()).optional(),
        })
        .optional(),
    })
    .optional(),
});

/** Parse schema di atas → tipe (undefined dibuang agar aman disimpan). */
export function parseVapiWebhookPayload(raw: unknown): VapiWebhookPayload | null {
  const parsed = vapiWebhookPayloadSchema.safeParse(raw);
  return parsed.success ? (parsed.data as VapiWebhookPayload) : null;
}

/**
 * Parse nama panggilan yang kita tetapkan saat create
 * (`booking:<bookingId>:<goalType>:<source>`) → bookingId (atau null).
 */
export function parseCallName(callName: string | null | undefined): { bookingId?: string } {
  if (!callName) return {};
  const parts = callName.split(':');
  if (parts[0] !== 'booking' || !parts[1]) return {};
  return { bookingId: parts[1] };
}
