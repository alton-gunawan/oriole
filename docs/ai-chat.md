# AI Chat di WhatsApp — Rencana Integrasi (LLM Q&A + Handoff ke Inbox)

Dokumen rencana ini mengusulkan integrasi LLM ke pipeline WhatsApp Oriole agar
bot bisa **menjawab pertanyaan layanan / harga / jam buka / lokasi** secara
otomatis, dengan **handoff otomatis ke unified inbox** saat AI tidak yakin.
Ini adalah *rencana* — status implementasi ada di bagian akhir.

Dasar keputusan kunci diambil dari fakta codebase (`apps/api/src/lib/whatsapp-handler.ts`,
`docs/messaging.md`, `packages/database/src/schema.ts`) dan riset vendor (Anthropic,
OpenAI, 360dialog webhook constraints).

---

## 1. Tujuan & non-tujuan

**Tujuan (scope MVP):**

- Customer bertanya lewat WhatsApp: layanan, harga, jam buka, lokasi, dan
  pertanyaan umum lain → bot menjawab dari **knowledge base workspace**
  (bukan jawaban bebas/halusinasi).
- Saat AI tidak yakin / di luar knowledge base / pertanyaan sensitif → **handoff
  otomatis ke staf** lewat mekanisme `needsAttention` yang sudah ada (staff lihat
  di unified inbox, balas dari web).
- Menghormati seluruh pipeline yang ada: opt-out, dedup idempotensi,
  provider-aware send (360dialog & WAHA), pencatatan pesan ke inbox.

**Non-tujuan (di luar MVP):**

- AI **tidak** membuat/mengubah booking langsung (alur booking tetap lewat
  tautan form / tombol — sudah ada).
- AI **tidak** menggantikan reminder template WhatsApp (di luar 24h window tetap
  template; AI hanya aktif saat customer *menulis duluan* → dalam window).
- Bukan RAG penuh atas dokumen; knowledge base MVP berupa teks terstruktur +
  FAQ yang dikelola owner.
- Tidak menjawab di Telegram/email dulu (rencana ini WhatsApp; arsitektur
  dibuat agar bisa diperluas).

---

## 2. Alur sekarang vs usulan

### Sekarang (state machine `applyInboundIntent` di whatsapp-handler.ts)

```
pesan masuk → parse intent
  ├─ opt-out            → matikan channel, tutup percakapan
  ├─ confirm/cancel/reschedule → handleBookingAction (tombol/keyword)
  ├─ booking-request    → kirim tautan form (Google Form/Tally)
  └─ text (bebas)       → re-send reminder (kalau ada booking aktif)
                         → markNeedsAttention()  ← SEMUA teks bebas ke staf
                         → renderGenericReply()  ("Maaf, ... staf akan menghubungi")
```

Teks bebas **selalu** berakhir di `needsAttention` — staf harus menjawab semua,
termasuk "jam bukanya kapan?" yang seharusnya bisa otomatis.

### Usulan

```
text (bebas) → cek: AI aktif untuk workspace? knowledge base terisi?
  ├─ tidak → (perilaku lama) markNeedsAttention + renderGenericReply
  └─ ya   → panggil LLM (sinkron, timeout ketat, lihat §6)
             ├─ jawab dari knowledge base (confidence ≥ 0.8)
             │    → balas jawaban AI (text biasa, provider-aware) + catat ke inbox
             ├─ yakin sebagian (0.5–0.8) → klarifikasi 1 langkah (opsional fase 2)
             └─ tidak yakin (< 0.5) / butuh manusia / di luar KB
                  → markNeedsAttention() + renderAiHandoffReply()
                  → staff balas dari inbox (jalur POST /api/inbox/:id/reply tetap)
```

---

## 3. Posisi di state machine (file yang disentuh)

Sisipan **satu titik** di `applyInboundIntent` (`apps/api/src/lib/whatsapp-handler.ts`),
tepat sebelum blok `if (event.intent === 'text') { await markNeedsAttention(...) }`
terakhir:

```ts
// Pesan bebas: coba AI chat (Q&A knowledge base) bila aktif.
if (event.intent === 'text') {
  const aiReply = await tryAiChatReply(workspaceId, conversation, event);
  if (aiReply) return aiReply;            // dijawab AI / handoff sudah ditandai
  await markNeedsAttention(conversation.id);  // fallback perilaku lama
}
```

