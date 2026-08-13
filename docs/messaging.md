# Multi-Channel Messaging — Architecture & Ops Runbook

Oriole mengirim reminder & menerima balasan customer lewat **Telegram**, **WhatsApp**,
dan **email**, ter-orchestrasi dari satu pipeline yang sama dengan panggilan AI (Vapi).

Keputusan arsitektur (dikunci saat riset):

- **(b) Onboarding per-workspace via partner** — tiap project punya bot/nomor sendiri
  (`workspace_channels.providerConfig`), diatur dari UI **Channels**.
- **BSP: 360dialog** untuk WhatsApp Cloud API.
- **Telegram dulu, lalu WhatsApp** (sudah selesai), email sebagai channel outbound.
- **Template + tombol terstruktur** (bukan AI bebas di chat) — AI/human menindaklanjuti
  lewat window inbox; pesan yang tidak bisa diproses bot ditandai `needsAttention`.

---

## 1. Diagram alur

```
Booking dibuat (API / chat)
   │  emitBookingCreated() → event `booking/created` (berisi reminderAt)
   ▼
Inngest `remindBooking` ── sleepUntil(reminderAt) ── cancelOn booking/cancelled|completed
   │
   ▼ guard: status masih pending/confirmed?
   ├── Telegram  → sendMessage + tombol (bk:<id>:confirm|reschedule|cancel)
   ├── WhatsApp  → Message Template (wajib di luar 24h window)
   └── Email     → Resend (email dari tabel contacts)
        ▼ balasan customer (webhook)
   Telegram/WhatsApp webhook → verify secret/HMAC → dedup webhook_events
        ▼
   handler state machine: opt-out > tombol > reschedule 2-langkah > needsAttention
        ▼
   Unified inbox (conversations + messages) → staff balas dari UI Inbox
```

## 2. Database

Tabel baru (migrasi `0003` + `0004`):

- `workspace_channels` — kredensial per workspace (multi-tenant). `providerConfig`
  privat (token/secret) — **jangan pernah di-expose ke frontend**.
- `customer_channels` — registri identitas + **opt-in** customer per channel.
- `conversations` — thread ter-unifikasi; `state` jsonb (state machine &
  `needsAttention`); `unreadCount` + `lastMessageAt` untuk inbox.
- `messages` — riwayat pesan; dedup per (conversation, provider_message_id).
- `workspaces.reminder_lead_minutes` — lead time reminder per project (default 120 menit).
- `workspaces.call_goal_language` — bahasa panggilan AI / Vapi (default `en`; `id` disiapkan).
- `workspaces.auto_call_enabled` + `workspaces.auto_call_lead_hours` — auto-call Vapi otomatis per project (default mati; lead default 24 jam sebelum jadwal). Migrasi: `drizzle.gen/0005_brave_vivisector.sql`.

### Apply migrasi (di mesin normal, sandbox tidak bisa menulis `drizzle/`)

Migrasi 0003 & 0004 sudah digenerate di `packages/database/drizzle.gen/`
(karena direktori `drizzle/` tidak bisa ditulis di lingkungan sandbox).
Di mesin Anda:

```bash
# Opsi A — regenerasi identik lalu migrate
pnpm db:generate          # menghasilkan drizzle/0003_* & 0004_* yang sama
pnpm db:migrate

# Opsi B — salin langsung dari drizzle.gen
cp packages/database/drizzle.gen/0003_*.sql packages/database/drizzle/
cp packages/database/drizzle.gen/0004_*.sql packages/database/drizzle/
pnpm db:migrate
```

⚠️ `0003` juga membuat tabel `contacts` — selama ini tabel itu belum pernah
dimigrasikan (gap bootstrap yang ikut diperbaiki).

## 3. Setup Telegram

### Via CLI (one-shot)

```bash
pnpm --filter @oriole/api setup:telegram --workspace <workspaceId> --token <BOT_TOKEN>
# opsional: --secret <webhookSecret> (otomatis digenerate bila tidak dikirim)
```

