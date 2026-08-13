# WAHA spike — WhatsApp unofficial integration

Spike to validate **WAHA** (`devlikeapro/waha`) as the unofficial WhatsApp
transport for Oriole. It runs WAHA (NOWEB engine) in Docker, creates a session,
prints the QR / pairing code, sends a text message, captures the webhook
payloads, and feeds them through a reference inbound adapter that maps them to
Oriole's existing WhatsApp types.

```
spikes/waha/
├── docker-compose.yml              # WAHA (NOWEB), API on :3000
├── .env.example                    # credentials (compose reads .env)
├── README.md                       # this file — exact formats + mapping
├── scripts/
│   ├── spike.mjs                   # runner: listener + session + QR + send + adapter demo
│   └── lib/
│       ├── waha-client.mjs         # zero-dep REST client
│       ├── map-waha-to-meta.mjs    # REFERENCE inbound adapter (WAHA → app types)
│       └── map-waha-to-meta.test.mjs
└── captured/                       # created at runtime (gitignored)
    ├── events.jsonl                # raw webhooks (headers + body)
    ├── examples/                   # first payload of each event type
    ├── adapter-output.jsonl        # WAHA → Meta → Canonical per captured message
    ├── qr.png                      # QR to scan
    └── README.md                   # run summary
```

---

## ⚠️ Read this first — risk & safety

Unofficial WhatsApp (WAHA/Baileys/etc.) **violates Meta's Terms of Service**.
Numbers used with unofficial clients can be **banned**. For a multi-tenant SaaS
this is a product-liability decision, not just a technical one.

- Use only a number you're willing to lose. Never a customer's number, never
  your production business number.
- WhatsApp shadow-restricts accounts that message many *new* contacts
  (**reachout timelock**): sends to new chats fail with server error **463**
  until `timeEnforcementEnds`. The session stays `WORKING` — **do not restart
  or re-pair**, the lock lifts automatically. This is surfaced in
  `session.status` events (see below).
- Unlike Meta Cloud API, unofficial clients have **no 24h customer-service
  window and no template approval** — free-form text works anytime. That
  convenience is exactly what drives bans. Your existing "templates only
  outside the window" reminder flow maps to plain `sendText` here; keep the
  reminder volume low and always respect opt-outs.

---

## Quick start

Prereqs: Docker (Desktop running), Node 18+, and a phone with WhatsApp.

```bash
cd spikes/waha

# 1. credentials
cp .env.example .env                # then set real secrets

# 2. start WAHA (NOWEB engine)
docker compose up -d
docker compose logs -f waha         # wait for "WhatsApp HTTP API is running"

# 3. run the spike — creates the session, prints pairing code / QR
node scripts/spike.mjs              # optionally: TARGET_CHAT_ID=6281234567890@c.us

# 4. pair with your phone:
#    WhatsApp → Linked devices → Link a device → scan captured/qr.png
#    (or "Link with phone number instead" → type the pairing code)

# 5. while the script is capturing, message the paired number
#    → the inbound payload + its adapter mapping are printed
```

Unit tests for the adapter (no Docker needed):

```bash
node --test spikes/waha/scripts/lib/map-waha-to-meta.test.mjs
```

Stopping / resetting:

```bash
docker compose down
rm -rf sessions captured            # wipes the linked device
```

---

## API reference (exact request / response)

Base: `http://localhost:3000` — auth header `X-Api-Key: <WAHA_API_KEY>`.
All bodies are JSON. Status codes: 201 on create/send, 409 if the session
name already exists, 400/500 on provider errors.

### Create + start session

```http
POST /api/sessions
```

```jsonc
{
  "name": "spike",                  // optional — auto-generated if omitted
  "config": {
    "webhooks": [
      {
        "url": "http://host.docker.internal:5055/events",
        "events": ["message", "message.any", "message.ack", "session.status"],
        "hmac": { "key": "change-me" },   // optional → X-Webhook-Hmac (SHA-512)
        "retries": { "policy": "constant", "delaySeconds": 2, "attempts": 15 }
      }
    ],
    "metadata": { "workspace.id": "ws_123" },  // echoed back in every event
    "noweb": { "store": { "enabled": true, "fullSync": false } } // NOWEB only
  }
}
```

Response (201):

