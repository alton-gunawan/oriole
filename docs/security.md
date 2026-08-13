# Keamanan — Oriole

Dokumen ini merangkum postur keamanan API & web, kontrol yang sudah
diterapkan, batasan yang disadari, dan tindakan yang harus dilakukan
operator. Bahasa kode & dokumentasi: Indonesia.

---

## 1. Model ancaman (ringkas)

Oriole adalah SaaS booking + panggilan AI keluar (Vapi). Aset sensitif:

- **Data pribadi**: nama & nomor telepon customer, email, transkrip panggilan.
- **Biaya panggilan AI (Vapi)**: setiap panggilan yang dipicu = biaya riil (abuse = kerugian finansial).
- **State bisnis**: status booking (`completed` dkk) dan riwayat panggilan.

Ancaman utama: eksploitasi tanpa akun (webhook palsu, abuse endpoint
berbayar), pencurian sesi via XSS, dan kebocoran data via error/side-channel.

---

## 2. Kontrol yang sudah diterapkan

### 2.1 Autentikasi & sesi
- **JWT stateless** dari Neon Auth (managed Better Auth), diverifikasi
  terhadap JWKS remote via `jose.jwtVerify`:
  - `issuer` dibatasi ke origin `NEON_AUTH_URL`
  - `algorithms: ['EdDSA']` — **terverifikasi dari JWKS live** (Ed25519).
    JANGAN ubah tanpa mengecek ulang
    `${NEON_AUTH_URL}/.well-known/jwks.json` (pernah hampir mematikan
    seluruh auth).
  - `clockTolerance: 30s` untuk mengakomodasi skew jam.
- **Sesi cookie HttpOnly (hand-off)** — pola defense-in-depth:
  1. Setelah login, client mengirim JWT **sekali** ke `POST /api/auth/session`
     (diverifikasi `requireAuth`).
  2. Server menyimpan JWT sebagai cookie `oriole_session` (HttpOnly +
     Secure di produksi + SameSite `None` lintas-origin / `Lax` di dev).
  3. Client lalu **membuang token dari sessionStorage** — token tidak lagi
     terekspos ke JavaScript (mitigasi kerugian XSS).
  4. `requireAuth` menerima `Authorization: Bearer` sebagai sumber utama,
     cookie sebagai **fallback** — fully backward-compatible.
  - `signOut()` menghapus cookie lewat `DELETE /api/auth/session`.
  - Nilai cookie selalu diambil dari **Bearer token yang terverifikasi**
    (bukan field body yang tidak diverifikasi).
  - Catatan CSRF: cookie `SameSite=None` dibutuhkan karena web
    (Cloudflare Pages) dan API lintas-origin; permukaan CSRF dibatasi
    karena semua route memvalidasi JSON (`Content-Type: application/json`
    memicu CORS preflight) dan CORS hanya mengizinkan `env.APP_URL`.
  - ⚠️ **Lintas-situs (production)**: `SameSite=None` yang hidup di domain
    berbeda dari web (mis. web `oriole.com` vs API `*.railway.app`) adalah
    cookie pihak-ketiga dan bisa diblokir browser (fase-out cookie
    pihak-ketiga). Solusi terbaik: API di subdomain yang sama
    (`api.oriole.com` → same-site). Bila diblokir, app otomatis kembali ke
    Bearer token (fallback tetap jalan) — tetapi migrasi ini baru
    sepenuhnya efektif bila cookie bisa dikirim.
  - Masa hidup: cookie 7 hari, tetapi JWT di dalamnya short-lived
    (~15 menit) — sesi efektif sama seperti sebelum migrasi (perlu refresh
    JWT via Neon Auth / re-login).

### 2.2 Otorisasi & validasi input
- **BOLA (API1)**: `requireWorkspace` memverifikasi kepemilikan
  `X-Workspace-Id` per user; semua query booking/contact scoped ke
  workspace.
- **Validasi zod** di semua route (`zValidator`) — anti mass-assignment
  (API3). Webhook Vapi divalidasi dalam (`lib/vapi-types.ts`).