Urutan penting dipertahankan: opt-out → state `awaiting-time` → aksi booking →
`booking-request` → **AI text** → fallback `needsAttention`. Jadi customer yang
mengetik "mau booking" tetap dapat tautan form (bukan jawaban AI), dan yang
mengetik "batal" saat reschedule tetap membatalkan perubahan jadwal.

**File baru:**
- `apps/api/src/lib/ai-chat.ts` — orchestration LLM (prompt, call, parse,
  threshold, timeout) — semua logika AI terisolasi di sini.
- `apps/api/src/lib/ai-chat.test.ts` — unit test (mock HTTP Anthropic).

**File diubah:**
- `apps/api/src/lib/whatsapp-handler.ts` — sisipan di atas + impor.
- `packages/messaging/src/telegram/render.ts` (+ re-export di `whatsapp/render.ts`)
  — `renderAiHandoffReply()` (teks "saya hubungkan dengan tim kami…") dan
  `renderAiDisabledReply()` opsional.
- `packages/database/src/schema.ts` + migrasi — kolom knowledge base (§4).
- `packages/config/src/env.ts` — `AI_CHAT_API_KEY` (opsional) + `AI_CHAT_BASE_URL` / `AI_CHAT_MODEL` (default Groq free tier).
- `apps/api/src/routes/me.ts` (atau route baru `/api/settings/ai`) — PATCH
  knowledge base + toggle.
- `apps/web` — halaman/bagian pengaturan AI (edit KB, toggle on/off).

---

## 4. Knowledge base — penyimpanan data bisnis

Saat ini **tidak ada** kolom alamat/jam/layanan/harga di `workspaces`
(hanya `name`, `industry`, `templateCategory`, `avatarUrl`, dll). Perlu ditambah:

**Opsi A (rekomendasi MVP) — kolom di `workspaces`:**
```ts
aiEnabled: boolean('ai_enabled').default(false).notNull(),
aiKnowledge: jsonb('ai_knowledge').$type<AiKnowledge | null>(),
```
```ts
interface AiKnowledge {
  description: string;      // deskripsi singkat usaha (1-2 kalimat)
  services: string;         // layanan + harga, bebas format teks ("Cuci mobil 50rb …")
  hours: string;            // jam buka ("Sen–Sab 08.00–20.00")
  location: string;         // alamat + patokan / link maps
  faq: { q: string; a: string }[];  // FAQ tambahan
  policy: string;           // opsional: kebijakan lain (deposit, pembatalan)
}
```

Kenapa jsonb satu kolom: owner menulis sekali di UI pengaturan, isi prompt
LLM secara utuh; tidak perlu relasi/jumlah kolom tetap. Kecil, tanpa migrasi
relasional rumit.

**Opsi B (fase 2) — tabel `workspace_ai_faq`** untuk FAQ banyak + RAG ringan
(embeddings sederhana). Tidak perlu di MVP.

**UI:** Bagian "AI Chat" di halaman settings (apps/web): toggle aktif/nonaktif +
form knowledge base + pratinjau prompt yang akan dikirim. Default **mati**
(`aiEnabled=false`) — tidak ada perubahan perilaku sampai owner mengaktifkan.

---

## 5. LLM: provider, model, biaya

> **Update (Agt 2026):** implementasi memakai provider OpenAI-compatible
> gratis — **Groq Llama 3.3 70B** sebagai default (§5.1). Sub-bab ini
> adalah rencana awal (Anthropic, tool use) dan sudah digantikan §5.1.

**Rencana awal (tidak dipakai): Anthropic Claude — Messages API, tool use dengan `tool_choice` dipaksa.**
(`@anthropic-ai/sdk` — paket resmi, Node ESM, satu dependency.)

Alasan:
- **Satu panggilan, output terstruktur**: paksa satu tool `answer_inquiry`
  dengan `input_schema` berisi `{ answer, confidence, needsHuman, reason }`
  (`tool_choice: { type: 'tool', name: 'answer_inquiry' }`). Tidak perlu parsing
  JSON bebas; confidence & keputusan handoff keluar terstruktur.