```json
{
  "name": "spike",
  "status": "STARTING",
  "engine": { "engine": "NOWEB" },
  "config": { "webhooks": [ /* as sent */ ], "debug": false },
  "me": null
}
```

Engine selection: set `WHATSAPP_DEFAULT_ENGINE=NOWEB` (or `GOWS`) in the
container env (done in `docker-compose.yml`). `GOWS` supports custom device
names and highest density; `NOWEB` is the general lightweight default.

Other session ops (all idempotent): `GET /api/sessions?all=true`,
`GET /api/sessions/{name}`, `POST /api/sessions/{name}/start|stop|restart`,
`POST /api/sessions/{name}/logout`, `DELETE /api/sessions/{name}`.

### Session statuses

`STOPPED` → `STARTING` → `SCAN_QR_CODE` → `WORKING` (or `FAILED`).
New in 2026: `PASSKEY_REQUIRED` / `PASSKEY_CONFIRMATION_REQUIRED` during
pairing. `SCAN_QR_CODE` is re-issued **every time the QR rotates** — refetch it.

### Get QR / pairing code

```http
POST /api/{session}/auth/qr
```
(Historical versions used `GET /api/{session}/auth/qr` — the spike's client
tries POST then GET.) Response shape is version-dependent; the spike parses
the documented fields:

```json
{
  "status": "SCAN_QR_CODE",
  "qr": {
    "url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg...",
    "expected": "CQTG-XJXL-4BD6-KKAS-HFDE-8AAQ",   // pairing code text inside the QR
    "ttl": 20
  }
}
```

Pairing code (NOWEB flow — "Link with phone number instead"):

```http
POST /api/{session}/auth/request-code
```

```json
{ "phoneNumber": "6281111111111" }
```

The exact response fields vary by version — the spike prints it raw. Note:
pairing-code auth is likely to fail if a custom device name is set
(`WAHA_CLIENT_DEVICE_NAME`) — keep the default device name for pairing.

Also: `GET /api/sessions/{session}/me` → `{ "id": "6281111111111@c.us",
"pushName": "~", "reachoutTimelock": null }` when WORKING, `null` otherwise.

### Send text message

```http
POST /api/sendText
```

```json
{ "session": "spike", "chatId": "6281234567890@c.us", "text": "Hi there!" }
```

`chatId` = international number **without `+`** + `@c.us`
(`6281234567890@s.whatsapp.net` appears in internal `_data` on NOWEB/GOWS —
convert it to `@c.us` before sending). Optional fields: `reply_to`
(message id to reply to), `mentions`, `linkPreview: false`.

Response (201; exact key set is engine-dependent — the spike prints the live
one):

```json
{
  "id": "true_6281234567890@c.us_3EB0CAAAAAAAAAAAAAAAAAAAAAAAA",
  "timestamp": 1786000000,
  "from": "6281111111111@c.us",
  "to": "6281234567890@c.us",
  "body": "Hi there!",
  "hasMedia": false
}
```

### Mark seen

```http
POST /api/sendSeen
```

```json
{ "session": "spike", "chatId": "6281234567890@c.us" }
```

(Optional `messageIds` / `participant` for granular reads on NOWEB/GOWS.)
⚠️ WAHA recommends calling `sendSeen` before replying to new messages —
"⚠️ How to Avoid Blocking".

---

## Webhook reference (exact payload shapes)

WAHA POSTs events to each configured webhook URL. Every event:

```json
{
  "id": "evt_01k3xyz0000000000000000000",   // lower-case ULID, unique per delivery
  "timestamp": 1741249702485,               // ms
  "event": "message",
  "session": "spike",
  "metadata": { "workspace.id": "ws_123" }, // set at session creation
  "me": { "id": "6281111111111@c.us", "pushName": "~" }, // present when WORKING
  "payload": { /* event-specific */ },
  "environment": { "tier": "CORE", "version": "2026.7.2" },
  "engine": "NOWEB"
}
```

Headers on every delivery:

| Header | Value |
|---|---|
| `X-Webhook-Request-Id` | unique request id |
| `X-Webhook-Timestamp` | Unix **ms** when sent |
| `X-Webhook-Hmac` | HMAC of the **raw body** (when `hmac.key` configured) |
| `X-Webhook-Hmac-Algorithm` | `sha512` — **not** sha256! |

