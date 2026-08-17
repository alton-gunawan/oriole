# PostHog Analytics — Implementation Research

**Date:** August 12, 2026
**Status:** ✅ Research complete — implementation pending
**Stack:** React 19 + Vite 8 SPA (`apps/web`, React Router v7 **data mode**), Hono API (`apps/api`), pnpm monorepo

---

## 1. TL;DR

PostHog is a good fit for Oriole. One vendor covers the four things this app most needs:

1. **Product analytics** — pageviews, funnels (signup → workspace → first booking → paid), retention.
2. **Session replay** — watch real users struggle with the booking flow / integrations setup.
3. **Feature flags** — roll out Vapi/WAHA/auto-call features gradually per workspace.
4. **Error tracking** — unify client React errors + server Hono errors in one place.

Because the SPA is a plain client-side Vite app (no SSR) and the API is Hono on Node, the integration is simple:

- **Client:** `posthog-js` + `@posthog/react`. Init in `main.tsx` with the `defaults` option → **SPA pageviews are tracked automatically** (no router hook needed in React Router v7 data mode).
- **Server:** `posthog-node` as a Hono middleware + `app.onError` handler.
- **Identity:** link both sides with `posthog.identify(userId)` on the client and `X-POSTHOG-DISTINCT-ID` tracing headers to the API.

Free tier (1M events/mo, 5k session replays/mo) comfortably covers an early-stage app. Estimated total effort: **4–6 hours** across ~10 files.

---

## 2. How PostHog Works (30-second mental model)

- You create a **project** in PostHog Cloud (US or EU region). You get:
  - **Project API key / token** (`phc_...`) — public, safe to embed in the client bundle, and the same key the server SDKs send events with. Since 2026 PostHog calls this the *project API key* (`phc_`), distinct from *personal API keys* (`phx_`, account-level, for the private REST API only — **rejected by the capture endpoint**).
  - **Host** (`https://us.i.posthog.com` or `https://eu.i.posthog.com`) — where events are sent.
  - **Personal API key** (`phx_...`) — optional, server-only; only needed if you later automate the private API (flags/replay/annotations management).
- The web SDK (`posthog-js`) auto-captures: pageviews, pageleaves, clicks, inputs, form submissions. It assigns an anonymous `distinct_id` cookie until you call `identify()`.
- The Node SDK (`posthog-node`) captures events server-side, batches them, and flushes on demand.
- Events are just `{ event: string, distinctId: string, properties: {...} }`. Everything downstream (funnels, retention, replay, flags) is built on them.

---

## 3. Current Stack — What Matters for the Integration

| Area | Facts found in repo | Impact |
|---|---|---|
| Router | React Router v7 **data mode** (`createBrowserRouter` + `<RouterProvider>` in `apps/web/src/router.tsx`) | Pageviews auto-captured via `capture_pageview: 'history_change'` (browser History API) — **zero router code** |
| App root | `apps/web/src/main.tsx` — single `createRoot().render()` | Single place to `posthog.init()` + wrap `<PostHogProvider>` |
| Web env | `apps/web/src/config/env.ts` reads `VITE_*` (currently `VITE_API_URL`, `VITE_NEON_AUTH_URL`); `.env.example` documents them | Add `VITE_POSTHOG_PROJECT_TOKEN` + `VITE_POSTHOG_HOST` here |
| API env | `packages/config/src/env.ts` — Zod `apiEnvSchema`, validated at boot | Add `POSTHOG_PUBLIC_KEY` + `POSTHOG_HOST` (optional, so dev boots without keys) |
| User identity (client) | `restoreSession()` in `apps/web/src/lib/session.ts` fetches `/me` → `{ userId, email, name }` into the session store; `signOut()` clears it | Identify/`reset()` hook points already exist |
| User identity (server) | API auth middleware verifies Neon Auth JWT → userId available per request | Server events can use `userId` as `distinctId` directly |
| Event naming | Existing domain events `booking.created` / `booking.completed` / `booking.cancelled` / `booking.updated` / `booking.deleted` (see `apps/api/src/lib/slack.ts`, `routes/bookings.ts`) | Reuse this taxonomy for PostHog server events — consistent, already familiar |
| Background jobs | Inngest (`apps/api/src/inngest/`) handles auto-calls, webhooks, reminders | Server events also fire from here — capture in the same `lib/analytics` helper |
| Bundle splitting | Pages are lazy-loaded; `main.tsx` deliberately keeps the boot bundle small | `posthog-js` (~40 kB gz) must be added to the **initial** bundle because it must init before first render |