Hanya butuh `DATABASE_URL` + `API_URL` (bukan env API lengkap).

### Dev mode: tunnel + webhook otomatis (`pnpm dev`)

Di development, `pnpm dev` menjalankan `pnpm dev:services` lebih dulu
(`apps/api/src/scripts/dev-services.ts`, **dev only** — di-skip saat
`NODE_ENV=production`), yang otomatis:

1. Menghidupkan **Cloudflare quick tunnel** (`cloudflared` → URL `*.trycloudflare.com`)
   jika `WEBHOOK_BASE_URL` kosong / masih trycloudflare. URL permanen milik Anda
   tidak diganggu.
2. Menyinkronkan `WEBHOOK_BASE_URL` di root `.env` (URL quick tunnel berubah
   tiap restart) dan **mendaftarkan ulang webhook Telegram** (`setWebhook`,
   secret lama dipertahankan) untuk semua channel workspace.
3. Menghidupkan **Inngest Dev Server** (localhost:8288) bila belum jalan.

Jebakan DNS: hostname quick tunnel butuh waktu hingga ~1 menit untuk propagate
ke resolver publik. Script menunggu DNS hangat (lokal + 8.8.8.8 + 1.1.1.1)
sebelum `setWebhook` pertama — bila tetap gagal (resolver Telegram meng-cache
NXDOMAIN), tunnel otomatis **dirotasi** ke URL baru. State tunnel disimpan di
`node_modules/.cache/oriole/tunnel.json` agar `pnpm dev` berikutnya me-reuse
tunnel yang masih hidup. Jalankan ulang hanya `pnpm dev:services` bila perlu.

### Via UI

