import { and, eq } from 'drizzle-orm';
import { loadRootEnv } from '@oriole/config';
import { bookings, conversations, createDb, messages, workspaces } from '@oriole/database';

/**
 * CLI: seed percakapan inbox dummy (dengan unreadCount) untuk development.
 *
 *   pnpm --filter @oriole/api seed:unread [--workspace <workspaceId>]
 *
 * - Tanpa --workspace: dipakai workspace pertama milik user pertama.
 * - Membuat 3 percakapan (2 belum dibaca: 3 & 1 unread; 1 sudah dibaca: 0)
 *   lengkap dengan pesan inbound, supaya badge unread di switcher bisnis di
 *   sidebar dan daftar inbox terlihat berisi.
 * - Idempoten: percakapan dengan (workspace, channel, externalId) yang sama
 *   dilewati — aman dijalankan ulang kapan saja.
 */

function readArg(flag: string): string | undefined {
  const prefix = `--${flag}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
}

/** Data demo — externalId unik per channel (chat id / nomor / email). */
const DEMO_CONVERSATIONS: {
  channelType: 'telegram' | 'whatsapp' | 'email';
  externalId: string;
  customerName: string;
  unreadCount: number;
  messages: string[];
}[] = [
  {
    channelType: 'telegram',
    externalId: '1002003001',
    customerName: 'Umar Gunawan',
    unreadCount: 3,
    messages: [
      'Halo, apakah jadwal treatment saya minggu ini masih bisa?',
      'Saya mau pindah ke sore hari kalau bisa.',
      'Terima kasih!',
    ],
  },
  {
    channelType: 'whatsapp',
    externalId: '+6281234567890',
    customerName: 'Sinta Ramadhan',
    unreadCount: 1,
    messages: ['Permisi, apakah ada slot untuk konsultasi besok?'],
  },
  {
    channelType: 'email',
    externalId: 'customer.demo@example.com',
    customerName: 'Budi Santoso',
    unreadCount: 0,
    messages: ['Terima kasih atas reminder-nya, saya akan datang tepat waktu.'],
  },
];

async function main(): Promise<void> {
  loadRootEnv();

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL wajib diisi (root .env atau env platform).');
    process.exit(1);
  }
  const db = createDb(databaseUrl);

  // Target workspace: arg --workspace, atau workspace pertama user pertama.
  let workspaceId = readArg('workspace');
  let userId: string;
  if (!workspaceId) {
    const [first] = await db
      .select({ id: workspaces.id, userId: workspaces.userId, name: workspaces.name })
      .from(workspaces)
      .orderBy(workspaces.createdAt)
      .limit(1);
    if (!first) {
      console.error('Belum ada workspace. Buat bisnis dulu lewat UI (onboarding).');
      process.exit(1);
    }
    workspaceId = first.id;
    userId = first.userId;
    console.log(`→ Memakai workspace pertama: ${first.name} (${first.id})`);
  } else {
    const [ws] = await db
      .select({ userId: workspaces.userId, name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (!ws) {
      console.error(`Workspace tidak ditemukan: ${workspaceId}`);
      process.exit(1);
    }
    userId = ws.userId;
  }
  void userId; // nilai sementara tidak dipakai (WIP)

  // Booking pertama di workspace ini (opsional) — untuk tautan thread inbox.
  const [booking] = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(eq(bookings.workspaceId, workspaceId))
    .limit(1);

  let created = 0;
  let skipped = 0;

  for (const demo of DEMO_CONVERSATIONS) {
    const [existing] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.workspaceId, workspaceId),
          eq(conversations.channelType, demo.channelType),
          eq(conversations.externalId, demo.externalId),
        ),
      )
      .limit(1);

    if (existing) {
      console.log(`→ Lewati (sudah ada): ${demo.channelType} ${demo.externalId} (${demo.customerName})`);
      skipped += 1;
      continue;
    }

    const lastMessageAt = new Date();
    const [conversation] = await db
      .insert(conversations)
      .values({
        workspaceId,
        bookingId: booking?.id ?? null,
        channelType: demo.channelType,
        externalId: demo.externalId,
        customerName: demo.customerName,
        status: 'active',
        lastMessageAt,
        unreadCount: demo.unreadCount,
      })
      .returning({ id: conversations.id });

    await db.insert(messages).values(
      demo.messages.map((content, index) => ({
        conversationId: conversation.id,
        channelType: demo.channelType,
        direction: 'inbound' as const,
        providerMessageId: `seed-${demo.externalId}-${index}`,
        status: 'delivered' as const,
        content,
        // Beri jarak waktu antar pesan agar urutan thread masuk akal.
        createdAt: new Date(lastMessageAt.getTime() - (demo.messages.length - index) * 60_000),
      })),
    );

    console.log(
      `✅ Dibuat: ${demo.channelType} ${demo.externalId} (${demo.customerName}) — ${demo.unreadCount} unread`,
    );
    created += 1;
  }

  console.log(
    `\nSelesai: ${created} percakapan dibuat, ${skipped} dilewati (sudah ada). ` +
      `Badge unread kini tampil di switcher bisnis sidebar.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
