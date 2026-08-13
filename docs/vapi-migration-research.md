# HeyCall-e → VAPI Migration Research

**Date:** August 11, 2026  
**Status:** ✅ Research complete — **migration shipped** (Aug 11, 2026). Lihat bagian 11 untuk keputusan final & deviasi dari dokumen ini.

---

## 1. Current HeyCall-e Integration — What Exists Today

### SDK & Service
- **Package:** `@call-e/calle` v0.6.0 (TypeScript SDK)
- **Service file:** `apps/api/src/services/calle.ts` — singleton `CalleClient`
- **Base URL:** `https://api.heycall-e.com`
- **Auth:** `CALLE_API_KEY` env var

### How Calls Are Made
The HeyCall-e SDK exposes `calle.calls.create()` with this shape:

```ts
calle.calls.create({
  task: config.prompt,                          // System prompt / instructions
  recipient: {
    phone: booking.phone,                       // E.164 phone number
    locale: 'en-US' | 'id-ID',                 // Language
  },
  resultSchema: config.resultSchema,            // Structured output schema
  metadata: { bookingId, workspaceId, userId, goalType, source },  // Passthrough metadata
  webhookUrl: `${env.API_URL}/api/webhooks/calle`,  // Where to POST results
}, {
  idempotencyKey: `booking:${bookingId}:${goalType}:${autoCallAt}`,  // Dedup key
});
```

### Where Calls Are Created (2 locations)
1. **Manual call** — `apps/api/src/routes/bookings.ts` (~line 890) — POST `/:id/trigger-call`
2. **Auto-call** — `apps/api/src/lib/auto-call.ts` (~line 117) — via Inngest `autoCallBooking`

### Webhook Inbound
- **Route:** `apps/api/src/routes/webhooks/calle.ts`
- **Endpoint:** `POST /api/webhooks/calle`
- **Signature:** `x-calle-signature` header = HMAC-SHA256(rawBody, `CALLE_WEBHOOK_SECRET`)
- **Idempotency:** `CALL-E-Event-Id` header / `body.id`
- **After verification:** queued to Inngest → `calle/event.received`

### Inngest Handler (`onCalleEvent`)
1. **Upsert** call record in `calle_calls` table (insert or update by `calle_call_id`)
2. **Complete linked booking** — if status is `completed`, mark booking `completed` + emit `booking.completed` event + outgoing webhooks + Slack

### Database: `calle_calls` Table
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `user_id` | uuid FK → auth.user | |
| `workspace_id` | uuid FK → workspaces | |
| `booking_id` | uuid FK → bookings | |
| `calle_call_id` | text UNIQUE | External ID from HeyCall-e |
| `phone` | text | E.164 number called |
| `task` | text | Prompt sent |
| `goal_type` | text | Audit trail |
| `status` | text | terminal status |
| `result` | jsonb | Webhook payload result |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

### Other References to CALL-E
- `bookings.calle_call_id` — column on bookings table linking to the call
- `apps/api/src/lib/calls.ts` — `extractCallSeconds()` helper
- `apps/api/src/lib/calle-types.ts` — TypeScript types for webhook payload
- `apps/api/src/lib/quota.ts` — monthly call quota enforcement
- `apps/api/src/lib/booking-goal.ts` — counts call attempts per booking
- `apps/api/src/lib/analytics.ts` — call status distribution
- `apps/api/src/routes/calls.ts` — GET list calls per user
- `apps/api/src/routes/billing.ts` — call history in billing
- `apps/web/src/i18n/` — "HeyCall-e AI" / "HeyCall AI" labels
- Skills: `invoice-exception-manager-briefing`, `deployment-approval-call`, `verify-contact-claim`, `outbound-call-skill-creator`, `call-reminder`

### Environment Variables
```
CALLE_API_KEY=calle_test_key
CALLE_BASE_URL=https://api.heycall-e.com
CALLE_WEBHOOK_SECRET=
```

---

## 2. VAPI Platform Overview

### What Vapi Is
Vapi is a developer platform for building **voice AI agents** that make and receive phone calls. It's a full-stack voice pipeline:
- **STT** (Deepgram, Google, AssemblyAI, etc.)
- **LLM** (OpenAI, Anthropic, Google, etc.)
- **TTS** (ElevenLabs, Cartesia, Azure, OpenAI, etc.)

### Key Differences from HeyCall-e

