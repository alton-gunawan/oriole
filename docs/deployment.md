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
   `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`, `RESEND_API_KEY`, `CALLE_API_KEY`, `CALLE_BASE_URL`,
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

## 7. CALL-E

1. Buat API key di [CALL-E Developer](https://docs.heycall-e.com/) → `CALLE_API_KEY`.
2. Tambahkan webhook endpoint di dashboard CALL-E →
   `https://<api-domain>/api/webhooks/calle`.
3. Event dikirim tanpa signature — idempotency ditangani server via `CALL-E-Event-Id` / `body.id`.

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
