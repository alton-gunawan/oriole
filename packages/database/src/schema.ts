import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgSchema,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { WORKSPACE_TEMPLATE_CATEGORY_IDS } from '@oriole/config';
import { INDUSTRIES } from '@oriole/call-goals';

/**
 * Schema `neon_auth` dimiliki dan dikelola sepenuhnya oleh **Neon Auth**
 * (Managed Better Auth). Tabel user/session/account/verification dibuat
 * otomatis oleh Neon saat fitur Auth diaktifkan di console Neon.
 *
 * Definisi tabel `user` di bawah ini HANYA untuk referensi type-safe pada
 * foreign key tabel aplikasi kita. JANGAN migrasikan / drop bagian ini —
 * sinkronkan dengan database sungguhan via `pnpm db:pull`.
 */
export const neonAuth = pgSchema('neon_auth');

export const authUser = neonAuth.table('user', {
  id: uuid().primaryKey().notNull(),
  name: text().notNull(),
  email: text().notNull(),
  emailVerified: boolean().notNull(),
  image: text(),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

/* ────────────────────────────────────────────────────────────
 * Public schema — tabel aplikasi
 * ──────────────────────────────────────────────────────────── */

export const bookingStatus = pgEnum('booking_status', [
  'pending',
  'confirmed',
  'cancelled',
  'completed',
]);

export const subscriptionStatus = pgEnum('subscription_status', [
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
]);

/** Industri bisnis (workspace) — dipilih sekali saat onboarding / business settings. */
export const businessIndustry = pgEnum('business_industry', [...INDUSTRIES]);

/** Profil tambahan per user aplikasi (1:1 dengan auth user). */
export const profiles = pgTable(
  'profiles',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    displayName: text('display_name'),
    plan: text('plan').default('free').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
);

/**
 * Workspace / bisnis milik user. Satu akun dapat memiliki banyak
 * workspace, masing-masing dengan template bisnis yang berbeda.
 */
export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    templateCategory: text('template_category').notNull(),
    /** Industri dipilih sekali saat onboarding — dipakai untuk goal CALL-E otomatis. */
    industry: businessIndustry('industry'),
    /** Berapa menit sebelum jadwal reminder dikirim (default 120 = 2 jam). */
    reminderLeadMinutes: integer('reminder_lead_minutes').default(120).notNull(),
    /** Bahasa panggilan CALL-E (default en; id = extension point yang belum aktif). */
    callGoalLanguage: text('call_goal_language').default('en').notNull(),
    /**
     * Bahasa balasan bot chat (Telegram / WhatsApp / email) — default en.
     * Terpisah dari callGoalLanguage agar bahasa bot bisa diatur independen
     * dari bahasa panggilan CALL-E.
     */
    chatLanguage: text('chat_language').default('en').notNull(),
    /**
     * Avatar bisnis. null = planet DiceBear deterministik dari nama bisnis;
     * selain itu bisa berupa URL planet DiceBear (hasil pemilihan di picker)
     * atau data URL gambar upload (sudah di-crop 1:1 + di-compress di client).
     */
    avatarUrl: text('avatar_url'),
    /** Auto-call CALL-E aktif/mati (default mati — panggilan manual tetap tersedia). */
    autoCallEnabled: boolean('auto_call_enabled').default(false).notNull(),
    /** Berapa jam sebelum jadwal auto-call dipicu (default 24). */
    autoCallLeadHours: integer('auto_call_lead_hours').default(24).notNull(),
    /**
     * AI chat WhatsApp aktif/mati (default mati — tanpa persetujuan owner,
     * tidak ada perubahan perilaku bot). Saat aktif + knowledge base terisi,
     * bot menjawab pertanyaan layanan/harga/jam/lokasi dari KB; di luar KB
     * tetap handoff ke staf (needsAttention).
     */
    aiEnabled: boolean('ai_enabled').default(false).notNull(),
    /** Knowledge base AI chat: layanan+harga, jam buka, lokasi, kebijakan, FAQ. */
    aiKnowledge: jsonb('ai_knowledge').$type<AiKnowledge | null>(),
    /**
     * Soft-delete: bisnis dihapus (hilang dari UI) dengan menyetel kolom ini;
     * baris + semua data terkait (booking, kontak, chat, ...) dihapus permanen
     * oleh job pembersih (Inngest cron) setelah masa tenggang 3 hari.
     */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('workspaces_user_id_idx').on(t.userId),
    // Job pembersih soft-delete: scan workspace yang sudah lewat masa tenggang.
    index('workspaces_deleted_at_idx').on(t.deletedAt),
    // CHECK constraint menegakkan daftar kategori yang sama dengan
    // WORKSPACE_TEMPLATE_CATEGORY_IDS di @oriole/config — data invalid
    // ditolak di level database, bukan hanya di validasi API.
    check(
      'workspaces_template_category_check',
      // sql.raw aman di sini: daftar nilai berasal dari konstanta `as const`
      // milik kita sendiri (WORKSPACE_TEMPLATE_CATEGORY_IDS), bukan input user.
      sql`${t.templateCategory} in (${sql.raw(
        WORKSPACE_TEMPLATE_CATEGORY_IDS.map((categoryId) => `'${categoryId}'`).join(', '),
      )})`,
    ),
  ],
);