⚠️ **This matters for Oriole:** your existing webhook route
(`apps/api/src/routes/webhooks/whatsapp.ts`) verifies `X-Hub-Signature-256`
(HMAC-SHA256, Meta's scheme). WAHA uses **HMAC-SHA512** with different header
names — the adapter needs its own verification (or verify with the existing
`verifyWebhookSignature` helper adapted to sha512). Details below.

### `message` — inbound text (what the app cares about)

```json
{
  "event": "message",
  "session": "spike",
  "engine": "NOWEB",
  "payload": {
    "id": "false_6281234567890@c.us_3EB0CAAAAAAAAAAAAAAAAAAAAAAAA",
    "timestamp": 1786000000,
    "from": "6281234567890@c.us",
    "fromMe": false,
    "to": "me",
    "body": "Halo!",
    "hasMedia": false,
    "ack": 1,
    "vCards": [],
    "_data": { }
  }
}
```

Key facts:

- `id` format: `{fromMe}_{chatId}_{messageId}[_{participant}]` — `false_` =
  inbound, `true_` = outbound. **Unique and stable → usable as the
  idempotency key** where the app currently uses Meta's `wamid`.
- The `message` event fires **only for inbound**; `message.any` fires for all
  (own messages have `fromMe: true` / `source: "api"`). Subscribe to
  `message` for the inbox.
- **No contact name** in the event. Resolve via
  `GET /api/{session}/contacts/{chatId}` if you need a display name.
- Media: `hasMedia: true` + `media: { url, mimetype, filename }` — the URL is
  only reachable with the API key (`?x-api-key=` or header). The app's parser
  currently ignores non-text messages.
- `replyTo` present when the message replies to another message (has its own
  `id`, `body`, `media`).

### `message.ack` — delivery status of outbound

```json
{
  "event": "message.ack",
  "session": "spike",
  "engine": "NOWEB",
  "payload": { "id": "true_..._3EB0C...", "from": "6281111111111@c.us",
               "participant": null, "fromMe": true, "ack": 3, "ackName": "READ" }
}
```

| ack | ackName | meaning |
|---|---|---|
| -1 | ERROR | error |
| 0 | PENDING | pending |
| 1 | SERVER | sent to server |
| 2 | DEVICE | delivered to device |
| 3 | READ | read |
| 4 | PLAYED | played |

### `session.status` — lifecycle + timelock

```json
{
  "event": "session.status",
  "session": "spike",
  "payload": {
    "status": "WORKING",
    "statuses": [
      { "status": "STOPPED", "timestamp": 1700000001000 },
      { "status": "STARTING", "timestamp": 1700000002000 },
      { "status": "WORKING", "timestamp": 1700000003000 }
    ],
    "data": null
  }
}
```

`data` carries extras: `{ "reachoutTimelock": { "enforcementType": "RESTRICT_ALL_COMPANIONS",
"isActive": true, "timeEnforcementEnds": 1784477333 } }` while a 463 shadow-ban
is active (re-issued with `isActive: false` when lifted), or passkey
challenges on `PASSKEY_REQUIRED` / `PASSKEY_CONFIRMATION_REQUIRED`.

---

## Mapping to Oriole's existing types

Targets (read these first):

- `packages/messaging/src/whatsapp/parse.ts` — `WhatsAppWebhookPayload` +
  `parseWhatsAppWebhook()` (wa_id from `from`, intent detection incl. STOP →
  opt-out, skips non-text).
- `packages/messaging/src/types.ts` — `CanonicalInboundEvent` (the unified
  shape fed to handlers).
- `apps/api/src/routes/webhooks/whatsapp.ts` — existing route: HMAC-SHA256
  verify → `recordWebhookEvent` (idempotency) → Inngest
  `whatsapp/message.received` → `apps/api/src/lib/whatsapp-handler.ts`
  (`handleWhatsAppUpdate`).

### Inbound — WAHA `message` event → `WhatsAppWebhookPayload`

Implemented in `scripts/lib/map-waha-to-meta.mjs` (and unit-tested):

| WAHA | → Meta `value.messages[0]` | → `CanonicalInboundEvent` |
|---|---|---|
| `payload.from` (`628…@c.us`) | `from` (strip `@c.us`) → wa_id | `senderIdentifier` |
| `payload.id` (`false_…`) | `id` (idempotency key) | `providerEventId` |
| `payload.timestamp` (s) | `timestamp` (string) | `receivedAt` (ISO) |
| `payload.body` | `type: "text"`, `text.body` | `content` |
| `payload.fromMe: true` | skipped (outbound echo) | skipped |
| `payload.hasMedia: true` | skipped (parser ignores media) | skipped |
| `me.id` (when WORKING) | `metadata.phone_number_id` / `display_phone_number` | — |
| `session` | `entry[].id` | `raw.session` |
| — (not in event) | — | `senderName: null` (resolve via contacts API if wanted) |

Recommended architecture — **shape-shift at the webhook edge, reuse everything
after it**:

```
WAHA ──webhook──▶ adapter (Hono: POST /api/webhooks/waha/:workspaceId)
                   1. verify X-Webhook-Hmac (SHA-512)
                   2. mapWahaEventToMeta(event) → WhatsAppWebhookPayload
                   3. recordWebhookEvent('waha', eventId, ...)
                   4. inngest.send('whatsapp/message.received', { workspaceId, payload })
                     └─▶ handleWhatsAppUpdate() — unchanged
```

- **Idempotency:** keep the same `webhook_events` mechanism; namespace the
  event id so Meta-wamids and WAHA ids never collide:
  `eventId = \`${workspaceId}:waha:${payload.id}\``.
- **Opt-in gating:** `handleWhatsAppUpdate` auto-creates `customerChannels`
  on first inbound message and honors opt-out — unchanged, since the channel
  is still `whatsapp`.
- **Session ↔ workspace:** one WAHA session per workspace, named
  `ws_<id>`, with `metadata: { "workspace.id": "<id>" }` for lookup, and the
  session's HMAC secret stored in the existing
  `workspace_channels.providerConfig` row (same place as the 360dialog
  `apiKey`/`webhookSecret` today — `apps/api/src/services/whatsapp.ts`).

### Outbound — existing `services/whatsapp.ts` functions → WAHA

| Oriole call (360dialog) | WAHA equivalent | Notes |
|---|---|---|
| `whatsappSendText` | `POST /api/sendText` | 1:1, same semantics |
| `whatsappSendInteractive` (reply buttons) | `POST /api/send/buttons/reply` (engine-dependent) | ⚠️ **capture at spike time** — button replies arrive as a plain message whose body is the label; no callback-data like Meta's `button_reply.id`. Implemented: `parseWhatsAppWebhook` maps the label/free-text keywords (`ya hadir`, `batal`, `ubah jadwal`) to confirm/cancel/reschedule intents; the handler resolves the booking from the conversation. |
| `whatsappSendTemplate` | plain `sendText` | Unofficial clients have no Meta templates / 24h window — free text anytime, but that's the ban-risk tradeoff. Keep opt-outs + volume low. |
| `whatsappGetConfig` (validate API key) | `GET /api/sessions/{session}/me` or `GET /api/{session}/auth/qr` probe | Setup validation instead becomes "create session + wait WORKING". |

### Keys / security for the connector

- WAHA supports **session-scoped API keys**: `POST /api/keys` with
  `{ "session": "ws_<id>", "actions": { "read": true, "send": true, "control": false, ... } }`.
  Give outbound only a send+read key; keep a full key for provisioning.
- HMAC is **SHA-512** with `X-Webhook-Hmac` — a small
  `verifyWahaWebhookSignature(rawBody, secret, provided)` (node:crypto
  `createHmac('sha512', secret)`) is all the adapter needs.
- Webhook delivery headers include `X-Webhook-Request-Id` — log it; WAHA
  retries with backoff (configurable `retries`), so keep webhook handling
  idempotent (it is).

---

## What the spike validates (and what it can't)

✅ Session lifecycle (create → SCAN_QR_CODE → WORKING), QR + pairing code,
`sendText` + `sendSeen`, webhook delivery (message, message.any, message.ack,
session.status), adapter mapping on real payloads.

❌ It cannot pair without a real phone. Interactive-button inbound, media
download, and contacts-name resolution need dedicated capture steps (run the
spike, tap the buttons, watch the payloads).

Next step after this spike: implement the adapter route + provider abstraction
in `apps/api` (keep the 360dialog path as default, WAHA behind a
`provider: 'waha'` flag on the workspace channel), then port
`map-waha-to-meta.mjs` to TypeScript with vitest tests mirroring
`parse.test.ts`.