---

## 4. Client Integration (`apps/web`)

### 4.1 Install

```bash
pnpm --filter @oriole/web add posthog-js @posthog/react
```

> `@posthog/react` is required — it provides `<PostHogProvider>` and hooks (`usePostHog`, `useFeatureFlagEnabled`, …). Access PostHog **only** through those; direct `import posthog from 'posthog-js'` outside the provider causes "library not initialized" errors.

### 4.2 Env vars

`apps/web/src/config/env.ts`:

```ts
export const env = {
  API_URL: import.meta.env.VITE_API_URL ?? '/api',
  NEON_AUTH_URL: (import.meta.env.VITE_NEON_AUTH_URL as string | undefined) ?? '',
  POSTHOG_PROJECT_TOKEN: (import.meta.env.VITE_POSTHOG_PROJECT_TOKEN as string | undefined) ?? '',
  POSTHOG_HOST: (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ?? 'https://us.i.posthog.com',
} as const;
```

`.env.example`:

```
# ── PostHog (analytics) ────────────────────────────────────────
# Project token (phc_...) dari PostHog Cloud → Project Settings.
# VITE_POSTHOG_HOST: US = https://us.i.posthog.com, EU = https://eu.i.posthog.com.
# Kosong = analitik nonaktif (app tetap jalan normal).
VITE_POSTHOG_PROJECT_TOKEN=
VITE_POSTHOG_HOST=https://us.i.posthog.com
```

**Design decision:** make the token **optional**. If unset, PostHog is simply not initialized and the app behaves exactly as today. This keeps local dev and the public landing page clean, and lets you enable tracking per environment.

### 4.3 Init in `main.tsx`

The `defaults` option is the key to SPA pageviews — recent defaults set `capture_pageview: 'history_change'`, which captures navigation via the browser History API. This covers React Router v7 data mode **without a router subscription**:

```tsx
// main.tsx
import posthog from 'posthog-js';
import { PostHogProvider } from '@posthog/react';
import { env } from './config/env';

if (env.POSTHOG_PROJECT_TOKEN) {
  posthog.init(env.POSTHOG_PROJECT_TOKEN, {
    api_host: env.POSTHOG_HOST,
    defaults: '2026-05-30',          // enables history_change pageviews, updated autocapture
    capture_pageview: 'history_change',
    // Optional (see §7 identity linking):
    // tracing_headers: ['localhost:3000'],
  });
}

// inside bootstrap(), wrap:
<RootErrorBoundary>
  <Theme theme={neutralTheme}>
    <QueryClientProvider client={queryClient}>
      <PostHogProvider client={posthog}>
        <RouterProvider router={router} />
      </PostHogProvider>
    </QueryClientProvider>
  </Theme>
</RootErrorBoundary>
```

**Autocapture tuning** (init options):
- `autocapture: false` — if you prefer only explicit events (recommended once you have custom events; start with autocapture on for zero-effort data).
- `capture_pageview: 'history_change'` — SPA navigation tracking (default with recent `defaults`).
- `session_recording: { maskAllInputs: true }` — mask sensitive input before enabling replay.

### 4.4 Identify & reset (session lifecycle)

Hook into the existing session store. `apps/web/src/lib/session.ts`:

- After `restoreSession()` succeeds (`store.setUser(...)`): `posthog.identify(me.userId, { email, name })` — also set `group` once workspaces are known: `posthog.group('workspace', workspaceId)`.
- In `signOut()`: `posthog.reset()` so the next person on the same browser doesn't inherit the previous user's identity.

Prefer a `lib/analytics.ts` wrapper so components never touch `posthog-js` directly (keeps the "don't import directly" rule and makes the module easy to tree-shake when disabled):

```ts
// apps/web/src/lib/analytics.ts
import { env } from '../config/env';

export const analytics = {
  enabled: Boolean(env.POSTHOG_PROJECT_TOKEN),
  async identify(userId: string, props?: Record<string, unknown>) { /* dynamic import + posthog.identify */ },
  async track(event: string, props?: Record<string, unknown>) { /* posthog.capture */ },
  async reset() { /* posthog.reset */ },
};
```

### 4.5 Custom events worth capturing (client)

| Event | When | Properties |
|---|---|---|
| `signup_started` / `signin_started` | Auth pages submit | `provider` |
| `workspace_created` | Onboarding completes | — |
| `booking_created` (client side, complement to server event) | BookingNewPage submit success | `goal_type`, `source`, `has_phone` |
| `call_triggered` | Trigger-call button | `goal_type` |
| `integration_connected` | Integrations page connect | `provider` (vapi / whatsapp / telegram / zoom / meta / slack) |
| `payments_checkout_opened` | Paddle checkout dialog | — |

