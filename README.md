# 🪶 Oriole — AI Booking Assistant

SaaS booking + **AI outbound calls** (Vapi) + **unified inbox** (WhatsApp, Telegram, email) untuk bisnis jasa — klinik, salon, fitness, dan layanan lokal. TypeScript end-to-end di seluruh monorepo.

Oriole menyatukan booking, follow-up otomatis, dan insight pelanggan dalam satu ruang yang tenang: buat booking → AI menelepon pelanggan untuk konfirmasi/reminder → balasan masuk ke satu inbox → lihat hasilnya di analytics.

## Fitur

- **Booking** — CRUD booking, filter status/tanggal, ubah status massal (bulk confirm/complete/cancel), jadwal + timezone, integrasi Vapi (panggilan AI per booking, history per booking).
- **Panggilan AI (Vapi)** — goal panggilan deterministik per industri (`@oriole/call-goals`), panggilan keluar **otomatis** per booking (Inngest `autoCallBooking`), riwayat panggilan + ringkasan (total, bulan ini, sukses/gagal, durasi), kuota anti-abuse per plan.
- **Channels** — hubungkan Telegram bot (per bisnis), WhatsApp Business via 360dialog (BSP), dan email otomatis via Resend; **Automatic reminders** dengan lead time per bisnis.
- **Inbox terpadu** — semua percakapan (Telegram, WhatsApp, email) di satu tempat, dengan tombol kirim reminder + action buttons per booking.
- **Analytics** — data nyata: booking per bulan, status distribution, outcome panggilan AI, pesan per channel, conversion funnel.
- **Multi-bisnis** — kelola banyak bisnis dalam satu akun, terpisah rapi (bookings, calls, channels).
- **Billing** — Paddle sebagai Merchant of Record, usage bulanan (calls & menit) per plan, upgrade/portal.
- **Payments (Global)** — integrasi Payments di halaman Integrations: payment link satu kali (deposit / biaya layanan) untuk customer, checkout global Paddle (MoR), status lunas tersinkron otomatis via webhook. Tanpa gateway lokal — pembayaran global sejak awal.
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
| Customer payments | Paddle (Merchant of Record) | payment link satu kali (non-catalog price), checkout hosted global |
| Background jobs | Inngest | durable steps + retry (reminder, sync subscription, update call) |
| Email | Resend | reminder booking + welcome email |
| Voice AI | Vapi (`@vapi-ai/server-sdk`) | SDK resmi; asisten transient per panggilan; webhook **Bearer auth** + idempotency |
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
│           ├── inngest/        # client + functions (Vapi event, email, reminder)
│           ├── services/       # vapi, paddle, resend, whatsapp, telegram
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
#    `pnpm dev` menjalankan `pnpm dev:services` lebih dulu (DEV ONLY):
#    menghidupkan Cloudflare tunnel untuk webhook Telegram + Inngest Dev
#    Server, menyinkronkan WEBHOOK_BASE_URL di .env, dan mendaftarkan ulang
#    webhook Telegram otomatis. Detail: docs/messaging.md → "Dev mode".
pnpm dev
#   atau terpisah: pnpm dev:web / pnpm dev:api / pnpm dev:services

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
| `VAPI_API_KEY` / `VAPI_PHONE_NUMBER_ID` | kredensial & nomor keluar Vapi (server-only) |
| `VAPI_WEBHOOK_SECRET` | **wajib diset** — webhook Vapi ditolak (503) tanpa ini |
| `TELNYX_API_KEY` / `VAPI_TELNYX_CREDENTIAL_ID` | *(opsional)* BYO nomor Telnyx untuk Vapi — dipakai script `setup:telnyx` (bukan runtime) |
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