- **Bahasa Indonesia** kuat untuk teks santai (casual, campur slang).
- **Latensi & biaya cocok untuk Q&A pendek** (tabel di bawah).

| Model | Input / 1M tok | Output / 1M tok | Latensi pesan pendek | Cocok |
|---|---|---|---|---|
| `claude-haiku-4-5` | $1.00 | $5.00 | <300–500 ms | **MVP (rekomendasi)** |
| `claude-sonnet-5` | $3.00 | $15.00 | 0.6–1.2 s | Cadangan bila butuh nalar lebih |

Perkiraan biaya: 1 percakapan Q&A ≈ 600 token input (system prompt + KB +
riwayat) + 150 token output → **±$0.00135 / tanya-jawab** dengan Haiku
(≈$1.35 per 1.000 percakapan). Dengan `aiEnabled` default mati + cap
opsional per workspace, biaya terkontrol.

Env baru (`packages/config/src/env.ts`, semuanya opsional — AI mati tanpa key):
```env
AI_CHAT_API_KEY=
AI_CHAT_BASE_URL=https://api.groq.com/openai/v1   # default Groq (lihat §5.1)
AI_CHAT_MODEL=llama-3.3-70b-versatile
```

**Fallback jika API gagal / timeout / tanpa key:** perilaku lama
(`markNeedsAttention` + pesan generik) — AI tidak boleh membuat WhatsApp
error.

---

## 5.1 Opsi gratis (tanpa biaya API)

Ya — beberapa provider menawarkan **free tier permanen** (tanpa kartu kredit)
yang cukup untuk Q&A WhatsApp skala kecil-menengah (riset 2026):

| Provider | Model contoh | Kuota gratis | RPM | Data dipakai training? | OpenAI-compatible |
|---|---|---|---|---|---|
| **Groq** | Llama 3.3 70B, Llama 4, Qwen | 1.000 req/hari + **100K token/hari** | 30 | Tidak | ✅ |
| **Cerebras** | gpt-oss-120b, GLM-4.7, Gemma 4 31B | ~1 jt token/hari (perlu aktivasi di tab Billing) | 30 | Tidak | ✅ |
| **Fireworks AI** | Llama, DeepSeek, Qwen | ~1 jt token/hari | tinggi | Tidak | ✅ |
| **Google AI Studio** | Gemini 2.5 Flash / Flash-Lite | **1.500 req/hari** (flash+flash-lite berbagi) | 10–15 | Ya (di luar EU/UK/EEA) | Parsial |
| **Mistral (Experiment)** | Mistral Small/Large, Codestral | ~1 M token/bulan | variabel | Ya (wajib opt-in) | ✅ |
| **OpenRouter** | 20+ model `:free` | 50 req/hari; 1.000/hari dgn top-up $10 sekali | 20 | Tidak | ✅ |
| **Cloudflare Workers AI** | 20+ model | ~10K req/hari | tinggi | Tidak | Parsial |
| ~~GitHub Models~~ | — | **Retired 30 Jul 2026** (tidak tersedia lagi) | — | — | — |

**Rekomendasi gratis (default implementasi): Groq (Llama 3.3 70B).**

> **Migrasi selesai (Agt 2026):** default di `env.ts` = Groq
> (`AI_CHAT_BASE_URL=https://api.groq.com/openai/v1`,
> `AI_CHAT_MODEL=llama-3.3-70b-versatile`). Alasan: tanpa kartu kredit,
> langsung aktif, limit resmi & jelas (100K token/hari; terukur ±620
> token/jawaban → ≈160 jawaban AI/hari). Catatan: Cerebras sempat dicoba tapi
> akun butuh verifikasi pembayaran di tab Billing (HTTP 402) dan
> llama-3.3-70b deprecated di sana — Groq dipilih agar bot langsung jalan
> tanpa hambatan; pindah provider kapan saja = ganti 3 env (semua
> OpenAI-compatible).
- Cepat (~276–394 token/detik) → nyaman dalam budget 8 detik webhook (§6,
  termasuk retry terbatas + hormati header retry-after saat 429).
