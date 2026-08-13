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

### Payments (Global — payment link Paddle)

```
Web ──POST /api/integrations/payments/connect──▶ (one-click, kredensial server-side PADDLE_API_KEY)
Web ──POST /api/payments──{title, amount, currency, bookingId?}──▶ Hono
   ├─ gate: integrasi payments aktif + PADDLE_API_KEY terisi (bukan placeholder)
   ├─ insert `payment_links` (status pending, amountMinor minor units)
   ├─ paddle.transactions.create(non-catalog price + custom_data.payment_link_id)
   └─ update row: paddle_transaction_id + checkout_url → URL dibagikan ke customer
Paddle ──POST /api/webhooks/paddle──transaction.completed/canceled──▶ Hono (verifikasi + idempotency)
   └─ Inngest sync-payment-link: pending → paid (dengan txn id, email, paidAt) / canceled
```

- Jumlah bebas per link via **non-catalog price** (`unitPrice` + `product.name`) — tanpa
  membuat product/price di katalog Paddle. Kode mata uang divalidasi terhadap daftar
  global Paddle (`CurrencyCode` SDK) sebelum dipanggil.
- Pembatalan di sisi app memanggil Paddle dulu (`transactions.update status=canceled`)
  agar URL checkout yang sudah dibagikan mati; gagal → 502 dan link tetap pending.
- Webhook menaut lewat `custom_data.payment_link_id` + workspace guard
  (`custom_data.workspace_id`) — event asing tidak bisa mengubah link project lain.

### Slack (notifikasi booking ke channel tim)

```
Web ──POST /api/integrations/slack/connect──{webhookUrl, channel?}──▶ Hono
   ├─ validasi URL harus https://hooks.slack.com/services/…
   ├─ ping uji SEKARANG (deliverSlackMessage ping) — gagal → 502, tidak disimpan
   └─ upsert workspace_integrations (providerConfig.webhookUrl = SECRET)
Route bookings / form-booking / webhook Vapi ──emitSlackBookingEvent──▶ inngest.send('slack/booking.event')
Inngest deliver-slack-notification → dispatchSlackNotification (retry built-in)
   └─ buildSlackMessage(event, data) → POST blocks ke webhook URL
```

- Event yang dikirim: `booking.created` / `booking.updated` / `booking.cancelled` /
  `booking.completed` / `booking.deleted` — payload sama dengan webhook keluar
  (`integration-events.ts` → `emitSlackBookingEvent` di tiap titik emit).
- URL webhook adalah **secret** (siapa pun yang memegangnya bisa memposting ke
  channel) — serializer publik hanya menampilkan host (`hooks.slack.com`) + label
  channel, nilai aslinya tidak pernah keluar dari server.
- Format pesan memakai Slack **blocks** (header + section fields: customer, waktu,
  telepon, status) dengan mrkdwn escaping input user.

### Panggilan suara (Vapi)

```
Web / Inngest ──placeBookingCall()──▶ Vapi API (asisten transient + nomor tujuan)
   ├─ RESERVE   calle_calls: insert id deterministik `pending:<callName>` (queued)
   ├─ RECONCILE retry: cari call Vapi by nama → adopsi (tanpa create ganda)
   ├─ CREATE    placeVapiCall() — gagal → reservasi dihapus, error dilempar
   └─ COMMIT    update row → id asli Vapi + bookings.calle_call_id ← call id
Vapi ──POST /api/webhooks/vapi──(Authorization: Bearer <VAPI_WEBHOOK_SECRET>)──▶ Hono
   ├─ status-update       → update status live di calle_calls (inline)
   ├─ end-of-call-report  → validasi (zod) + recordWebhookEvent('vapi', `${callId}:eocr`)
   │                        + inngest.send('vapi/event.received', id: eventId) — dedup Inngest
   └─ event lain (hang, transcript) → ack
Inngest (onVapiEvent): map endedReason → completed/failed/canceled
   ├─ upsert calle_calls (status + result: transkrip, recording, durasi) —
   │   row yang hilang (commit DB gagal) dibuat ulang dari nama panggilan
   └─ status completed → update bookings (status completed, guard panggilan
      terkini) + emit booking.completed
```

- SDK `@vapi-ai/server-sdk` (server-only, jangan expose `VAPI_API_KEY` di browser).
- Asisten dibuat **transient per panggilan** dari prompt goal (`composeCallGoal`),
  server URL webhook dikonfigurasi di `assistant.server` — tanpa setup dashboard.
- **Carrier BYO (opsional): Telnyx** — nomor keluar bisa diimpor dari Telnyx
  (kredensial dibuat sekali di dashboard Vapi, `VAPI_TELNYX_CREDENTIAL_ID`).
  Provisioning & registrasi otomatis via `scripts/setup-telnyx.ts`
  (`lib/telnyx-setup.ts` + `services/telnyx.ts`, REST v2 langsung — bukan paket
  `telnyx` npm, lihat catatan supply-chain di `services/telnyx.ts`). Runtime
  TIDAK tergantung Telnyx: panggilan tetap lewat `VAPI_PHONE_NUMBER_ID`; ops
  mengecek status dengan `scripts/telnyx-status.ts`.
- **Nomor keluar per-workspace (Integrations)** — integrasi `vapi` di
  `workspace_integrations` menyimpan pilihan nomor (`vapiPhoneNumberId`);
  kredensial tetap server-side (env). Setiap penempatan panggilan membaca
  `resolveOutboundPhoneNumber()` (`lib/place-call.ts`): pilihan workspace →
  fallback `VAPI_PHONE_NUMBER_ID`. UI: halaman Integrations → Voice AI calls.
- **BYOC (Bring your own carrier) — fase-2** — workspace menempel API key
  Telnyx miliknya sendiri di kartu Voice AI; `lib/telnyx-byoc.ts` membuat
  kredensial Telnyx DI SISI Vapi (`services/vapi-credential.ts` — POST
  /credential via passthrough `vapi.fetch()`, endpoint belum ada di SDK),
  membeli nomor bila perlu, lalu mendaftarkannya
  (`registerTelnyxNumberInVapi`). Key Telnyx workspace TIDAK pernah disimpan
  — dipakai sekali saat request; DB hanya menyimpan referensi non-secret
  (`vapiCredentialId`, `vapiPhoneNumberId`, nomor, `mode: 'byoc'`). Nomor
  BYOC disaring dari picker operator (`filterOperatorVapiNumbers`, prefix
  `oriole-byoc-`). Idempotensi: adopsi credential by nama + list-then-create
  nomor — retry tidak menggandakan credential/nomor/pembelian.
- Nama tabel & kolom lama (`calle_calls`, `calle_call_id`) dipertahankan untuk
  menghindari migrasi DB; id Vapi disimpan di `calle_call_id`.
- Nama panggilan (`booking:<id>:<goal>:<source>`) jadi jejak audit + dasar
  reservasi & rekonsiliasi retry (`lib/place-call.ts`): `vapi.calls.create`
  tidak idempoten, jadi retry Inngest memakai reserve → reconcile → create →
  commit — tidak menggandakan panggilan, dan crash di tengah tidak
  menghilangkan panggilan (call ter-orphan dipulihkan webhook via nama).

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
