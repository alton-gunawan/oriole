import { eq } from 'drizzle-orm';
import { loadRootEnv } from '@oriole/config';
import {
  contacts,
  createDb,
  customerChannels,
  workspaceChannels,
  workspaces,
} from '@oriole/database';

/**
 * CLI dev: isi knowledge base AI chat contoh untuk workspace 'Northside Studio'
 * (toggle AI on + layanan/harga/jam/lokasi/kebijakan/FAQ), lalu cetak status
 * prasyarat kirim WhatsApp nyata (channel + nomor customer) untuk uji bot.
 *
 *   pnpm --filter @oriole/api seed:ai-kb [--workspace <workspaceId>]
 *
 * Idempoten: meng-overwrite ai_knowledge workspace target dengan contoh ini.
 */
const SAMPLE_KNOWLEDGE = {
  description:
    'Northside Studio — klinik perawatan hewan peliharaan di Jakarta. Melayani grooming, vaksinasi, dan konsultasi dokter hewan.',
  services:
    'Grooming kecil (kucing) 150rb\nGrooming besar (anjing) 250rb\nVaksinasi lengkap 350rb\nKonsultasi dokter hewan 100rb\nPembersihan telinga 50rb',
  hours: 'Senin–Sabtu 08.00–20.00, Minggu 09.00–15.00',
  location:
    'Jl. Merdeka No. 12, Jakarta Selatan (seberang Taman Suropati)',
  policy: 'Reschedule gratis hingga 12 jam sebelum jadwal. Pembatalan < 12 jam dikenakan biaya 50% dari deposit.',
  faq: [
    { q: 'Terima kartu?', a: 'Ya, debit & kredit diterima.' },
    { q: 'Melayani hewan darurat?', a: 'Ya — untuk kasus darurat hubungi kami langsung di WhatsApp agar segera dijadwalkan.' },
    { q: 'Berapa lama grooming kucing?', a: 'Sekitar 1,5–2 jam tergantung kondisi bulu.' },
  ],
};

function readArg(flag: string): string | undefined {
  const prefix = `--${flag}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
}

async function main(): Promise<void> {
  loadRootEnv();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL wajib diisi (root .env).');
    process.exit(1);
  }
  const db = createDb(databaseUrl);

  const targetId = readArg('workspace');
  const [ws] = targetId
    ? await db.select().from(workspaces).where(eq(workspaces.id, targetId)).limit(1)
    : await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.name, 'Northside Studio'))
        .limit(1);

  if (!ws) {
    console.error('Workspace "Northside Studio" tidak ditemukan. Daftar workspace:');
    const all = await db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces);
    for (const w of all) console.log(`  - ${w.name} (${w.id})`);
    process.exit(1);
  }

  await db
    .update(workspaces)
    .set({ aiEnabled: true, aiKnowledge: SAMPLE_KNOWLEDGE, updatedAt: new Date() })
    .where(eq(workspaces.id, ws.id));

  console.log(`✓ AI aktif + knowledge base contoh terisi untuk "${ws.name}" (${ws.id})`);
  console.log(`  services: ${SAMPLE_KNOWLEDGE.services.split('\n').length} baris, FAQ: ${SAMPLE_KNOWLEDGE.faq.length} butir`);

  // ── Inspeksi prasyarat kirim WhatsApp nyata ──
  const channels = await db
    .select({
      channelType: workspaceChannels.channelType,
      isActive: workspaceChannels.isActive,
      provider: workspaceChannels.providerConfig,
    })
    .from(workspaceChannels)
    .where(eq(workspaceChannels.workspaceId, ws.id));
  console.log(`\nChannel terkonfigurasi: ${channels.length === 0 ? 'TIDAK ADA' : ''}`);
  for (const ch of channels) {
    const cfg = (ch.provider ?? {}) as { provider?: string };
    console.log(`  - ${ch.channelType} (isActive=${ch.isActive}, provider=${cfg.provider ?? '360dialog'})`);
  }
  if (channels.length === 0) {
    console.log('  (fallback env WHATSAPP_API_KEY di .env: ' + (process.env.WHATSAPP_API_KEY ? 'ada' : 'TIDAK ADA') + ')');
  }

  const custChannels = await db
    .select({ channelType: customerChannels.channelType, identifier: customerChannels.identifier, contactPhone: customerChannels.contactPhone, isOptedIn: customerChannels.isOptedIn })
    .from(customerChannels)
    .where(eq(customerChannels.workspaceId, ws.id))
    .limit(20);
  console.log(`\nCustomer channel (${custChannels.length}):`);
  for (const c of custChannels) {
    console.log(`  - ${c.channelType} ${c.identifier} → phone=${c.contactPhone ?? '-'} optedIn=${c.isOptedIn}`);
  }

  const custContacts = await db
    .select({ name: contacts.name, phone: contacts.phone })
    .from(contacts)
    .where(eq(contacts.workspaceId, ws.id))
    .limit(10);
  console.log(`\nKontak (${custContacts.length}):`);
  for (const c of custContacts) console.log(`  - ${c.name} (${c.phone})`);

  console.log(`\nAI_CHAT_API_KEY di .env: ${process.env.AI_CHAT_API_KEY ? 'ada' : 'TIDAK ADA (AI tidak akan menjawab)'}`);
}

void main();