- OpenAI-compatible → output terstruktur `{answer, confidence, needsHuman}`
  lewat **JSON mode** (`response_format`) — pengganti tool_choice §5, hasil sama.
- Tidak melatih dengan data customer (beda Mistral Experiment & Google non-EU)
  — penting karena isi percakapan customer dikirim ke provider.
- Tanpa kartu kredit; kalau kuota habis, jalur handoff `needsAttention` yang
  sudah ada tetap jalan (bot tidak error).

**Cadangan & failover:** OpenRouter (satu key untuk 20+ model gratis, failover
otomatis, top-up $10 sekali → 1.000 req/hari) atau Fireworks AI (1 jt
token/hari). Catatan: GitHub Models **sudah retired (30 Jul 2026)** — bukan
lagi opsi. Karena semua OpenAI-compatible, perpindahan antar-provider = ganti
`base_url`/`model`/`key` saja.

**Trade-off free tier:** tidak ada SLA, limit bisa diubah sewaktu-waktu
(contoh nyata: Gemini dipangkas drastis Des 2025), sebagian provider memakai
data untuk training. Saat trafik naik, migrasi ke paid Groq/OpenRouter cukup
ganti key — tanpa perubahan kode.

**Dampak ke rencana ini:** §3/§5 berubah dari "SDK Anthropic + tool_choice"
menjadi "SDK OpenAI-compatible + `base_url` per provider + JSON mode". Logika
inti `ai-chat.ts` (prompt builder, threshold §7, fallback, timeout) tidak
berubah; env jadi `AI_CHAT_BASE_URL` / `AI_CHAT_API_KEY` / `AI_CHAT_MODEL`
(bukan `ANTHROPIC_API_KEY`). Toggle `aiEnabled` default mati tetap berlaku —
free tier hanya menghapus biaya, tidak mengubah perilaku. (Catatan: ini untuk
biaya LLM; biaya saluran WhatsApp 360dialog terpisah dan tetap ada.)

---

## 6. Latensi & sinkron-vs-asinkron (batasan webhook)

360dialog/Meta mengharapkan webhook dibalas cepat; praktek aman: **HTTP 200
segera, kerja berat di background**. Namun handler WhatsApp saat ini **sinkron**
dan mencatat balasan dengan dedup `replyToWamid` sebelum kirim.

**Pendekatan MVP: sinkron dengan budget keras (8 detik) + retry terbatas.**

- `tryAiChatReply` memanggil LLM dalam budget 8 s (`AbortController`);
  kegagalan transien (429 rate limit, 5xx, network/timeout) dicoba ulang
  maks 3× dengan jeda 300/700 ms — semua dalam budget, webhook tidak molor.
- Karena record-outbound+dedup sudah dilakukan *sebelum* send (pola yang sama
  dengan balasan tombol), retry Inngest/webhook tidak akan mengirim duplikat.
- 8 detik jauh di bawah batas 360dialog yang umumnya toleran di dalam 24h
  window; jika khawatir, fase 2 pindah ke pipeline Inngest:
  webhook → catat + `emit 'ai/chat.requested'` → fungsi Inngest panggil LLM →
  kirim → catat (mirip `onTallySubmission`). Arsitektur `ai-chat.ts`
  dipisah agar perpindahan ini hanya mengubah pemanggil, bukan logika.

**Rekomendasi fase 2 (dokumentasi saja di rencana ini):** pindah ke Inngest
bila trafik tinggi / ingin "typing…" indicator; `ai-chat.ts` sudah diisolasi.

---

## 7. Confidence & handoff — keputusan otomatis

LLM mengembalikan (via tool, schema ketat):

```json
{
  "answer": "Jam buka kami Senin–Sabtu 08.00–20.00.",
  "confidence": 0.93,
  "needsHuman": false,
  "reason": "answered-from-kb"
}
```

Threshold (`apps/api/src/lib/ai-chat.ts`, konstanta mudah disesuaikan):

