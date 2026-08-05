# 🪶 Oriole — AI Booking Assistant

SaaS booking + **AI outbound calls** (CALL-E) + **unified inbox** (WhatsApp, Telegram, email) untuk bisnis jasa — klinik, salon, fitness, dan layanan lokal. TypeScript end-to-end di seluruh monorepo.

Oriole menyatukan booking, follow-up otomatis, dan insight pelanggan dalam satu workspace yang tenang: buat booking → AI menelepon pelanggan untuk konfirmasi/reminder → balasan masuk ke satu inbox → lihat hasilnya di analytics.

## Fitur

- **Booking** — CRUD booking, filter status/tanggal, ubah status massal (bulk confirm/complete/cancel), jadwal + timezone, integrasi CALLE (panggilan AI per booking, history per booking).
- **Panggilan AI (CALL-E)** — goal panggilan deterministik per industri (`@oriole/call-goals`), trigger manual per booking, riwayat panggilan + ringkasan (total, bulan ini, sukses/gagal, durasi), kuota anti-abuse per plan.
- **Channels** — hubungkan Telegram bot (per project), WhatsApp Business via 360dialog (BSP), dan email otomatis via Resend; **Automatic reminders** dengan lead time per workspace.
- **Inbox terpadu** — semua percakapan (Telegram, WhatsApp, email) di satu tempat, dengan tombol kirim reminder + action buttons per booking.
- **Analytics** — data nyata: booking per bulan, status distribution, outcome panggilan AI, pesan per channel, conversion funnel.
- **Multi-project** — kelola banyak store/brand dalam satu akun, terpisah rapi (bookings, calls, channels).
- **Billing** — Paddle sebagai Merchant of Record, usage bulanan (calls & menit) per plan, upgrade/portal.
- **i18n** — Bahasa Indonesia & English, dengan guard sinkronisasi katalog di build.
- **Auth** — Neon Auth (managed Better Auth), JWT diverifikasi via JWKS remote.

## Stack

| Layer | Pilihan | Catatan |
| --- | --- | --- |
| Monorepo | pnpm workspace + Turborepo | `apps/*` + `packages/*` |
| Frontend | Vite 8 · React 19 · TypeScript | TanStack Query, Zustand, React Router v7 |
| Styling | Tailwind CSS 4 | Astryx design system via cascade layers; Tremor untuk chart |
| Form | React Hook Form + Zod v4 | validasi terpusat di `apps/web/src/lib/validations.ts` |
| Backend | Hono 4 · Node 22+ | `@hono/node-server`, jalankan TS langsung via tsx |
| Database | Neon (serverless PostgreSQL) | Drizzle ORM, driver `neon-http` |
| Auth | Neon Auth (Managed Better Auth) | JWT ÷ JWKS remote — tanpa sesi server sendiri |
| Billing | Paddle (Merchant of Record) | `@paddle/paddle-node-sdk`, webhook HMAC-verified |
| Background jobs | Inngest | durable steps + retry (reminder, sync subscription, update call) |
| Email | Resend | reminder booking + welcome email |
| Voice AI | CALL-E (`@call-e/calle`) | SDK resmi; webhook **HMAC-SHA256** (`x-calle-signature`) + idempotency |
| Hosting | Cloudflare Pages (web) · Railway/Fly.io (api) | config siap pakai |

## Struktur

```
oriole/
├── apps/
│   ├── web/                    # Frontend Vite + React 19
│   │   └── src/
│   │       ├── app/pages/      # dashboard, bookings, contacts, inbox, channels, calls, analytics, billing, settings, workspaces, help
│   │       ├── app/shell/      # AppShell (sidebar), icons, UI primitives
│   │       ├── lib/            # api client, auth, validations, messaging helpers
│   │       ├── stores/         # Zustand (session, workspace)
│   │       ├── i18n/           # react-i18next (en + id)
│   │       └── config/         # env VITE_*
│   └── api/                    # Backend Hono
│       └── src/
│           ├── middleware/     # auth (JWKS Neon Auth), workspace scoping, rate-limit
│           ├── routes/         # bookings, contacts, channels, inbox, calls, analytics, billing, triggers, webhooks
│           ├── lib/            # phone normalization, quota, reminders, webhook-signature
│           ├── inngest/        # client + functions (CALL-E event, email, reminder)
│           ├── services/       # calle, paddle, resend, whatsapp, telegram
│           └── db/             # Drizzle client
├── packages/
│   ├── config/                 # brand + env schemas (Zod) + loader .env root
│   ├── database/               # Drizzle schema + migrations + client
│   ├── call-goals/             # engine goal panggilan deterministik (industry × tipe)
│   └── messaging/              # render reminder booking, format slot, normalisasi telepon
├── docs/                       # architecture, deployment, security, messaging
└── .github/workflows/ci.yml
```

