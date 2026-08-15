# Deployment & Setup Layanan

## 1. Neon — database + Neon Auth

1. Buat project di [Neon Console](https://console.neon.tech) → copy **pooled connection string**
   ke `DATABASE_URL` (`.env`).
2. Aktifkan **Auth** (Neon Console → Project → Auth) → dapatkan `NEON_AUTH_URL`
   (contoh `https://ep-xxx.neon.tech/neondb/auth`).
   - Neon otomatis membuat schema `neon_auth` (user/session/account/verification).
   - Jangan migrasikan schema tersebut — definisi di `packages/database/src/schema.ts`
     hanya referensi FK. Gunakan `pnpm db:pull` untuk sinkronisasi definisi.
3. Migrasi tabel aplikasi: `pnpm db:migrate` (review hasil `db:generate` dulu —
   hapus bagian DDL `neon_auth` dari SQL).
4. *(Opsional)* Branch DB untuk preview/CI otomatis mewarisi data auth — fitur unggulan Neon Auth.

## 2. API — Railway (atau Fly.io / Render)

### Railway (direkomendasikan, file config sudah ada)

1. Buat project baru → **Deploy from GitHub** → pilih repo, root dir `oriole`.
2. `railway.json` sudah terdeteksi (Dockerfile). Tambahkan env vars:
   `DATABASE_URL`, `NEON_AUTH_URL`, `PADDLE_ENV`, `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`,
   `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`, `RESEND_API_KEY`, `VAPI_API_KEY`,
   `VAPI_PHONE_NUMBER_ID`, `VAPI_WEBHOOK_SECRET`,
   `APP_URL` (URL web), `NODE_ENV=production`.
3. Healthcheck otomatis ke `/api/health` (terkonfigurasi di `railway.json`).

### Fly.io

```bash
cd apps/api
fly launch   # pakai fly.toml yang disediakan
fly secrets set DATABASE_URL=... NEON_AUTH_URL=... # dst
fly deploy
```

### Render

- Web Service → root dir `oriole`, Dockerfile `apps/api/Dockerfile`, port `3000`.
- Set env vars yang sama seperti di atas.

## 3. Frontend — Cloudflare Pages

1. New project → hubungkan repo → **Production branch** pilih `main`.
2. Build settings:
   - Build command: `pnpm install && pnpm --filter @oriole/web build`
   - Output directory: `apps/web/dist`
   - Framework preset: **None** (konfigurasi manual di atas).
3. Environment variables:
   - `VITE_API_URL=https://<api-domain>` (mis. `https://oriole-api.up.railway.app`).
   - `VITE_NEON_AUTH_URL=<NEON_AUTH_URL>`.
4. *(Opsional)* `wrangler.toml` disertakan untuk deploy via `wrangler pages deploy`.

> Catatan: kustomisasi output dir per-workspace membutuhkan `apps/web` sebagai output —
> jika Pages menyulitkan, build di CI lalu upload `dist` (lihat workflow CI).

## 4. Paddle (sandbox dulu)

1. Daftar [Paddle Sandbox](https://sandbox-vendors.paddle.com) → Developer tools.
2. `PADDLE_API_KEY` (private key sandbox), `PADDLE_CLIENT_TOKEN` (untuk checkout frontend).
3. **Notifications**: buat endpoint secret → `PADDLE_WEBHOOK_SECRET`.
   Tambahkan webhook URL `https://<api-domain>/api/webhooks/paddle` (events subscription.*).
4. Saat membuat checkout dari app, kirim `custom_data: { user_id }` agar sinkronisasi
   subscription (fungsi Inngest) bisa memetakan ke user lokal.

## 5. Inngest

1. Buat app di [Inngest Cloud](https://www.inngest.com) → salin `INNGEST_EVENT_KEY`
   dan `INNGEST_SIGNING_KEY` ke env API.
2. Serve URL di dashboard Inngest → `https://<api-domain>/api/inngest`.
3. Lokal: `npx inngest-cli dev` (tidak butuh key).

## 6. Resend

1. Buat API key → `RESEND_API_KEY`.
2. Verifikasi domain untuk `brand.emailFrom` (`packages/config/src/brand.ts`).
   Untuk tes awal boleh pakai `onboarding@resend.dev`.

## 7. Vapi (voice AI)

1. Buat akun di [dashboard.vapi.ai](https://dashboard.vapi.ai) → API Keys → `VAPI_API_KEY`.
2. **Phone Numbers** → pilih/buat nomor untuk panggilan keluar → `VAPI_PHONE_NUMBER_ID`
   (nomor gratis Vapi hanya area code US; untuk internasional impor nomor Twilio/Telnyx —
   lihat bagian Telnyx di bawah).
3. `VAPI_WEBHOOK_SECRET` — nilai acak (mis. `openssl rand -hex 32`). Dikirim Vapi
   sebagai header `Authorization: Bearer <secret>` lewat `assistant.server.headers`
   (dikonfigurasi otomatis di kode `services/vapi.ts` — tidak perlu setup credential
   di dashboard). Webhook masuk di `https://<api-domain>/api/webhooks/vapi`.
4. *(Opsional)* Sesuaikan `VAPI_MODEL` (default `gpt-4o-mini`) & `VAPI_VOICE_ID`
   (default ElevenLabs `cgSgspJ2msm6clMCkdW9`) di env.

> Catatan: asisten dibuat **transient per panggilan** dari prompt goal — tidak ada
> asisten yang perlu dibuat manual di dashboard Vapi.

### 7a. Telnyx (BYO nomor internasional untuk Vapi)

Runtime API **tidak butuh Telnyx** — panggilan tetap lewat `VAPI_PHONE_NUMBER_ID`;
Telnyx hanya penyedia nomor di balik layar (diimpor ke Vapi sebagai BYO). Alur
resmi (Vapi + Telnyx): buat kredensial Telnyx di Vapi sekali, impor nomor, lalu
aktifkan panggilan keluar lewat Outbound Voice Profile.

**Setup otomatis (sebagian):**

1. Portal Telnyx → buat API key v2 **dedicated untuk Vapi** → `TELNYX_API_KEY`.
2. Dashboard Vapi → **Keys** → buat kredensial **Telnyx** (tempel API key itu)
   → salin id kredensial → `VAPI_TELNYX_CREDENTIAL_ID`. *(Langkah manual satu
   kali — payload kredensial tidak diekspos SDK Vapi, jadi tidak diautomasi.)*
3. Jalankan (idempotent — tidak membeli nomor dua kali; `--dry-run` untuk uji):

   ```bash
   pnpm --filter @oriole/api setup:telnyx --country ID [--area-code 21] [--number +62…] [--dry-run]
   ```

   Script mencari & membeli nomor voice-capable (bila `--number` tidak diisi),
   mendaftarkannya ke Vapi (`provider: telnyx`), lalu mencetak
   `VAPI_PHONE_NUMBER_ID` yang harus disetel di env.
4. **Manual terakhir (sekali):** Portal Telnyx → **Outbound Voice Profiles** →
   enable destinasi (mis. ID) → tambahkan koneksi yang dipakai Vapi ke profil.
   Tanpa ini panggilan keluar gagal.
5. Cek status kapan saja: `pnpm --filter @oriole/api telnyx:status`.
6. **Per-workspace:** setelah nomor terdaftar, setiap bisnis bisa memilih
   nomor keluar di halaman **Integrations → Voice AI calls** (tanpa kredensial
   — cukup pilih nomor; tersimpan di `workspace_integrations` tipe `vapi`).
   Tanpa pilihan, panggilan memakai default server (`VAPI_PHONE_NUMBER_ID`).

Keamanan: `TELNYX_API_KEY` server-only (dipakai script, bukan runtime); jangan
commit. Rotasi = ganti key di Telnyx + update kredensial di dashboard Vapi.

### 7b. Bring your own carrier (BYOC) — per-workspace

Fase-2 di balik kartu **Integrations → Voice AI calls** (tab
**"Bring your own carrier"**). Workspace yang punya akun Telnyx sendiri
menempel API key mereka (portal.telnyx.com → API Keys) dan menyiapkan nomor
mereka sendiri — kredensial Telnyx dibuat **di sisi Vapi** oleh operator:

1. **Search** — backend memvalidasi key (daftar nomor milik akun; key salah
   → 401) dan menampilkan nomor yang sudah dimiliki + tersedia untuk dibeli
   (read-only, tidak ada pembelian).
2. **Connect** — backend (idempotent, aman dijalankan ulang):
   - Membuat **kredensial Telnyx di akun Vapi operator** (`POST /credential`)
     dengan API key workspace. Endpoint tidak ada di SDK resmi — dipanggil via
     passthrough `vapi.fetch()` (`services/vapi-credential.ts`). Credential
     lama diadopsi by nama (`oriole-byoc-<workspaceId>`), jadi retry tidak
     menggandakan credential.
   - Membeli nomor pilihan di akun Telnyx workspace (hanya bila belum dimiliki;
     tidak pernah beli dua kali).
   - Mendaftarkan nomor ke Vapi (`provider: telnyx` + credential itu).
   - Menyimpan pilihan (`mode: 'byoc'`) di `workspace_integrations`.

Setelah connect, panggilan keluar workspace dialukan lewat nomor & akun
Telnyx **mereka sendiri** — biaya nomor/telco ditanggung workspace (lewat
akun Telnyx mereka), biaya platform Vapi + LLM/TTS tetap milik operator.

**Keamanan BYOC:** API key Telnyx workspace hanya dipakai SELAMA request
(validasi + membuat credential di Vapi) — **tidak pernah disimpan** di DB.
Vapi memegang key (dibutuhkan untuk dial); DB hanya menyimpan referensi
non-secret (`vapiPhoneNumberId`, `vapiCredentialId`, nomor, mode). Nomor BYOC
juga disaring dari picker "Server numbers" workspace lain (prefix nama
`oriole-byoc-`).

**Ops:** bila workspace mencabut API key di Telnyx, panggilan dari nomor itu
gagal — update kredensial di dashboard Vapi / hubungi operator. Disconnect di
kartu mengembalikan ke default server (`VAPI_PHONE_NUMBER_ID`).

## Checklist produksi

- [ ] Production secrets ter-set & dirotasi
- [ ] Database production + backup & restore teruji
- [ ] Paddle production keys + webhook terverifikasi
- [ ] Inngest serving URL terverifikasi (signing key production)
- [ ] Domain email Resend terverifikasi (SPF/DKIM)
- [ ] `APP_URL` / CORS di API mengarah ke domain web production
- [ ] Migration diterapkan (`pnpm db:migrate`)
- [ ] CI hijau (typecheck + test + build)
- [ ] SSL & custom domain untuk web (Pages) dan api
