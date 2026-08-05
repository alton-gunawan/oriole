# Keamanan — Oriole

Dokumen ini merangkum postur keamanan API & web, kontrol yang sudah
diterapkan, batasan yang disadari, dan tindakan yang harus dilakukan
operator. Bahasa kode & dokumentasi: Indonesia.

---

## 1. Model ancaman (ringkas)

Oriole adalah SaaS booking + panggilan AI keluar (CALL-E). Aset sensitif:

- **Data pribadi**: nama & nomor telepon customer, email, transkrip panggilan.
- **Biaya CALL-E**: setiap panggilan yang dipicu = biaya riil (abuse = kerugian finansial).
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
  (API3). Webhook CALL-E kini divalidasi dalam (sebelumnya `z.unknown()`).
- **Normalisasi telepon** (`lib/phone.ts`): 8–15 digit, `+` opsional —
  menolak data sampah masuk ke CALL-E.

### 2.3 Webhook & integrasi
- **Paddle**: signature diverifikasi di **raw body**
  (`paddle.webhooks.unmarshal`); idempotensi via tabel `webhookEvents`
  unik (provider, eventId) — replay aman.
- **CALL-E**: wajib `x-calle-signature` = HMAC-SHA256 atas **raw body**
  dengan `CALLE_WEBHOOK_SECRET`, dibandingkan constant-time
  (`crypto.timingSafeEqual`). **Fail-closed**: tanpa secret → 503, event
  tanpa/header salah → 401.
- **Inngest**: `serveInngest` memverifikasi signature; guard startup
  memastikan `INNGEST_SIGNING_KEY` ter-set di produksi.
- **Telegram/WhatsApp**: secret per-channel diverifikasi di masing-masing
  route webhook.

### 2.4 Rate limiting & resource (OWASP API4/API6)
Rate limiter in-memory zero-dep (`middleware/rate-limit.ts`, fixed window,
dibersihkan otomatis):
- Global `/api/*` : **300 request/menit/IP**
- `/api/webhooks/*` : **120/menit**
- `/api/bookings/*/trigger-call` : **10/menit** (backstop kuota bulanan)

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

### 2.6 Kuota plan (anti-abuse biaya CALL-E)
- `lib/quota.ts`: free = **10 panggilan/bulan & 30 menit**, pro =
  500 panggilan & 2.000 menit (baca dari status subscription).
- Ditegakkan di `POST /bookings/:id/trigger-call` → 429 + pesan upgrade.
- Batasan disadari: check-then-act tidak atomik (dua request konkuren
  bisa lolos) — rate limiter 10/menit menjadi backstop; penegakan atomik
  butuh tabel counter + transaksi.

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
   - `CALLE_WEBHOOK_SECRET` — nilai acak (mis. `openssl rand -hex 32`),
     dan **konfigurasi webhook CALL-E** harus mengirim header
     `x-calle-signature` berisi HMAC-SHA256(raw body) dengan secret yang
     sama. Tanpa ini endpoint webhook CALL-E menolak semua event (503)
     **by design** — server menampilkan warning saat boot.
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
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/api/webhooks/calle -d '{}'   # → 401 (fail-closed)
```