| Feature | HeyCall-e | VAPI |
|---------|-----------|------|
| **API model** | Single `calls.create()` with `task` prompt | Assistants + transcriber + model + voice pipeline |
| **Phone numbers** | Managed by HeyCall-e | BYO (Twilio, Telnyx, DIDWW) or free Vapi numbers (US only) |
| **Agent config** | Task prompt + result schema (opaque) | Full control: system prompt, model, voice, tools, behaviors |
| **Tool calling** | Not exposed | Rich function calling (custom tools, API request, code tools) |
| **Call events** | Single webhook after call ends | Multiple events: status-update, end-of-call-report, transcript, tool-calls, hang, etc. |
| **SDK** | `@call-e/calle` | `@vapi-ai/server-sdk` (TypeScript) + REST API |
| **Scheduled calls** | Handled client-side via Inngest sleep | Native `schedulePlan.earliestAt` in API |
| **Voicemail detection** | Opaque | Configurable voicemail tool |
| **Call transfer** | Not exposed | Built-in warm transfer, handoff tools, squads |
| **Structured output** | `resultSchema` | `structuredOutputs` with schema-defined extraction |
| **Pricing model** | Appears to be per-call | $0.05/min + provider costs (STT, LLM, TTS, phone) |
| **Multi-language** | `locale` parameter | Full multilingual support with auto-detection |
| **Web calls** | Not supported | Web SDK for browser-based voice calls |
| **Squads (multi-agent)** | Not supported | Multi-assistant orchestration with handoffs |

### VAPI Create Call API

```ts
POST https://api.vapi.ai/call
Authorization: Bearer <VAPI_API_KEY>

{
  "assistantId": "saved-assistant-id",     // or transient "assistant" object
  "phoneNumberId": "phone-number-id",      // your Vapi/Twilio number
  "customer": { "number": "+1234567890" }, // destination
  "schedulePlan": {                        // optional: schedule for later
    "earliestAt": "2026-08-12T10:00:00Z"
  }
}
```

### VAPI Webhook Events (Server URL)
Vapi sends POST requests to your configured server URL. Key event types:

| Event Type | When | Notes |
|-----------|------|-------|
| `status-update` | Status changes | `scheduled`, `queued`, `ringing`, `in-progress`, `ended` |
| `end-of-call-report` | Call ends | Full transcript, recording, messages, artifacts |
| `tool-calls` | Tool triggered | Requires synchronous response with results |
| `assistant-request` | Inbound call needs agent | Dynamic assistant selection |
| `transfer-destination-request` | Dynamic transfer needed | Return destination |
| `transcript` | Live transcript | Partial and final transcripts |
| `hang` | Call ends abruptly | Notification |
| `conversation-update` | Conversation history updated | Full message history |
| `knowledge-base-request` | Custom KB query | Return documents |
| `speech-update` | Assistant speaking | Status: started/stopped |
| `user-interrupted` | User barge-in | turnId for cancellation |