- **Normalisasi telepon** (`lib/phone.ts`): 8–15 digit, `+` opsional —
  menolak data sampah masuk ke Vapi.

### 2.3 Webhook & integrasi
- **Paddle**: signature diverifikasi di **raw body**
  (`paddle.webhooks.unmarshal`); idempotensi via tabel `webhookEvents`
  unik (provider, eventId) — replay aman.
- **Vapi**: webhook mewajibkan `Authorization: Bearer <VAPI_WEBHOOK_SECRET>`
  (atau header legacy `X-Vapi-Secret`), dibandingkan constant-time
  (`crypto.timingSafeEqual`). Vapi mengirim secret itu via
  `assistant.server.headers` — tidak perlu setup credential di dashboard.
  **Fail-closed**: tanpa secret → 503, event tanpa/header salah → 401.
- **Inngest**: `serveInngest` memverifikasi signature; guard startup
  memastikan `INNGEST_SIGNING_KEY` ter-set di produksi.
- **Telegram/WhatsApp**: secret per-channel diverifikasi di masing-masing
  route webhook.

### 2.4 Rate limiting & resource (OWASP API4/API6)
Rate limiter in-memory zero-dep (`middleware/rate-limit.ts`, fixed window,
dibersihkan otomatis):
- Global `/api/*` : **300 request/menit/IP**
- `/api/webhooks/*` : **120/menit**

Batas body: 1 MB route API, 10 MB webhook (transkrip panggilan).
Kunci IP memakai socket asli (`getConnInfo`), bukan header yang bisa
di-spoof. ⚠️ Multi-instance → butuh Redis (lihat catatan di file).

### 2.5 Headers, error handling, dependensi
- **Security headers** di API: `hono/secure-headers` (nosniff,
  X-Frame-Options, HSTS, Referrer-Policy). Web (Cloudflare Pages):
  `apps/web/public/_headers` (CSP ketat, clickjacking DENY, HSTS).
- **Error handler global**: `HTTPException` diteruskan apa adanya, error
  lain → 500 generik **tanpa stack trace**; detail hanya di log server.
- **CI**: `pnpm audit --prod --audit-level high` (report; gate diberlakukan
  saat CVE teratasi) + Dependabot mingguan.

### 2.6 Kuota plan (anti-abuse biaya panggilan AI)
- `lib/quota.ts`: free = **10 panggilan/bulan & 30 menit**, pro =
  500 panggilan & 2.000 menit (baca dari status subscription).
- Ditegakkan di jalur **auto-call** (`lib/auto-call.ts` → `checkCallQuota`)
  → skip + alasan `quota-<status>` (tidak ada lagi trigger manual).
- Batasan disadari: check-then-act tidak atomik (dua request konkuren
  bisa lolos) — guard call-in-flight di `placeBookingCall` menjadi
  backstop; penegakan atomik butuh tabel counter + transaksi.

### 2.7 Enkripsi at-rest pesan inbox (AES-256-GCM)
- **`lib/message-encryption.ts`**: konten `messages.content` dienkripsi
  saat disimpan (AES-256-GCM, IV acak 12 byte + auth tag) dan didekripsi
  transparan saat dibaca (inbox, preview, konteks AI chat).
- **Kunci per-workspace**: diturunkan deterministik via HKDF-SHA256 dari
  master key env `MESSAGE_ENCRYPTION_KEY` (32 byte / 64 hex char) dengan
  salt = `workspaceId` — workspace berbeda → kunci berbeda, tanpa menyimpan
  kunci di database (kebocoran DB tidak bisa mendekripsi pesan).
- **Kompatibilitas mundur**: baris plaintext legacy (tanpa prefix `enc:v1:`)
  tetap terbaca apa adanya. Tanpa master key, enkripsi nonaktif
  (passthrough — cukup untuk dev).
- **Degradasi aman**: baris terenkripsi yang tidak bisa didekripsi (key
  hilang/berubah, data rusak) ditampilkan sebagai `[encrypted]` — ciphertext
  mentah tidak pernah bocor ke UI/konteks LLM.