/**
 * Knowledge base AI chat (WhatsApp) — sumber jawaban bot untuk pertanyaan
 * layanan / harga / jam buka / lokasi. Disimpan sebagai JSON di kolom
 * `workspaces.ai_knowledge`. Semua field teks bebas (owner menulis di UI
 * settings); prompt LLM menyusunnya apa adanya, jadi formatnya sengaja
 * longgar agar mudah dirawat pemilik bisnis.
 */
export interface AiKnowledge {
  /** Deskripsi singkat usaha (1-2 kalimat) — konteks identitas bot. */
  description?: string;
  /** Layanan + harga, bebas format teks ("Cuci mobil 50rb, poles 150rb …"). */
  services?: string;
  /** Jam buka ("Sen–Sab 08.00–20.00"). */
  hours?: string;
  /** Alamat + patokan / link maps. */
  location?: string;
  /** Kebijakan lain (opsional): deposit, pembatalan, dsb. */
  policy?: string;
  /** FAQ tambahan di luar field di atas. */
  faq?: { q: string; a: string }[];
}

/**
 * Layanan (service catalog) per workspace — sumber kebenaran nama / durasi /
 * harga layanan yang ditawarkan bisnis. Dipakai untuk:
 *  - auto-fill booking (title + durasi + routing staf saat membuat booking),
 *  - slot engine availabilitas (durasi layanan, bukan tebakan per booking),
 *  - knowledge base AI chat (generate daftar layanan+harga dari katalog).
 * `priceMinor` sengaja nullable: banyak bisnis jasa tidak mencantumkan harga
 * (paket custom / negosiasi) — null = harga belum di-set.
 */
export const services = pgTable(
  'services',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    /** Durasi layanan dalam menit (5..720) — dipakai slot engine & auto-fill booking. */
    durationMinutes: integer('duration_minutes').default(60).notNull(),
    /** Harga dalam minor units (sen) — null = harga belum di-set. */
    priceMinor: integer('price_minor'),
    /** Kode mata uang ISO 4217 — dipakai bersama priceMinor. */
    currency: text('currency').default('USD').notNull(),
    /** Warna aksen (chip/badge) — hex, mis. '#f59e0b'. */
    color: text('color').default('#f59e0b').notNull(),
    /** Kategori/tag layanan (bebas teks, mis. ["Perawatan", "Paket"]). */
    category: text('category').array(),
    isActive: boolean('is_active').default(true).notNull(),
    /** Urutan tampilan di dropdown/picker (naik). */
    sortOrder: integer('sort_order').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('services_workspace_id_idx').on(t.workspaceId),
    index('services_user_id_idx').on(t.userId),
  ],
);

/** Langganan Paddle (Merchant of Record) — historis per perubahan status. */
export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    paddleCustomerId: text('paddle_customer_id'),
    paddleSubscriptionId: text('paddle_subscription_id').notNull(),
    planId: text('plan_id'),
    priceId: text('price_id'),
    status: subscriptionStatus('status').default('trialing').notNull(),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').default(false).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('subscriptions_paddle_sub_id_idx').on(t.paddleSubscriptionId),
    index('subscriptions_user_id_idx').on(t.userId),
  ],
);

