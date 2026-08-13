import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { and, eq } from 'drizzle-orm';
import { loadRootEnv } from '@oriole/config';
import { conversations, createDb, messages, workspaces } from '@oriole/database';

/**
 * CLI dev: demo bot AI menjawab dari knowledge base nyata (DB dev).
 *
 *   pnpm --filter @oriole/api test:ai-bot [--question "Berapa harga grooming kucing?"] [--workspace <id>]
 *
 * - Menjalankan MOCK LLM lokal (http://localhost:8787) yang menjawab dari
 *   knowledge base yang ada di prompt (tanpa panggilan eksternal / biaya).
 * - Membuat percakapan + pesan inbound untuk nomor test, lalu memanggil
 *   `tryAiChatReply` (fungsi produksi sungguhan) terhadap DB dev.
 * - Mencetak jawaban AI + status handoff. Tidak ada pesan yang dikirim ke
 *   luar (send WhatsApp tidak dieksekusi di sini).
 */
const MOCK_LLM_PORT = 8787;
const TEST_NUMBER = '6281234567890';
const QUESTION = readArg('question') ?? 'Berapa harga grooming kucing?';

function readArg(flag: string): string | undefined {
  const prefix = `--${flag}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
}

/** Mock LLM: jawab pertanyaan dari baris knowledge base di system prompt. */
function mockAnswer(system: string, question: string) {
  const kb = system.split('Knowledge base:')[1]?.split('Aturan:')[0] ?? '';
  const lower = question.toLowerCase();
  const pick = (pattern: RegExp) => {
    const line = kb.split('\n').find((l) => pattern.test(l.toLowerCase()));
    return line ? line.replace(/^-\s*[^:]+:\s*/, '').trim() : null;
  };
  if (/harga|berapa|biaya|tarif/.test(lower)) {
    const line = kb.split('\n').find((l) => /layanan & harga/i.test(l));
    const body = line ? line.split(':').slice(1).join(':').trim() : null;
    if (body) return { answer: `Berikut layanan kami: ${body}`, confidence: 0.95, needsHuman: false, reason: 'answered-from-kb' };
    const faq = kb.match(/Q: [^\n]*harga[^\n]*\n  A: ([^\n]+)/i);
    if (faq) return { answer: faq[1], confidence: 0.95, needsHuman: false, reason: 'answered-from-kb' };
  }
  if (/jam|buka|tutup|hari apa/.test(lower)) {
    const found = pick(/jam buka/);
    if (found) return { answer: `Jam buka kami: ${found}`, confidence: 0.95, needsHuman: false, reason: 'answered-from-kb' };
  }
  if (/lokasi|alamat|di mana|dimana/.test(lower)) {
    const found = pick(/lokasi/);
    if (found) return { answer: `Alamat kami: ${found}`, confidence: 0.95, needsHuman: false, reason: 'answered-from-kb' };
  }
  const faqMatch = kb.match(new RegExp(`Q: ([^\\n]*${lower.split(' ')[0]}[^\\n]*)\\n  A: ([^\\n]+)`, 'i'));
  if (faqMatch) return { answer: faqMatch[2], confidence: 0.95, needsHuman: false, reason: 'answered-from-kb' };
  // Di luar KB → confidence rendah (handoff) — perilaku sama seperti LLM asli.
  return { answer: 'Maaf, saya tidak menemukan jawabannya.', confidence: 0.2, needsHuman: false, reason: 'out-of-kb' };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
  });
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
    res.writeHead(404).end();
    return;
  }
  const body = JSON.parse(await readBody(req)) as { messages?: { role: string; content: string }[] };
  const system = body.messages?.find((m) => m.role === 'system')?.content ?? '';
  const question =
    body.messages?.filter((m) => m.role === 'user').at(-1)?.content.split('\n').at(-1) ?? QUESTION;
  const result = mockAnswer(system, question);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
});

async function main(): Promise<void> {
  loadRootEnv();

  // Override env AI → mock lokal, SEBELUM modul ai-chat/env di-import.
  process.env.AI_CHAT_BASE_URL = `http://localhost:${MOCK_LLM_PORT}/v1`;
  process.env.AI_CHAT_API_KEY = 'dev-mock-key';

  await new Promise<void>((resolve) => server.listen(MOCK_LLM_PORT, resolve));
  console.log(`[mock-llm] mendengarkan :${MOCK_LLM_PORT}`);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL wajib diisi');
  const db = createDb(databaseUrl);

  const targetId = readArg('workspace');
  const [ws] = targetId
    ? await db.select().from(workspaces).where(eq(workspaces.id, targetId)).limit(1)
    : await db.select().from(workspaces).where(eq(workspaces.name, 'Northside Studio')).limit(1);
  if (!ws) throw new Error('Workspace target tidak ditemukan');

  // Percakapan untuk nomor test (find-or-create) + pesan inbound pertanyaan.
  const [existingConv] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.workspaceId, ws.id),
        eq(conversations.channelType, 'whatsapp'),
        eq(conversations.externalId, TEST_NUMBER),
      ),
    )
    .limit(1);
  const conversation = existingConv ?? (await db.insert(conversations).values({
    workspaceId: ws.id,
    channelType: 'whatsapp',
    externalId: TEST_NUMBER,
    customerName: 'Budi',
    status: 'active',
  }).returning())[0];

  await db.insert(messages).values({
    conversationId: conversation.id,
    channelType: 'whatsapp',
    direction: 'inbound',
    providerMessageId: `mock-wamid-${Date.now()}`,
    content: QUESTION,
    status: 'sent',
  }).onConflictDoNothing();

  // ── Panggil fungsi PRODUKSI yang sama dengan handler WhatsApp ──
  const { tryAiChatReply } = await import('../lib/ai-chat.ts');
  console.log(`\nPertanyaan: "${QUESTION}" (workspace: ${ws.name})`);
  const reply = await tryAiChatReply(ws.id, conversation.id);

  if (!reply) {
    console.log('→ AI tidak menjawab (null) — AI mati / KB kosong / LLM gagal. Fallback perilaku lama.');
  } else {
    console.log(`→ Jawaban bot: "${reply.text}"`);
    console.log(`→ Ditandai pesan AI (metadata ai): ${reply.ai === true}`);
  }

  const [after] = await db
    .select({ state: conversations.state })
    .from(conversations)
    .where(eq(conversations.id, conversation.id))
    .limit(1);
  const state = (after?.state ?? {}) as { needsAttention?: boolean };
  console.log(`→ Handoff ke staf (needsAttention): ${state.needsAttention === true}`);

  server.close();
}

void main().catch((err) => {
  console.error(err);
  server.close();
  process.exit(1);
});