- ⚠️ **Peringatan rotasi**: setelah pesan terenkripsi, mengganti/kehilangan
  `MESSAGE_ENCRYPTION_KEY` membuat pesan lama tidak terbaca. Set di produksi
  sebelum pesan masuk.

---

## 3. Yang belum dikerjakan (keputusan terpantau)

| Item | Status | Alasan / rencana |
|---|---|---|
| **CVE `better-auth` via `@neondatabase/auth` (critical)** | Diketahui | `@neondatabase/auth@0.4.2-beta` meng-pin `better-auth@1.4.18` persis; belum ada rilis patch dari Neon. Dependabot membuka PR otomatis saat tersedia. **Jangan override** tanpa uji login live. |
| **CVE `react-router` (high)** | Diketahui | Patch = major upgrade v8 (breaking). Jadwalkan. |
| **Klaim `aud` di JWT** | Todo | Neon Auth tidak mendokumentasikan `aud`; setelah verifikasi dengan token asli, tambahkan `audience:` di `middleware/auth.ts`. |
| **Rate limiter Redis** | Todo | Saat deploy multi-instance (Railway scale-out), pindah ke counter terdistribusi (Redis) — lihat `middleware/rate-limit.ts`. |
| **Penegakan kuota atomik** | Todo | Tabel counter + transaksi bila abuse konkuren terdeteksi. |
| **Retensi data (UU PDP)** | Todo | Cron Inngest: purge `webhookEvents` (90 hari) dkk; mask PII di `webhookEvents.payload`; alur hapus akun. |
| **Audit log & RBAC** | Todo | Fase berikutnya. |

---

## 4. Tindakan operator

1. **`.env`** harus berisi:
   - `MESSAGE_ENCRYPTION_KEY` — master key 32 byte (mis. `openssl rand -hex 32`)
     untuk enkripsi at-rest pesan inbox. Kosong = enkripsi nonaktif.
   - `VAPI_WEBHOOK_SECRET` — nilai acak (mis. `openssl rand -hex 32`),
     dikirim Vapi sebagai header `Authorization: Bearer <secret>` (di-set
     otomatis di `assistant.server.headers` pada kode). Tanpa ini endpoint
     webhook Vapi menolak semua event (503) **by design** — server
     menampilkan warning saat boot.
   - `TELNYX_API_KEY` (bila BYO nomor Telnyx) — server-only, hanya dipakai
     script provisioning (`setup:telnyx`), bukan runtime. Rotasi: ganti key
     di Telnyx + update kredensial di dashboard Vapi (`VAPI_TELNYX_CREDENTIAL_ID`
     ikut berubah). Jangan pakai satu key Telnyx untuk integrasi lain.
   - **BYOC (per-workspace):** API key Telnyx milik workspace TIDAK pernah
     disimpan di database — dipakai sekali selama request untuk membuat
     kredensial Telnyx di sisi Vapi (POST /credential) dan validasi
     kepemilikan nomor. DB hanya menyimpan referensi non-secret
     (`vapiCredentialId`, `vapiPhoneNumberId`, nomor, `mode`). Endpoint
     `/integrations/vapi/byoc/*` mewajibkan auth (requireAuth +
     requireWorkspace) dan validasi key Telnyx (401 bila ditolak) SEBELUM
     membuat kredensial Vapi — key tidak valid tidak menghasilkan orphan
     credential.
   - `INNGEST_SIGNING_KEY` di produksi (guard startup).
2. **Hanya HTTPS** di produksi (cookie `Secure`, HSTS aktif).
3. Pantau `pnpm audit` di CI; ikuti PR Dependabot.
4. Sebelum ubah kunci JWT (`algorithms`, `audience`) — cek ulang JWKS live.

---

## 5. Verifikasi lokal

```bash
pnpm --filter @oriole/api test        # 50+ test (termasuk keamanan)
pnpm --filter @oriole/api typecheck
pnpm --filter @oriole/web typecheck
cd packages/config && pnpm test && pnpm run typecheck
```

Smoke test live:

```bash
curl -sI http://localhost:3000/api/health | grep -iE 'x-content-type|x-frame|strict-transport'
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/api/webhooks/vapi -d '{}'   # → 401 (fail-closed)
```