/** Booking — entitas inti SaaS booking. */
export const bookings = pgTable(
  'bookings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    // Title TIDAK disimpan — booking diambil dari layanan katalog: nama layanan
    // (services.name) selalu menjadi title, diturunkan saat dibaca (lihat
    // apps/api/src/lib/booking-title.ts).
    description: text('description'),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    timezone: text('timezone').default('UTC').notNull(),
    status: bookingStatus('status').default('pending').notNull(),
    calleCallId: text('calle_call_id'),
    /** Kontak customer untuk panggilan CALL-E. */
    customerName: text('customer_name'),
    phone: text('phone'),
    /**
     * Kontak terkait di tabel `contacts` — sinkron find-or-create saat
     * booking dibuat/diubah (nomor telepon unik per workspace). Set null
     * bila kontak dihapus (booking tetap ada).
     */
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    /** Override industri per-booking (opsional); kosong = ikut industri workspace. */
    industry: businessIndustry('industry'),
    /** Override goal CALL-E (opsional); null = otomatis via determineCallGoal. */
    goalType: text('goal_type'),
    /** Instruksi tambahan dari bisnis yang disisipkan ke prompt CALL-E. */
    customInstruction: text('custom_instruction'),
    /** Riwayat no-show customer pada booking ini. */
    noShowCount: integer('no_show_count').default(0).notNull(),
    /** Customer meminta perubahan jadwal. */
    changeRequested: boolean('change_requested').default(false).notNull(),
    /**
     * Staf yang menangani booking (nullable = tanpa staf / mode lama).
     * Dihapus (set null) bila staf dihapus — booking tetap ada.
     */
    staffId: uuid('staff_id').references(() => staffMembers.id, { onDelete: 'set null' }),
    /**
     * Layanan katalog terkait (nullable = booking tanpa katalog / mode lama).
     * Dihapus (set null) bila layanan dihapus — booking tetap ada. Saat layanan
     * di-set, durasi diisi otomatis dari katalog dan nama layanan menjadi title
     * (lihat route bookings: resolveServiceDefaults & lib/booking-title.ts).
     */
    serviceId: uuid('service_id').references(() => services.id, { onDelete: 'set null' }),
    /** Durasi layanan dalam menit (5..720). Dipakai slot engine & event kalender. */
    durationMinutes: integer('duration_minutes').default(60).notNull(),
    /** Aturan pengulangan — nullable = booking sekali (one-off). */
    recurrence: jsonb('recurrence').$type<RecurrenceRule | null>(),
    /**
     * Id seri pengulangan — semua instance booking dari satu seri berbagi
     * id ini (untuk cancel/complete seluruh seri). Null = bukan seri.
     */
    recurrenceSeriesId: uuid('recurrence_series_id'),
    /**
     * Link video call (Zoom join URL / Google Meet hangoutLink) untuk booking
     * — dihasilkan otomatis saat integrasi video aktif (zoom) atau lewat
     * sync Google Calendar (meet). Disertakan ke reminder & tampilan detail.
     */
    videoLink: text('video_link'),
    /**
     * Asal pembuatan booking (mis. 'google-forms' / 'tally' / manual).
     * Dipakai untuk idempotensi (bersama sourceRef) — retry webhook tidak
     * membuat booking ganda — dan jejak asal booking.
     */
    source: text('source'),
    /** Referensi unik dari sumber (responseId Google Forms / submissionId Tally). */
    sourceRef: text('source_ref'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('bookings_user_id_idx').on(t.userId),
    index('bookings_scheduled_at_idx').on(t.scheduledAt),
    index('bookings_contact_id_idx').on(t.contactId),
    index('bookings_staff_id_idx').on(t.staffId),
    index('bookings_service_id_idx').on(t.serviceId),
    index('bookings_recurrence_series_id_idx').on(t.recurrenceSeriesId),
    // Idempotensi booking dari form: satu (source, sourceRef) per workspace.
    uniqueIndex('bookings_source_ref_idx')
      .on(t.workspaceId, t.source, t.sourceRef)
      .where(sql`${t.source} is not null`),
  ],
);