Fire these from page components via `usePostHog()` or the `analytics` wrapper. Do **not** put PII (phone numbers, customer names, email contents) in event properties — see §8.

---

## 5. Server Integration (`apps/api`)

### 5.1 Install

```bash
pnpm --filter @oriole/api add posthog-node
```

### 5.2 Env vars (`packages/config/src/env.ts`)

```ts
// PostHog analytics — opsional; tanpa key server hanya tidak mengirim event.
POSTHOG_PUBLIC_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
POSTHOG_HOST: z.string().url().default('https://us.i.posthog.com'),
```

`.env.example`:

```
# ── PostHog (analytics, server-side) ───────────────────────────
# Project API key (`phc_...`, Project Settings → API keys) — key yang SAMA
# dengan token web SDK. BUKAN personal API key (`phx_...`) yang hanya untuk
# REST API privat dan DITOLAK endpoint capture.
# Kosong = event server tidak dikirim (dev tetap jalan).
POSTHOG_PUBLIC_KEY=
POSTHOG_HOST=https://us.i.posthog.com
```

### 5.3 Client singleton + capture helper

```ts
// apps/api/src/lib/analytics.ts
import { PostHog } from 'posthog-node';

export const posthog = new PostHog(env.POSTHOG_PUBLIC_KEY ?? '', {
  host: env.POSTHOG_HOST,
  // flushAt: 20, flushInterval: 3000 — defaults fine for Hono request lifecycle
});

export function capture(
  event: string,
  opts: { distinctId: string; properties?: Record<string, unknown>; groups?: Record<string, string> },
) {
  if (!env.POSTHOG_PUBLIC_KEY) return; // no-op when disabled
  posthog.capture({ distinctId: opts.distinctId, event, properties: opts.properties, groups: opts.groups });
}
```

### 5.4 Middleware (per-request events + error tracking)

