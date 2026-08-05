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
export const businessIndustry = pgEnum('business_industry', [
  'dental',
  'medspa',
  'hair_salon',
  'medical_clinic',
  'restaurant',
  'wellness',
  'other',
]);

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
 * Workspace / store / project milik user. Satu akun dapat memiliki banyak
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('workspaces_user_id_idx').on(t.userId),
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
    title: text('title').notNull(),
    description: text('description'),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    timezone: text('timezone').default('UTC').notNull(),
    status: bookingStatus('status').default('pending').notNull(),
    calleCallId: text('calle_call_id'),
    /** Kontak customer untuk panggilan CALL-E. */
    customerName: text('customer_name'),
    phone: text('phone'),
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('bookings_user_id_idx').on(t.userId),
    index('bookings_scheduled_at_idx').on(t.scheduledAt),
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('contacts_workspace_phone_idx').on(t.workspaceId, t.phone),
    index('contacts_user_id_idx').on(t.userId),
    index('contacts_workspace_id_idx').on(t.workspaceId),
  ],
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