/**
 * Kontak klien per workspace — dipakai untuk panggilan AI dan booking.
 * Nomor telepon unik per workspace (duplikat menandakan data ganda).
 */
export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    phone: text('phone').notNull(),
    email: text('email'),
    notes: text('notes'),
    /**
     * Kapan terakhir kali kontak ini ditawari re-engagement otomatis
     * (pesan "kami rindu Anda" untuk pelanggan dorman / no-show). Dipakai
     * cooldown agar customer tidak di-spam setiap run cron.
     */
    lastReEngagedAt: timestamp('last_re_engaged_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('contacts_workspace_phone_idx').on(t.workspaceId, t.phone),
    index('contacts_user_id_idx').on(t.userId),
    index('contacts_workspace_id_idx').on(t.workspaceId),
  ],
);

/* ────────────────────────────────────────────────────────────
 * Staf / tim (practitioner) per workspace + jadwal & cuti
 * ──────────────────────────────────────────────────────────── */

/**
 * Aturan pengulangan booking (recurring appointments). Disimpan sebagai
 * JSON di kolom `bookings.recurrence`. Semua komputasi waktu memakai UTC.
 *
 * - `frequency` + `interval`: berapa sering terjadi (tiap N hari/minggu/bulan).
 * - `count` / `until`: kapan berhenti (salah satu; count menang bila keduanya).
 * - `weekdays`: HANYA untuk weekly — hari dalam seminggu (0=Min..6=Sab) yang
 *   dilayani; kosong/tidak ada = hanya hari pertama (anchor) tiap interval.
 */
export interface RecurrenceRule {
  frequency: 'daily' | 'weekly' | 'monthly';
  interval: number;
  count?: number;
  until?: string;
  weekdays?: number[];
}

/** Anggota staf (practitioner) — satu booking dapat ditugaskan ke satu staf. */
export const staffMembers = pgTable(
  'staff_members',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    email: text('email'),
    phone: text('phone'),
    /** Warna aksen (avatar/chip) — hex, mis. '#f59e0b'. */
    color: text('color').default('#f59e0b').notNull(),
    /** Zona waktu jadwal mingguan staf (schedules/day_of_week dihitung di zona ini). */
    timezone: text('timezone').default('UTC').notNull(),
    isActive: boolean('is_active').default(true).notNull(),
    /** Buffer menit antara dua booking berurutan staf ini (anti back-to-back). */
    bufferMinutes: integer('buffer_minutes').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('staff_members_workspace_id_idx').on(t.workspaceId),
    index('staff_members_user_id_idx').on(t.userId),
  ],
);

/**
 * Jadwal mingguan per staf: hari kerja + rentang jam (menit sejak tengah
 * malam, zona waktu staf). Satu staf boleh punya beberapa rentang per hari
 * (mis. 09:00-12:00 dan 14:00-18:00).
 */
export const staffSchedules = pgTable(
  'staff_schedules',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    staffId: uuid('staff_id')
      .notNull()
      .references(() => staffMembers.id, { onDelete: 'cascade' }),
    /** 0=Sunday .. 6=Saturday. */
    dayOfWeek: integer('day_of_week').notNull(),
    startMinutes: integer('start_minutes').notNull(),
    endMinutes: integer('end_minutes').notNull(),
  },
  (t) => [index('staff_schedules_staff_id_idx').on(t.staffId)],
);

/**
 * Staf yang melayani layanan (many-to-many) — routing staf saat booking:
 * layanan dengan SATU staf ter-assign otomatis memilih staf itu; layanan
 * dengan banyak staf menyerahkan pilihan ke user. Staff dihapus → tautan
 * ikut terhapus (cascade); layanan dihapus → tautan ikut terhapus.
 */
export const serviceStaff = pgTable(
  'service_staff',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
    staffId: uuid('staff_id')
      .notNull()
      .references(() => staffMembers.id, { onDelete: 'cascade' }),
  },
  (t) => [
    uniqueIndex('service_staff_service_staff_idx').on(t.serviceId, t.staffId),
    index('service_staff_staff_id_idx').on(t.staffId),
  ],
);