1. Buat bot di [@BotFather](https://t.me/BotFather) → dapatkan token.
2. Buka **Channels** → **Telegram** → tempel token → **Hubungkan bot**.
   Token divalidasi ke Telegram (`getMe`), webhook didaftarkan otomatis dengan
   secret acak (`setWebhook`).
3. Webhook URL: `{API_URL}/api/webhooks/telegram/{workspaceId}` (tampil di UI,
   bisa disalin). Secret `X-Telegram-Bot-Api-Secret-Token` diverifikasi pada tiap request.

### Linking chat → booking (nomor HP)

Bot Telegram tidak pernah menerima nomor telepon user secara otomatis. Alur linking:

1. User chat pertama kali → bot minta nomor HP dengan **reply keyboard sekali pakai
   `request_contact`** (tombol "📱 Bagikan Nomor") — nomor yang dikirim Telegram
   **verified** (lengkap kode negara, tanpa typo) dan merupakan consent eksplisit.
   Ketikan manual tetap didukung sebagai fallback (state `awaiting-phone`).
2. Nomor (dari `message.contact.phone_number` → intent `contact`, atau dari teks)
   dicocokkan secara kanonik (+62 / 62 / 0812) dengan **booking aktif** saja
   (`findActiveBookingByPhone`, status pending/confirmed) — mencegah klaim nomor
   customer lain. Cocok → `customer_channels` dibuat/update (opt-in) + chat ter-link.
3. Nomor valid **tanpa booking aktif** → bot TIDAK membalas "nomor tidak cocok";
   ia menandai percakapan `needsAttention` (terlihat staf di inbox) dan mengarahkan
   ke **form booking terintegrasi** (Google Forms/Tally) bila ada — customer yang
   ingin booking dari awal langsung bisa. Tanpa form → balasan handoff
   (`renderNoFormReply`). Input yang bukan nomor valid → bot minta ulang dengan
   tombol request_contact (bukan penolakan).

## 4. Setup WhatsApp (360dialog)

1. Daftar di 360dialog, verifikasi nomor, buat **Message Template** reminder
   (disarankan nama `booking_reminder`, bahasa `id`) dengan body 3 param:
   `{{1}}` nama customer, `{{2}}` judul, `{{3}}` waktu terformat.
   Template **harus di-approve Meta** sebelum bisa dipakai di luar 24h window.
2. Buka **Channels** → **WhatsApp** → tempel API key 360dialog → **Hubungkan WhatsApp**.
   Key divalidasi via `GET /v1/configs`.
3. **Tempel URL webhook di dashboard 360dialog** (Settings → Webhooks):
   `{API_URL}/api/webhooks/whatsapp/{workspaceId}` dan set App Secret
   (dipakai untuk memverifikasi `X-Hub-Signature-256`).
4. Verifikasi di dashboard 360dialog bahwa webhook aktif & mengirim event
   `messages` (Meta mengirim test payload saat setup — di-ack 200 otomatis).

Catatan operasional WhatsApp:

- Pesan **teks/interactive** hanya sah dalam 24h customer-service window.
- Di luar window, satu-satunya cara kontak adalah **Message Template** —
  inilah yang dipakai reminder (fallback `WHATSAPP_TEMPLATE_REMINDER`).
- Balasan customer (tombol `bk:...`) otomatis membuka window 24 jam baru.

## 5. Env vars

```env
# Fallback single-tenant development (prioritas utama: tabel workspace_channels)
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=
WHATSAPP_API_KEY=
WHATSAPP_WEBHOOK_SECRET=
WHATSAPP_TEMPLATE_REMINDER=booking_reminder
# Inngest
INNGEST_EVENT_KEY=
INNGEST_SIGNING_KEY=
```

Tanpa `INNGEST_EVENT_KEY`, `inngest.send` butuh **Dev Server** lokal:

```bash
pnpm --filter @oriole/api dev:inngest
# ≡ inngest-cli dev -u http://localhost:3000/api/inngest
```

**Alternatif satu-perintah (disarankan):** overlay compose di
`deploy/waha/docker-compose.dev.yml` menjalankan WAHA + API + Inngest Dev
Server sekaligus di container — tanpa terminal `dev:inngest` terpisah
(lihat `deploy/waha/README.md` → "Full stack in one command").

⚠️ **Tanpa Dev Server ini, pipeline WhatsApp BYO (WAHA) TIDAK berfungsi:**
webhook `message` memanggil `inngest.send` → koneksi ditolak → API balas 503
(WAHA me-retry dengan envelope id yang sama, jadi pesan tidak hilang — begitu
server hidup, retry diproses). Dev Server juga wajib agar fungsi `remindBooking`
dkk. terdaftar (lihat `apps/api/src/inngest/functions.ts`).

## 6. Endpoint API

| Method | Path | Keterangan |
|---|---|---|
| GET | `/api/health/inngest` | Health pipeline Inngest (`{ status: ok\|down, mode, baseUrl }`) — UI menampilkan peringatan saat down (webhook pesan membalas 503 diam-diam) |
| GET | `/api/channels` | Status channel + webhook URL (tanpa kredensial) |
| POST | `/api/channels/telegram/setup` | Validasi token + setWebhook |
| POST | `/api/channels/telegram/rewebhook` | Re-register webhook |
| POST | `/api/channels/whatsapp/setup` | Validasi API key 360dialog |
| PATCH | `/api/channels/:type` | Aktif / nonaktif |
| DELETE | `/api/channels/:type` | Lepas channel |
| GET | `/api/inbox` | Daftar percakapan (unread, needsAttention, pagination) |
| GET | `/api/inbox/:id` | Thread + riwayat pesan + info booking |
| POST | `/api/inbox/:id/read` | Tandai dibaca |
| POST | `/api/inbox/:id/reply` | Balas via channel asli (text, opsional tombol) |
| POST | `/api/bookings/:id/trigger-telegram` | Kirim reminder sekarang (manual) |
| POST | `/api/bookings/:id/trigger-whatsapp` | Kirim reminder sekarang (template) |
| POST | `/api/bookings/:id/trigger-email` | Kirim reminder email sekarang |
| POST | `/api/webhooks/telegram/:workspaceId` | Webhook Telegram (secret token) |
| POST | `/api/webhooks/whatsapp/:workspaceId` | Webhook WhatsApp (HMAC) |

Semua route `/api/channels` & `/api/inbox` butuh auth + workspace aktif.
Setup channel dibatasi rate limit 10/menit.

## 7. Keamanan & kepatuhan (production checklist)

- [ ] `TELEGRAM_WEBHOOK_SECRET` / webhook secret per-workspace disetel —
      webhook **fail-closed** di produksi tanpa secret.
- [ ] `WHATSAPP_WEBHOOK_SECRET` disetel (App Secret di 360dialog) — verifikasi
      `X-Hub-Signature-256` atas RAW body.
- [ ] `INNGEST_SIGNING_KEY` disetel — endpoint `/api/inngest` memverifikasi signature.
- [ ] Link nomor Telegram hanya untuk booking aktif (`phoneExistsInWorkspace`)
      — mencegah klaim nomor customer lain.
- [ ] Opt-out dihormati: teks `STOP`/`BERHENTI`, tombol stop, dan blokir bot
      (`my_chat_member` kicked) → `isOptedIn=false`; pengiriman apa pun ditolak.
- [ ] Inbox reply menolak mengirim ke customer yang sudah opt-out / percakapan ditutup.
- [ ] Token/secret hanya dikirim via HTTPS; `providerConfig` tidak pernah
      muncul di respons API.
- [ ] Idempotensi: webhook dedup di `webhook_events`; balasan bot dedup via
      `metadata.replyToUpdateId` / `replyToWamid`; reminder guard status di
      Inngest (booking dibatalkan = tidak dikirim).

## 7b. Integrasi form booking: Tally (pengganti Typeform)

Form submission → kontak + booking otomatis didukung oleh **Google Forms**
(polling) dan **Tally** (webhook real-time). Tally menggantikan Typeform
sepenuhnya:

- **Connect** (halaman Integrations): tempel API key Tally (sekali) → pilih
  form → webhook `FORM_RESPONSE` didaftarkan otomatis via `POST /webhooks`
  (Tally tidak menyediakan OAuth — API key Bearer adalah satu-satunya auth).
  Pintasan "Get your API key" di dialog mengarah ke `tally.so/settings/api-keys`.
- **Webhook masuk**: `POST /api/webhooks/tally/:workspaceId`, verifikasi header
  `Tally-Signature` (base64 HMAC-SHA256 raw body, `signingSecret`), idempotent
  per `submissionId` (tabel `webhook_events`).
- **Mapping field**: tipe `INPUT_PHONE_NUMBER`/`INPUT_EMAIL`/`INPUT_DATE`/
  `INPUT_TIME` dipakai langsung; nama/catatan/layanan heuristic judul — sama
  dengan Google Forms. Pilihan (multiple choice dll.) di-resolve ke teks option.
- **Migrasi dari Typeform**: migration DB `0022` mengubah baris
  `workspace_integrations` dengan `integration_type = 'typeform'` menjadi
  `'tally'` dalam keadaan NONAKTIF (`provider_config = {"migratedFrom":"typeform"}`)
  — API key Typeform lama tidak bisa dipakai Tally. UI menampilkan banner
  "migrated" dan workspace tinggal hubungkan ulang dengan API key Tally.

## 8. Extension point berikutnya

- **Channel baru** (Line, SMS): implementasi `ChannelAdapter` di
  `@oriole/messaging` (parser + render) dan dispatcher + webhook di `apps/api`.
- **Inbound email**: Resend inbound webhook → parser → `CanonicalInboundEvent`
  (saat ini email outbound-only).
- **AI di inbox**: percakapan `needsAttention` adalah antrean handoff —
  hubungkan ke LLM window di web (`POST /api/inbox/:id/reply` tetap jadi jalur
  balasan terstruktur).
