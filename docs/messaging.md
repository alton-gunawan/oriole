# Multi-Channel Messaging — Architecture & Ops Runbook

Oriole mengirim reminder & menerima balasan customer lewat **Telegram**, **WhatsApp**,
**Line**, dan **email**, ter-orchestrasi dari satu pipeline yang sama dengan panggilan AI (Vapi).

Keputusan arsitektur (dikunci saat riset):

- **(b) Onboarding per-workspace via partner** — tiap bisnis punya bot/nomor sendiri
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
   ├── Line      → push/reply + template tombol (postback bk:<id>:…)
   └── Email     → Resend (email dari tabel contacts)
        ▼ balasan customer (webhook)
   Telegram/WhatsApp/Line webhook → verify secret/HMAC → dedup webhook_events
        ▼
   handler state machine (chat-engine.ts, lintas channel): opt-out > tombol > reschedule 2-langkah > needsAttention
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
- `workspaces.reminder_lead_minutes` — lead time reminder per bisnis (default 120 menit).
- `workspaces.call_goal_language` — bahasa panggilan AI / Vapi (default `en`; `id` disiapkan).
- `workspaces.auto_call_enabled` + `workspaces.auto_call_lead_hours` — auto-call Vapi otomatis per bisnis (default mati; lead default 24 jam sebelum jadwal). Migrasi: `drizzle.gen/0005_brave_vivisector.sql`.

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
   (`renderNoBookingReply` tanpa URL: jelaskan tidak ada booking aktif + hubungi
   admin). Input yang bukan nomor valid → bot minta ulang dengan tombol
   request_contact (bukan penolakan).

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

## 4b. Setup Line (Messaging API)

