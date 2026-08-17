import { eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { db } from '../../db/index.ts';
import { inngest } from '../../inngest/client.ts';
import { calleCalls } from '@oriole/database';
import { env } from '../../lib/env.ts';
import { verifyBearerToken } from '../../lib/webhook-signature.ts';
import { markWebhookProcessed, recordWebhookEvent } from '../../lib/webhooks.ts';
import { parseVapiWebhookPayload, type VapiWebhookPayload } from '../../lib/vapi-types.ts';
import {
  buildInboundAssistantForWorkspace,
  getInboundAssistantForWorkspace,
  getWorkspaceIdByAssistantId,
  handleInboundToolCall,
  resolveInboundWorkspaceId,
} from '../../lib/vapi-inbound.ts';

/**
 * Webhook Vapi (server events) — dikirim Vapi sebagai POST ke server URL
 * asisten (transient, lihat services/vapi.ts).
 *
 * Keamanan: Vapi mengirim `Authorization: Bearer <secret>` (dikonfigurasi via
 * assistant.server.headers). Endpoint mewajibkan header itu cocok dengan
 * `VAPI_WEBHOOK_SECRET` (constant-time compare); header `X-Vapi-Secret`
 * juga diterima untuk konfigurasi credential legacy. Tanpa secret
 * terkonfigurasi endpoint bersifat fail-closed (503).
 *
 * Penanganan per tipe event:
 * - `assistant-request` → panggilan MASUK: resolve workspace dari
 *   `phoneNumber.id` → kembalikan asisten transient per-workspace (resepsionis
 *   AI dengan daftar layanan + tool booking). Tanpa ini Vapi menggantung call.
 * - `tool-calls`        → panggilan MASUK: dispatch tool `check_availability`
 *   / `create_booking` ke lib/vapi-inbound.ts; hasil JSON dikembalikan agar
 *   agen mengonfirmasi booking real-time di telepon.
 * - `status-update`   → update status live di tabel (idempotent, inline).
 * - `end-of-call-report` → event terminal: idempotency + Inngest (upsert
 *   hasil lengkap + tandai booking completed bila goal tercapai).
 * - event lain (hang, transcript, ...) → di-ack tanpa diproses.
 */
export const vapiWebhookRoutes = new Hono().post('/', async (c) => {
  const secret = env.VAPI_WEBHOOK_SECRET;
  if (!secret) {
    return c.json(
      {
        error:
          'Webhook belum dikonfigurasi: set VAPI_WEBHOOK_SECRET dan konfigurasi Authorization header di asisten Vapi (assistant.server.headers).',
      },
      503,
    );
  }

  // Terima Authorization: Bearer <secret> (kini) atau X-Vapi-Secret (legacy).
  const bearer = c.req.header('authorization') ?? '';
  const provided = bearer.startsWith('Bearer ') ? bearer.slice('Bearer '.length) : (c.req.header('x-vapi-secret') ?? '');
  if (!verifyBearerToken(provided, secret)) {
    return c.text('Invalid secret', 401);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await c.req.text());
  } catch {
    return c.json({ error: 'Payload bukan JSON valid' }, 400);
  }
  const payload = parseVapiWebhookPayload(parsed);
  if (!payload) {
    return c.json({ error: 'Payload tidak valid' }, 400);
  }

  const message = payload.message;
  const eventType = message?.type ?? 'unknown';
  const callId = message?.call?.id;

  /* ── Panggilan MASUK: Vapi meminta konfigurasi asisten (transient) ── */
  if (eventType === 'assistant-request') {
    const phoneNumberId = message?.phoneNumber?.id;
    if (!phoneNumberId) {
      return c.json({ error: 'assistant-request tanpa phoneNumber.id' }, 400);
    }
    const workspaceId = await resolveInboundWorkspaceId(phoneNumberId);
    if (!workspaceId) {
      return c.json({ error: 'Nomor inbound tidak terdaftar di aplikasi.' }, 404);
    }
    // Jalur hibrida: asisten permanen yang sudah di-provision dari kode
    // (bisa di-test di dashboard Vapi) dipakai lebih dulu. Fallback ke
    // asisten transient per-workspace bila belum di-provision — prompt
    // transient selalu fresh dari DB; asisten permanen mengikuti saat
    // terakhir di-provision (re-sync otomatis oleh Inngest).
    let stored: { assistantId: string; name: string | null } | null = null;
    try {
      stored = await getInboundAssistantForWorkspace(workspaceId);
    } catch (err) {
      // Kegagalan baca DB tidak boleh menggagalkan call — fallback transient
      // (call tetap jalan; tool-calls me-resolve workspace dari nomor).
      console.warn('[vapi-webhook] gagal baca asisten tersimpan (fallback transient):', err);
    }
    if (stored) {
      return c.json({ assistantId: stored.assistantId });
    }
    const assistant = await buildInboundAssistantForWorkspace(workspaceId);
    if (!assistant) {
      return c.json({ error: 'Workspace untuk nomor inbound tidak ditemukan.' }, 404);
    }
    return c.json({ assistant });
  }

  /* ── Panggilan MASUK: agen memanggil tool (booking real-time) ── */
  if (eventType === 'tool-calls') {
    if (!callId) {
      return c.json({ error: 'tool-calls tanpa call.id' }, 400);
    }
    const phoneNumberId = message?.call?.phoneNumberId;
    const rawAssistantId = message?.call?.assistantId;
    const assistantId = typeof rawAssistantId === 'string' ? rawAssistantId : undefined;
    // Resolve workspace: prefer nomor inbound (panggilan telepon); fallback ke
    // assistantId permanen untuk web call / Playground Vapi (tanpa nomor).
    const workspaceId = phoneNumberId
      ? await resolveInboundWorkspaceId(phoneNumberId)
      : assistantId
        ? await getWorkspaceIdByAssistantId(assistantId)
        : null;
    if (!workspaceId) {
      return c.json({ error: 'Nomor inbound tidak terdaftar di aplikasi.' }, 404);
    }

    const results = [];
    for (const toolCall of message?.toolCalls ?? []) {
      const toolCallId = toolCall.id ?? '';
      const name = toolCall.function?.name ?? 'unknown';
      const outcome = await handleInboundToolCall(workspaceId, { callId, toolCallId }, {
        name,
        arguments: toolCall.function?.arguments ?? '',
      });
      if (outcome.ok) {
        results.push({ toolCallId, name, result: JSON.stringify(outcome.result) });
      } else {
        results.push({ toolCallId, name, error: outcome.error });
      }
    }
    return c.json({ results });
  }

  if (!callId) {
    return c.json({ error: 'Event tanpa call.id' }, 400);
  }

  // Status live: update langsung (idempotent — set nilai yang sama aman),
  // tanpa Inngest & tanpa log webhook (terlalu berisik per panggilan).
  // Vapi mengirim status di `message.status`; fallback ke `call.status`.
  if (eventType === 'status-update') {
    const status = message?.status ?? message?.call?.status;
    if (status) {
      await db
        .update(calleCalls)
        .set({ status, updatedAt: new Date() })
        .where(eq(calleCalls.calleCallId, callId));
    }
    return c.json({ received: true, event: eventType, callId, status });
  }

  if (eventType === 'end-of-call-report') {
    // Idempotency per (provider, eventId) — Vapi tidak mengirim header event
    // id; key = `${call.id}:eocr` (satu laporan akhir per panggilan).
    const eventId = `${callId}:eocr`;
    const record = await recordWebhookEvent(db, 'vapi', eventId, eventType, payload);
    if (record === 'processed') {
      return c.json({ duplicate: true, eventId }, 200);
    }

    // `id` = idempotency Inngest: bila markWebhookProcessed gagal setelah send
    // sukses, pengiriman ulang webhook dengan eventId yang sama di-dedup oleh
    // Inngest (event tidak memicu fungsi dua kali).
    await inngest.send({
      id: eventId,
      name: 'vapi/event.received',
      data: { eventId, eventType, payload },
    });
    await markWebhookProcessed(db, 'vapi', eventId);

    return c.json({ received: true, eventId });
  }

  // Event informatif lain — ack saja (tidak ada side effect).
  return c.json({ received: true, event: eventType, callId });
});

/** Ekspor tipe payload agar handler Inngest konsisten. */
export type { VapiWebhookPayload };
