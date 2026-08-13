# Product Spec — "Bring Your Own WhatsApp Number" (unofficial channel)

**Status:** Draft v1 · **Owner:** Platform · **Related:** `spikes/waha/README.md`
(API formats + connector design validated in the WAHA spike)

## 1. Summary

Give each workspace the option to connect their **own WhatsApp number** through
a self-hosted unofficial gateway (WAHA) instead of (or alongside) the official
360dialog Business API. This is a **high-risk, opt-in-only** feature: unofficial
WhatsApp violates Meta ToS, and the connected number can be **banned**.

The product framing is deliberately narrow:

- **Enabled by default** once connected: unified inbox, auto-replies to inbound
  messages, booking reminders and form sends — **only to opted-in customers**.
- **Disabled by default**: anything that looks like outreach or marketing
  (bulk/cold messaging). An admin can enable outreach **per workspace** only
  after a second explicit consent step, and it stays capped and auditable.
- The feature ships with a **consent screen** (ban-risk disclosure), a
  **session health state machine** (connecting / QR expired / connected /
  disconnected / banned) and a **watchdog** that alerts the owner and
  auto-pauses outbound when the number looks banned.

## 2. Goals / Non-goals

**Goals**

- Let small businesses use a number they already own (no 360dialog signup, no
  template approval) for the core booking conversation loop.
- Reuse the existing unified pipeline unchanged: `parseWhatsAppWebhook` →
  inbox → `customerChannels` opt-in gating → reminders / form-sends.
- Make ban risk **visible, acknowledged, and monitorable** — never silent.
- Protect the company: consent audit trail, kill switch, no liability for
  numbers lost by workspaces that opted in.

**Non-goals (v1)**

- No marketing/outreach product (see §6 — guarded admin opt-in only).
- No multi-tenant gateway hosting by us by default (BYO gateway URL; see
  Open Questions §10 for a managed gateway later).
- No media-rich flows (images/voice) beyond the existing text pipeline.
- No replacement of the official 360dialog path — it stays the default and
  the recommended option.

## 3. Placement in the Integrations page