### VAPI Webhook Security
- Bearer token authentication (set in dashboard or API)
- Optional: HMAC signature verification (different from HeyCall-e's approach)
- Server URL configured per-assistant

### VAPI Assistants (Agent Configuration)
An assistant bundles:
```ts
{
  name: "Booking Reminder Agent",
  model: {
    provider: "openai",
    model: "gpt-4o",
    messages: [{ role: "system", content: "..." }],
    toolIds: ["tool-id-1", "tool-id-2"]
  },
  voice: {
    provider: "11labs",
    voiceId: "..."
  },
  firstMessage: "Hello, this is...",
  serverUrl: "https://api.yourapp.com/api/webhooks/vapi",
  serverMessages: ["end-of-call-report", "status-update", "tool-calls"],
  structuredOutputs: { ... },  // post-call data extraction
  endCallPhrases: ["goodbye", "bye"],
  maxDurationSeconds: 300,
}
```

### VAPI Custom Tools
Tools allow the AI agent to call your backend during a conversation:
```ts
{
  type: "function",
  function: {
    name: "get_booking_info",
    description: "Fetch booking details",
    parameters: {
      type: "object",
      properties: {
        bookingId: { type: "string" }
      },
      required: ["bookingId"]
    }
  },
  server: { url: "https://api.yourapp.com/api/vapi/tools/get-booking" }
}
```

### VAPI Phone Numbers
- **Free Vapi numbers:** US area codes only, up to 5 per account
- **Import from Twilio:** BYO number with STIR/SHAKEN
- **Import from Telnyx/DIDWW:** SIP trunking
- Phone number must be associated with an assistant for inbound handling

---

## 3. Migration Impact Assessment

### High-Impact Changes (Must Handle)

| Area | HeyCall-e | VAPI Migration Required |
|------|-----------|------------------------|
| **SDK** | `@call-e/calle` | `@vapi-ai/server-sdk` or raw REST calls |
| **Call creation** | `calle.calls.create()` | `vapi.calls.create()` with assistant + phone number |
| **Webhook route** | `/api/webhooks/calle` | `/api/webhooks/vapi` — different event structure |
| **Webhook signature** | `x-calle-signature` HMAC | VAPI bearer token auth (different model) |
| **Event structure** | Single payload with `data.callId/status/result` | Multiple event types (`status-update`, `end-of-call-report`, etc.) |
| **DB column** | `calle_call_id` / `calle_calls` table | Rename to `vapi_call_id` / `vapi_calls` or keep and alias |
| **Env vars** | `CALLE_*` | `VAPI_API_KEY`, `VAPI_PHONE_NUMBER_ID` |
| **Agent config** | Prompt-based (opaque) | Must create VAPI assistants with model/voice/prompt |

### Medium-Impact Changes

| Area | Impact |
|------|--------|
| **Phone number management** | Need VAPI phone number(s) — possibly import existing Twilio numbers |
| **Assistant lifecycle** | Must create/update VAPI assistants per workspace or globally |
| **Tool system** | Opportunity to add real-time tools (booking lookup, availability check) |
| **Call status tracking** | More granular statuses available (ringing, in-progress, etc.) |
| **Recording & transcripts** | VAPI provides full transcript + recording URLs |
| **Quota enforcement** | Same concept, different API |
| **Analytics** | More data available (duration, transcript, tool calls) |

### Low-Impact (Mostly Text Changes)

- i18n strings: "HeyCall-e AI" → "VAPI AI" / custom label
- Documentation references
- Test mock setup

---

## 4. Recommended Migration Approach

### Phase 1: Foundation (Core Service Swap)
1. **Add `@vapi-ai/server-sdk`** dependency, remove `@call-e/calle`
2. **Create `apps/api/src/services/vapi.ts`** — singleton VapiClient
3. **Rename env vars:** `CALLE_API_KEY` → `VAPI_API_KEY`, add `VAPI_PHONE_NUMBER_ID`
4. **Keep DB columns as-is** (`calle_call_id`, `calle_calls`) to avoid migration; alias in code

### Phase 2: Call Creation
1. **Rewrite `auto-call.ts`** — use `vapi.calls.create()` with assistant ID + phone number + customer
2. **Rewrite manual trigger** in `bookings.ts` — same pattern
3. **Decide on assistant strategy:**
   - Option A: Global assistant per goal type (3-5 saved assistants)
   - Option B: Transient assistants per call (more flexible, more API calls)
   - **Recommendation:** Option A (saved assistants) for cost efficiency and easier management

### Phase 3: Webhook Handling
1. **Create `/api/webhooks/vapi`** route
2. **Handle `end-of-call-report`** event → replaces current CALL-E webhook
3. **Map VAPI endedReason** → CALL-E status (e.g., `hangup` → `completed`, `assistant-error` → `failed`)
4. **Extract transcript, recording URL, duration** from `artifact`
5. **Handle `status-update`** events for real-time status tracking (optional enhancement)
6. **Update Inngest handler** to work with new event structure

### Phase 4: Cleanup
1. **Rename DB columns** via migration (optional — can be done later)
2. **Update all references** from `calle` to `vapi` naming
3. **Update i18n strings**
4. **Remove HeyCall-e env vars**
5. **Update skills** that reference CALL-E

---

## 5. Key Architectural Decisions Needed

### Decision 1: Assistant Strategy
**Question:** How do we map CALL-E's `task` prompt to VAPI assistants?

- CALL-E: each call gets a fresh `task` prompt
- VAPI: assistants have a fixed system prompt; tools provide dynamic context

**Options:**
- A) **Few saved assistants** (e.g., `booking-reminder`, `follow-up`, `no-show`) with different system prompts. Use **variables** (`{{bookingId}}`, `{{customerName}}`) to personalize.
- B) **Transient assistants** per call — pass full prompt as `assistant.model.messages[0].content`. Maximum flexibility but potentially more expensive.
- C) **Hybrid** — saved assistant + **server-side assistant-request** handler that dynamically selects/configures.