/**
 * Cuti / hari libur per staf (rentang tanggal). Hari penuh — dipakai mesin
 * availabilitas untuk memblokir slot, dan menimpa jadwal mingguan.
 */
export const staffTimeOff = pgTable(
  'staff_time_off',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    staffId: uuid('staff_id')
      .notNull()
      .references(() => staffMembers.id, { onDelete: 'cascade' }),
    startDate: timestamp('start_date', { withTimezone: true }).notNull(),
    endDate: timestamp('end_date', { withTimezone: true }).notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('staff_time_off_staff_id_idx').on(t.staffId)],
);

/** Panggilan CALL-E yang dijalankan dari aplikasi. */
export const calleCalls = pgTable(
  'calle_calls',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').references(() => authUser.id, { onDelete: 'set null' }),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
    /** Booking yang dicoba dihubungi — untuk menghitung attempt per booking. */
    bookingId: uuid('booking_id').references(() => bookings.id, { onDelete: 'set null' }),
    calleCallId: text('calle_call_id').notNull(),
    phone: text('phone').notNull(),
    task: text('task'),
    /** Goal type yang terkirim (audit trail). */
    goalType: text('goal_type'),
    status: text('status'),
    result: jsonb('result').$type<Record<string, unknown> | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('calle_calls_call_id_idx').on(t.calleCallId),
    index('calle_calls_user_id_idx').on(t.userId),
    index('calle_calls_booking_id_idx').on(t.bookingId),
  ],
);

/**
 * Idempotency log untuk semua webhook masuk (Paddle, CALL-E, ...).
 * Unik per (provider, eventId) — event duplikat otomatis ditolak,
 * sehingga side effect (inngest) hanya terjadi satu kali.
 */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    provider: text('provider').notNull(),
    eventId: text('event_id').notNull(),
    eventType: text('event_type'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('webhook_events_provider_event_id_idx').on(t.provider, t.eventId)],
);

/* ────────────────────────────────────────────────────────────
 * Multi-channel messaging (Fase 0+1 — Telegram MVP)
 * ──────────────────────────────────────────────────────────── */

/** Status percakapan chat — dipakai state machine alur booking via chat. */
export const conversationStatus = pgEnum('conversation_status', [
  'active',
  'waiting_input',
  'closed',
]);

export const messageDirection = pgEnum('message_direction', ['inbound', 'outbound']);

export const messageStatus = pgEnum('message_status', ['queued', 'sent', 'delivered', 'failed']);

/**
 * Kredensial channel per workspace (multi-tenant: tiap bisnis punya bot /
 * nomor WhatsApp sendiri). `providerConfig` berisi token privat (bot_token,
 * webhook secret) — jangan pernah di-expose ke client frontend.
 */
export const workspaceChannels = pgTable(
  'workspace_channels',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    channelType: text('channel_type').notNull(),
    /** Identitas publik channel (bot username / nomor WhatsApp). */
    identifier: text('identifier'),
    /** Kredensial privat per provider (bot_token, webhook_secret, ...). */
    providerConfig: jsonb('provider_config').$type<Record<string, unknown>>().notNull(),
    isActive: boolean('is_active').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('workspace_channels_ws_type_idx').on(t.workspaceId, t.channelType),
    index('workspace_channels_workspace_id_idx').on(t.workspaceId),
  ],
);

/**
 * Integrasi aplikasi eksternal per workspace (Notion, ...) — di luar channel
 * komunikasi. `providerConfig` berisi kredensial privat (token) — jangan
 * pernah di-expose ke client frontend.
 */
export const workspaceIntegrations = pgTable(
  'workspace_integrations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    integrationType: text('integration_type').notNull(),
    /** Identitas publik integrasi (nama database Notion / dsb.). */
    identifier: text('identifier'),
    /** Kredensial privat per provider (token Notion, databaseId, ...). */
    providerConfig: jsonb('provider_config').$type<Record<string, unknown>>().notNull(),
    isActive: boolean('is_active').default(true).notNull(),
    /** Kapan sinkronisasi terakhir berhasil (mis. sync kontak → Notion). */
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('workspace_integrations_ws_type_idx').on(t.workspaceId, t.integrationType),
    index('workspace_integrations_workspace_id_idx').on(t.workspaceId),
  ],
);