- **Vapi (voice AI)** — panggilan keluar **otomatis**: saat booking dibuat (atau dijadwal ulang / nomor ditambahkan), Inngest `autoCallBooking` menyusun goal panggilan, membuat asisten transient + panggilan keluar via `@vapi-ai/server-sdk`, mencatat ke `calle_calls` (nama tabel legacy; `calle_call_id` = id call Vapi). Webhook `/api/webhooks/vapi` diverifikasi **Bearer token** (`VAPI_WEBHOOK_SECRET`), di-dedup via idempotency key (`call.id:eocr`), lalu diproses Inngest (upsert hasil + tandai booking completed).
- **Vapi (panggilan masuk / inbound)** — nomor masuk per workspace (halaman Integrations → Voice AI). Customer menelepon → Vapi kirim `assistant-request` → webhook mengembalikan asisten resepsionis AI per-workspace (daftar layanan dari katalog + bahasa workspace). Agen memakai tool `check_availability` (slot nyata dari slot engine) dan `create_booking` (buat booking + kontak + reminder + auto-call + webhook keluar, idempoten via `source='vapi-inbound'` + `sourceRef=<callId>:<toolCallId>`). Hasil call tercatat di `calle_calls` (bookingId null).
- **Telegram** — bot per bisnis; customer konfirmasi/reschedule/cancel via tombol. Endpoint setup/rewebhook di `/api/channels`.
- **WhatsApp** — 360dialog (BSP); reminder memakai Meta Message Templates.
- **Email** — Resend; reminder otomatis selama kontak customer punya alamat email.
- **Paddle** — webhook HMAC-verified → Inngest `paddle/event.received` → sinkronisasi `subscriptions` (event `subscription.*`) dan `payment_links` (event `transaction.completed` / `transaction.canceled`).
- **Payments (Global Payments)** — kartu Payments di halaman Integrations (one-click connect, kredensial server-side `PADDLE_API_KEY`); `POST /api/payments` membuat checkout one-time dengan jumlah bebas; status link diperbarui otomatis oleh webhook Paddle (idempotent).
- **Slack** — notifikasi booking ke channel tim via Slack Incoming Webhook (kartu di halaman Integrations). Event booking (created / updated / cancelled / completed / deleted) diformat sebagai Slack blocks dan dikirim lewat Inngest `slack/booking.event`; URL webhook disimpan server-side dan tidak pernah di-expose.
- **Telegram booking alerts** — notifikasi booking ke chat Telegram bisnis (kartu di halaman Integrations). Owner mengikat chat-nya lewat deep-link `t.me/<bot>?start=oriole_<token>` (token dirotasi setelah bind); setiap `booking.created` (termasuk dari form Tally/Google Forms, AI chat, dan panggilan Vapi inbound) dikirim sebagai kartu instan via bot Telegram workspace — pola sama dengan Slack. `chatId` tersimpan server-side dan tidak pernah di-expose.
- **Zoom** — meeting dibuat otomatis per booking baru (server-to-server OAuth, kredensial env). `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET` diisi di `.env`.
- **Google Meet** — tautan video otomatis dari event Google Calendar (cukup hubungkan Google Calendar, dan link Meet akan tersimpan di booking).
- **Instagram DMs & Facebook Page messages** — pesan masuk ke inbox terpadu; balas dari dashboard. Setup: Meta access token jangka panjang (scope `pages_messaging`) via Meta for Developers, ditempel di kartu kanal Integrations.
- **Inngest** — reminder booking terjadwal (`booking/created` → `remindBooking`), dengan cancel-on untuk booking dibatalkan/selesai.

Selengkapnya: [docs/architecture.md](docs/architecture.md) (alur data), [docs/security.md](docs/security.md) (validasi webhook & normalisasi telepon), [docs/messaging.md](docs/messaging.md) (kanal pesan).

## Deploy

Lihat [docs/deployment.md](docs/deployment.md) untuk langkah lengkap (Neon, Neon Auth, Cloudflare Pages, Railway/Fly, Paddle, Inngest, Resend, Vapi).

- Web: static build Vite → **Cloudflare Pages** (`apps/web/wrangler.toml`).
- API: TS langsung via tsx, Dockerfile multi-stage + `railway.json`/`fly.toml`.

## Testing & CI

- Unit test: Vitest (API routes/lib, call-goals, config) — `pnpm test`.
- Guard i18n: `apps/web/scripts/check-locales.mjs` memastikan katalog en/id sinkron (dijalankan di `pnpm build`).
- CI: `.github/workflows/ci.yml` (typecheck + test + build).

## Roadmap

- Checkout Paddle frontend (`PADDLE_CLIENT_TOKEN` + Paddle.js / Overlay).
- Template email React Email + endpoint `/emails` di Inngest.
- Verifikasi payload webhook Vapi dengan contoh nyata (`lib/vapi-types.ts`).
- Tools real-time Vapi (booking lookup, availability check) untuk percakapan lebih kaya.
