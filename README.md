# 🪶 Oriole — AI Booking, Voice AI & Multi-Channel Communication Platform

Oriole adalah platform manajemen reservasi dan komunikasi bisnis modern berbasis AI. Dilengkapi dengan **Voice AI inbound & outbound** (Vapi + Telnyx), **Unified Inbox multi-channel** (WhatsApp, Telegram, LINE, Email), **AI Chat Knowledge Base**, **Form Intake otomatis** (Tally & Google Forms), **Kalender & Penjadwalan Staf interaktif**, serta **Global Payments** terintegrasi (Paddle).

Dibangun dengan arsitektur monorepo TypeScript end-to-end yang tangguh, cepat, dan terukur.

---

## 🌟 Fitur Utama

### 📅 1. Kalender & Manajemen Booking Interaktif
- **Tampilan Kalender Komprehensif**: Navigasi fleksibel dengan mode *Month*, *Week*, *Day*, dan *Resource / Staff View*.
- **Dedicated Calendar & Bookings Hub**: Halaman khusus `/app/calendar` dan `/app/bookings` untuk manajemen reservasi.
- **Siklus Booking Lengkap**: Filter status (*Pending*, *Confirmed*, *Completed*, *Cancelled*), tanggal, layanan, staf, dan pencarian cepat.
- **Pencegahan Double-Booking & Konflik Jadwal**: Validasi otomatis ketersediaan slot staf secara *real-time*.
- **Zona Waktu Fleksibel**: Dukungan penyesuaian zona waktu otomatis (*browser timezone*, *workspace timezone*, dan *user preference*).
- **Waitlist Management**: Sistem antrean tunggu otomatis saat slot jadwal penuh.

### 📞 2. Voice AI Inbound & Outbound (Vapi & Telnyx)
- **Panggilan Keluar Otomatis (Auto-Call Reminder)**: AI otomatis menghubungi pelanggan sebelum jadwal untuk konfirmasi kehadiran atau pengingat (*reminder*).
- **Resepsionis AI Masuk (24/7 Inbound Receptionist)**: Nomor telepon bisnis khusus (via Telnyx SIP / Vapi phone numbers). AI menerima panggilan 24/7, memeriksa ketersediaan slot staf, dan membuat booking langsung.
- **Vapi Assistant Dynamic Sync**: Sinkronisasi otomatis instruksi asisten Vapi dengan layanan, jam buka, staf, dan preferensi bisnis.
- **Deterministic Call Goals (`@oriole/call-goals`)**: Skenario percakapan terstruktur per industri (salon, klinik kesehatan, gym/fitness, konsultasi, dan profesional).
- **Riwayat & Analisis Panggilan**: Transkrip percakapan, durasi panggilan, analisis sentimen/outcome, dan pemutaran rekaman audio di `/app/calls`.
- **Test Call Sandbox**: Fitur uji coba panggilan langsung dari dashboard sebelum go-live.

### 💬 3. Unified Inbox & Multi-Channel Messaging
- **Pusat Komunikasi Terpadu (`/app/inbox`)**: Kelola seluruh percakapan pelanggan dari berbagai kanal dalam satu antarmuka terpusat.
- **Kanal yang Didukung**:
  - **WhatsApp**: Pilihan *Bring-Your-Own-WhatsApp* via WAHA (Scan QR code) atau WhatsApp Cloud API (Meta / 360dialog).
  - **Telegram**: Integrasi bot Telegram dengan tombol inline interaktif untuk konfirmasi, ubah jadwal (*reschedule*), atau pembatalan.
  - **LINE**: Integrasi LINE Messaging API dengan format pesan terstruktur.
  - **Email**: Pengiriman konfirmasi dan reminder otomatis via Resend.
- **Customer Opt-In & Channel Registry**: Manajemen status persetujuan (*opt-in / opt-out*) per kontak dan kanal.
- **Handoff ke Staf (`needsAttention`)**: Penandaan otomatis untuk pesan yang memerlukan respon manual staf.

### 🤖 4. AI Chat & Business Knowledge Base
- **LLM Automated Q&A**: Asisten AI pintar yang menjawab pertanyaan umum seputar layanan, harga, jam operasional, dan lokasi berdasarkan basis pengetahuan bisnis (*Knowledge Base*).
- **Smart Decision Engine**: Pengambilan keputusan terstruktur (`ai-decision`, `ai-rag`, `ai-tools`) yang aman dari halusinasi dan otomatis melakukan eskalasi (*handoff*) ke staf jika pertanyaan di luar konteks.

### 📝 5. Intake Forms & Otomasi Prospek (Lead Capture)
- **Tally Forms Webhook Integration**: Tangkap data booking langsung dari form Tally, otomatis membuat kontak, reservasi, dan mengirim konfirmasi ke kanal pilihan.
- **Google Forms Intake**: Generator link reservasi cerdas dengan pengisian form Google Forms terintegrasi.