| Kondisi | Aksi |
|---|---|
| `confidence ≥ 0.8` dan `needsHuman == false` | **Kirim `answer`** ke customer; catat sebagai pesan AI di inbox (`metadata: { ai: true }`). `needsAttention` TIDAK disetel. |
| `0.5 ≤ confidence < 0.8` | **Fase 2**: kirim pertanyaan klarifikasi 1 langkah (state `{ step: 'ai-clarify' }`). MVP: treat sebagai handoff. |
| `confidence < 0.5`, `needsHuman == true`, `reason == 'out-of-kb'` / berbahaya / dll | **Handoff**: `markNeedsAttention()` + `renderAiHandoffReply()`; staff balas dari inbox. |

**Prompt (system) — isi yang dijamin stabil:**
- Identitas: nama usaha, industri, template category.
- Knowledge base utuh dari §4 + FAQ.
- **Aturan keras di system prompt:**
  1. Jawab HANYA dari knowledge base; jangan mengarang harga/lokasi.
  2. Bila tidak tahu → `confidence` rendah + `reason: 'out-of-kb'` (jangan halusinasi).
  3. Bila customer minta booking → jangan buat booking; arahkan ke form
     (jawaban teks cukup: "Silakan isi formulir…", tautan form dipakai alur
     `booking-request` yang sudah ada).
  4. Jangan pernah menyebut bahwa Anda AI / model tertentu (opsi; bisa diubah
     per bisnis).
  5. Bahasa: Indonesia santai tapi sopan; singkat (< 3 kalimat bila bisa).
- **Konteks per pesan:** 8–10 pesan terakhir dari tabel `messages` (bukan
  seluruh riwayat) + nama customer + info booking aktif (judul/jam) bila ada
  (`conversation.bookingId` → lookup `bookings`).

**Keamanan dasar:**
- Input customer + KB dikirim ke Anthropic — KB adalah data yang owner sendiri
  tulis; tetap catat di dokumen keamanan (§9) + opsi `ANTHROPIC_API_KEY` per
  environment, bukan per-workspace (MVP single-key; multi-key per-workspace
  bisa jadi fase lanjutan untuk BYO key).
- Opt-out dihormati: alur opt-out tetap dieksekusi SEBELUM AI.
- Jangan kirim data sensitif yang tidak perlu: konteks pesan dibatasi 10 pesan,
  tanpa nomor/email kecuali ada di pesan customer sendiri.

---

## 8. Implementasi bertahap (milestones)

**Fase 1 — MVP (intinya rencana ini):**
1. Schema: `aiEnabled` + `aiKnowledge` di `workspaces` + migrasi.
2. `env.ts`: `AI_CHAT_API_KEY` (opsional; tanpa key AI mati) + `AI_CHAT_BASE_URL` / `AI_CHAT_MODEL` (default Groq).
3. `apps/api/src/lib/ai-chat.ts`: prompt builder, call LLM OpenAI-compatible
   (JSON mode, budget 8 s + retry terbatas), parse + threshold; fallback aman.
4. Sisipan di `applyInboundIntent` (WhatsApp).
5. Renderer `renderAiHandoffReply` (+ re-export).
6. Route PATCH settings AI (toggle + KB) + halaman web sederhana.
7. `ai-chat.test.ts` (mock fetch): jawab-dari-KB, handoff low-confidence,
   out-of-kb, timeout, tanpa key → fallback.
8. Update `docs/messaging.md` §8 + dokumen ini (status).

**Fase 2 (setelah MVP stabil):**
- Klarifikasi 1 langkah untuk confidence menengah (state `ai-clarify`).
- Pindah ke Inngest async + typing indicator.
- Ekstensi ke Telegram (handler `telegram-handler.ts` punya titik yang sama).
- Analitik AI: berapa % ter-handle otomatis vs handoff (`analytics.ts` +
  dashboard).

**Fase 3 (opsional):**
- RAG ringan atas FAQ banyak / dokumen upload.
- BYO API key per workspace (pakai providerConfig pola `workspace_integrations`).

---

## 9. Keamanan & kepatuhan (checklist produksi)

- [x] `AI_CHAT_API_KEY` hanya di env server; tidak pernah ke frontend.
- [x] Knowledge base jsonb tidak diekspos mentah ke frontend selain di halaman
      settings pemilik (route sudah auth workspace).
- [ ] Data customer yang dikirim ke provider LLM diminimalkan (10 pesan terakhir,
      tanpa data yang tidak perlu). Catat pemrosesan data pihak ketiga di
      dokumentasi privasi.
