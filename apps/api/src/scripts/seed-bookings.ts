import { eq } from 'drizzle-orm';
import { loadRootEnv } from '@oriole/config';
import { bookings, createDb, services, workspaces } from '@oriole/database';

/**
 * CLI: buat 50 booking dummy untuk sebuah workspace (development/seed).
 *
 *   pnpm --filter @oriole/api seed:bookings [--workspace <workspaceId>]
 *
 * - Tanpa --workspace: dipakai workspace pertama milik user pertama.
 * - Data dummy: nama Indonesia, telepon +62, status & jadwal bervariasi
 *   (rentang ±30 hari dari sekarang), beberapa dengan no-show/changeRequested.
 * - HANYA insert — tidak menyentuh tabel lain (reminder/auto-call tetap
 *   dijalankan oleh alur normal bila booking dibuat lewat API).
 */

function readArg(flag: string): string | undefined {
  const prefix = `--${flag}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
}

const FIRST_NAMES = [
  'Andi', 'Budi', 'Citra', 'Dewi', 'Eka', 'Fitri', 'Galih', 'Hana', 'Indra', 'Joko',
  'Kartika', 'Lestari', 'Maya', 'Nanda', 'Okta', 'Putri', 'Rizky', 'Sari', 'Teguh', 'Utami',
  'Vina', 'Wahyu', 'Yulia', 'Zaki', 'Agus', 'Bayu', 'Cahya', 'Dian', 'Erna', 'Fajar',
  'Gita', 'Hendra', 'Intan', 'Jihan', 'Kevin', 'Lia', 'Mega', 'Nadia', 'Oscar', 'Pandu',
  'Qori', 'Ratna', 'Sinta', 'Tono', 'Umar', 'Vera', 'Winda', 'Yoga', 'Zahra', 'Dimas',
];

const LAST_NAMES = [
  'Pratama', 'Saputra', 'Wijaya', 'Santoso', 'Nugroho', 'Hidayat', 'Kusuma', 'Setiawan',
  'Ramadhan', 'Putra', 'Lestari', 'Anggraini', 'Firmansyah', 'Gunawan', 'Halim', 'Iskandar',
  'Jatmiko', 'Kurniawan', 'Mahendra', 'Natalia', 'Oktaviani', 'Purnama', 'Rahayu', 'Susanti',
  'Tambunan', 'Utomo', 'Vermansyah', 'Wibowo', 'Yulianto', 'Zulkarnain',
];

const STATUSES = ['pending', 'confirmed', 'cancelled', 'completed'] as const;

/** Nomor telepon Indonesia dummy (tidak pernah dipanggil — format valid saja). */
function dummyPhone(): string {
  const prefix = '0812';
  const digits = Array.from({ length: 8 }, () => Math.floor(Math.random() * 10)).join('');
  return `+62${prefix.slice(1)}${digits}`;
}

/** Jadwal acak dalam rentang ±30 hari dari sekarang, jam kerja 08–20. */
function randomScheduledAt(): Date {
  const dayOffset = Math.floor(Math.random() * 61) - 30; // -30..+30
  const hour = 8 + Math.floor(Math.random() * 12);
  const minute = Math.random() < 0.5 ? 0 : 30;
  const date = new Date();
  date.setDate(date.getDate() + dayOffset);
  date.setHours(hour, minute, 0, 0);
  return date;
}

function randomItem<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

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

  // Booking diambil dari layanan katalog (kolom title sudah dihapus):
  // setiap booking dummy menautkan ke layanan workspace acak (bila ada).
  const catalog = await db
    .select({ id: services.id, name: services.name, durationMinutes: services.durationMinutes })
    .from(services)
    .where(eq(services.workspaceId, workspaceId));

  // Susun 50 baris booking dummy.
  const rows = Array.from({ length: 50 }, () => {
    const firstName = randomItem(FIRST_NAMES);
    const lastName = randomItem(LAST_NAMES);
    const service = catalog.length > 0 ? randomItem(catalog) : null;
    return {
      userId,
      workspaceId,
      description: Math.random() < 0.4 ? 'Booking via seeding — data dummy untuk development.' : null,
      scheduledAt: randomScheduledAt(),
      timezone: 'Asia/Jakarta',
      status: randomItem(STATUSES),
      customerName: `${firstName} ${lastName}`,
      phone: dummyPhone(),
      noShowCount: Math.random() < 0.15 ? 1 + Math.floor(Math.random() * 2) : 0,
      changeRequested: Math.random() < 0.2,
      industry: null,
      goalType: null,
      customInstruction: null,
      serviceId: service?.id ?? null,
      durationMinutes: service?.durationMinutes ?? 60,
    };
  });

  await db.insert(bookings).values(rows);
  console.log(`✅ 50 booking dummy dibuat untuk workspace ${workspaceId}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
