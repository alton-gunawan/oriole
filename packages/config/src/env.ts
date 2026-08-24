import { z } from 'zod';

/**
 * Skema environment untuk backend (apps/api).
 * Divalidasi sekali saat boot — app berhenti dengan pesan jelas
 * jika ada variabel wajib yang hilang.
 */
export const apiEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_NAME: z.string().default('Oriole'),
  APP_URL: z.string().url().default('http://localhost:5173'),
  API_URL: z.string().url().default('http://localhost:3000'),
  // Base URL publik untuk webhook inbound (Telegram/WhatsApp/WAHA).
  // WAJIB HTTPS publik di produksi — provider (Telegram) menolak http/
  // localhost. Saat kosong, jatuh ke API_URL (cukup untuk dev/display).
  WEBHOOK_BASE_URL: z
    .preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  PORT: z.coerce.number().int().positive().default(3000),

  // Database (Neon serverless PostgreSQL)
  DATABASE_URL: z.string().min(1, 'DATABASE_URL wajib diisi (pooled connection string Neon)'),

  // Neon Auth (Managed Better Auth) — JWT / JWKS
  NEON_AUTH_URL: z.string().url('NEON_AUTH_URL harus berupa URL endpoint auth Neon'),

  // Paddle Billing
  PADDLE_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  PADDLE_API_KEY: z.string().min(1, 'PADDLE_API_KEY wajib diisi'),
  PADDLE_CLIENT_TOKEN: z.string().optional(),
  PADDLE_WEBHOOK_SECRET: z.string().min(1, 'PADDLE_WEBHOOK_SECRET wajib diisi'),

  // Paddle — price ID paket Pro & Business (dipakai endpoint POST /api/billing/checkout)
  PADDLE_PRO_PRICE_ID: z.string().optional(),
  PADDLE_BUSINESS_PRICE_ID: z.string().optional(),

  // Inngest (opsional — Dev Server lokal tidak butuh key)
  INNGEST_EVENT_KEY: z.string().optional(),
  INNGEST_SIGNING_KEY: z.string().optional(),

  // Resend
  RESEND_API_KEY: z.string().min(1, 'RESEND_API_KEY wajib diisi'),

  // Vapi (voice AI calls) — menggantikan CALL-E (HeyCall-e).
  // OPSIONAL (preprocess kosong → undefined, pola sama dengan WAHA/AI chat):
  // tanpa key, boot API tetap jalan dan fitur panggilan mati dengan pesan
  // jelas (VapiNotConfiguredError) — placeholder .env.example tidak boleh
  // membuat API gagal boot.
  VAPI_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
  // ID nomor telepon Vapi yang dipakai untuk panggilan keluar (outbound).
  // Dibuat di dashboard Vapi (Phone Numbers) atau via API; nomor gratis US
  // hanya mendukung panggilan dalam negeri US — untuk internasional impor
  // nomor dari Twilio/Telnyx.
  VAPI_PHONE_NUMBER_ID: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
  // Shared secret untuk otentikasi webhook Vapi — dikirim Vapi sebagai
  // header `Authorization: Bearer <secret>` (dikonfigurasi via
  // assistant.server.headers). Endpoint /api/webhooks/vapi bersifat
  // fail-closed tanpa secret ini.
  VAPI_WEBHOOK_SECRET: z.string().optional(),
  // Model LLM & suara TTS default untuk asisten Vapi (transient per panggilan).
  VAPI_MODEL: z.string().default('gpt-4o-mini'),
  VAPI_VOICE_ID: z.string().default('cgSgspJ2msm6clMCkdW9'),

  // Telnyx (BYO phone number untuk Vapi) — lihat scripts/setup-telnyx.ts.
  // Semua OPSIONAL: runtime API TIDAK butuh Telnyx (panggilan tetap lewat
  // VAPI_PHONE_NUMBER_ID; Telnyx hanya penyedia nomor di balik layar).
  // Dipakai oleh script provisioning/ops (setup:telnyx, telnyx:status).
  TELNYX_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
  // Nomor Telnyx pilihan (E.164) — setup:telnyx memakainya bila diisi,
  // menggantikan pencarian/pembelian otomatis.
  TELNYX_PHONE_NUMBER: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  // Negara default untuk pencarian nomor baru (ISO 3166-1 alpha-2).
  TELNYX_COUNTRY_CODE: z.string().default('US'),
  // ID kredensial Telnyx DI SISI VAPI (dashboard.vapi.ai → Keys → Telnyx),
  // dibuat SEKALI dengan menempel API key Telnyx. Wajib untuk mendaftarkan
  // nomor Telnyx ke Vapi (CreateTelnyxPhoneNumberDto.credentialId).
  VAPI_TELNYX_CREDENTIAL_ID: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),

  // Enkripsi at-rest pesan inbox (AES-256-GCM, kunci per-workspace diturunkan
  // via HKDF). Master key 32 byte dalam 64 hex char — buat dengan
  // `openssl rand -hex 32`. KOSONG → enkripsi nonaktif (pesan disimpan
  // plaintext, kompatibel untuk dev). PERINGATAN: setelah pesan terenkripsi,
  // mengganti/kehilangan key ini membuat pesan lama tidak terbaca.
  MESSAGE_ENCRYPTION_KEY: z
    .preprocess((v) => (v === '' ? undefined : v), z.string().optional())
    .refine((v) => v === undefined || /^[0-9a-fA-F]{64}$/.test(v), {
      message: 'MESSAGE_ENCRYPTION_KEY harus 64 hex char (32 byte) atau kosong',
    }),

  // Telegram (chat channel MVP) — fallback single-tenant development.
  // Token & secret per-workspace disimpan di tabel workspace_channels;
  // env ini hanya dipakai bila konfigurasi workspace belum ada.
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),

  // WhatsApp (360dialog BSP) — fallback development single-tenant.
  // Kredensial per-workspace disimpan di tabel workspace_channels.
  WHATSAPP_API_KEY: z.string().optional(),
  WHATSAPP_WEBHOOK_SECRET: z.string().optional(),
  // Nama Message Template Meta untuk reminder booking (harus sudah di-approve).
  WHATSAPP_TEMPLATE_REMINDER: z.string().default('booking_reminder'),

  // WAHA (BYO WhatsApp) — gateway ter-managed server (WAJIB untuk BYO).
  // Kredensial SELALU dari env ini: dialog BYO tidak lagi menampilkan field
  // gateway URL/API key — backend memakainya untuk semua workspace (user
  // hanya consent + scan QR). Tanpa keduanya, setup BYO ditolak 400.
  // preprocess mengubah string kosong (baris `KEY=` di .env) jadi undefined —
  // tanpa ini .url()/.min() menolak "" dan boot API gagal saat .env.example
  // disalin apa adanya.
  WAHA_GATEWAY_URL: z
    .preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().url('WAHA_GATEWAY_URL harus berupa URL http(s)').optional(),
    ),
  WAHA_GATEWAY_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(10).optional()),

  // AI chat (WhatsApp Q&A knowledge base) — endpoint OpenAI-compatible,
  // default Groq free tier (Llama 3.3 70B, tanpa kartu kredit; key gsk_ dari
  // console.groq.com). Tanpa key → fitur AI mati (perilaku lama, handoff
  // staf). preprocess mengubah string kosong (baris `KEY=` di .env) jadi
  // undefined agar boot tidak gagal.
  AI_CHAT_BASE_URL: z
    .preprocess((v) => (v === '' ? undefined : v), z.string().url().optional())
    .default('https://api.groq.com/openai/v1'),
  AI_CHAT_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
  AI_CHAT_MODEL: z.string().default('llama-3.3-70b-versatile'),

  // Enkripsi kredensial at-rest (providerConfig integrasi) — AES-256-GCM.
  // Hex 64 karakter (32 byte), generate: openssl rand -hex 32.
  // Tanpa key → token disimpan plaintext (mode kompatibilitas; TIDAK
  // disarankan di produksi — log warning saat boot).
  APP_ENCRYPTION_KEY: z
    .preprocess(
      (v) => (v === '' ? undefined : v),
      z
        .string()
        .regex(/^[0-9a-fA-F]{64}$/, 'APP_ENCRYPTION_KEY harus hex 64 karakter (32 byte)'),
    )
    .optional(),

  // Zoom (Server-to-Server OAuth) — video link otomatis untuk booking.
  // Kredensial dibuat di zoom.us → Build App → Server-to-Server OAuth.
  // Kosong (placeholder) = provider zoom dinonaktifkan di halaman Integrations.
  ZOOM_ACCOUNT_ID: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  ZOOM_CLIENT_ID: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  ZOOM_CLIENT_SECRET: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),

  // Meta (Instagram + Facebook DMs) — verifikasi webhook + app secret.
  // Dibuat di developers.facebook.com → Apps → Webhooks.
  // META_VERIFY_TOKEN = token verifikasi (GET hub.challenge) yang kamu
  // tempel di dashboard Meta; META_APP_SECRET = App Secret (X-Hub-Signature-256).
  META_VERIFY_TOKEN: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(8).optional()),
  META_APP_SECRET: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(8).optional()),

  // Meta WhatsApp Business — Embedded Signup (Tech Provider).
  // Meta App milik PLATFORM (bukan tenant): app id/secret + config_id
  // (konfigurasi Embedded Signup di App Dashboard → WhatsApp → Embedded
  // Signup) + verify token (hub.challenge webhook) + system user token
  // (long-lived, untuk GET /debug_token saat resolve WABA ID pasca-signup).
  // Semua opsional — tanpa config lengkap fitur menampilkan "belum dikonfigurasi".
  META_WHATSAPP_APP_ID: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(8).optional()),
  META_WHATSAPP_APP_SECRET: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(8).optional()),
  META_WHATSAPP_CONFIG_ID: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
  META_WHATSAPP_VERIFY_TOKEN: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(8).optional()),
  META_WHATSAPP_SYSTEM_USER_TOKEN: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(8).optional()),
  META_GRAPH_API_VERSION: z.string().default('v21.0'),

  // Cloudflare Turnstile — bot detection / captcha
  // Opsional: tanpa secret key, verifikasi di backend selalu lolos (kompatibel untuk dev).
  TURNSTILE_SECRET_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),

  // PostHog analytics — server-side event capture (product analytics).
  // Opsional: tanpa POSTHOG_PUBLIC_KEY semua capture di-skip dan API tetap
  // berjalan normal (no-op sink). Nilainya = project API key (`phc_...`,
  // Project Settings → API keys) — key yang SAMA dengan token web SDK
  // (VITE_POSTHOG_PROJECT_TOKEN). BUKAN personal API key (`phx_...`) yang
  // hanya untuk REST API privat dan ditolak endpoint capture.
  POSTHOG_PUBLIC_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  POSTHOG_HOST: z.string().url().default('https://us.i.posthog.com'),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;

/**
 * Skema environment untuk frontend (apps/web) — variabel VITE_*.
 * Dijaga ringan agar boot frontend tidak mudah gagal; nilai default
 * cukup untuk development.
 */
export const webEnvSchema = z.object({
  VITE_API_URL: z.string().default('/api'),
  VITE_NEON_AUTH_URL: z.string().url().optional(),
  VITE_TURNSTILE_SITE_KEY: z.string().optional(),
});

export type WebEnv = z.infer<typeof webEnvSchema>;

/** Helper validasi env; melempar error terperinci jika gagal. */
export function parseEnv<T extends z.ZodType>(
  schema: T,
  source: Record<string, string | undefined>,
): z.infer<T> {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Konfigurasi environment tidak valid:\n${issues}`);
  }
  return parsed.data;
}
