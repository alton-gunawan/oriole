# 🪶 Oriole — AI Booking & Communication Platform

SaaS manajemen booking modern yang dilengkapi **Voice AI outbound & inbound** (Vapi), **Unified Inbox** multi-channel (WhatsApp, Telegram, Instagram, Messenger, Email), **Kalender & Penjadwalan Staf interaktif**, serta **Global Payments** terintegrasi (Paddle).

Dibangun dengan arsitektur monorepo TypeScript end-to-end yang tangguh, cepat, dan terukur.

---

## 🌟 Fitur Utama

- 📅 **Kalender & Manajemen Booking**
  - Tampilan kalender interaktif: *Month*, *Week*, *Day*, dan *Resource / Staff View*.
  - CRUD booking lengkap dengan filter status, tanggal, layanan, staf, dan pencarian cepat.
  - Perubahan status booking (*Confirmed*, *Completed*, *Cancelled*, *No-show*) dan aksi massal (*bulk actions*).
  - Penyesuaian zona waktu otomatis (*browser timezone* & *workspace timezone*).

- 📞 **Voice AI (Vapi Integration)**
  - **Panggilan Keluar Otomatis (Outbound)**: AI menghubungi pelanggan otomatis sebelum jadwal untuk konfirmasi kehadiran atau pengingat (*reminder*).
  - **Resepsionis Masuk AI (Inbound Phone)**: Nomor telepon khusus per bisnis. AI menerima panggilan masuk 24/7, mengecek ketersediaan jadwal staf secara *real-time*, dan membuat booking langsung ke sistem.
  - **Deterministic Call Goals**: Engine percakapan terstruktur per industri (`@oriole/call-goals`) untuk salon, klinik, gym, konsultasi, dan layanan profesional.
  - **Riwayat & Transkrip Panggilan**: Detail percakapan, durasi, *sentiment / outcome*, dan rekaman.

- 💬 **Unified Inbox & Komunikasi Multi-Channel**
  - Satu inbox terpusat untuk mengelola percakapan dari **Telegram**, **WhatsApp Business (360dialog)**, **Instagram DMs**, **Facebook Page Messages**, dan **Email (Resend)**.
  - Kirim tautan booking, konfirmasi jadwal, dan pesan tindak lanjut langsung dari ruang obrolan.

- 👥 **Manajemen Staf & Jadwal Kerja**
  - Manajemen anggota staf, penugasan layanan, dan pengaturan jam kerja mingguan (*weekly schedule*).
  - Pencegahan konflik jadwal (*double-booking prevention*) otomatis.
  - Pengaturan cuti / waktu libur (*time-off*).

- 🏷️ **Katalog Layanan (Services Catalog)**
  - Pengelompokan layanan berdasarkan kategori, durasi waktu, dan harga multi-mata uang (*multi-currency*).
  - Form dialog terstruktur untuk penambahan dan modifikasi layanan.

- 📇 **Customer / Contacts Directory**
  - Database pelanggan lengkap dengan riwayat reservasi, catatan preferensi, nomor kontak terverifikasi, dan metrik interaksi.

- 💳 **Billing & Global Payments (Paddle MoR)**
  - Manajemen paket langganan bisnis (*Free*, *Pro*, *Business*) berbasis Merchant of Record (Paddle).
  - Pembuatan tautan pembayaran satu kali (*one-time payment links*) untuk deposit atau pelunasan booking dengan mata uang global.
  - Sinkronisasi status transaksi otomatis melalui webhook terverifikasi HMAC.

- 🔌 **Ekosistem Integrasi Luas**
  - **Kalender & Rapat Online**: Google Calendar sync, Cal.com, Zoom Rooms/Meetings, Google Meet.
  - **Formulir & Data**: Google Forms, Tally Forms, Notion Database, Obsidian Vault sync.
  - **Notifikasi Tim**: Slack channel webhooks, Telegram instant booking alerts, Custom Webhooks.

- 🌐 **Internasionalisasi (i18n)**
  - Dukungan penuh dwibahasa: **Bahasa Indonesia** & **English**.
  - Script validasi build otomatis (`check:i18n`) untuk menjamin sinkronisasi seluruh kunci terjemahan.

---

## 🛠️ Tech Stack