/**
 * Status koneksi WhatsApp Business (Meta Embedded Signup — Tech Provider).
 * `connecting`  : flow signup Meta sedang berjalan (state dibuat sebelum redirect).
 * `connected`   : onboarding selesai, WABA + nomor tersimpan & webhook subscribe.
 * `error`       : onboarding/refresh gagal — pesan error ramah disimpan.
 * `disconnected`: tenant memutus koneksi (token dihapus, metadata dipertahankan).
 */
export const whatsappConnectionStatus = pgEnum('whatsapp_connection_status', [
  'connecting',
  'connected',
  'error',
  'disconnected',
]);

/**
 * Koneksi WhatsApp Business per tenant (Meta Cloud API via Embedded Signup).
 *
 * Satu baris per workspace (unique workspace_id). `accessTokenEncrypted` adalah
 * business integration system user access token (per tenant) — dienkripsi
 * at-rest via `encryptSecret` (AES-256-GCM), TIDAK pernah dikirim ke frontend.
 * Tenant di-resolve dari webhook via `phone_number_id` (unique per nomor).
 *
 * Kehadiran baris ini TIDAK mengganggu channel WhatsApp lama (360dialog/WAHA)
 * yang disimpan di workspace_channels — provider 'meta' ditambahkan sebagai
 * opsi ketiga di resolveWhatsAppChannel.
 */
