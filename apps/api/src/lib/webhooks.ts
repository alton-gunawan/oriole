import { and, eq } from 'drizzle-orm';
import { webhookEvents, type Database } from '@oriole/database';

export type WebhookRecordResult = 'new' | 'pending' | 'processed';

/**
 * Catat event webhook dengan idempotency: unik per (provider, eventId).
 *
 * - `'new'`      → event baru, silakan proses.
 * - `'pending'`  → duplikat TAPI belum selesai diproses (attempt sebelumnya
 *                  gagal di tengah) — proses ulang, jangan buang.
 * - `'processed'`→ duplikat yang sudah selesai — abaikan.
 */
export async function recordWebhookEvent(
  db: Database,
  provider: string,
  eventId: string,
  eventType: string | undefined,
  payload: Record<string, unknown>,
): Promise<WebhookRecordResult> {
  const [inserted] = await db
    .insert(webhookEvents)
    .values({ provider, eventId, eventType, payload })
    .onConflictDoNothing()
    .returning({ id: webhookEvents.id });

  if (inserted) {
    return 'new';
  }

  const [existing] = await db
    .select({ processedAt: webhookEvents.processedAt })
    .from(webhookEvents)
    .where(and(eq(webhookEvents.provider, provider), eq(webhookEvents.eventId, eventId)))
    .limit(1);

  return existing?.processedAt ? 'processed' : 'pending';
}

/** Tandai event webhook sudah diproses. */
export async function markWebhookProcessed(
  db: Database,
  provider: string,
  eventId: string,
): Promise<void> {
  await db
    .update(webhookEvents)
    .set({ processedAt: new Date() })
    .where(and(eq(webhookEvents.provider, provider), eq(webhookEvents.eventId, eventId)));
}