| Layer | Teknologi | Deskripsi |
| --- | --- | --- |
| **Monorepo** | pnpm workspaces + Turborepo | Struktur modular `apps/*` & `packages/*` |
| **Frontend** | Vite 8 · React 19 · TypeScript | TanStack Query, Zustand, React Router v7 |
| **UI & Styling** | Astryx Design System + Tailwind CSS 4 | Komponen UI accessible, Phosphor Icons, StyleX theme tokens |
| **Backend API** | Hono 4 · Node.js 22+ | Framework ringan berbasis TypeScript dengan performa tinggi |
| **Database** | Neon Serverless PostgreSQL | Drizzle ORM dengan tipe aman dan migrasi otomatis |
| **Authentication** | Neon Auth (Managed Better Auth) | Verifikasi stateless JWT melalui remote JWKS |
| **Background Jobs** | Inngest | Durable workflows, scheduled reminders, retry otomatis |
| **Voice AI** | Vapi SDK (`@vapi-ai/server-sdk`) | Speech-to-Speech LLM agents untuk outbound & inbound calls |
| **Payments** | Paddle | Merchant of Record untuk subscription SaaS & customer payment links |
| **Email Service** | Resend | Pengiriman email transaksional dan reminder |

---

## 📁 Struktur Monorepo

```
oriole/
├── apps/
│   ├── web/                    # Aplikasi Frontend (Vite + React 19)
│   │   └── src/
│   │       ├── app/pages/      # Dashboard, Bookings, Calendar, Contacts, Services, Staff, Integrations, Settings
│   │       ├── app/shell/      # Layout, AppShell, Navigation, Modal Dialogs, Icons
│   │       ├── lib/            # API client, Auth, Validations, Helpers
│   │       ├── stores/         # Zustand stores (Session, Workspace)
│   │       └── i18n/           # react-i18next locales (id, en)
│   └── api/                    # Backend API Service (Hono)
│       └── src/
│           ├── middleware/     # Auth, Workspace scoping, Rate limiting
│           ├── routes/         # Bookings, Staff, Services, Channels, Calls, Payments, Webhooks
│           ├── inngest/        # Scheduled functions, Event handlers, Retry pipelines
│           ├── services/       # Vapi, Paddle, Resend, Telegram, WhatsApp, Slack, Zoom
│           └── db/             # Drizzle ORM schema & client
├── packages/
│   ├── config/                 # Skema konfigurasi dan validasi environment (Zod)
│   ├── database/               # Skema PostgreSQL, Drizzle client & migrations
│   ├── call-goals/             # Engine perumusan skenario percakapan AI per industri
│   └── messaging/              # Format pesan, normalisasi telepon, template reminder
├── docs/                       # Dokumentasi arsitektur, deployment, keamanan, dan kanal
└── .github/workflows/          # CI pipeline (lint, typecheck, test, build)
```

---

## 🚀 Panduan Memulai (Quickstart)

### 1. Prasyarat
- **Node.js**: `≥ 22.0.0`
- **pnpm**: `≥ 10.0.0`

### 2. Instalasi Dependensi
```bash
pnpm install
```

### 3. Konfigurasi Environment
Salin berkas template lingkungan ke root direktori:
```bash
cp .env.example .env
```
Isi konfigurasi penting seperti `DATABASE_URL` (Neon), `NEON_AUTH_URL`, `VAPI_API_KEY`, dan `PADDLE_API_KEY`.

### 4. Database Migrations
Generate dan jalankan migrasi database via Drizzle:
```bash
pnpm db:generate
pnpm db:migrate
```

### 5. Menjalankan Server Development
```bash
# Menjalankan seluruh aplikasi (Web: port 5173, API: port 3000)
pnpm dev
```
Buka browser di `http://localhost:5173`.

---

## 🧪 Validasi & Pengujian

```bash
# Pengecekan tipe data TypeScript di semua workspace
pnpm typecheck

# Menjalankan unit & integration test
pnpm test

# Sinkronisasi & validasi kunci i18n
pnpm --filter @oriole/web check:i18n

# Build produksi seluruh monorepo
pnpm build
```

---

## 🚢 Panduan Deployment

Lihat panduan lengkap di [docs/deployment.md](docs/deployment.md).

- **Web Frontend**: Di-deploy ke **Cloudflare Pages** (`apps/web/wrangler.toml`).
- **API Backend**: Di-deploy ke **Railway** atau **Fly.io** menggunakan Dockerfile multi-stage.
- **Database**: Dikelola secara serverless melalui **Neon PostgreSQL**.

---

## 📄 Lisensi

Proyek ini dilisensikan di bawah lisensi MIT. Silakan lihat berkas `LICENSE` untuk informasi lebih lanjut.