Per the [official Hono guide](https://posthog.com/docs/libraries/hono), add a middleware for request-level capture and `app.onError` for exceptions:

```ts
// apps/api/src/middleware/analytics.ts
import { createMiddleware } from 'hono/factory';
import { capture, posthog } from '../lib/analytics';

/** Capture satu event ringan per request + flush di akhir. */
export const analyticsMiddleware = createMiddleware(async (c, next) => {
  await next();
  await posthog.flush();
});
```

```ts
// apps/api/src/index.ts
app.use('*', analyticsMiddleware);
app.onError(async (err, c) => {
  posthog.captureException(err, 'server-error', {
    path: c.req.path,
    method: c.req.method,
    url: c.req.url,
  });
  await posthog.flush();
  // existing error handling...
});
```

**Shutdown:** In serverless/edge deployments events can be lost at process exit; on long-running Node (this app: `@hono/node-server` / tsx) call `posthog.shutdown()` on SIGTERM/SIGINT so queued batches flush.

### 5.5 Server events to capture (reuse existing domain events)

These map 1:1 to places that already emit `emitOutgoingWebhookEvent(...)` / `emitSlackBookingEvent(...)` — add a `capture(...)` call alongside (in `apps/api/src/lib/` helpers so both HTTP routes and Inngest jobs share them):

| Event | Where it already exists | Properties (no PII) |
|---|---|---|
| `booking.created` | `routes/bookings.ts`, `lib/form-booking.ts` | `workspace_id`, `source`, `goal_type` |
| `booking.completed` | `routes/bookings.ts`, `inngest/functions.ts` | `workspace_id`, `goal_type` |
| `booking.cancelled` / `booking.updated` / `booking.deleted` | `routes/bookings.ts` | `workspace_id` |
| `call.completed` | `inngest/functions.ts` (vapi event) | `workspace_id`, `goal_type`, `duration_seconds`, `status` |
| `ai_chat_used` | `lib/ai-chat.ts` | `workspace_id`, `model` |
| `payment.completed` | `lib/paddle-payments.ts` / `routes/payments.ts` | `workspace_id`, `plan` (never amounts/PII) |
| `workspace.created` | workspace creation route | — |
| `integration.connected` | integrations route | `provider` |

`distinctId` for server events: the authenticated `userId` (already resolved by the auth middleware and stored on `c`), or `workspace:<id>` for system events (Inngest jobs, webhooks) where no user is in context. Add `groups: { workspace: workspaceId }` so PostHog can aggregate per workspace (your product is workspace-centric — this is important for per-workspace dashboards).

---

## 6. Optional PostHog Products (recommended, but phase them)

### 6.1 Session replay
- Zero extra code — enabled via init option `session_recording: { maskAllInputs: true }`.
- **Gate it behind consent** (§8) — replay captures full UI, including inbox messages and customer data.
- Free tier: 5,000 recordings/mo.

### 6.2 Feature flags (high value for this app)
- `useFeatureFlagEnabled('flag-key', false)` from `@posthog/react` — no provider change needed.
- Great candidates: Vapi auto-call rollout, WAHA BYO WhatsApp, AI chat KB, new booking flow.
- Server-side: `posthog.isFeatureEnabled('flag', distinctId)` — consistent targeting per workspace.
- **Tip:** for server-side flags, pass `{ groups: { workspace } }` and define flag conditions on group properties so you can roll out per-workspace.

### 6.3 Experiments (A/B tests)
- Built on flags; `useFeatureFlagVariantKey('experiment-key')`.
- Start after flags are stable.

### 6.4 Surveys
- Web SDK surveys need no code; good for NPS + "why did you cancel" after `booking.cancelled`.

### 6.5 Error tracking
- Client: `posthog.captureException(err)` — add to `RootErrorBoundary.componentDidCatch` in `main.tsx` and `RouteErrorElement`.
- Server: `app.onError` (§5.4).
- Unifies React + Hono errors in one place — biggest DX win per line of code.

---

## 7. Identity Linking: Client ↔ Server

Server events need to attach to the **same person** as client events. Two mechanisms:

1. **`distinctId` = your `userId`** (both sides). Client calls `posthog.identify(userId)`; server captures with the JWT-sub `userId`. PostHog merges them into one person.
2. **`tracing_headers`** (optional, best-effort): set in client init to the API host. posthog-js then adds `X-POSTHOG-DISTINCT-ID` + `X-POSTHOG-SESSION-ID` headers to matching requests; server SDK reads them to correlate its events with the frontend session/replay.

```ts
// client init
posthog.init(token, { ..., tracing_headers: ['localhost:3000'] });
```

Only set this if you capture server events (Phase 3). Hostnames only, no protocol/path.

---

## 8. Privacy, GDPR & Security

1. **EU region:** if your users are mainly EU, create the project in EU cloud (`https://eu.i.posthog.com`). US cloud otherwise.
2. **Consent:** PostHog has first-class opt-in/out APIs. Recommended flow:
   - Don't init PostHog (or call `posthog.opt_out_capture()`) until the user accepts the cookie/analytics banner.
   - `posthog.has_opted_in_capture()` to check state.
   - Replay + autocapture should require consent; your **explicit custom events** (bookings, integrations) can arguably run on legitimate interest, but the safest path is one banner controlling everything.
3. **Data minimization:** never send `phone`, `email` (use as person property at most — PostHog redacts `email`), message content, or customer names in event properties. This app handles sensitive PII (customer phones, inbox messages) — keep it out of analytics.
4. **Masking:** add `className="ph-no-capture"` to inbox message bodies and phone inputs so autocapture/replay never records them.
5. **CSP:** if you add a Content-Security-Policy, allow `https://*.posthog.com` for `script-src` / `connect-src` (and `worker-src blob: data:` for replay). Without it, capture **silently fails** — events never arrive while the integration looks fine.
6. **DPA:** PostHog Cloud offers a standard DPA; sign it before production if you're EU-facing.

---

## 9. Cost

PostHog Cloud free tier (resets monthly, no credit card for Cloud Free):

| Product | Free tier | Beyond |
|---|---|---|
| Product analytics | **1M events/mo** | from $0.00005/event |
| Session replay | **5,000 recordings/mo** | ~$0.005/recording |
| Feature flags | 1M requests/mo | from $0.0001/request |
| Surveys | included | — |
| Error tracking | included with analytics | — |

**Estimate for Oriole:** pageviews (~10–30/active user/day) + autocapture clicks + ~15 explicit events per booking lifecycle. Even at 1,000 active users this stays well under 1M events/mo. Autocapture inflates volume fastest — if you approach limits, disable autocapture and keep only explicit events (they're the ones you actually analyze).

---

## 10. Recommended Implementation Plan

### Phase 1 — Client foundation (1.5–2 h)
1. Add `posthog-js` + `@posthog/react` to `apps/web`.
2. Add `VITE_POSTHOG_PROJECT_TOKEN` / `VITE_POSTHOG_HOST` to `config/env.ts` + `.env.example`.
3. Init in `main.tsx` + wrap `<PostHogProvider>`; no-op when token missing.
4. Verify: pageviews + autocapture appear in PostHog **live events** for `/`, `/auth/*`, `/app/*` navigation.

### Phase 2 — Identity & custom events (1 h)
5. `lib/analytics.ts` wrapper; `identify()` in `restoreSession()`, `reset()` in `signOut()`, `group('workspace', …)` when workspace is set.
6. Add client events from §4.5 table to key pages.

### Phase 3 — Server events (1.5 h)
7. Add `posthog-node`; `POSTHOG_PUBLIC_KEY`/`POSTHOG_HOST` to `packages/config/src/env.ts` + `.env.example`.
8. `lib/analytics.ts` server helper + middleware + `app.onError` (`captureException`).
9. `capture()` alongside existing `booking.*` emissions (HTTP routes + Inngest).
10. Verify identity merge: one person shows client + server events.

### Phase 4 — Optional productization (when ready)
11. Session replay (consent-gated) → feature flags (`useFeatureFlagEnabled`) → surveys → error tracking in `RootErrorBoundary`.

---

## 11. Files Touched (complete map)

| File | Change |
|---|---|
| `apps/web/package.json` | + `posthog-js`, `@posthog/react` |
| `apps/web/src/config/env.ts` | + `POSTHOG_PROJECT_TOKEN`, `POSTHOG_HOST` |
| `apps/web/src/main.tsx` | `posthog.init` + `<PostHogProvider>` |
| `apps/web/src/lib/analytics.ts` | **new** — client wrapper (identify/track/reset) |
| `apps/web/src/lib/session.ts` | `identify()` after `/me`, `reset()` in `signOut()` |
| `apps/web/src/app/pages/*` (key pages) | custom events (§4.5) |
| `apps/api/package.json` | + `posthog-node` |
| `packages/config/src/env.ts` | + `POSTHOG_PUBLIC_KEY`, `POSTHOG_HOST` |
| `apps/api/src/lib/analytics.ts` | **new** — server helper + `capture()` |
| `apps/api/src/middleware/analytics.ts` | **new** — request middleware + flush |
| `apps/api/src/index.ts` | `app.use('*', …)`, `app.onError` → `captureException` |
| `apps/api/src/lib/booking-goal.ts`, `form-booking.ts`, `inngest/functions.ts`, `paddle-payments.ts`, … | `capture()` next to existing `booking.*` / payment emissions |
| `.env.example` | both client + server PostHog vars |

---

## 12. Risks & Open Questions

| Item | Notes |
|---|---|
| **Bundle size** | `posthog-js` goes in the initial bundle. ~40 kB gz — acceptable; lazy-init only when token present. |
| **Silent failure** | If a CSP exists, events silently don't send. Add the `*.posthog.com` allowances (§8.5) at the same time as the SDK. |
| **Consent timing** | Decide the banner UX before Phase 4 (replay). Explicit events in Phases 1–3 are lower-risk. |
| **EU vs US cloud** | Pick at project creation — not changeable later. Depends on your user base. |
| **PII in properties** | Discipline required: phone numbers and message content must never reach PostHog. `ph-no-capture` + reviewer checklist. |
| **Event volume from autocapture** | Watch analytics usage; can disable autocapture and rely on explicit events. |
| **Per-workspace analytics** | PostHog supports `group('workspace', id)` — decide early (Phase 2) so dashboards aggregate correctly. |

**Open questions for stakeholders:**
1. EU or US cloud region?
2. Consent banner now or later? (Affects replay only, mostly.)
3. Which server events matter first — bookings, calls, payments, or AI chat usage?
4. Do you want per-workspace dashboards (→ `group()` from day one)?

---

## 13. Recommendation

**Proceed.** Start with Phase 1 + 2 (client pageviews, identify, ~6 custom events) — that's ~3 hours and gives immediate value with zero server changes and no consent blocker. Phase 3 (server events) is cheap because the `booking.*` emission points already exist. Treat session replay, feature flags, and error tracking as follow-on wins, each independently shippable.

---

## 14. ✅ Implementation Shipped (Aug 12, 2026)

Fase 1–3 + error tracking dieksekusi penuh (API + web + docs + tests hijau). Keputusan final & deviasi vs rekomendasi riset:

### 14.1 Client (`apps/web`)

- **Deps:** `posthog-js` + `@posthog/react`; init di `main.tsx` dengan `defaults` + `capture_pageview: 'history_change'` — pageview SPA React Router v7 data mode **otomatis**, tanpa kode router.
- **Env:** `VITE_POSTHOG_PROJECT_TOKEN` / `VITE_POSTHOG_HOST` di `config/env.ts` + `.env.example`; **token opsional** → tanpa token PostHog tidak di-init (no-op).
- **Wrapper:** `lib/analytics.ts` — lazy `import('posthog-js')`, aman dipakai di test node; helper `initAnalytics` / `identifyAnalyticsUser` / `groupAnalyticsWorkspace` / `resetAnalytics` / `trackEvent` / `captureClientError`.
- **Identitas:** `identify(userId)` setelah `restoreSession()` (id stabil dari `/me`, bukan email), `group('workspace', id)` saat boot/switch bisnis, `reset()` di `signOut()`.

### 14.2 Deviasi #1 — event client dipangkas (hindari double-count)

Riset §4.5 menyarankan `workspace_created`, `booking_created`, `call_triggered`, `integration_connected` di client. **Tidak diimplementasikan di client** karena server sekarang meng-capture event yang sama (double-count mencemari funnel). Client hanya meng-capture yang **tidak bisa dilihat server**: `signin_started` / `signup_started` (metode email/google/github), `payments_dialog_opened`, dan error (`captureClientError` di `RootErrorBoundary` + `RouteErrorElement`).

### 14.3 Server (`apps/api`)

- **Deps:** `posthog-node` v5; env `POSTHOG_PUBLIC_KEY` (opsional, project API key `phc_...` — sama dengan token web) + `POSTHOG_HOST` di `packages/config/src/env.ts` + `.env.example`.
- **`lib/analytics.ts`:** sink abstraksi (`AnalyticsSink`) — tanpa key = no-op sink, test menyuntikkan fake; helper domain no-PII: `captureBookingEvent`, `captureCallEvent`, `capturePaymentEvent`, `captureWorkspaceEvent`, `captureIntegrationEvent` — semua mengikat group `workspace`.
- **`middleware/analytics.ts`:** flush antrian PostHog setelah tiap response (best-effort, tidak menggagalkan request).
- **`index.ts`:** middleware terpasang di `/api/*`; `onError` → `captureException` + flush; SIGTERM/SIGINT → `shutdownAnalytics()` (flush antrian saat proses berhenti).
- **Event terpasang:** `booking.created/completed/cancelled/updated/deleted` (routes + form-booking + Inngest), `call.triggered` (route), `call.completed`/`call.failed` (Inngest Vapi), `payment.checkout_created` (route payments), `payment.completed`/`payment.canceled`/`subscription.activated`/`subscription.canceled` (Inngest Paddle), `workspace.created` (routes/me), `integration.connected` (routes/integrations — pusat di `upsertIntegration`).

### 14.4 Privasi (deviasi #2 — replay OFF, masking ON)

- **Session replay NONAKTIF** — butuh consent banner + kebijakan privasi (dokumentasi cara mengaktifkan ada di `main.tsx` / `lib/analytics.ts`).
- **`ph-no-capture`** dipasang di: isi pesan inbox (`InboxPage`), input nomor telepon (`PhoneInput` — semua halaman), nama/email customer (`PaymentsDialog`), nama & nomor customer + input edit (`BookingDetailPage` — tidak ada lagi preview prompt mentah sejak redesign).
- Properti event diverifikasi **tanpa PII** oleh test (`analytics.test.ts` server: `not.toHaveProperty('phone'/'email'/'customer_name')`).
- `tracing_headers` (link sesi client↔server) **tidak diaktifkan** — server event sudah merge via `identify(userId)`; menghindari risiko CORS bila API cross-origin.

### 14.5 Test

- `apps/api/src/lib/analytics.test.ts` (11) — no-op tanpa key, forwarding sink, bentuk properti no-PII, group workspace, flush/shutdown.
- `apps/api/src/middleware/analytics.test.ts` (3) — flush per response, flush gagal tidak merusak response, nonaktif aman.
- `apps/web/src/lib/analytics.test.ts` (9) — init/identify/group/track/reset/error dengan fake posthog-js; jalur nonaktif (tanpa token) no-op total.
- Full suite: API 53 file / 734 test ✓, web 17 test ✓, typecheck API + web ✓, `vite build` ✓.

### 14.6 Belum digarap (scope berikutnya)

- `tracing_headers` bila ingin korelasi sesi replay dengan event server (setelah CORS/domain dipastikan same-origin).

---

## 15. Six-Capability Implementation (Product Analytics, AI Calls, Replay, Flags & Experiments, Errors, Surveys)

> Status: **implemented, production-ready, fully tested** (see §15.7). Sections below map each PostHog capability → what was built → how to use it from the dashboard.

### 15.1 Product analytics

**Already flowing** (from the earlier implementation): pageviews auto-captured via `capture_pageview: 'history_change'` (React Router v7 data mode — zero router code), auth events (`signin_started`/`signup_started`), and the full domain taxonomy (`booking.*`, `payment.*`, `subscription.*`, `workspace.created`, `integration.connected`). All events bind to the `workspace` **group**, so every chart can be broken down per business.

**New in this round (client):**

- `onboarding.started` / `onboarding.completed` (`template_category` property) — closes the funnel *signup → workspace → booking*: users who sign up but never finish onboarding are now visible as a drop-off step.
- Person identity already merges client + server events via `identify(userId)` after `/me` (server events from Inngest use `workspace:<id>` or the user id, so they land on the same person).

**How to use in PostHog:**

1. *Product analytics → Trends*: `booking.created` over time; filter by group `workspace`.
2. *Funnels*: `signup_started` → `onboarding.completed` → `booking.created` → `payment.completed`. Every step exists.
3. *Retention*: cohort of `workspace.created` users, follow-up event `booking.created`.

### 15.2 AI call analytics

Server-side events (`call.triggered`, `call.completed`, `call.failed`) already carried `duration_seconds`, `goal_type`, `status`. **New:** every Vapi end-of-call event now includes `ended_reason` (enum, non-PII) — e.g. `customer-ended-call`, `customer-didnt-answer`, `assistant-ended-call`, `error-*` — which is the key dimension for diagnosing *why* calls fail or don't convert.

**How to use in PostHog:**

1. *Trends*: `call.failed` count over time; break down by `ended_reason` → instantly see if failures are technical (`error-*`), no-answers, or customer hang-ups.
2. *Funnel*: `call.completed` → `booking.completed` → call-to-booking conversion.
3. *Insights*: average `duration_seconds` per `goal_type` (reminder calls vs. booking confirmation calls).
4. Optional *dashboard*: three tiles (completed/failed split, avg duration, top `ended_reason`) — no code needed.

### 15.3 Session replay (consent-gated)

Replay is now **on, but only after explicit opt-in** — the privacy posture from §14.4 is replaced by a real consent flow:

**Implementation:**

- `stores/consent.ts` — consent store (`undecided | granted | denied`) persisted to localStorage (`oriole.analytics.consent.v1`), corrupt-value-safe, SSR-safe.
- `app/components/ConsentBanner.tsx` — bottom banner (EN + ID), shown only when analytics is configured **and** no decision has been made. Accept → replay + surveys; decline → stays off; banner never reappears.
- `SettingsDialog` → **Privacy & analytics** section: toggle to enable/disable anytime.
- `main.tsx` / `lib/analytics.ts`: `disable_session_recording: readStoredConsent() !== 'granted'` at init; `applyAnalyticsConsent()` calls `posthog.startSessionRecording()` / `stopSessionRecording()` (idempotent, works without reload).
- **Masking (defense-in-depth):** `session_recording: { maskAllInputs: true, maskTextSelector: '.ph-no-capture' }` on top of the existing `ph-no-capture` classes on inbox messages, phone inputs, and customer details.

**How to use in PostHog:** replays appear under *Replay*. Best practice: set *sampling* (e.g. 10%) in Project Settings → Replay ingestion to control volume, and use a **URL trigger** (`/app/booking`) to record only the booking flow if volume is a concern.

> Legal note: with a consent banner + masking + no-PII events, replay is GDPR/PDP-compliant for most SaaS apps. Still have a privacy policy that mentions session recording.

### 15.4 Feature flags & experiments

**Server (posthog-node 5.48):**

- `lib/analytics.ts` → `getFeatureFlagValue(key, distinctId, { groups, fallback })` built on the **modern `evaluateFlags()` API** (the old `getFeatureFlag()` is deprecated in this SDK) — one `/flags` request, snapshot methods `isEnabled/getFlag`, wrapped in try/catch.
- **Kill-switch semantics:** only a *defined* boolean flag overrides the default; a missing flag or PostHog outage falls back safely (a not-yet-created kill-switch must never silently disable a feature).
- **Wired consumer:** `remindBooking` (Inngest) checks `reminders-enabled` per workspace before dispatching any reminder → turn off all reminders from the PostHog dashboard without a deploy.

**Client (posthog-js + @posthog/react):**

- `lib/analytics.ts` → `isFeatureFlagEnabled(key, fallback)` and `getFeatureFlagPayload(key, fallback)` for non-component code.
- **Live experiment:** `SignUpPage` reads `signup-hero-variant` via `useFeatureFlagPayload`; a JSON payload `{ "cta": "…" }` swaps the sign-up button label. Defaults to the i18n label when the flag doesn't exist — safe to ship before creating the flag.

**How to use in PostHog:**

1. *Feature flags* → create `reminders-enabled` (boolean). Rollout = percentage of workspaces or targeting by group `workspace`. Flip to 0% to kill reminders globally.
2. *Experiments* → create experiment on `signup-hero-variant` with variants, attach JSON payload `{ "cta": ... }` per variant. PostHog evaluates locally (client) and logs `$feature_flag_called`, so experiment results appear automatically.
3. Client flags are evaluated locally from a cached snapshot — first page load may show the fallback for one request; acceptable for marketing copy, and `{ fresh: true }` forces a reload if you ever need it.

### 15.5 Error tracking

Already wired on both sides (§5.4, §13) and now hardened:

- **Client:** `capture_exceptions: true` in the init config (autocaptures uncaught exceptions in addition to the manual `RootErrorBoundary` / `RouteErrorElement` captures); `posthog.captureException` on every routed error.
- **Server:** Hono `onError` → `captureException(err, userId, { path, method, url })` + flush, best-effort (never breaks the response).
- **Best practice now enabled:** use *Error tracking* in PostHog to group by stack trace; because every event carries the `workspace` group, you can see which businesses are affected. Combine with *Replay* (event trigger on `exception` events) to watch the exact user session around a crash.

### 15.6 Surveys

- Surveys are **consent-gated** like replay: `disable_surveys_automatic_display: true` at init, and after opt-in `applyAnalyticsConsent` renders matching surveys into an app-owned container (`#ph-surveys-root`) via `getActiveMatchingSurveys` + `renderSurvey`. Without consent, surveys never appear — no dashboard condition can override that.
- **How to use:** *Surveys* → create (e.g. NPS, or "Why did you cancel?" triggered after `booking.cancelled`). Target by conditions/feature flag. PostHog records responses automatically; responses are tied to the identified person.

### 15.7 What changed (file map) & test status

**Server (`apps/api`):**

- `lib/analytics.ts` — `AnalyticsSink.evaluateFlags?` + `FlagsSnapshot`; `getFeatureFlagValue()` with fallback; `ended_reason` in `captureCallEvent`.
- `inngest/functions.ts` — `reminders-enabled` kill-switch step in `remindBooking`; `ended_reason` passed to `call.completed`/`call.failed`.
- `lib/analytics.test.ts` — 15 tests (flag helper: value-overrides-fallback, undefined→fallback, PostHog-down→fallback; `ended_reason` property).

**Web (`apps/web`):**

- `stores/consent.ts` (+ `consent.test.ts`, 7 tests) — consent store, localStorage persistence, SSR-safe.
- `lib/analytics.ts` (+ tests) — `analyticsInitOptions` (error autocapture, replay masking, replay gated on consent, surveys manual), `applyAnalyticsConsent`, `isFeatureFlagEnabled`, `getFeatureFlagPayload`.
- `main.tsx` — shared init options, consent applied at boot, `<ConsentBanner />` + `#ph-surveys-root`.
- `app/components/ConsentBanner.tsx` — banner (EN/ID).
- `app/shell/SettingsDialog.tsx` — Privacy & analytics section with replay toggle.
- `app/auth/SignUpPage.tsx` — A/B experiment via `useFeatureFlagPayload` (`signup-hero-variant`).
- `app/pages/OnboardingPage.tsx` — `onboarding.started` / `onboarding.completed`.
- `i18n/locales/{en,id}/translation.json` — new `consent` section.

**Verification:** API typecheck ✓, API tests ✓ (59 files / 801 tests incl. 15 analytics), web typecheck ✓, web tests ✓ (29 incl. 14 analytics + 7 consent), i18n key check ✓ (1309 keys, en/id sync), production `vite build` ✓.

**How to turn it on:** keys are already in your `.env` (`POSTHOG_PUBLIC_KEY`/`POSTHOG_HOST`/`VITE_POSTHOG_PROJECT_TOKEN`/`VITE_POSTHOG_HOST`, project 361916, US Cloud). Restart both servers, click **Allow** on the banner once, then create flags/experiments/surveys in the dashboard — the code is live behind them.