- [ ] Opt-out & `isOptedIn=false` → AI tidak pernah membalas (blokir lebih awal).
- [ ] Dedup balasan AI memakai pola `metadata.replyToWamid` yang sama.
- [x] Timeout & error LLM → fallback ke perilaku lama (handoff), bukan 500;
      retry terbatas (429/5xx/network, maks 3×) dalam budget 8 s.
- [ ] `aiEnabled` default false — tidak ada perubahan perilaku tanpa persetujuan
      owner.
- [ ] System prompt menyuruh model TIDAK mengarang harga/lokasi/jam (anti
      halusinasi), ditambah confidence gate di sisi kode.

---

## 10. Biaya, risiko, & keputusan terbuka

**Biaya (estimasi):**
- Haiku 4.5: ±$0.00135/tanya-jawab. 1.000 Q&A/bulan ≈ $1.35; 10.000 ≈ $13.50.
- Cap per workspace (mis. 200 Q&A/hari) mudah ditambahkan di `ai-chat.ts`
  dengan hitung pesan AI hari itu — disarankan di fase 2.

**Risiko & mitigasi:**
| Risiko | Mitigasi |
|---|---|
| Halusinasi harga/lokasi | System prompt + knowledge base eksplisit + confidence gate + handoff |
| Webhook timeout | Timeout 8 s + fallback; fase 2 pindah Inngest |
| Biaya tak terkontrol | Toggle default mati + (fase 2) cap harian |
| Jawaban AI tidak cocok tone bisnis | KB & prompt diedit owner di settings |
| Jawaban AI salah tapi confidence tinggi | FAQ diverifikasi owner; log jawaban AI di inbox (`metadata.ai`) untuk audit |

**Keputusan terbuka (minta masukan owner/stakeholder):**
1. ~~Haiku 4.5 berbayar vs Groq gratis~~ → **Diputuskan: Groq Llama 3.3 70B
   gratis (Agt 2026, migrasi balik dari Cerebras)** — tanpa kartu kredit,
   langsung aktif; Cerebras butuh verifikasi pembayaran (§5.1).
2. Teks handoff: "Tim kami akan segera menghubungi Anda" vs menyebut AI?
3. Apakah AI boleh langsung meminta booking lewat form (bukan hanya arahkan)?
4. Simpan knowledge base per-workspace di jsonb (Opsi A) atau mulai tabel FAQ (Opsi B)?

---

## Status

- [x] Riset vendor & batasan webhook (2026-08-08)
- [x] Analisis titik sisip di codebase (whatsapp-handler.ts, schema, inbox)
- [x] Dokumen rencana ini
- [x] Fase 1 langkah 1: schema `aiEnabled` + `aiKnowledge` (jsonb) + migrasi `0012` (§4 Opsi A)
- [x] Fase 1 langkah 6: PATCH `/me/workspaces/:id` (toggle + KB, clear via null) + test
- [x] Fase 1 langkah 6: UI "Pengaturan chat AI" di WorkspaceSettingsPage (toggle + form KB/FAQ)
- [x] Fase 1 langkah 3: modul `ai-chat.ts` — prompt builder, JSON mode (Groq default), threshold 0.8, budget 8s + retry terbatas, fallback aman + test
- [x] Fase 1 langkah 4: sisipan `tryAiChatReply` di `applyInboundIntent` (sebelum handoff; reminder booking tetap prioritas) + dedup `replyToWamid` via jsonb path + test integrasi handler (6 kasus: jawab AI, handoff, tanpa key, KB kosong, prioritas reminder, dedup retry)
- [x] Fase 1 langkah 5: `renderAiHandoffReply` + `renderAiDisabledReply` (+ re-export) + test
- [x] Migrasi default LLM **balik ke Groq** (llama-3.3-70b-versatile, tanpa kartu kredit): env default + `.env.example` + retry terbatas 429/5xx/network dalam budget 8 s + hormati header retry-after + test (Agt 2026)
- [x] Cerebras dievaluasi & ditunda: akun butuh verifikasi pembayaran di tab Billing (402) dan llama-3.3-70b deprecated — tetap bisa dipakai kapan saja via 3 env (OpenAI-compatible)
- [x] Fase 1 langkah 7: update `docs/messaging.md` §8 — selesai di langkah berikutnya bila perlu

