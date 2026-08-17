import { and, eq, isNull } from 'drizzle-orm';
import { loadRootEnv } from '@oriole/config';
import { workspaces } from '@oriole/database';

import { db } from '../db/index.ts';
import { type ServiceSnapshot } from '../lib/service-catalog.ts';
import {
  buildInboundAssistant,
  inboundAssistantName,
  provisionInboundAssistantForWorkspace,
} from '../lib/vapi-inbound.ts';
import { createVapiAssistant, getVapiAssistant } from '../services/vapi.ts';

/**
 * CLI: provision asisten Vapi permanen (jalur hibrida) untuk satu workspace.
 *
 *   pnpm --filter @oriole/api provision:vapi-assistant                 # workspace aktif pertama
 *   pnpm --filter @oriole/api provision:vapi-assistant -- --workspace <id>
 *   pnpm --filter @oriole/api provision:vapi-assistant -- --demo        # data contoh, tanpa DB
 *
 * Membuat (atau memperbarui bila sudah ada) asisten di dashboard Vapi dari
 * builder kode `buildInboundAssistant` — prompt + tools + daftar layanan
 * identik dengan asisten transient — lalu menyimpan assistantId di
 * `workspace_integrations` (type 'vapi-assistant'). Idempotent: dijalankan
 * ulang = re-sync asisten yang sama (update), bukan duplikat.
 *
 * Butuh env: VAPI_API_KEY. Untuk mode workspace juga butuh DATABASE_URL.
 */

function readArg(flag: string): string | undefined {
  const prefix = `--${flag}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
}

function demoServices(): ServiceSnapshot[] {
  const base = {
    description: null,
    color: '#f59e0b',
    category: null,
    isActive: true,
    sortOrder: 0,
    staffIds: [] as string[],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  return [
    { id: 'demo-1', name: 'Haircut & Styling', durationMinutes: 60, priceMinor: 150_000, currency: 'IDR', ...base },
    { id: 'demo-2', name: 'Hair Coloring', durationMinutes: 90, priceMinor: 350_000, currency: 'IDR', ...base },
    { id: 'demo-3', name: 'Manicure & Pedicure', durationMinutes: 75, priceMinor: 120_000, currency: 'IDR', ...base },
  ];
}

async function provisionDemo(): Promise<{ assistantId: string; name: string; updated: boolean }> {
  const workspaceName = 'Oriole Demo Salon';
  const name = inboundAssistantName(workspaceName);
  const dto = buildInboundAssistant({
    workspaceName,
    language: 'id',
    services: demoServices(),
    servicesText: null,
    knowledgeText:
      'jam buka: Sen–Sab 09.00–19.00\nlokasi: Jl. Melati No. 10, Jakarta\nkebijakan: pembatalan maksimal 24 jam sebelum jadwal',
  });
  const created = await createVapiAssistant({ ...dto, name });
  return { assistantId: created.assistantId, name: created.name, updated: false };
}

async function main(): Promise<void> {
  loadRootEnv();

  if (!process.env.VAPI_API_KEY) {
    console.error('VAPI_API_KEY wajib diisi di .env (dashboard.vapi.ai → API Keys).');
    process.exit(1);
  }

  const workspaceArg = readArg('workspace');
  const demo = process.argv.includes('--demo');

  let result: { assistantId: string; name: string; updated: boolean };
  let source: string;

  if (demo) {
    result = await provisionDemo();
    source = 'data contoh (--demo, tanpa DB)';
  } else {
    try {
      const [ws] = workspaceArg
        ? await db
            .select({ id: workspaces.id, name: workspaces.name })
            .from(workspaces)
            .where(and(eq(workspaces.id, workspaceArg), isNull(workspaces.deletedAt)))
            .limit(1)
        : await db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces).where(isNull(workspaces.deletedAt)).limit(1);
      if (!ws) throw new Error(workspaceArg ? `Workspace tidak ditemukan: ${workspaceArg}` : 'Tidak ada workspace aktif di DB');
      result = await provisionInboundAssistantForWorkspace(ws.id);
      source = `workspace "${ws.name}" (${ws.id})`;
    } catch (err) {
      if (workspaceArg) {
        console.error(`\n✗ ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
      console.log(`(DB tidak bisa dipakai: ${err instanceof Error ? err.message : err})`);
      console.log('Memakai data contoh (--demo).');
      result = await provisionDemo();
      source = 'data contoh (tanpa DB)';
    }
  }

  const verified = await getVapiAssistant(result.assistantId);
  console.log(`\n✅ Asisten Vapi permanen ${result.updated ? 'diperbarui (re-sync)' : 'dibuat'} untuk ${source}`);
  console.log(`   assistantId : ${result.assistantId}`);
  console.log(`   nama        : ${result.name}`);
  console.log(`   terverifikasi di akun: ${verified ? 'ya' : 'TIDAK (cek dashboard)'}`);
  console.log(`   dashboard   : https://dashboard.vapi.ai/assistant/${result.assistantId}`);
  console.log(
    '\nCatatan jalur hibrida: webhook assistant-request memakai asisten ini bila tersimpan;\n' +
      'jalankan ulang script ini setelah layanan/KB berubah untuk re-sync prompt.\n',
  );
}

main().catch((err) => {
  console.error(`\n✗ Provision asisten gagal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
