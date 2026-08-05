# Arsitektur Oriole

## Prinsip

- **TypeScript end-to-end**: satu bahasa di frontend, backend, schema DB, dan konfigurasi.
- **Sumber tunggal**: schema Drizzle + brand + env schemas hidup di `packages/` dan dipakai kedua app.
- **Stateless API**: auth lewat JWT (Neon Auth), tidak ada sesi server sendiri — cocok untuk serverless.
- **Idempotent webhooks**: semua webhook masuk dicatat di tabel `webhook_events` (unique per provider+eventId).
- **Durable side effects**: semua efek samping (email, sinkronisasi subscription, update call)
  dijalankan sebagai fungsi Inngest dengan retry otomatis — bukan inline di request handler.

## Alur data

### Autentikasi (Neon Auth)

```
Browser ──redirect──▶ Neon Auth (hosted UI) ──JWT──▶ Browser (sessionStorage)
Browser ──GET /api/me── Authorization: Bearer <jwt> ──▶ Hono
   └─ middleware/auth.ts: jose.jwtVerify(token, JWKS dari ${NEON_AUTH_URL}/.well-known/jwks.json)
   └─ c.set('userId', payload.sub)
```

- Frontend menyimpan JWT via `src/lib/auth.ts`; `src/lib/api.ts` melampirkannya otomatis.
- Tidak ada lookup DB per request — token diverifikasi secara kriptografis (JWKS remote).

### Subscription (Paddle MoR)

```
Paddle ──POST /api/webhooks/paddle──(raw body + Paddle-Signature)──▶ Hono
   ├─ paddle.webhooks.unmarshal() — verifikasi HMAC (raw body WAJIB)
   ├─ recordWebhookEvent('paddle', eventId) — idempotency (duplicate → 200, diabaikan)
   ├─ inngest.send('paddle/event.received') — proses durable
   └─ markWebhookProcessed()
Inngest: sync-subscription → upsert tabel `subscriptions`
```

- `userId` di-resolve dari `custom_data.user_id` yang dikirim saat checkout dibuat dari app kita.
- Status subscription dipetakan ke enum Drizzle (`trialing/active/past_due/canceled/unpaid/paused`).

### Panggilan suara (CALL-E)

```
CALL-E ──POST /api/webhooks/calle──(unsigned JSON + CALL-E-Event-Id)──▶ Hono
   ├─ validasi body (zod), cek header vs body.id
   ├─ recordWebhookEvent('calle', eventId) — idempotency
   ├─ inngest.send('calle/event.received')
   └─ markWebhookProcessed()
Inngest: upsert `calle_calls` → update `bookings` (status completed) bila terhubung via calle_call_id
```

- SDK `@call-e/calle` (server-only, jangan expose `CALLE_API_KEY` di browser).

### Email (Resend)

```
API ──POST /api/triggers/welcome-email──(Zod validasi)──▶ inngest.send('user/signed-up')
Inngest: send-welcome-email → resend.emails.send() (from: brand.emailFrom)
```

## Repo & tooling

- **pnpm workspace** + **Turborepo** (`turbo.json`): `dev`, `build`, `typecheck`, `test`.
- Package internal (`@oriole/config`, `@oriole/database`) di-export langsung dari **sumber TS**
  (tidak ada langkah build terpisah) — konsumen (tsx / Vite / Vitest) men-transpile on-the-fly.
- **Env**: satu `.env` di root. `loadRootEnv()` (di `@oriole/config`) memuatnya tanpa menimpa
  env platform (Railway/Fly/Render menang). API memvalidasi seluruh env via Zod saat boot.
- **Deployment**: API dijalankan sebagai TS langsung (`node --import tsx`),
  Dockerfile multi-stage + railway.json + fly.toml disertakan. Web = static build Vite → Cloudflare Pages.

## Keputusan penting

| Keputusan | Alasan |
| --- | --- |
| Drizzle (vs Prisma) | ringan, type-safe penuh, native untuk Neon serverless; intropeksi `neon_auth` via `drizzle-kit pull` |
| Neon Auth (vs Better Auth self-host) | branchable dengan database, nol sesi server, JWKS terkelola |
| Inngest (vs Trigger.dev) | adapter Hono resmi, Dev Server lokal, durable steps |
| `node --import tsx` di produksi | menghilangkan step build/transpile; Docker image tetap ringan |
| Astryx via cascade layers | koeksistensi bersih dengan Tailwind 4 (`@layer` ordering) |