**Recommendation:** Option A (saved assistants) — cleaner, cheaper, easier to version and test. The existing `composeCallGoal()` can select the right assistant ID based on goal type.

### Decision 2: Phone Number Strategy
**Question:** How do we handle outgoing phone numbers?

- Need at least one VAPI phone number for outbound calls
- Free VAPI numbers are US-only
- International numbers require Twilio/Telnyx import

**Options:**
- A) Use free VAPI numbers for US customers
- B) Import existing Twilio numbers into VAPI
- C) BYO SIP trunk

**Recommendation:** Start with B (import Twilio) if already using Twilio, else A for MVP.

### Decision 3: Webhook Security Model
**Question:** How do we secure the VAPI webhook?

- HeyCall-e used `x-calle-signature` HMAC (shared secret)
- VAPI uses Bearer token auth OR custom HMAC

**Options:**
- A) Use VAPI's built-in server authentication (Bearer token)
- B) Implement custom HMAC verification similar to current setup
- C) Both (defense in depth)

**Recommendation:** A (Bearer token) — simpler, VAPI-native, well-documented.

### Decision 4: Tool System Integration
**Question:** Should we leverage VAPI's tool system for real-time call control?

- VAPI tools allow the AI agent to call your backend mid-conversation
- Could enable: booking lookup, availability check, appointment rescheduling, etc.

**This is an optional enhancement** — the initial migration can work without tools (just prompt-based agents like HeyCall-e), then tools can be added incrementally.

---

## 6. Cost Comparison

### HeyCall-e Pricing
- Appears to be per-call or per-minute (specifics unclear from docs)

### VAPI Pricing
- **Vapi platform:** $0.05/min
- **Voice (TTS):** Varies by provider (ElevenLabs ~$0.01-0.03/min, Cartesia ~$0.01/min)
- **STT:** Varies by provider (Deepgram ~$0.0043/min, Google ~$0.016/min)
- **LLM:** Varies by model (GPT-4o ~$0.005-0.02/min)
- **Phone:** Twilio ~$0.013/min outbound + carrier fees
- **Total estimated:** ~$0.08-0.15/min depending on provider choices

**Note:** VAPI's multi-provider flexibility can optimize costs. Use Model Intelligence presets for balanced cost/quality.

---

## 7. Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| API downtime during migration | High | Run both providers in parallel (feature flag) |
| Phone number porting issues | Medium | Test with new number first, port later |
| Transcript/recordings missing | Low | VAPI provides full artifacts by default |
| Cost overrun | Medium | Set billing alerts; start with free tier |
| Multi-language regression | Low | VAPI has strong multilingual support |
| Data loss during DB migration | Low | Keep existing columns, rename later |

---

## 8. Effort Estimate

| Phase | Estimated Effort | Files Touched |
|-------|-----------------|---------------|
| Phase 1: Foundation | 2-3 hours | 5-8 files |
| Phase 2: Call creation | 3-4 hours | 4-6 files |
| Phase 3: Webhooks | 4-6 hours | 6-10 files |
| Phase 4: Cleanup | 2-3 hours | 15-20 files |
| **Total** | **11-16 hours** | **~30-45 files** |

---

## 9. Recommendations Summary

1. **Proceed with migration** — VAPI is a significantly more capable platform with better developer experience, more control, and richer features.

2. **Use saved assistants** (not transient) for cost efficiency and manageability.

3. **Import Twilio numbers** if available; use free VAPI numbers for development/testing.

4. **Implement in phases** — start with core call creation + webhook handling, then add tools and advanced features.

5. **Keep existing DB schema** initially — avoid migration risk; rename columns in a separate PR.

6. **Feature-flag the migration** — allow switching between providers during rollout.

7. **Leverage VAPI's structured outputs** — replace custom `resultSchema` with VAPI's native structured extraction for post-call analysis.

8. **Add tools incrementally** — start with prompt-only agents (like HeyCall-e), then add booking lookup and scheduling tools for richer conversations.

---

## 10. Open Questions for Stakeholders

