import { zValidator } from '@hono/zod-validator';
import { and, asc, eq, gte, gt, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { WORKSPACE_TEMPLATE_CATEGORY_IDS, industryForTemplateCategory } from '@oriole/config';
import { INDUSTRIES } from '@oriole/call-goals';
import { bookings, conversations, profiles, workspaces } from '@oriole/database';

import { db } from '../db/index.ts';
import { emitVapiAssistantSync } from '../lib/vapi-assistant-sync.ts';
import { captureWorkspaceEvent } from '../lib/analytics.ts';
import { isValidTimezone } from '../lib/form-booking.ts';
import { requireAuth, type AuthVariables } from '../middleware/auth.ts';
import { rescheduleWorkspaceAutoCalls } from '../lib/reminders.ts';

/** Avatar bisnis: URL planet DiceBear (dipilih dari picker) atau data URL
 *  gambar upload (sudah di-crop 1:1 + di-compress client-side). */
const DICEBEAR_PLANETS_PREFIX = 'https://api.dicebear.com/10.x/planets/svg';
/** Data URL gambar max ~370KB biner (512×512 WebP hasil compress client). */
const MAX_AVATAR_CHARS = 500_000;

const avatarUrlField = z
  .string()
  .max(MAX_AVATAR_CHARS, 'Avatar terlalu besar (compress dulu di bawah 500KB)')
  .refine(
    (value) => value.startsWith(DICEBEAR_PLANETS_PREFIX) || value.startsWith('data:image/'),
    'Avatar harus berupa URL planet DiceBear atau data URL gambar',
  )
  .nullable()
  .optional();

/**
 * Knowledge base AI chat (WhatsApp) — sumber jawaban bot untuk layanan /
 * harga / jam / lokasi. Field teks bebas; semua opsional (owner boleh mengisi
 * sebagian). `faq` dibatasi jumlah & panjangnya agar tidak membebani prompt.
 */
const aiKnowledgeSchema = z.object({
  description: z.string().trim().max(2_000).optional(),
  services: z.string().trim().max(10_000).optional(),
  hours: z.string().trim().max(1_000).optional(),
  location: z.string().trim().max(2_000).optional(),
  policy: z.string().trim().max(2_000).optional(),
  faq: z
    .array(
      z.object({
        q: z.string().trim().min(1, 'Pertanyaan FAQ tidak boleh kosong').max(500),
        a: z.string().trim().min(1, 'Jawaban FAQ tidak boleh kosong').max(2_000),
      }),
    )
    .max(50, 'FAQ maksimal 50 butir')
    .optional(),
});

const workspaceSchema = z.object({
  name: z.string().trim().min(2).max(120),
  templateCategory: z.enum(WORKSPACE_TEMPLATE_CATEGORY_IDS),
  /** Avatar bisnis (planet DiceBear / upload 1:1). null = planet dari nama. */
  avatarUrl: avatarUrlField,
  /**
   * Industri bisnis (opsional) — dipakai untuk goal CALL-E otomatis.
   * Bila tidak dikirim, diturunkan dari `templateCategory` via
   * `industryForTemplateCategory` (user cukup memilih kategori sekali).
   */
  industry: z.enum(INDUSTRIES).optional(),
  /** Lead time reminder otomatis (menit sebelum jadwal). */
  reminderLeadMinutes: z.number().int().min(5).max(10_080).optional(),
  /** Bahasa panggilan CALL-E (hanya 'en' aktif saat ini; 'id' = extension point). */
  callGoalLanguage: z.enum(['en', 'id']).optional(),
  /** Nama asisten voice AI — greeting + label asisten Vapi. */
  callAssistantName: z.string().trim().min(1).max(80).optional(),
  /** Voice ID ElevenLabs — null = default server (env VAPI_VOICE_ID). */
  callVoiceId: z.string().trim().max(100).nullable().optional(),
  /** Ambang percobaan panggilan gagal sebelum goal jadi final follow-up (default 2). */
  maxCallAttempts: z.number().int().min(1).max(10).optional(),
  /** Bahasa balasan bot chat (Telegram / WhatsApp / email) — default 'en'. */
  chatLanguage: z.enum(['en', 'id']).optional(),
  /** Auto-call CALL-E aktif/mati. */
  autoCallEnabled: z.boolean().optional(),
  /** Berapa jam sebelum jadwal auto-call dipicu (default 24). */
  autoCallLeadHours: z.number().int().min(1).max(10_080).optional(),
  /** AI chat WhatsApp aktif/mati (default mati). */
  aiEnabled: z.boolean().optional(),
  /** Knowledge base AI chat — null = hapus KB (kembali ke kosong). */
  aiKnowledge: aiKnowledgeSchema.nullable().optional(),
  /** Situs web bisnis — null = hapus. */
  website: z.string().trim().max(200).nullable().optional(),
  /** Nomor telepon bisnis — null = hapus. */
  phone: z.string().trim().max(40).nullable().optional(),
  /** Lokasi bisnis — null = hapus. */
  country: z.string().trim().max(80).nullable().optional(),
  city: z.string().trim().max(80).nullable().optional(),
  address: z.string().trim().max(500).nullable().optional(),
  /** Jam buka mingguan — null = hapus (tidak ada jam buka tersimpan). */
  businessHours: z
    .array(
      z.object({
        dayOfWeek: z.number().int().min(0).max(6),
        startMinutes: z.number().int().min(0).max(1440),
        endMinutes: z.number().int().min(0).max(1440),
      }),
    )
    .max(7)
    .nullable()
    .optional(),
});

/** PATCH bersifat parsial — cukup kirim field yang ingin diubah. */
const workspacePatchSchema = workspaceSchema.partial();

const workspaceIdParamSchema = z.object({ id: z.string().uuid() });

/** Profil user (tabel `profiles`) — nama tampilan + preferensi bahasa/zona waktu. */
const profilePatchSchema = z.object({
  name: z.string().trim().min(1, 'Nama tidak boleh kosong').max(80, 'Nama maksimal 80 karakter'),
  /** Preferensi bahasa UI ('en' | 'id') — null/undefined = ikuti browser. */
  language: z.enum(['en', 'id']).nullable().optional(),
  /** Preferensi zona waktu (IANA, mis. 'Asia/Jakarta') — null/undefined = ikuti browser. */
  timezone: z
    .string()
    .trim()
    .refine((value) => isValidTimezone(value), 'Zona waktu tidak valid')
    .nullable()
    .optional(),
});

/** Identitas user + daftar bisnis yang dimiliki akun. */
export const meRoutes = new Hono<{ Variables: AuthVariables }>()
  .get('/', requireAuth, async (c) => {
    const userId = c.get('userId');
    const [profile] = await db
      .select({ displayName: profiles.displayName, language: profiles.language, timezone: profiles.timezone })
      .from(profiles)
      .where(eq(profiles.id, userId))
      .limit(1);
    // Bisnis soft-deleted disembunyikan — daftar hanya bisnis aktif.
    const userWorkspaces = await db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.userId, userId), isNull(workspaces.deletedAt)))
      .orderBy(asc(workspaces.createdAt));

    return c.json({
      userId,
      email: c.get('userEmail'),
      // Nama tampilan dari profil aplikasi (bisa diubah via PATCH /me);
      // null bila user belum pernah set — client memakai nama Neon Auth.
      name: profile?.displayName ?? null,
      // Preferensi UI user — null = ikuti browser (client memakai nilai ini
      // sebagai default bahasa/zona waktu saat sesi dipulihkan).
      language: profile?.language ?? null,
      timezone: profile?.timezone ?? null,
      workspaces: userWorkspaces,
    });
  })
  /* ── Profil — simpan nama tampilan (upsert ke tabel profiles) ── */
  /* ── Ringkasan unread per bisnis — badge di switcher bisnis sidebar ──
   * Total unreadCount percakapan inbox per workspace, hanya untuk bisnis
   * milik user ini. Ringan (aggregate SQL) — dipanggil client + polling.
   * ──────────────────────────────────────────────────────────── */
  .get('/unread-summary', requireAuth, async (c) => {
    const userId = c.get('userId');
    const rows = await db
      .select({
        workspaceId: conversations.workspaceId,
        unread: sql<number>`sum(${conversations.unreadCount})::int`,
      })
      .from(conversations)
      .innerJoin(workspaces, eq(workspaces.id, conversations.workspaceId))
      .where(and(eq(workspaces.userId, userId), isNull(workspaces.deletedAt), gt(conversations.unreadCount, 0)))
      .groupBy(conversations.workspaceId);

    const unreadByWorkspace: Record<string, number> = {};
    for (const row of rows) {
      unreadByWorkspace[row.workspaceId] = row.unread ?? 0;
    }
    return c.json({ unreadByWorkspace });
  })
  .patch('/', requireAuth, zValidator('json', profilePatchSchema), async (c) => {
    const userId = c.get('userId');
    const body = c.req.valid('json');
    const { name } = body;
    // language/timezone hanya diubah bila dikirim (undefined = jangan sentuh
    // nilai tersimpan; null = bersihkan preferensi → ikuti browser).
    const set: {
      displayName: string;
      updatedAt: Date;
      language?: string | null;
      timezone?: string | null;
    } = { displayName: name, updatedAt: new Date() };
    if (body.language !== undefined) set.language = body.language;
    if (body.timezone !== undefined) set.timezone = body.timezone;

    await db
      .insert(profiles)
      .values({
        id: userId,
        displayName: name,
        ...(body.language !== undefined ? { language: body.language } : {}),
        ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
      })
      .onConflictDoUpdate({
        target: profiles.id,
        set,
      });

    return c.json({
      name,
      ...(body.language !== undefined ? { language: body.language } : {}),
      ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
    });
  })
  .post('/workspaces', requireAuth, zValidator('json', workspaceSchema), async (c) => {
    const body = c.req.valid('json');
    const industry = body.industry ?? industryForTemplateCategory(body.templateCategory);
    const [workspace] = await db
      .insert(workspaces)
      .values({
        userId: c.get('userId'),
        name: body.name,
        templateCategory: body.templateCategory,
        industry,
        ...(body.avatarUrl !== undefined ? { avatarUrl: body.avatarUrl } : {}),
        ...(body.website !== undefined ? { website: body.website } : {}),
        ...(body.phone !== undefined ? { phone: body.phone } : {}),
        ...(body.country !== undefined ? { country: body.country } : {}),
        ...(body.city !== undefined ? { city: body.city } : {}),
        ...(body.address !== undefined ? { address: body.address } : {}),
        ...(body.businessHours !== undefined ? { businessHours: body.businessHours } : {}),
        ...(body.callAssistantName !== undefined ? { callAssistantName: body.callAssistantName } : {}),
        ...(body.callVoiceId !== undefined ? { callVoiceId: body.callVoiceId } : {}),
        ...(body.maxCallAttempts !== undefined ? { maxCallAttempts: body.maxCallAttempts } : {}),
      })
      .returning();

    captureWorkspaceEvent('workspace.created', {
      userId: c.get('userId'),
      workspaceId: workspace.id,
      templateCategory: workspace.templateCategory,
      industry: workspace.industry,
    });

    return c.json({ workspace }, 201);
  })
  .patch(
    '/workspaces/:id',
    requireAuth,
    zValidator('param', workspaceIdParamSchema),
    zValidator('json', workspacePatchSchema),
    async (c) => {
      const userId = c.get('userId');
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');

      if (
        !body.name &&
        !body.templateCategory &&
        body.industry === undefined &&
        body.reminderLeadMinutes === undefined &&
        body.callGoalLanguage === undefined &&
        body.chatLanguage === undefined &&
        body.autoCallEnabled === undefined &&
        body.autoCallLeadHours === undefined &&
        body.avatarUrl === undefined &&
        body.aiEnabled === undefined &&
        body.aiKnowledge === undefined &&
        body.website === undefined &&
        body.phone === undefined &&
        body.country === undefined &&
        body.city === undefined &&
        body.address === undefined &&
        body.businessHours === undefined &&
        body.callAssistantName === undefined &&
        body.callVoiceId === undefined &&
        body.maxCallAttempts === undefined
      ) {
        return c.json({ error: 'Tidak ada field yang diubah' }, 400);
      }

      // Sinkronisasi: industry mengikuti kategori baru, kecuali client mengirim
      // override eksplisit — nilai yang sengaja tidak cocok tetap dihormati.
      const industry =
        body.industry ??
        (body.templateCategory ? industryForTemplateCategory(body.templateCategory) : undefined);

      // Baca setting lama untuk mendeteksi perubahan auto-call → re-schedule.
      const [existing] = await db
        .select({ autoCallEnabled: workspaces.autoCallEnabled, autoCallLeadHours: workspaces.autoCallLeadHours })
        .from(workspaces)
        .where(and(eq(workspaces.id, id), eq(workspaces.userId, userId), isNull(workspaces.deletedAt)))
        .limit(1);
      if (!existing) {
        return c.json({ error: 'Workspace tidak ditemukan' }, 404);
      }

      const autoCallChanged =
        body.autoCallEnabled !== undefined &&
        body.autoCallEnabled !== existing.autoCallEnabled;
      const leadChanged =
        body.autoCallLeadHours !== undefined &&
        body.autoCallLeadHours !== existing.autoCallLeadHours;

      const [workspace] = await db
        .update(workspaces)
        .set({
          ...(body.name ? { name: body.name } : {}),
          ...(body.templateCategory ? { templateCategory: body.templateCategory } : {}),
          ...(industry !== undefined ? { industry } : {}),
          ...(body.reminderLeadMinutes !== undefined
            ? { reminderLeadMinutes: body.reminderLeadMinutes }
            : {}),
          ...(body.callGoalLanguage !== undefined ? { callGoalLanguage: body.callGoalLanguage } : {}),
          ...(body.chatLanguage !== undefined ? { chatLanguage: body.chatLanguage } : {}),
          ...(body.autoCallEnabled !== undefined ? { autoCallEnabled: body.autoCallEnabled } : {}),
          ...(body.autoCallLeadHours !== undefined ? { autoCallLeadHours: body.autoCallLeadHours } : {}),
          // null = hapus avatar (kembali ke planet dari nama).
          ...(body.avatarUrl !== undefined ? { avatarUrl: body.avatarUrl } : {}),
          ...(body.aiEnabled !== undefined ? { aiEnabled: body.aiEnabled } : {}),
          // null = hapus knowledge base AI chat.
          ...(body.aiKnowledge !== undefined ? { aiKnowledge: body.aiKnowledge } : {}),
          // null = hapus field info bisnis.
          ...(body.website !== undefined ? { website: body.website } : {}),
          ...(body.phone !== undefined ? { phone: body.phone } : {}),
          ...(body.country !== undefined ? { country: body.country } : {}),
          ...(body.city !== undefined ? { city: body.city } : {}),
          ...(body.address !== undefined ? { address: body.address } : {}),
          ...(body.businessHours !== undefined ? { businessHours: body.businessHours } : {}),
          // Settings Voice AI.
          ...(body.callAssistantName !== undefined ? { callAssistantName: body.callAssistantName } : {}),
          // null = kembali ke voice default server.
          ...(body.callVoiceId !== undefined ? { callVoiceId: body.callVoiceId } : {}),
          ...(body.maxCallAttempts !== undefined ? { maxCallAttempts: body.maxCallAttempts } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(workspaces.id, id), eq(workspaces.userId, userId), isNull(workspaces.deletedAt)))
        .returning();

      if (!workspace) {
        return c.json({ error: 'Workspace tidak ditemukan' }, 404);
      }

      // Setting auto-call berubah → re-schedule semua booking mendatang yang
      // aktif (cancel run lama dulu, lalu jadwalkan ulang dengan window baru).
      // Error di sini tidak menggagalkan PATCH — log & lanjut.
      if (autoCallChanged || leadChanged) {
        try {
          await rescheduleWorkspaceAutoCalls({
            workspaceId: id,
            enabled: body.autoCallEnabled ?? existing.autoCallEnabled,
            leadHours: body.autoCallLeadHours ?? existing.autoCallLeadHours,
          });
        } catch (error) {
          console.error(`[me] GAGAL re-schedule auto-call ${id}:`, error);
        }
      }

      // Data bisnis berubah (nama/KB/bahasa/voice) → sinkronkan asisten Vapi
      // permanen bila sudah di-provision (best-effort; transient tetap fallback).
      emitVapiAssistantSync(id).catch(() => {});

      return c.json({ workspace });
    },
  )
  /* ── Dampak setting auto-call: berapa booking terdampak + jadwal terdekat ── */
  .get(
    '/workspaces/:id/auto-call-impact',
    requireAuth,
    zValidator('param', workspaceIdParamSchema),
    zValidator(
      'query',
      z.object({ leadHours: z.coerce.number().int().min(1).max(10_080).default(24) }),
    ),
    async (c) => {
      const userId = c.get('userId');
      const { id } = c.req.valid('param');
      const { leadHours } = c.req.valid('query');

      const [workspace] = await db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(and(eq(workspaces.id, id), eq(workspaces.userId, userId), isNull(workspaces.deletedAt)))
        .limit(1);
      if (!workspace) return c.json({ error: 'Workspace tidak ditemukan' }, 404);

      // Booking terdampak: aktif (pending/confirmed) + punya nomor telepon.
      const base = and(
        eq(bookings.workspaceId, id),
        inArray(bookings.status, ['pending', 'confirmed']),
        isNotNull(bookings.phone),
      );
      const now = Date.now();
      const leadWindowMs = leadHours * 3_600_000;
      // Hanya booking yang autoCallAt-nya belum lewat yang benar-benar dipanggil.
      const callable = and(base, gte(bookings.scheduledAt, new Date(now + leadWindowMs)));
      // Booking yang jadwalnya sudah di dalam window (keburu) TIDAK akan
      // dipanggil — dilaporkan terpisah agar peringatan jujur.
      const tooSoon = and(
        base,
        gte(bookings.scheduledAt, new Date(now)),
        lt(bookings.scheduledAt, new Date(now + leadWindowMs)),
      );

      const [countRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(bookings)
        .where(callable);
      const [missedRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(bookings)
        .where(tooSoon);
      const [nearest] = await db
        .select({ scheduledAt: bookings.scheduledAt })
        .from(bookings)
        .where(callable)
        .orderBy(asc(bookings.scheduledAt))
        .limit(1);

      const nearestScheduledAt = nearest ? nearest.scheduledAt.toISOString() : null;
      return c.json({
        upcoming: countRow?.count ?? 0,
        // Booking yang jadwalnya terlalu dekat sehingga tidak sempat dipanggil.
        missed: missedRow?.count ?? 0,
        nearestScheduledAt,
        // Kapan panggilan terdekat akan berbunyi bila auto-call aktif (selalu
        // di masa depan karena sudah difilter window di atas).
        nearestCallAt: nearestScheduledAt
          ? new Date(nearest.scheduledAt.getTime() - leadWindowMs).toISOString()
          : null,
      });
    },
  )
  /* ── Hapus bisnis — SOFT DELETE ───────────────────────────
   * Baris tidak dihapus; `deletedAt` disetel sehingga bisnis hilang dari
   * semua read path (daftar bisnis, switcher, akses workspace). Penghapusan
   * permanen dilakukan job pembersih Inngest setelah masa tenggang
   * (WORKSPACE_DELETE_GRACE_DAYS) — FK cascade membersihkan data terkait.
   * Idempoten untuk request ganda: bisnis yang sudah soft-deleted → 404.
   * ─────────────────────────────────────────────────────────── */
  .delete(
    '/workspaces/:id',
    requireAuth,
    zValidator('param', workspaceIdParamSchema),
    async (c) => {
      const userId = c.get('userId');
      const { id } = c.req.valid('param');

      const [deleted] = await db
        .update(workspaces)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(workspaces.id, id), eq(workspaces.userId, userId), isNull(workspaces.deletedAt)))
        .returning({ id: workspaces.id, deletedAt: workspaces.deletedAt });

      if (!deleted) {
        return c.json({ error: 'Workspace tidak ditemukan' }, 404);
      }
      return c.json({ ok: true, id: deleted.id, deletedAt: deleted.deletedAt });
    },
  );