### 👥 6. Manajemen Staf & Jadwal Kerja
- **Profil & Penugasan Staf**: Atur anggota staf, spesialisasi layanan, dan avatar.
- **Pengaturan Jam Kerja (Weekly Schedule)**: Konfigurasi jam kerja harian, jam istirahat, dan hari libur per staf.
- **Time-Off & Cuti**: Manajemen cuti staf dengan pemblokiran slot otomatis pada kalender.

### 🏷️ 7. Katalog Layanan (Services Catalog)
- **Struktur Layanan Fleksibel**: Kategori layanan, durasi waktu fleksibel, dan harga *multi-currency*.
- **Penugasan Staf**: Pemetaan staf yang memenuhi kualifikasi untuk masing-masing layanan.

### 📇 8. Customer Relationship Management (CRM Contacts)
- **Direktori Pelanggan Terpusat (`/app/contacts`)**: Detail profil pelanggan, riwayat booking, catatan preferensi, nomor telepon terverifikasi, dan kanal komunikasi aktif.

### 💳 9. Billing & Global Payments (Paddle MoR)
- **Manajemen Langganan SaaS**: Integrasi Merchant of Record (MoR) Paddle untuk paket *Free*, *Pro*, dan *Business*.
- **Tautan Pembayaran Sekali Bayar (Payment Links)**: Buat tautan pembayaran untuk deposit atau pelunasan reservasi dengan dukungan berbagai mata uang dunia.
- **Idempotent Webhook Processing**: Verifikasi tanda tangan HMAC dan pencatatan event transaksi yang aman dari duplikasi.

### 📊 10. Analitik & Telemetri Terintegrasi
- **PostHog Event Tracking**: Pelacakan analitik penggunaan aplikasi secara aman di sisi klien maupun server.
- **Server-side Error Tracking**: Monitoring dan pelaporan error secara terpusat untuk keandalan sistem.

### 🌐 11. Internasionalisasi (i18n)
- **Dukungan Dwibahasa Penuh**: Bahasa Indonesia (`id`) & English (`en`).
- **Validasi Build Otomatis (`check:i18n`)**: Menjamin konsistensi dan kelengkapan seluruh kunci terjemahan di frontend.

---

## 🛠️ Tech Stack

| Komponen | Teknologi | Deskripsi |
| --- | --- | --- |
| **Monorepo Architecture** | pnpm workspaces + Turborepo | Struktur modular `apps/*` dan `packages/*` |
| **Frontend Framework** | Vite 8 · React 19 · TypeScript | TanStack Query v5, Zustand, React Router v7 |
| **UI & Styling** | Astryx Design System + Tailwind CSS 4 | Komponen UI accessible, Lucide & Phosphor Icons, Framer Motion |
| **Backend API** | Hono 4 · Node.js 22+ | Framework HTTP performa tinggi dan ringan |
| **Database & ORM** | Neon PostgreSQL (Serverless) · Drizzle ORM | Database cloud elastis dengan migrasi tipe-aman |
| **Authentication** | Neon Auth (Managed Better Auth) | Autentikasi stateless via verifikasi JWT & JWKS |
| **Background Workflows** | Inngest | Event-driven queues, durable functions, cron jobs, retry otomatis |
| **Voice AI & Telephony** | Vapi SDK · Telnyx SIP | Speech-to-Speech LLM agents untuk inbound/outbound calls & SIP provisioning |
| **Messaging Channels** | WAHA · 360dialog · Telegram Bot · LINE · Resend | Gateway multi-channel WhatsApp, Telegram, LINE, dan Email transaksional |
| **Global Payments** | Paddle | Merchant of Record untuk subscription SaaS & customer payment links |
| **Product Analytics** | PostHog | Server-side & client-side telemetry dan error tracking |

---

## 📁 Struktur Monorepo