1. **Budget:** Are we comfortable with VAPI's per-minute pricing model?
2. **Phone numbers:** Do we have existing Twilio numbers to import?
3. **Voice selection:** Preferred TTS voice/language for the AI agent?
4. **Timeline:** When should the migration be complete?
5. **Parallel run:** Should we maintain both providers during transition?
6. **Tool priorities:** Which tools should be built in Phase 1 vs. later?

---

## 11. ✅ Migration Shipped — Keputusan Final & Deviasi

Migrasi dieksekusi penuh (API + web + docs + tests hijau). Keputusan final
vs rekomendasi riset:

### 11.1 Asisten: **transient per panggilan** (bukan saved assistants)

- Rekomendasi riset: Option A (saved assistants). **Yang dikerjakan: Option B**
  (transient) — satu asisten dibangun per call dari prompt `composeCallGoal()`,
  perilaku 1:1 dengan CALL-E (tiap call membawa prompt sendiri) dan **nol setup
  dashboard** (cukup API key + phone number ID).
- `services/vapi.ts` → `buildVapiAssistant()` — satu tempat untuk beralih ke
  saved assistant nanti (`VAPI_ASSISTANT_ID` + `assistantOverrides`).

### 11.2 SDK v1.2.0: `CreateCallDto` **tanpa** `metadata` / `idempotencyKey`

- Deviasi dari riset (yang mengasumsikan `metadata` passthrough seperti CALL-E).
- Korelasi webhook → booking dikerjakan lewat **nama panggilan**
  (`booking:<id>:<goal>:<source>`) + lookup baris `calle_calls`
  (`calle_call_id` = Vapi call id).
- Anti-duplikat: guard in-flight (bookingId + goalType berstatus non-terminal)
  sebelum create + `onConflictDoNothing` pada insert.

### 11.3 Webhook auth: **Bearer token via `assistant.server.headers`**

- SDK v1.2.0 menghapus `server.secret` inline → diganti `server.headers`
  (`Authorization: Bearer <VAPI_WEBHOOK_SECRET>`); route menerima juga
  `X-Vapi-Secret` legacy. Tanpa setup credential di dashboard.

### 11.4 DB: tabel & kolom lama dipertahankan

- `calle_calls` + `bookings.calle_call_id` tetap (sesuai rekomendasi riset —
  hindari migrasi DB). Id Vapi disimpan di `calle_call_id`; dokumentasi
  menjelaskan alias ini.
- Nama event Inngest baru: `vapi/event.received`; route webhook
  `/api/webhooks/vapi` menggantikan `/api/webhooks/calle`.

### 11.5 Pemetaan `endedReason` → status aplikasi

- `services/vapi.ts` → `mapEndedReason()`: completed (assistant/customer ended,
  hangup, forwarding, transport-completed) / canceled (manually-canceled,
  billing errors) / failed (sisanya: `*-failed`, `*-error*`, no-answer, busy,
  voicemail, transport errors).

### 11.6 Env vars baru

```
VAPI_API_KEY=…
VAPI_PHONE_NUMBER_ID=…
VAPI_WEBHOOK_SECRET=…      # wajib untuk webhook (fail-closed)
VAPI_MODEL=gpt-4o-mini     # opsional
VAPI_VOICE_ID=cgSgspJ2msm6clMCkdW9  # opsional (11labs)
```

### 11.7 Diluar scope (belum digarap)

- Rename kolom DB ke `vapi_*` (PR terpisah bila diinginkan).
- Tools real-time Vapi (booking lookup, availability) — enhancement.
- Skills `.agents/skills/` yang memakai CALL-E CLI (tooling standalone).
- Inbound call handling via `assistant-request`.

### 11.8 Trigger manual panggilan keluar **dihapus** (auto-call saja)

- `POST /api/bookings/:id/trigger-call` (routes/bookings.ts) dihapus
  beserta rate limiter khususnya; UI "Trigger call now" di booking detail
  ikut dihapus (termasuk key i18n `triggerNow`/`calling`/`callCreated`/
  `addPhoneHint`/`errors.triggerCall`).
- Satu-satunya pemanggil `placeBookingCall` sekarang `lib/auto-call.ts`
  (Inngest `autoCallBooking`): booking dibuat / dijadwal ulang / nomor
  ditambahkan → panggilan keluar otomatis dengan goal engine + kuota
  plan tetap ditegakkan (skip `quota-*`).