The WhatsApp channel already lives in the **Integrations page** as a channel
card (`channels.whatsappDesc` today: "WhatsApp Business number via 360dialog
(BSP). Reminders use Meta Message Templates."). We evolve that card rather
than create a new page.

**Card states (whatsapp channel card)**

| State | Description | Primary action |
|---|---|---|
| Not connected | No `workspace_channels` row for whatsapp | "Connect number" |
| Connected (official) | `provider` = `360dialog`, active | Show number + status; "Add a second option" below |
| Connected (BYO) | `provider` = `waha` | Health badge (see §7), pause/disconnect |

**New secondary option inside the card** — "Bring your own number"
- A sub-card with a distinct visual (amber warning tint) and a one-line
  risk teaser: *"Connect a number you already own via a self-hosted gateway.
  Unofficial — the number can be banned by WhatsApp."*
- **One WhatsApp channel per workspace** (existing constraint:
  `workspace_channels` unique on `(workspaceId, channelType)`). Choosing BYO
  when official is connected asks: *replace the existing number?* The old
  provider config is kept in a `providerHistory` for easy rollback.
- Both providers share the same channel row; `providerConfig.provider`
  distinguishes them (`360dialog` | `waha`).

## 4. Consent screen

Shown when the user clicks **"Bring your own number"**, and **again** when
(a) the gateway URL/engine changes, (b) the risk copy is updated, or
(c) outreach is being enabled (§6). Consent is **not** skippable.

**Copy (v2, EN — mirror in ID):**
> Note: changing any of the risk statements or checklist keys is a copy change
> and **requires bumping `WAHA_CONSENT_VERSION`** — otherwise old clients get
> a confusing 400 instead of the 409 re-consent flow.

> ⚠️ **Unofficial WhatsApp — your number can be banned**
>
> Connecting a number through an unofficial gateway (WAHA / Baileys-style)
> violates WhatsApp's Terms of Service. This is not a supported WhatsApp
> Business API. In practice this means:
>
> - **Your number can be permanently banned** by WhatsApp, with no appeal in
>   most cases. Use a number you can afford to lose — never a customer's
>   number or your main business line.
> - WhatsApp **shadow-restricts numbers that message many new contacts**
>   ("reachout timelock"). While restricted, sends to new contacts fail with
>   error 463 until the restriction lifts on its own.
> - We provide **no deliverability guarantee**: messages can be silently
>   dropped, delayed, or fail without a clear error.
> - Oriole is not responsible for numbers lost while using this integration.
>
> What we do for you: reminders and form sends only go to customers who have
> messaged you first (opted in), and we pause all outbound automatically if
> we detect a ban or restriction.

**Required acknowledgment:** risk checklist (v2) — **four** statements, each
with its own checkbox; **all must be ticked** before "Connect my number"
enables:

- ☐ My number can be permanently banned by WhatsApp, without appeal.
- ☐ Connecting via an unofficial gateway violates WhatsApp's Terms of Service.
- ☐ I will only use a number I can afford to lose — never a customer's number
  or my main business line.
- ☐ Reminders and form sends only go to customers who messaged me first.

Backend validates the **stable risk keys** (`WAHA_CONSENT_RISK_ITEMS` in
`apps/api/src/lib/waha-consent.ts`), not the displayed text — the frontend
labels live in i18n (`channels.byoRiskItem*`). A typed literal is no longer
required; ticking every box is the forced-engagement gate.

**Consent record (audit, not just a flag):** stored on the channel row:

```ts
providerConfig.consent = {
  version: 2,                 // bump when risk copy changes → re-consent
  acceptedAt: "2026-08-07T…", // ISO
  acceptedByUserId: "user_…",
  copyHash: "sha256:…",       // hash of the exact copy shown
  outreachConsent?: { acceptedAt, acceptedByUserId }, // §6
};
```

## 5. Connection flow (after consent)

| Step | UI | Backend |
|---|---|---|
| 1. Gateway credentials | **Server-managed only** — no user input. Creds always come from env `WAHA_GATEWAY_URL` + `WAHA_GATEWAY_API_KEY` (the dialog no longer has gateway URL/API key fields; `GET /channels/whatsapp/waha/gateway-info` is informational). Setup without env → 400 with a clear message | Always use env creds → validate with `GET /api/sessions?all=true` probe |
| 2. Create session | Spinner "Connecting…" | `POST /api/sessions` name=`ws_<id>`, `metadata.workspace.id`, webhooks → our adapter |
| 3. Pair | Show QR image + pairing code, 60s countdown, "QR expired" refresh (see §7) | Poll `GET /api/{session}/auth/qr` on `SCAN_QR_CODE`; webhook `session.status`. **Auto-recovery:** session `STOPPED` (QR expired unscanned / gateway restart) → refresh first calls `POST /api/sessions/{session}/start` (WAHA 2026.x path) then fetches a fresh QR — no re-setup needed |
| 4. Connected | Green "Connected — {number}" | `session.status=WORKING`; `GET me` for number |
| 5. First message | Optional test: send to the owner's phone | `POST /api/sendText` |

Webhook wiring: our adapter route receives WAHA events (HMAC-SHA512
`X-Webhook-Hmac`), maps them to `WhatsAppWebhookPayload`, and reuses the
existing idempotent pipeline — see `spikes/waha/README.md`.

> **Gateway deployment:** a production-ready, OrbStack-first reference
> deployment ships in **`deploy/waha/`** — version-pinned compose, `.env`
> secrets (API key + dashboard), healthcheck, session/media persistence,
> backups, and a runbook (pairing, 463 timelock, tunnels/HTTPS, updates,
> troubleshooting). Workspaces self-host it; Oriole only holds the gateway
> URL + key. Session creation enables the NOWEB store (chat history) so
> sessions and data survive restarts.

## 6. Feature matrix — what's on/off by default

| Capability | Default | Where enforced |
|---|---|---|
| **Inbound inbox** (customer → you) | ✅ ON | `whatsapp/message.received` → `handleWhatsAppUpdate` |
| **Auto-replies** (confirm/cancel/reschedule, booking reminder re-send) | ✅ ON | `applyInboundIntent` state machine |
| **Reply from inbox UI** | ✅ ON | `inbox.ts` outbound (`isActive` guard) |
| **Booking reminders** | ✅ ON — **only to `customerChannels.isOptedIn`** | `dispatchWhatsAppReminder` (already gated) |
| **Form sends** (Google Forms / Tally link) | ✅ ON — **only to opted-in** | `dispatchFormInvitation` (already gated) |
| **Outreach / marketing to contacts** (bulk, cold) | ❌ OFF — admin opt-in per workspace, then **capped** | New feature flag `waha.outreachEnabled` + daily cap + opt-out filter + audit log |
| **Auto-call (Vapi) outreach on BYO number** | ❌ OFF — Vapi keeps its own number; no cross-wiring in v1 | n/a |

**Guardrails that apply to everything outbound (both providers):**

1. **Opt-out always wins.** `customerChannels.isOptedIn=false` blocks every
   send; a user who messages "STOP"/"BERHENTI" is never re-opted-in by a
   stray message (already implemented in `whatsapp-handler.ts`).
2. **Reachout timelock (463).** When `session.status` carries
   `reachoutTimelock.isActive`, the adapter marks the session "restricted":
   outbound to contacts without an existing chat is blocked by us (not just
   by WhatsApp), and the owner sees a banner. **No restart/re-pair** — the
   lock lifts on its own (documented in the spike).
3. **Volume caps** (v1 defaults): ≤ 20 outbound new-contact messages/day;
   total outbound ≤ 200/day. Exceed → outbound paused + alert. Configurable
   via workspace settings.
4. **No template fiction.** Unofficial channels have no Meta templates or
   24h window — reminders send as plain text. Reminder copy should not claim
   to be from "WhatsApp Business".

**Outreach admin opt-in (v1.1, not in v1):** second consent screen (§4),
per-workspace `waha.outreachEnabled`, daily cap, and every batch logged to an
audit table with `(workspaceId, contactCount, sentAt, triggeredBy)`. If any
contact replies "STOP", the campaign run is halted immediately.

## 7. Session health states + watchdog

Product-level states map to WAHA signals; the UI shows a badge on the
Integrations card and a detail line with a "last seen" timestamp.

| Product state | Icon/badge | WAHA signals | Transitions to |
|---|---|---|---|
| `connecting` | amber "Connecting…" | `STARTING`, `SCAN_QR_CODE` (first pair) | `qr-expired`, `connected`, `failed` |
| `qr-expired` | amber "QR expired — refresh" | `SCAN_QR_CODE` re-issued after TTL; pairing timeout | `connecting` (re-fetch QR) |
| `connected` | green "Connected" | `WORKING` + `me.id` present | `disconnected` (heartbeat loss), `restricted` (timelock), `banned` |
| `restricted` | orange "Restricted (reachout timelock)" | `session.status` `data.reachoutTimelock.isActive` | `connected` (lock lifts — same event, `isActive:false`) |
| `disconnected` | red "Disconnected" | `FAILED`, `STOPPED`, webhook silence > 2h, gateway 5xx on health probe | `connecting` (re-pair), `banned` |
| `banned` | dark red "Banned — outbound paused" | repeated 463 beyond timelock end; send error text matching banned/`402`/`403`; manual report | `connected` only after re-pair (new session) |

> `paused` (user-initiated via existing `isActive` toggle) is orthogonal and
> still supported — pausing stops both directions like today.

**Watchdog — three layers, all idempotent:**

1. **Real-time (webhook-driven):** the WAHA adapter ingests `session.status`
   and `message.ack` events and updates health + `lastSeenAt` immediately.
   A `session.status` with `WORKING` resets the heartbeat timer.
2. **Polling (Inngest cron, every 5 min):** `GET /api/sessions/{name}` +
   `GET me` for every workspace with a `waha` channel. Sets
   `disconnected` when unreachable or `FAILED`; detects `banned` via outbound
   error heuristics (463 persisting past `timeEnforcementEnds`, 402/403,
   "banned" in error body) and **auto-pauses outbound** (`isActive=false`
   for sends only, inbound still recorded).
3. **Heartbeat (silence detection):** if `connected` but no inbound or ack
   activity for > 2h, probe; probe fail → `disconnected` (gateway likely down).

**Alerts (escalation):**

| State | In-app | Email to workspace owner |
|---|---|---|
| `connecting` > 5 min stuck | Integrations card badge | — |
| `qr-expired` | badge + banner | — |
| `restricted` | banner: "New-contact sends paused until {time}" | once per event |
| `disconnected` | badge + dashboard chip | once per event, daily digest if persistent |
| `banned` | badge + **modal on next login** | immediate + escalation to platform support |

**Dashboard chip:** extend the existing sync-health chip pattern
(`DashboardPage` `DATA_SYNC_TYPES` / `lastSyncAt`) with a `waha` health
source so a banned/disconnected number is visible on the landing page without
opening Integrations.

## 8. Data model & API changes (sketch)

```ts
// workspace_channels.providerConfig (waha variant)
{
  provider: 'waha',
  baseUrl: 'https://waha.example.com',      // BYO gateway
  apiKey: '…',                              // session-scoped key (§9)
  sessionName: 'ws_123',
  webhookSecret: '…',                       // X-Webhook-Hmac secret (SHA-512)
  consent: { … },                           // §4 audit record
  // health (mirrored in a dedicated channel_health table for queries)
  health: {
    state: 'connecting' | 'qr-expired' | 'connected' | 'restricted' | 'disconnected' | 'banned',
    lastSeenAt: '…',
    lastStatusAt: '…',
    reachoutTimelockUntil: '…' | null,
    lastError: { code: 463, message: '…', at: '…' } | null,
  },
}
```

- **New:** `channel_health` table (or `health` jsonb column) + `waha_outbound_log`
  audit for outreach (v1.1). Optional `outreach_caps` workspace setting.
- **New routes:** `POST /channels/whatsapp/waha/setup` (consent + gateway
  probe + session create), `POST /channels/whatsapp/waha/refresh-qr`,
  `POST /channels/whatsapp/waha/pause-outbound`, and the webhook adapter
  `POST /api/webhooks/waha/:workspaceId` (HMAC-SHA512 verify → map → existing
  pipeline — see spike README).
- **i18n:** `channels.whatsappByo*`, consent keys, health-state labels in
  EN + ID (locale parity check enforced by `check-locales.mjs`).

## 8b. Local runbook — jangan lupa Dev Server Inngest

Webhook pesan masuk (`message`) memanggil `inngest.send` (event
`whatsapp/message.received`) yang diproses sebagai fungsi Inngest. Tanpa
`INNGEST_EVENT_KEY` (lokal), SDK wajib diarahkan ke **Dev Server** — client
sudah menormalisasi ini (`isDev: true` saat key kosong):

```bash
pnpm --filter @oriole/api dev:inngest   # = inngest-cli dev -u http://localhost:3000/api/inngest
```

**Alternatif satu-perintah:** overlay `deploy/waha/docker-compose.dev.yml`
menjalankan gateway + API + Inngest Dev Server bersama di container
(`docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build`)
— tanpa terminal terpisah; detail di `deploy/waha/README.md` → "Full stack in
one command".

Bila Dev Server mati: webhook membalas **503** (bukan 500 generik) dan WAHA
me-retry dengan envelope id yang sama — begitu server hidup, pesan diproses.

## 9. Security & trust

- **BYO gateway** means we hold only the URL + session API key; store the key
  scoped to that session with `read/send` only (WAHA `POST /api/keys`), never
  the admin key.
- Webhook HMAC is **SHA-512** (`X-Webhook-Hmac`) — the adapter verifies it;
  keep the existing SHA-256 path for 360dialog.
- Consent records are immutable once written (append-only audit).
- Default credentials are rejected at setup (gateway must not respond with
  the compose-file defaults).

## 10. Rollout & open questions

**Launch checklist:** adapter route + mapping ported to TS (vitest) ·
channel_health table + migration · consent flow (EN+ID) · watchdog cron +
email alerts · feature flag `waha.enabled` (plan-gated: Pro+) · runbook entry
in `docs/messaging.md`.

**Open questions**

1. Managed gateway vs BYO only: do we later host a shared WAHA cluster and
   charge per seat (the spike's "shared gateway" option)?
2. Ban detection false positives: how aggressive should the heuristic be
   before auto-pausing outbound? (v1: pause on 463-past-timelock + 402/403 +
   manual report only.)
3. Should BYO be restricted to **Pro** plans? (Recommendation: yes — cost +
   support surface.)
4. Outreach v1.1: launch with per-workspace opt-in, or skip until a real
   demand signal exists? (Recommendation: skip v1.)