## Quickstart

```bash
# 1. Prasyarat: Node ≥ 22, pnpm ≥ 10
pnpm install

# 2. Environment — salin template lalu isi nilai asli
cp .env.example .env

# 3. Jalankan semua dev server (web :5173, api :3000)
pnpm dev
#   atau terpisah: pnpm dev:web / pnpm dev:api

# 4. Validasi
pnpm typecheck
pnpm test
pnpm build
```

Buka `http://localhost:5173` — Vite mem-proxy `/api` ke `localhost:3000`.

## Environment

Template lengkap di `.env.example` (root). Poin penting:

| Variabel | Keterangan |
| --- | --- |
| `DATABASE_URL` | pooled connection string Neon |
| `NEON_AUTH_URL` | endpoint auth Neon; JWT diverifikasi via JWKS remote |
| `PADDLE_API_KEY` / `PADDLE_ENV` / `PADDLE_WEBHOOK_SECRET` | sandbox dulu |
| `CALLE_API_KEY` / `CALLE_BASE_URL` | SDK panggilan AI (server-only) |
| `CALLE_WEBHOOK_SECRET` | **wajib diset** — webhook CALL-E ditolak (503) tanpa ini |
| `RESEND_API_KEY` | email reminder |
| `INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY` | opsional untuk Dev Server lokal (`npx inngest-cli dev`) |
| `VITE_API_URL` | `/api` saat dev (proxy Vite); URL production saat deploy web |

## Database (Drizzle + Neon)

```bash
pnpm db:generate   # generate migration dari schema (review SQL neon_auth sebelum migrate!)
pnpm db:migrate    # apply migration
pnpm db:studio     # Drizzle Studio
pnpm db:pull       # sinkronkan definisi neon_auth.user dari database asli
```

> **Schema `neon_auth`** dimiliki Neon Auth — definisi `user` di
> `packages/database/src/schema.ts` hanya referensi type-safe untuk foreign key.
> Saat `db:generate`, potongan DDL `neon_auth` pada SQL hasil generate **harus dihapus**
> sebelum migrate (tabel itu dibuat otomatis oleh Neon saat Auth diaktifkan).

## Integrasi & webhook

- **CALL-E (voice AI)** — `POST /api/bookings/:id/trigger-call` menyusun goal panggilan, memanggil SDK, mencatat ke `calle_calls`. Event webhook diverifikasi **HMAC-SHA256 atas raw body** (`x-calle-signature`), di-dedup via idempotency key, lalu diproses Inngest (upsert hasil + tandai booking completed).
- **Telegram** — bot per project; customer konfirmasi/reschedule/cancel via tombol. Endpoint setup/rewebhook di `/api/channels`.
- **WhatsApp** — 360dialog (BSP); reminder memakai Meta Message Templates.
- **Email** — Resend; reminder otomatis selama kontak customer punya alamat email.
- **Paddle** — webhook HMAC-verified → Inngest `paddle/event.received` → sinkronisasi `subscriptions`.
- **Inngest** — reminder booking terjadwal (`booking/created` → `remindBooking`), dengan cancel-on untuk booking dibatalkan/selesai.

Selengkapnya: [docs/architecture.md](docs/architecture.md) (alur data), [docs/security.md](docs/security.md) (validasi webhook & normalisasi telepon), [docs/messaging.md](docs/messaging.md) (kanal pesan).

## Deploy

Lihat [docs/deployment.md](docs/deployment.md) untuk langkah lengkap (Neon, Neon Auth, Cloudflare Pages, Railway/Fly, Paddle, Inngest, Resend, CALL-E).

- Web: static build Vite → **Cloudflare Pages** (`apps/web/wrangler.toml`).
- API: TS langsung via tsx, Dockerfile multi-stage + `railway.json`/`fly.toml`.

## Testing & CI

- Unit test: Vitest (API routes/lib, call-goals, config) — `pnpm test`.
- Guard i18n: `apps/web/scripts/check-locales.mjs` memastikan katalog en/id sinkron (dijalankan di `pnpm build`).
- CI: `.github/workflows/ci.yml` (typecheck + test + build).

## Roadmap

- Checkout Paddle frontend (`PADDLE_CLIENT_TOKEN` + Paddle.js / Overlay).
- Template email React Email + endpoint `/emails` di Inngest.
- Verifikasi payload webhook CALL-E dengan contoh nyata (asumsi awal di `calle-types.ts`).
