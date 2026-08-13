import { eq } from 'drizzle-orm';
import { loadRootEnv } from '@oriole/config';
import { createDb, staffMembers, staffSchedules, staffTimeOff, workspaces } from '@oriole/database';

/**
 * CLI: buat tim staf dummy (Staff & Team) untuk sebuah workspace (development).
 *
 *   pnpm --filter @oriole/api seed:staff [--workspace <workspaceId>]
 *
 * - Tanpa --workspace: dipakai workspace pertama milik user pertama.
 * - Membuat ~9 staf dengan jadwal mingguan (beberapa dengan 2 rentang/hari —
 *   mis. istirahat siang) dan cuti di masa depan untuk sebagian staf.
 *   Termasuk 2 staf non-aktif supaya state "tidak bisa di-assign" terlihat.
 * - Idempoten: staf dengan email yang sama di workspace yang sama dilewati —
 *   aman dijalankan ulang kapan saja (tidak membuat duplikat).
 * - HANYA insert — tidak menyentuh tabel lain (booking lama yang menunjuk
 *   staf seed tetap valid karena staf ini tidak dihapus).
 */

function readArg(flag: string): string | undefined {
  const prefix = `--${flag}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
}

/** Menit sejak tengah malam — jadwal staf disimpan dalam bentuk ini. */
function at(hour: number, minute = 0): number {
  return hour * 60 + minute;
}

/** Tanggal YYYY-MM-DD relatif dari hari ini (untuk cuti yang selalu di masa depan). */
function dateFromNow(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Nomor telepon Indonesia dummy (format valid saja — tidak pernah dihubungi). */
function dummyPhone(): string {
  const digits = Array.from({ length: 8 }, () => Math.floor(Math.random() * 10)).join('');
  return `+62812${digits}`;
}

interface SeedSchedule {
  dayOfWeek: number; // 0=Sunday .. 6=Saturday
  startMinutes: number;
  endMinutes: number;
}

interface SeedStaff {
  name: string;
  email: string;
  color: string;
  timezone: string;
  bufferMinutes: number;
  isActive: boolean;
  schedules: SeedSchedule[];
  /** Cuti opsional: [hariMulai, hariSelesai, alasan] relatif dari hari ini. */
  timeOff?: [number, number, string][];
}

/**
 * Tim demo — klinik/konsultasi gaya Indonesia (nama sama seperti seed-bookings
 * supaya konsisten). Warna dipakai untuk avatar/chip di halaman Staff & Team.
 */
const SEED_STAFF: SeedStaff[] = [
  {
    name: 'Dr. Sari Wijaya',
    email: 'sari.wijaya@example.com',
    color: '#8b5cf6',
    timezone: 'Asia/Jakarta',
    bufferMinutes: 15,
    isActive: true,
    schedules: [
      { dayOfWeek: 1, startMinutes: at(8), endMinutes: at(17) },
      { dayOfWeek: 2, startMinutes: at(8), endMinutes: at(17) },
      { dayOfWeek: 3, startMinutes: at(8), endMinutes: at(17) },
      { dayOfWeek: 4, startMinutes: at(8), endMinutes: at(17) },
      { dayOfWeek: 5, startMinutes: at(8), endMinutes: at(17) },
      { dayOfWeek: 6, startMinutes: at(9), endMinutes: at(13) },
    ],
    timeOff: [
      [21, 23, 'Seminar kedokteran di luar kota'],
      [45, 47, 'Cuti tahunan'],
    ],
  },
  {
    name: 'Rizky Pratama',
    email: 'rizky.pratama@example.com',
    color: '#0ea5e9',
    timezone: 'Asia/Jakarta',
    bufferMinutes: 10,
    isActive: true,
    schedules: [
      { dayOfWeek: 2, startMinutes: at(9), endMinutes: at(18) },
      { dayOfWeek: 3, startMinutes: at(9), endMinutes: at(18) },
      { dayOfWeek: 4, startMinutes: at(9), endMinutes: at(18) },
      { dayOfWeek: 5, startMinutes: at(9), endMinutes: at(18) },
      { dayOfWeek: 6, startMinutes: at(9), endMinutes: at(18) },
    ],
  },
  {
    name: 'Maya Anggraini',
    email: 'maya.anggraini@example.com',
    color: '#f59e0b',
    timezone: 'Asia/Jakarta',
    bufferMinutes: 0,
    isActive: true,
    // Dua rentang per hari — istirahat siang 12:00–13:00.
    schedules: [
      { dayOfWeek: 1, startMinutes: at(8), endMinutes: at(12) },
      { dayOfWeek: 1, startMinutes: at(13), endMinutes: at(16) },
      { dayOfWeek: 2, startMinutes: at(8), endMinutes: at(12) },
      { dayOfWeek: 2, startMinutes: at(13), endMinutes: at(16) },
      { dayOfWeek: 3, startMinutes: at(8), endMinutes: at(12) },
      { dayOfWeek: 3, startMinutes: at(13), endMinutes: at(16) },
      { dayOfWeek: 4, startMinutes: at(8), endMinutes: at(12) },
      { dayOfWeek: 4, startMinutes: at(13), endMinutes: at(16) },
      { dayOfWeek: 5, startMinutes: at(8), endMinutes: at(12) },
      { dayOfWeek: 5, startMinutes: at(13), endMinutes: at(16) },
    ],
  },
  {
    name: 'Hendra Kurniawan',
    email: 'hendra.kurniawan@example.com',
    color: '#10b981',
    timezone: 'Asia/Makassar',
    bufferMinutes: 20,
    isActive: true,
    schedules: [
      { dayOfWeek: 1, startMinutes: at(7), endMinutes: at(15) },
      { dayOfWeek: 3, startMinutes: at(7), endMinutes: at(15) },
      { dayOfWeek: 5, startMinutes: at(7), endMinutes: at(15) },
    ],
    timeOff: [[28, 30, 'Medical check-up']],
  },
  {
    name: 'Nadia Rahayu',
    email: 'nadia.rahayu@example.com',
    color: '#ec4899',
    timezone: 'Asia/Jakarta',
    bufferMinutes: 15,
    isActive: true,
    schedules: [
      { dayOfWeek: 3, startMinutes: at(10), endMinutes: at(19) },
      { dayOfWeek: 4, startMinutes: at(10), endMinutes: at(19) },
      { dayOfWeek: 5, startMinutes: at(10), endMinutes: at(19) },
      { dayOfWeek: 6, startMinutes: at(10), endMinutes: at(19) },
      { dayOfWeek: 0, startMinutes: at(10), endMinutes: at(17) },
    ],
  },
  {
    name: 'Budi Firmansyah',
    email: 'budi.firmansyah@example.com',
    color: '#f97316',
    timezone: 'Asia/Jakarta',
    bufferMinutes: 10,
    isActive: true,
    schedules: [
      { dayOfWeek: 1, startMinutes: at(6), endMinutes: at(14) },
      { dayOfWeek: 2, startMinutes: at(6), endMinutes: at(14) },
      { dayOfWeek: 3, startMinutes: at(6), endMinutes: at(14) },
      { dayOfWeek: 4, startMinutes: at(6), endMinutes: at(14) },
      { dayOfWeek: 5, startMinutes: at(6), endMinutes: at(14) },
      { dayOfWeek: 6, startMinutes: at(7), endMinutes: at(12) },
    ],
  },
  {
    name: 'Citra Mahendra',
    email: 'citra.mahendra@example.com',
    color: '#14b8a6',
    timezone: 'Asia/Jakarta',
    bufferMinutes: 5,
    isActive: true,
    schedules: [
      { dayOfWeek: 1, startMinutes: at(9), endMinutes: at(17) },
      { dayOfWeek: 2, startMinutes: at(9), endMinutes: at(17) },
      { dayOfWeek: 3, startMinutes: at(9), endMinutes: at(17) },
      { dayOfWeek: 4, startMinutes: at(9), endMinutes: at(17) },
    ],
  },
  {
    name: 'Kevin Gunawan',
    email: 'kevin.gunawan@example.com',
    color: '#6366f1',
    timezone: 'Asia/Jakarta',
    bufferMinutes: 0,
    isActive: true,
    schedules: [
      { dayOfWeek: 2, startMinutes: at(13), endMinutes: at(21) },
      { dayOfWeek: 4, startMinutes: at(13), endMinutes: at(21) },
      { dayOfWeek: 6, startMinutes: at(9), endMinutes: at(17) },
      { dayOfWeek: 0, startMinutes: at(9), endMinutes: at(17) },
    ],
    timeOff: [[35, 38, 'Acara keluarga']],
  },
  {
    name: 'Lestari Purnama',
    email: 'lestari.purnama@example.com',
    color: '#84cc16',
    timezone: 'Asia/Jakarta',
    bufferMinutes: 0,
    // Non-aktif — contoh anggota tim yang sudah keluar.
    isActive: false,
    schedules: [
      { dayOfWeek: 1, startMinutes: at(8), endMinutes: at(16) },
      { dayOfWeek: 2, startMinutes: at(8), endMinutes: at(16) },
      { dayOfWeek: 3, startMinutes: at(8), endMinutes: at(16) },
      { dayOfWeek: 4, startMinutes: at(8), endMinutes: at(16) },
      { dayOfWeek: 5, startMinutes: at(8), endMinutes: at(16) },
    ],
  },
  {
    name: 'Tono Iskandar',
    email: 'tono.iskandar@example.com',
    color: '#ef4444',
    timezone: 'Asia/Jakarta',
    bufferMinutes: 0,
    // Non-aktif — contoh staf yang sedang berhenti sementara.
    isActive: false,
    schedules: [
      { dayOfWeek: 6, startMinutes: at(9), endMinutes: at(15) },
      { dayOfWeek: 0, startMinutes: at(9), endMinutes: at(15) },
    ],
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
      console.error('Belum ada workspace. Buat project dulu lewat UI (onboarding).');
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

  // Idempoten: lewati staf yang email-nya sudah terdaftar di workspace ini.
  const existingRows = await db
    .select({ email: staffMembers.email })
    .from(staffMembers)
    .where(eq(staffMembers.workspaceId, workspaceId));
  const existingEmails = new Set(existingRows.map((row) => row.email).filter(Boolean));

  let created = 0;
  let skipped = 0;

  for (const demo of SEED_STAFF) {
    if (existingEmails.has(demo.email)) {
      console.log(`→ Lewati (sudah ada): ${demo.name} (${demo.email})`);
      skipped += 1;
      continue;
    }

    const [staff] = await db
      .insert(staffMembers)
      .values({
        userId,
        workspaceId,
        name: demo.name,
        email: demo.email,
        phone: dummyPhone(),
        color: demo.color,
        timezone: demo.timezone,
        bufferMinutes: demo.bufferMinutes,
        isActive: demo.isActive,
      })
      .returning({ id: staffMembers.id });

    if (demo.schedules.length > 0) {
      await db.insert(staffSchedules).values(
        demo.schedules.map((s) => ({ staffId: staff.id, ...s })),
      );
    }

    for (const [startDays, endDays, reason] of demo.timeOff ?? []) {
      const start = dateFromNow(startDays);
      const end = dateFromNow(endDays);
      // Simpan tanggal (tanpa zona) sebagai tengah malam UTC — sama seperti
      // route POST /api/staff/:id/time-off.
      await db.insert(staffTimeOff).values({
        staffId: staff.id,
        startDate: new Date(`${start}T00:00:00.000Z`),
        endDate: new Date(`${end}T00:00:00.000Z`),
        reason,
      });
    }

    console.log(
      `✅ Dibuat: ${demo.name} (${demo.email}) — ${demo.schedules.length} jadwal, ` +
        `${demo.timeOff?.length ?? 0} cuti${demo.isActive ? '' : ', non-aktif'}`,
    );
    created += 1;
  }

  console.log(
    `\nSelesai: ${created} staf dibuat, ${skipped} dilewati (sudah ada). ` +
      `Buka halaman Staff & Team untuk melihat hasilnya.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
