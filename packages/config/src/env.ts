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

  // Paddle — price ID paket Pro (dipakai endpoint POST /api/billing/checkout)
  PADDLE_PRO_PRICE_ID: z.string().optional(),

  // Inngest (opsional — Dev Server lokal tidak butuh key)
  INNGEST_EVENT_KEY: z.string().optional(),
  INNGEST_SIGNING_KEY: z.string().optional(),

  // Resend
  RESEND_API_KEY: z.string().min(1, 'RESEND_API_KEY wajib diisi'),

  // CALL-E
  CALLE_API_KEY: z.string().min(1, 'CALLE_API_KEY wajib diisi'),
  CALLE_BASE_URL: z.string().url().default('https://api.heycall-e.com'),
  // Shared secret untuk verifikasi webhook CALL-E (HMAC atas raw body).
  // Endpoint /api/webhooks/calle bersifat fail-closed tanpa secret ini.
  CALLE_WEBHOOK_SECRET: z.string().optional(),

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