export const whatsappConnections = pgTable(
  'whatsapp_connections',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    wabaId: text('waba_id'),
    phoneNumberId: text('phone_number_id'),
    displayPhoneNumber: text('display_phone_number'),
    businessName: text('business_name'),
    status: whatsappConnectionStatus('status').default('connecting').notNull(),
    errorMessage: text('error_message'),
    /** Business token per tenant — terenkripsi at-rest (encryptSecret). */
    accessTokenEncrypted: text('access_token_encrypted'),
    /** State CSRF alur Embedded Signup (dibuat di /connect, diverifikasi di callback). */
    signupState: text('signup_state'),
    /** Metadata integrasi (verified_name, quality_rating, dll.) — tanpa secret. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    connectedAt: timestamp('connected_at', { withTimezone: true }),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    disconnectedAt: timestamp('disconnected_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('whatsapp_connections_workspace_idx').on(t.workspaceId),
    index('whatsapp_connections_phone_number_id_idx').on(t.phoneNumberId),
  ],
);

/**
 * Nomor telepon MASUK (inbound) per workspace — customer menelepon nomor ini
 * dan dilayani agen Voice AI (Vapi). Satu nomor Vapi hanya bisa milik satu
 * workspace (unique vapiPhoneNumberId) — ini yang dipakai webhook untuk
 * me-resolve workspace dari sebuah panggilan masuk (`phoneNumber.id`).
 *
 * Alur: register → Vapi membuat nomor + serverUrl webhook (assistant-request
 * mengembalikan asisten transient per-workspace) → customer menelepon → agen
 * mengumpulkan layanan/jadwal/nama → tool-calls `check_availability` &
 * `create_booking` membuat booking real-time (source = 'vapi-inbound').
 */
export const vapiInboundNumbers = pgTable(
  'vapi_inbound_numbers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').references(() => authUser.id, { onDelete: 'set null' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Id nomor di sisi Vapi (provider 'vapi' / 'byo-phone-number' / dst). */
    vapiPhoneNumberId: text('vapi_phone_number_id').notNull(),
    /** Nomor E.164 (contoh +14155550123) — null selama provisioning berjalan. */
    number: text('number'),
    /** Label pilihan user (mis. "Cabang Senopati") — hanya referensi. */
    name: text('name'),
    /** Provider Vapi dari nomor (vapi / byo-phone-number / telnyx / ...). */
    provider: text('provider').default('vapi').notNull(),
    /** Nomor aktif menerima panggilan (false = dijeda, panggilan ditolak Vapi). */
    isActive: boolean('is_active').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Satu nomor Vapi → satu workspace (basis resolve webhook inbound).
    uniqueIndex('vapi_inbound_numbers_vapi_phone_number_id_idx').on(t.vapiPhoneNumberId),
    index('vapi_inbound_numbers_workspace_id_idx').on(t.workspaceId),
  ],
);

/**
 * Status entri daftar tunggu (waitlist).
 * - `waiting`: menunggu slot kosong.
 * - `offered`: slot kosong sudah ditawarkan (menunggu jawaban customer).
 * - `booked`: customer menerima tawaran, slot sudah dibooking.
 * - `declined`: customer menolak tawaran.
 * - `expired`: tawaran tidak dijawab / kadaluarsa.
 */
export const waitlistStatus = pgEnum('waitlist_status', [
  'waiting',
  'offered',
  'booked',
  'declined',
  'expired',
]);

/**
 * Daftar tunggu (waitlist) per workspace — customer yang ingin slot tertentu
 * tapi belum tersedia. Saat booking dibatalkan dan slot kosong, entri
 * berikutnya yang cocok ditawari slot tersebut lewat channel mereka.
 * `contactPhone` opsional (bisa belum share nomor); `channelType` +
 * `channelIdentifier` menentukan cara menghubungi (mis. chat_id Telegram).
 */
export const waitlistEntries = pgTable(
  'waitlist_entries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Layanan yang diinginkan (null = bebas / belum ditentukan). */
    serviceId: uuid('service_id').references(() => services.id, { onDelete: 'set null' }),
    /** Staf pilihan (null = bebas / belum ditentukan). */
    staffId: uuid('staff_id').references(() => staffMembers.id, { onDelete: 'set null' }),
    customerName: text('customer_name'),
    contactPhone: text('contact_phone'),
    /** Channel untuk menghubungi customer saat slot kosong (mis. 'telegram'). */
    channelType: text('channel_type').default('telegram').notNull(),
    /** Identifier eksternal channel (chat_id Telegram) — untuk kirim tawaran. */
    channelIdentifier: text('channel_identifier'),
    /** Tanggal pilihan (YYYY-MM-DD) — opsional. */
    preferredDate: text('preferred_date'),
    /** Preferensi waktu bebas ('sore', 'setelah jam 3') — opsional. */
    timePreference: text('time_preference'),
    status: waitlistStatus('status').default('waiting').notNull(),
    offeredAt: timestamp('offered_at', { withTimezone: true }),
    /** Slot yang ditawarkan saat booking dibatalkan — dipakai untuk booking ulang. */
    offeredSlotAt: timestamp('offered_slot_at', { withTimezone: true }),
    offeredServiceId: uuid('offered_service_id').references(() => services.id, { onDelete: 'set null' }),
    offeredStaffId: uuid('offered_staff_id').references(() => staffMembers.id, { onDelete: 'set null' }),
    offeredDurationMinutes: integer('offered_duration_minutes'),
    offeredTimezone: text('offered_timezone'),
    filledAt: timestamp('filled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('waitlist_entries_workspace_id_idx').on(t.workspaceId),
    index('waitlist_entries_workspace_status_idx').on(t.workspaceId, t.status),
    index('waitlist_entries_workspace_service_idx').on(t.workspaceId, t.serviceId),
  ],
);

/**
 * Status payment link (one-time checkout Paddle).
 * - `pending`: checkout dibuat, belum dibayar customer.
 * - `paid`: webhook `transaction.completed` terverifikasi (idempotent).
 * - `canceled`: dibatalkan (via API kami / event `transaction.canceled`).
 */
export const paymentLinkStatus = pgEnum('payment_link_status', [
  'pending',
  'paid',
  'canceled',
]);

/**
 * Payment link — checkout satu kali (deposit / biaya layanan) yang dibuat
 * workspace untuk customer, diproses oleh Paddle (Merchant of Record global).
 * Jumlah disimpan dalam MINOR UNITS (sen) agar aman integer; status final
 * disinkronkan lewat webhook Paddle terverifikasi (lihat onPaddleEvent).
 * `bookingId` nullable: link boleh dibuat tanpa booking (pembayaran umum).
 */
export const paymentLinks = pgTable(
  'payment_links',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Booking terkait (set null bila booking dihapus — riwayat tetap ada). */
    bookingId: uuid('booking_id').references(() => bookings.id, { onDelete: 'set null' }),
    /** Nama item yang dibayar (mis. "Deposit konsultasi"). */
    title: text('title').notNull(),
    description: text('description'),
    /** Jumlah dalam minor units (sen) — format aman integer, bukan float. */
    amountMinor: integer('amount_minor').notNull(),
    /** Kode mata uang ISO 4217 (Paddle: USD, EUR, IDR, ...). */
    currency: text('currency').default('USD').notNull(),
    status: paymentLinkStatus('status').default('pending').notNull(),
    /** Transaksi Paddle (id eksternal) — kunci idempotensi webhook. */
    paddleTransactionId: text('paddle_transaction_id'),
    /** URL checkout Paddle (hosted checkout MoR) — dibagikan ke customer. */
    checkoutUrl: text('checkout_url'),
    customerName: text('customer_name'),
    customerEmail: text('customer_email'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('payment_links_workspace_id_idx').on(t.workspaceId),
    index('payment_links_booking_id_idx').on(t.bookingId),
    // Satu transaksi Paddle hanya boleh menaut ke satu payment link.
    uniqueIndex('payment_links_paddle_transaction_idx')
      .on(t.paddleTransactionId)
      .where(sql`${t.paddleTransactionId} is not null`),
  ],
);

/**
 * Registri identitas + opt-in customer per channel.
 * `identifier` = id eksternal channel (chat_id Telegram / nomor WhatsApp);
 * `contactPhone` = nomor HP customer (ter-normalisasi) untuk mapping
 * chat → booking. Unik per (workspace, channel, identifier).
 */
export const customerChannels = pgTable(
  'customer_channels',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    channelType: text('channel_type').notNull(),
    identifier: text('identifier').notNull(),
    contactPhone: text('contact_phone'),
    isOptedIn: boolean('is_opted_in').default(true).notNull(),
    optedOutAt: timestamp('opted_out_at', { withTimezone: true }),
    source: text('source').default('telegram').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('customer_channels_ws_type_ident_idx').on(
      t.workspaceId,
      t.channelType,
      t.identifier,
    ),
    index('customer_channels_ws_phone_idx').on(t.workspaceId, t.contactPhone),
  ],
);