```
oriole/
├── apps/
│   ├── web/                         # Aplikasi Frontend (Vite 8 + React 19)
│   │   ├── src/
│   │   │   ├── app/
│   │   │   │   ├── auth/            # Halaman SignIn, SignUp, ForgotPassword, Callback
│   │   │   │   ├── pages/           # Dashboard, Bookings, Calendar, Calls, Contacts, Inbox, Services, Staff, Settings
│   │   │   │   ├── shell/           # Layout, Navigation, Dialogs, Inbound Phone Wizard (Telnyx/Vapi)
│   │   │   │   └── components/      # UI components (PhoneInput, BusinessInfo, GoalCustomizer, AvatarPicker)
│   │   │   ├── lib/                 # API client, Auth session, Validations, Analytics (PostHog)
│   │   │   ├── stores/              # Zustand stores (Session, Workspace)
│   │   │   └── i18n/                # Terjemahan react-i18next (en, id)
│   │   └── wrangler.toml            # Konfigurasi deployment Cloudflare Pages
│   │
│   └── api/                         # Backend API Service (Hono 4)
│       └── src/
│           ├── db/                  # Drizzle database client & connection
│           ├── inngest/             # Durable functions (reminders, auto-call, assistant sync, payment sync)
│           ├── lib/                 # AI decision engine, RAG, tools, chat-engine, availability, analytics
│           ├── middleware/          # Auth JWT guard, workspace scoping, rate limiting, secure headers
│           ├── routes/              # Bookings, staff, services, calls, contacts, inbox, channels, payments, triggers
│           │   └── webhooks/        # Webhooks (Paddle, Vapi, Tally, Telegram, Line, WAHA, WhatsApp)
│           ├── scripts/             # CLI scripts (Telegram setup, Telnyx setup, seed data, assistant provision)
│           └── services/            # Client wrappers (Vapi, Telnyx, Paddle, Resend, WAHA, Meta WhatsApp)
│
├── packages/
│   ├── config/                      # Konfigurasi bersama & validasi schema environment (Zod)
│   ├── database/                    # Skema PostgreSQL Drizzle & migration scripts
│   ├── call-goals/                  # Skenario & prompt percakapan AI terstruktur per industri
│   └── messaging/                   # Format pesan multi-channel, normalisasi telepon, template reminder
│
├── deploy/
│   └── waha/                        # Docker compose & konfigurasi untuk self-hosted WhatsApp HTTP API (WAHA)
├── docs/                            # Dokumentasi arsitektur, messaging, AI chat, keamanan, dan deployment
└── .github/workflows/               # Pipeline CI/CD (Lint, Typecheck, Test, Build)
```

---

## 🚀 Panduan Memulai (Quickstart)

### 1. Prasyarat Sistem
- **Node.js**: `≥ 22.0.0`
- **pnpm**: `≥ 10.0.0`
- **Docker** *(opsional, jika menggunakan integrasi WAHA WhatsApp lokal)*

### 2. Instalasi Dependensi
```bash
pnpm install
```

### 3. Konfigurasi Environment
Salin template environment di root direktori:
```bash
cp .env.example .env
```
Isi konfigurasi kunci di file `.env`, antara lain:
- **Database & Auth**: `DATABASE_URL` (Neon PostgreSQL), `NEON_AUTH_URL`
- **Voice AI**: `VAPI_API_KEY`, `VAPI_WEBHOOK_SECRET`, `TELNYX_API_KEY` (opsional untuk nomor inbound)
- **Messaging**: `TELEGRAM_BOT_TOKEN`, `RESEND_API_KEY`, kredensial WhatsApp/LINE
- **Payments**: `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`
- **Workflows & Analytics**: `INNGEST_SIGNING_KEY`, `POSTHOG_API_KEY`

### 4. Database Migrations
Jalankan migrasi skema database via Drizzle:
```bash
pnpm db:generate
pnpm db:migrate
```
*(Opsional: Jalankan `pnpm db:studio` untuk membuka Drizzle Studio GUI).*

### 5. Menjalankan Server Development
```bash
# Menjalankan seluruh aplikasi (Frontend: port 5173, API: port 3000)
pnpm dev
```
Akses antarmuka web di `http://localhost:5173`.

Untuk menjalankan Inngest Dev Server lokal:
```bash
pnpm --filter @oriole/api dev:inngest
```

---

## 🧪 Validasi & Pengujian

```bash
# Pengecekan tipe TypeScript di seluruh workspace
pnpm typecheck

# Menjalankan unit & integration tests
pnpm test

# Sinkronisasi & validasi kunci bahasa i18n
pnpm --filter @oriole/web check:i18n

# Build produksi seluruh monorepo
pnpm build
```

---

## 🚢 Panduan Deployment

Lihat panduan lengkap di [docs/deployment.md](docs/deployment.md).

- **Frontend (Web)**: Di-deploy ke **Cloudflare Pages** menggunakan konfigurasi `apps/web/wrangler.toml`.
- **Backend (API)**: Di-deploy ke **Railway** atau **Fly.io** menggunakan Dockerfile multi-stage.
- **Database**: Dikelola secara serverless melalui **Neon PostgreSQL**.
- **Background Jobs**: Terhubung ke dashboard cloud **Inngest**.
- **WhatsApp Gateway (WAHA)**: Dapat di-deploy mandiri menggunakan konfigurasi di `deploy/waha/docker-compose.yml`.

---

## 📄 Lisensi

Proyek ini dilisensikan di bawah lisensi MIT. Silakan lihat berkas `LICENSE` untuk rincian lebih lanjut.