---

## Fase 4 — AI Booking Agent (RAG + booking tools + Decision Engine)

> **Selesai (Agt 2026).** AI berubah dari sekadar Q&A knowledge base menjadi
> **AI Booking Agent**: retrieval tenant-scoped (bukan seluruh KB tiap request),
> intent detection, tool/function calling untuk data & aksi booking live, state
> booking terstruktur, grounding sumber, dan Decision Engine multi-sinyal.
> Groq tetap LLM; fallback handoff & retry/timeout lama dipertahankan.

### Perubahan arsitektur

```
pesan → guards → retrieval tenant-scoped → phase 1 LLM + tools
     → eksekusi tool BACKEND (availability/booking live)
     → phase 2 LLM JSON mode (intent + answer + sources)
     → validasi skema backend → Decision Engine → balas AI / handoff
```

- **Retrieval (`ai-rag.ts`)**: chunk dari `ai_knowledge` + katalog `services`,
  ranking lexical (token overlap + boost tipe/keyword), HANYA konteks relevan
  yang dikirim. Tenant-scoped di semua query (`workspaceId = tenantId`).
  Tidak memakai pgvector/vector DB: Groq tidak punya endpoint embeddings dan
  menambah DB baru tanpa kebutuhan melanggar batasan arsitektur.
- **Intent + tools (`ai-tools.ts`)**: `get_available_slots`, `get_service`,
  `get_staff_availability`, `get_customer_bookings`, `create_booking`,
  `reschedule_booking`, `cancel_booking` — dieksekusi backend (mesin slot +
  pipeline booking yang sama dengan route /bookings & vapi-inbound). LLM tidak
  pernah mengarang hasil; phone customer disuntikkan server-side (wa_id).
- **State booking (`conversations.state.ai`)**: intent, serviceId, tanggal,
  waktu, nama — disimpan terstruktur, tidak menebak ulang dari history chat.
- **Validasi output (`ai-schema.ts`)**: zod ketat — intent enum, confidence 0..1,
  struktur sources, tanpa kunci asing. Gagal → handoff.
- **Decision Engine (`ai-decision.ts`)**: confidence HANYA sinyal sekunder.
  Keputusan = retrieval relevance + grounding sumber + intent + hasil tool +
  level risiko + confidence. Source fiktif / tool gagal / tak ada konteks →
  handoff — termasuk jawaban confidence 0.97 yang mengarang harga.
- **Logging (`ai-log.ts`)**: satu baris JSON metadata-safe (requestId, tenant,
  intent, retrievalCount, tool, model, latency, handoff) — tanpa plaintext
  pesan customer / key.
- **Tool calling Groq**: phase 1 dengan `tools` (tanpa JSON mode — Groq
  menolak kombinasi keduanya), phase 2 JSON mode. Budget 8 s dibagi antar
  fase; retry 429/5xx/network tetap, hormati retry-after, tanpa retry 4xx.

### Status

- [x] Retrieval tenant-scoped + test (anti cross-tenant, relevansi, empty)
- [x] Intent detection (11 intent) + routing (RAG vs tools vs handoff)
- [x] 7 booking tools + eksekusi backend + test (create/reschedule/cancel/fail)
- [x] State booking terstruktur di `conversations.state.ai`
- [x] Prompt berlapis (instruksi / knowledge relevan / booking state / tool results)
- [x] Validasi skema backend + Decision Engine + test (fake source, ungrounded,
      tool gagal, confidence out-of-range, contradiction, tenant booking)
- [x] Source grounding (source fiktif → handoff; booking id fiktif → handoff)
- [x] Logging metadata-safe
- [x] Fallback lama dipertahankan: semua kegagalan → null → handoff staf
- [x] `pnpm --filter @oriole/api typecheck` + 939 test lulus (termasuk test lama)

Catatan scope: Telegram belum di-wire ke pipeline AI (di luar ruang lingkup);
WhatsApp tetap satu-satunya channel AI. `booking-request` (keyword) tetap
mengarah ke tautan form — alur existing tidak diubah.