1. Buat channel **Messaging API** di [Line Developers Console](https://developers.line.biz/console/)
   (bukan LINE Login). Catat **Channel access token** (long-lived) dan **Channel secret**.
2. Buka **Channels** → **Line** → tempel access token + channel secret → **Hubungkan Line**.
   Token divalidasi via `GET /v2/bot/info`; webhook endpoint didaftarkan otomatis via
   `PUT /v2/bot/channel/webhook/endpoint` ke
   `{API_URL}/api/webhooks/line/{workspaceId}`.
3. Di Console → Messaging API settings, pastikan toggle **Use webhook** aktif.

Catatan operasional Line:

- Kredensial disimpan **terenkripsi at-rest** (AES-256-GCM) di `providerConfig`.
- Setiap request webhook diverifikasi `X-Line-Signature` (HMAC-SHA256 channel secret);
  tanpa signature → 401.
- Balasan inbound memakai `replyToken` sekali pakai (window 1 menit); reminder &
  konfirmasi memakai **push message**. Tombol reminder → template `buttons`
  (postback `bk:<id>:confirm|reschedule|cancel`), teks panjang → `shortPrompt`.
- Tidak ada fallback env — Line selalu per-workspace (mirip WhatsApp).

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
| GET | `/api/channels/telegram/webhook-health` | URL webhook terdaftar + update tertunda (getWebhookInfo) |
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

- **Connect** (halaman Integrations): tempel API key Tally (sekali) → klik
  "Hubungkan Tally" → form booking baru **di-generate otomatis** dari API
  (`POST /integrations/tally/generate` → `POST /forms`), tanpa memilih form —
  lalu webhook `FORM_RESPONSE` didaftarkan (`POST /webhooks`) dan integrasi
  terhubung dalam satu langkah. Konten form **menyesuaikan industri workspace**
  (label layanan + field tambahan per industri via `INDUSTRY_FORM_PROFILES`,
  mis. salon → "Jenis Layanan" + stylist pilihan; dental → "Perawatan Gigi"
  + dokter pilihan). Label/tipe dipilih agar cocok dengan mapping field di
  bawah. Pintasan "Get your API key" di dialog mengarah ke
  `tally.so/settings/api-keys`.
- **Connect form lama (API saja)**: `POST /integrations/tally/connect` tetap
  mendukung menghubungkan form Tally yang sudah ada, dengan opsi opsional
  `updateContent: true` yang menimpa isi form dengan field booking standar
  (`PATCH /forms/:id`, industri-aware) sebelum webhook didaftarkan — gagal di
  langkah ini membatalkan connect. UI web memakai alur generate otomatis di
  atas (tidak lagi menawarkan pilihan form); endpoint ini untuk konsumen API
  yang ingin menyambungkan form miliknya sendiri.
- **Auto-respond (otomatis, tanpa pesan ulang)**: saat submission
  menghasilkan booking, owner diberi tahu lewat email DAN customer menerima
  konfirmasi "booking diterima" segera via Telegram
  (`dispatchTelegramConfirmation`, dedup `confirmationBookingId` — terpisah
  dari reminder terjadwal). Bot tidak lagi meminta customer "kirim pesan lagi"
  setelah mengisi form: tautan yang dikirim bot menyuntikkan **token chat
  asal** (hidden field `orioleChatId` di URL `?orioleChatId=<chat id>`),
  submission membawanya kembali, webhook memverifikasi token itu milik
  percakapan Telegram workspace (cegah token palsu mengarahkan konfirmasi ke
  chat lain), lalu konfirmasi dikirim **langsung ke chat tersebut** — bahkan
  bila nomor customer belum pernah di-link ke bot. Sekaligus chat ↔ nomor
  dikuatkan (opt-in) supaya reminder/review berikutnya bisa menjangkau
  customer lewat nomor. Fallback tetap ada: tanpa token (form dibuka via email
  / link umum), konfirmasi dikirim bila nomor sudah terhubung (perilaku lama).
  **Self-heal + visibilitas**: saat bot mengirim tautan form, form Tally yang
  belum punya blok enhanced (prefill + token chat) di-PATCH otomatis
  (`ensureTallyFormEnhanced`, fire-and-forget, throttle 1 jam) — tidak perlu
  owner membuka halaman Integrations lebih dulu. Chat ↔ nomor juga di-link
  (opt-in) saat customer mengirim nomornya walau belum ada booking aktif,
  sehingga konfirmasi by-phone berfungsi. Semua kegagalan konfirmasi /
  sinkronisasi dicatat di `providerConfig` (`lastConfirmationError` /
  `lastContentSyncError`) dan ditampilkan di kartu Tally — tidak pernah
  "diam tanpa kabar".
- **Prefill phone & nama (+ token chat)**: form yang di-generate memuat
  **hidden field `phone`, `name`, dan `orioleChatId`** — input nomor HP dan
  nama memakai hidden field masing-masing sebagai default answer. Payload mengikuti **OpenAPI resmi
  Tally** (`api.tally.so/openapi.json`): blok `HIDDEN_FIELDS` dengan
  `payload.hiddenFields: [{uuid, name}]`, dan input dengan `hasDefaultAnswer:
  true` + `defaultAnswer` berupa **referensi Field** (`{uuid, type:
  'HIDDEN_FIELD', questionType: 'HIDDEN_FIELDS', blockGroupUuid, title}`) ke
  hidden field yang bersangkutan. Best-effort dengan fallback berjenjang:
  Tally menolak blok prefill → form dibuat ulang tanpa prefill, tidak pernah
  gagal. Setiap pengiriman tautan ke customer — `dispatchFormInvitation`
  (Integrations), balasan bot "mau booking" di WhatsApp/Telegram/Line —
  menambahkan `?phone=<nomor-kanonik>` dan `?name=<nama>` ke URL
  (`formPublicUrlForCustomer`), sehingga nomor HP + nama terisi otomatis dan
  customer tidak perlu mengetiknya. **Auto-sync**: form yang sudah terhubung
  tapi belum punya prefill/dropdown (mis. terhubung sebelum fitur ini ada)
  di-PATCH ulang otomatis saat halaman Integrations dibuka (guard: sekali per
  kunjungan + 24 jam sejak percobaan terakhir, agar kegagalan Tally tidak
  menekan API tiap halaman dimuat; `contentSyncAttemptedAt` tersimpan di
  providerConfig dan `lastContentSyncAt` di-expose ke UI). Form lama tanpa
  hidden field (manual): ketik `/hidden` di editor Tally → field `phone`/
  `name` → Default answer pada pertanyaan → pilih hidden field-nya; parameter
  URL tetap aman dikirim (diabaikan Tally bila field tidak ada).
- **Dropdown layanan**: pertanyaan layanan di form yang di-generate memakai
  **DROPDOWN berisi layanan dari katalog** (halaman Services, urut sortOrder,
  nama dobel dibuang) alih-alih teks bebas — mengurangi typo dan cocok dengan
  pencocokan layanan di pipeline booking. Payload `DROPDOWN_OPTION` (satu
  `groupUuid`, `index`/`isFirst`/`isLast`) sesuai dokumentasi resmi Tally,
  dengan fallback berjenjang: Tally menolak blok dropdown → form dibuat ulang
  tanpa dropdown (tetap teks bebas), tidak pernah gagal. `serviceDropdown`
  menandakan hasil; tombol "Sinkronkan opsi layanan" di kartu integrasi
  memanggil `POST /integrations/tally/update-content` untuk memperbarui form
  yang sudah ada setelah daftar layanan berubah (industri-aware, best-effort).
  Nilai jawaban single-select (ID option) di-resolve ke teks layanan saat
  submission diproses.
- **Webhook masuk**: `POST /api/webhooks/tally/:workspaceId`, verifikasi header
  `Tally-Signature` (base64 HMAC-SHA256 raw body, `signingSecret`), idempotent
  per `submissionId` (tabel `webhook_events`). **Submission diproses SINCRON di
  route** (kontak + booking + konfirmasi Telegram) — TIDAK antre ke Inngest,
  agar alur inti tidak bergantung pada worker Inngest yang berjalan (di dev,
  worker tidak selalu aktif; tanpa ini, submission tidak pernah terproses).
  Kegagalan → 500 → Tally me-retry webhook (at-least-once); idempotensi
  internal (booking unique `sourceRef` + find-or-create kontak) membuat retry
  aman. Event hanya ditandai `processed` SETELAH sukses.
- **Mapping field**: tipe `INPUT_PHONE_NUMBER`/`INPUT_EMAIL`/`INPUT_DATE`/
  `INPUT_TIME` dipakai langsung; nama/catatan/layanan heuristic judul — sama
  dengan Google Forms. Pilihan (multiple choice dll.) di-resolve ke teks option.
- **Migrasi dari Typeform**: migration DB `0022` mengubah baris
  `workspace_integrations` dengan `integration_type = 'typeform'` menjadi
  `'tally'` dalam keadaan NONAKTIF (`provider_config = {"migratedFrom":"typeform"}`)
  — API key Typeform lama tidak bisa dipakai Tally. UI menampilkan banner
  "migrated" dan workspace tinggal hubungkan ulang dengan API key Tally.

## 7c. Notifikasi booking ke chat bisnis (Telegram alerts)

Saat booking dibuat — dari form Tally/Google Forms, route POST /bookings,
waitlist, AI chat, atau panggilan Vapi inbound — owner bisnis bisa menerima
**kartu notifikasi instan di chat Telegram** (pola sama dengan Slack, tetapi
via bot Telegram workspace yang sudah dipakai):

- **Bind chat**: halaman Integrations → kartu "Telegram Booking Alerts" →
  tombol membuka deep-link `https://t.me/<bot>?start=oriole_<token>` (token
  acak 48 hex, disimpan di `workspace_integrations.providerConfig`). Owner
  menekan Start pada bot → webhook menerima `/start oriole_<token>` → chat
  terikat (`providerConfig.chatId`/`chatName`), token **dirotasi** (link bekas
  tidak bisa dipakai ulang). Pesan bind TIDAK masuk inbox customer.
- **Event**: `booking.created` (semua sumber) dikirim sebagai kartu
  (`🆕 New booking` + judul + customer + waktu + telepon). Map meta mendukung
  cancelled/completed/updated/deleted — tinggal emit dari jalur terkait.
- **Alur**: route mengirim event `telegram-alert/booking.event` (hanya bila
  integrasi aktif — `emitTelegramBookingAlert`) → Inngest
  `deliverTelegramBookingAlert` → `deliverTelegramBusinessAlert` memuat
  chatId + token channel, memformat pesan, dan mengirim via Telegram API.
  Belum terkonfigurasi/belum bind → `skipped` (tidak retry); kegagalan
  pengiriman dilempar → retry built-in Inngest.
- **Endpoint**: `POST /integrations/telegram-alerts/connect` (tautan bind),
  `/test` (ping uji), PATCH toggle, DELETE lepas. `chatId` tidak pernah
  di-expose ke frontend (hanya status bind + nama chat).

## 8. Extension point berikutnya

- **Channel baru** (Line, SMS): implementasi `ChannelAdapter` di
  `@oriole/messaging` (parser + render) dan dispatcher + webhook di `apps/api`.
- **Inbound email**: Resend inbound webhook → parser → `CanonicalInboundEvent`
  (saat ini email outbound-only).
- **AI di inbox**: percakapan `needsAttention` adalah antrean handoff —
  hubungkan ke LLM window di web (`POST /api/inbox/:id/reply` tetap jadi jalur
  balasan terstruktur).
