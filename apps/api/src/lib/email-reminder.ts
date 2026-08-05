import { and, eq } from 'drizzle-orm';
import { contacts, conversations, messages } from '@oriole/database';
import { brand } from '@oriole/config';
import { normalizePhone, renderBookingReminder, formatSlotTime } from '@oriole/messaging';

import { db } from '../db/index.ts';
import { resend } from '../services/email.ts';

/** Error bisnis siap-tampil — dipetakan route → 400 (atau di-skip oleh scheduler). */
export class EmailDispatchError extends Error {}

/**
 * Kirim reminder via email (channel outbound-only; inbound parsing email
 * butuh Resend inbound webhook — catat sebagai extension point).
 *
 * Email customer di-resolve dari tabel contacts (via nomor HP booking).
 * Pesan dicatat ke unified inbox (conversation externalId = email) agar
 * satu tempat dengan Telegram/WhatsApp.
 */
export async function dispatchEmailReminder(input: {
  workspaceId: string;
  booking: {
    id: string;
    title: string;
    customerName: string | null;
    phone: string | null;
    scheduledAt: Date;
    timezone: string;
  };
  businessName: string | null;
}): Promise<void> {
  const phone = input.booking.phone;
  if (!phone) {
    throw new EmailDispatchError('Booking belum memiliki nomor telepon customer.');
  }

  // Pencocokan via normalizePhone (digit saja) — konsisten dengan seluruh
  // sistem (findChatByPhone dll). Pencocokan raw 'eq' bisa gagal karena
  // format nomor berbeda (+62 vs 62 vs spasi).
  const contactRows = await db
    .select({ email: contacts.email, name: contacts.name, phone: contacts.phone })
    .from(contacts)
    .where(eq(contacts.workspaceId, input.workspaceId))
    .limit(500);
  const contact = contactRows.find((row) => row.email && normalizePhone(row.phone) === phone);

  const email = contact?.email;
  if (!email) {
    throw new EmailDispatchError('Tidak ada email customer di kontak untuk booking ini.');
  }

  const reminder = renderBookingReminder(
    {
      businessName: input.businessName ?? 'kami',
      customerName: input.booking.customerName ?? contact.name,
      title: input.booking.title,
      scheduledAt: input.booking.scheduledAt.toISOString(),
      timezone: input.booking.timezone,
    },
    input.booking.id,
  );

  // Siapkan percakapan + cek dedup DULU (sebelum kirim) agar retry Inngest
  // tidak mengirim email ganda.
  const [existing] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.workspaceId, input.workspaceId),
        eq(conversations.channelType, 'email'),
        eq(conversations.externalId, email),
      ),
    )
    .limit(1);

  let conversationId = existing?.id;
  if (!conversationId) {
    const [created] = await db
      .insert(conversations)
      .values({
        workspaceId: input.workspaceId,
        bookingId: input.booking.id,
        channelType: 'email',
        externalId: email,
        customerName: input.booking.customerName ?? contact.name ?? null,
        status: 'active',
        lastMessageAt: new Date(),
      })
      .returning({ id: conversations.id });
    conversationId = created?.id;
  }
  if (!conversationId) return;

  const reminderMetadata = { reminderBookingId: input.booking.id };
  const [alreadySent] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.direction, 'outbound'),
        eq(messages.metadata, reminderMetadata),
      ),
    )
    .limit(1);
  if (alreadySent) return;

  // Catat 'queued' SEBELUM kirim — baris ini jadi jaring pengaman dedup.
  await db
    .insert(messages)
    .values({
      conversationId,
      channelType: 'email',
      direction: 'outbound',
      providerMessageId: '',
      content: reminder.text,
      status: 'queued',
      metadata: reminderMetadata,
    })
    .onConflictDoNothing();
  await db
    .update(conversations)
    .set({ bookingId: input.booking.id, lastMessageAt: new Date(), updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));

  const html = [
    `<p>${reminder.text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br/>')}</p>`,
    '<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0"/>',
    '<p style="color:#6b7280;font-size:12px">',
    `Butuh bantuan? Balas email ini atau hubungi ${input.businessName ?? 'kami'} langsung.`,
    '</p>',
  ].join('');

  const { data, error } = await resend.emails.send({
    from: brand.emailFrom,
    to: [email],
    subject: `Pengingat booking: ${input.booking.title} — ${formatSlotTime(
      input.booking.scheduledAt.toISOString(),
      input.booking.timezone,
    )}`,
    html,
  });
  if (error) {
    throw new EmailDispatchError(`Resend gagal mengirim email: ${error.message}`);
  }

  await db
    .update(messages)
    .set({ status: 'sent', providerMessageId: data?.id ?? '' })
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.direction, 'outbound'),
        eq(messages.metadata, reminderMetadata),
      ),
    );
}