/**
 * Thread percakapan ter-unifikasi per (workspace, channel, externalId).
 * `state` dipakai state machine (mis. { step: 'awaiting-time' } saat
 * user sedang mengubah jadwal).
 */
export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    bookingId: uuid('booking_id').references(() => bookings.id, { onDelete: 'set null' }),
    channelType: text('channel_type').notNull(),
    /** Id eksternal thread di provider (chat_id Telegram). */
    externalId: text('external_id').notNull(),
    /** Nama customer (denormalized dari booking / profil channel) untuk inbox. */
    customerName: text('customer_name'),
    status: conversationStatus('status').default('active').notNull(),
    /**
     * State machine: { step: 'awaiting-time' } saat user mengubah jadwal,
     * atau { needsAttention: true } saat pesan bebas butuh tangan staf/AI.
     */
    state: jsonb('state').$type<Record<string, unknown> | null>(),
    /** Waktu pesan terakhir (inbound/outbound) — sorting unified inbox. */
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    /** Jumlah pesan masuk yang belum dibaca staf. */
    unreadCount: integer('unread_count').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('conversations_ws_channel_external_idx').on(
      t.workspaceId,
      t.channelType,
      t.externalId,
    ),
    index('conversations_booking_id_idx').on(t.bookingId),
  ],
);

/** Pesan masuk/keluar di dalam percakapan (unified inbox). */
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    channelType: text('channel_type').notNull(),
    direction: messageDirection('direction').notNull(),
    /** Id pesan dari provider (wamid / message_id) — untuk dedup. */
    providerMessageId: text('provider_message_id'),
    status: messageStatus('status').default('queued').notNull(),
    content: text('content').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown> | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Unik per percakapan: message_id Telegram unik per chat, bukan global.
    uniqueIndex('messages_conversation_provider_idx').on(
      t.conversationId,
      t.providerMessageId,
    ),
    index('messages_conversation_id_idx').on(t.conversationId),
  ],
);
