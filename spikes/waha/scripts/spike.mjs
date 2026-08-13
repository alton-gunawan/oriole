#!/usr/bin/env node
/**
 * WAHA spike runner — WhatsApp unofficial integration research.
 *
 * Zero dependencies (Node 18+): uses built-in fetch, node:http, node:fs.
 *
 * Flow:
 *   1. Start a webhook capture listener (binds 0.0.0.0:5055/events) and log
 *      every event WAHA sends (headers + body) to captured/events.jsonl.
 *   2. Create (or reuse) a session named "spike" with per-session webhooks
 *      pointed at the listener.
 *   3. Wait for SCAN_QR_CODE → fetch the QR / pairing code, print it big,
 *      save the QR image to captured/qr.png. If PHONE_NUMBER is set, also
 *      request a pairing code.
 *   4. Wait until the session is WORKING (you pair with your phone), then
 *      POST /api/sendText to TARGET_CHAT_ID and mark seen.
 *   5. Capture events for a few seconds, then run the reference inbound
 *      adapter (map-waha-to-meta.mjs) over the captured message events and
 *      print the resulting Meta-shaped payloads + canonical events.
 *
 * Env vars (all optional):
 *   WAHA_URL, WAHA_API_KEY, WAHA_SESSION (default "spike"),
 *   TARGET_CHAT_ID (e.g. 6281234567890@c.us), PHONE_NUMBER (pairing code),
 *   WEBHOOK_PORT (5055), PAIR_TIMEOUT_SECONDS (180), CAPTURE_SECONDS (20)
 *
 * Run: node scripts/spike.mjs
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WahaClient } from './lib/waha-client.mjs';
import { mapWahaEventToCanonical, mapWahaEventToMeta } from './lib/map-waha-to-meta.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CAPTURED_DIR = path.join(ROOT, 'captured');
const EXAMPLES_DIR = path.join(CAPTURED_DIR, 'examples');
fs.mkdirSync(EXAMPLES_DIR, { recursive: true });

const env = (key, fallback) => process.env[key] ?? fallback;
const BASE_URL = env('WAHA_URL', 'http://localhost:3000');
const API_KEY = env('WAHA_API_KEY', 'spike-waha-change-me-00000000000000000000000000000000');
const SESSION = env('WAHA_SESSION', 'spike');
const TARGET_CHAT_ID = env('TARGET_CHAT_ID', ''); // e.g. 6281234567890@c.us
const PHONE_NUMBER = env('PHONE_NUMBER', '');
const WEBHOOK_PORT = Number(env('WEBHOOK_PORT', '5055'));
const WEBHOOK_URL = env('WEBHOOK_URL', `http://host.docker.internal:${WEBHOOK_PORT}/events`);
const PAIR_TIMEOUT_MS = Number(env('PAIR_TIMEOUT_SECONDS', '180')) * 1000;
const CAPTURE_MS = Number(env('CAPTURE_SECONDS', '20')) * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pretty = (x) => JSON.stringify(x, null, 2);
const banner = (title, body = '') =>
  console.log(`\n${'═'.repeat(64)}\n  ${title}\n${'═'.repeat(64)}\n${body}\n`);

// ── 1. Webhook capture listener ────────────────────────────────
const eventsFile = path.join(CAPTURED_DIR, 'events.jsonl');
let webhookCount = 0;

function startListener() {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = { _parseError: raw.slice(0, 500) };
    }

    webhookCount += 1;
    const record = { headers: { ...req.headers }, body };
    fs.appendFileSync(eventsFile, JSON.stringify(record) + '\n');

    const eventName = body.event ?? '(unknown)';
    console.log(`\n📥 webhook #${webhookCount} — ${eventName} (session: ${body.session ?? '-'})`);
    if (eventName !== 'session.status' || process.env.VERBOSE === '1') {
      console.log(pretty(body));
    } else {
      console.log(`   status: ${body.payload?.status} → ${JSON.stringify(body.payload?.statuses ?? [])}`);
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  return new Promise((resolve) => {
    server.listen(WEBHOOK_PORT, '0.0.0.0', () => resolve(server));
  });
}

function extractQrInfo(json) {
  const qr = json?.qr && typeof json.qr === 'object' ? json.qr : json;
  return {
    status: json?.status ?? null,
    url: typeof qr?.url === 'string' ? qr.url : null,
    expected: qr?.expected ?? json?.expected ?? json?.pairingCode ?? null,
    ttl: qr?.ttl ?? json?.ttl ?? null,
  };
}

function saveQrPng(dataUri) {
  if (!dataUri || !dataUri.startsWith('data:image')) return null;
  const base64 = dataUri.replace(/^data:image\/[^;]+;base64,/, '');
  const file = path.join(CAPTURED_DIR, 'qr.png');
  fs.writeFileSync(file, Buffer.from(base64, 'base64'));
  return file;
}

// ── 4. Wait helpers ────────────────────────────────────────────
async function waitForStatus(client, name, targets, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const session = await client.getSession(name);
      last = session?.status ?? null;
      if (targets.includes(last)) return session;
    } catch {
      /* session may not exist yet */
    }
    await sleep(2000);
  }
  return last;
}

// ── Main ───────────────────────────────────────────────────────
async function main() {
  console.log(`WAHA spike — ${BASE_URL} (session "${SESSION}")`);
  console.log(`Webhook listener → ${WEBHOOK_URL} (host.docker.internal:${WEBHOOK_PORT})`);
  if (!TARGET_CHAT_ID) {
    console.log('⚠️  TARGET_CHAT_ID not set — sending will be skipped (set e.g. TARGET_CHAT_ID=6281234567890@c.us).');
  }

  const server = await startListener();
  console.log(`👂 Listening for WAHA webhooks on 0.0.0.0:${WEBHOOK_PORT}/events → captured/events.jsonl\n`);

  const client = new WahaClient({ baseUrl: BASE_URL, apiKey: API_KEY });

  // 2. Create or reuse the session
  const existing = (await client.listSessions()).find((s) => s.name === SESSION);
  let session;
  if (existing) {
    console.log(`♻️  Reusing existing session "${SESSION}" (status: ${existing.status}).`);
    session = existing;
  } else {
    console.log(`🚀 Creating session "${SESSION}" with webhooks → ${WEBHOOK_URL}`);
    try {
      session = await client.createSession(SESSION, {
        webhooks: [
          {
            url: WEBHOOK_URL,
            // message = inbound only; message.any = also outbound echoes —
            // subscribe to both here for CAPTURE completeness; the real
            // connector should subscribe to `message` alone (dedup by
            // payload.id still protects the adapter demo below).
            events: ['message', 'message.any', 'message.ack', 'session.status'],
          },
        ],
      });
    } catch (err) {
      if (err.status === 409) {
        // Created concurrently by another run — reuse it.
        console.log('♻️  Session already existed (409) — reusing.');
        session = await client.getSession(SESSION);
      } else {
        throw err;
      }
    }
    console.log(pretty(session));
  }

  // 3. Auth: QR / pairing code
  const current = await waitForStatus(client, SESSION, ['SCAN_QR_CODE', 'WORKING', 'FAILED'], 30_000);
  console.log(`\nSession status: ${current ?? 'unknown'}`);

  if (current === 'FAILED') {
    console.log('❌ Session FAILED — try: docker compose restart waha, then delete the session and rerun.');
    await finish(server, 1);
    return;
  }

  if (current !== 'WORKING') {
    banner('📱 PAIR THE SESSION', [
      '1. WhatsApp app → Linked devices → Link a device',
      '2. Scan captured/qr.png (printed below) — or tap "Link with phone number instead"',
      '   and type the pairing code.',
      '3. The script waits automatically; status flips to WORKING.',
    ].join('\n'));

    // QR is only available once SCAN_QR_CODE fires; retry briefly in case the
    // session was still STARTING when we checked.
    let qr = null;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        qr = extractQrInfo(await client.getQr(SESSION));
        if (qr.url || qr.expected) break;
      } catch {
        /* not ready yet */
      }
      console.log(`⏳ QR not available yet (attempt ${attempt}/5)…`);
      await sleep(3000);
    }
    if (!qr || (!qr.url && !qr.expected)) {
      console.log('❌ Could not fetch the QR — is the session in SCAN_QR_CODE state?');
      console.log('   Check container logs: docker compose logs -f waha');
      await finish(server, 1);
      return;
    }
    if (qr.expected) {
      banner(`🔑 PAIRING CODE (NOWEB)\n  ${qr.expected}`);
    }
    const qrFile = saveQrPng(qr.url);
    console.log(`\nQR: ${qr.url ? 'saved to captured/qr.png' : 'no image in response'}`);
    console.log(`Expected/pairing code: ${qr.expected ?? '(none in response)'}`);
    console.log(`QR ttl: ${qr.ttl ?? 'n/a'}s  — refetch if it expires (event SCAN_QR_CODE fires again).`);
    if (qrFile) console.log(`Open the QR image:  open captured/qr.png`);

    if (PHONE_NUMBER) {
      console.log(`\n📲 Requesting pairing code for ${PHONE_NUMBER}...`);
      const code = await client.requestPairingCode(SESSION, PHONE_NUMBER);
      banner('🔑 PAIRING CODE RESPONSE', pretty(code));
    }
    console.log(`\nAlso check container logs — WAHA_PRINT_QR=true prints the QR there:\n  docker compose logs -f waha`);

    const reached = await waitForStatus(client, SESSION, ['WORKING', 'FAILED'], PAIR_TIMEOUT_MS);
    if (reached !== 'WORKING') {
      console.log(`⏳ Timed out after ${PAIR_TIMEOUT_MS / 1000}s (last status: ${reached}).`);
      console.log('Pair the session and re-run the script — it reuses the session.');
      await finish(server, 0);
      return;
    }
    console.log('✅ Session is WORKING!');
  }

  const me = await client.getMe(SESSION);
  console.log(`\n🆔 me: ${pretty(me)}`);

  // 4. Send a test message
  if (TARGET_CHAT_ID) {
    banner('✉️  Sending test text', `→ ${TARGET_CHAT_ID}`);
    const sent = await client.sendText(SESSION, TARGET_CHAT_ID, `Spike from WAHA (NOWEB) @ ${new Date().toISOString()}`);
    console.log(pretty(sent));
    try {
      const seen = await client.sendSeen(SESSION, TARGET_CHAT_ID);
      console.log(`\n👁 sendSeen: ${pretty(seen)}`);
    } catch {
      /* sendSeen is best-effort */
    }
  }

  // 5. Capture window — ask the user to send an inbound message
  banner('📥 CAPTURING WEBHOOKS', [
    `Listening for ${CAPTURE_MS / 1000}s...`,
    TARGET_CHAT_ID
      ? 'Send a WhatsApp message to the paired number to capture an inbound payload.'
      : 'Set TARGET_CHAT_ID on the next run to also exercise outbound + message.ack.',
  ].join('\n'));

  await sleep(CAPTURE_MS);

  // Examples: first event of each type
  const seenTypes = new Set();
  const lines = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean) : [];
  for (const line of lines) {
    const { body } = JSON.parse(line);
    const type = body.event ?? 'unknown';
    if (!seenTypes.has(type)) {
      seenTypes.add(type);
      fs.writeFileSync(path.join(EXAMPLES_DIR, `${type.replace(/\W+/g, '-')}.json`), pretty(body) + '\n');
    }
  }

  // Adapter demo: map captured inbound message events
  const messageEvents = lines
    .map((line) => JSON.parse(line).body)
    .filter((body) => body.event === 'message');
  const unique = [...new Map(messageEvents.map((e) => [e.payload?.id, e])).values()];

  banner('🔀 ADAPTER DEMO — WAHA → app types', `${unique.length} unique inbound message event(s) captured`);
  const adapterLines = [];
  for (const evt of unique) {
    const meta = mapWahaEventToMeta(evt);
    const canonical = mapWahaEventToCanonical(evt);
    console.log(`\n--- WAHA event ${evt.payload?.id} ---`);
    console.log('→ WhatsAppWebhookPayload (feeds parseWhatsAppWebhook):');
    console.log(meta ? pretty(meta) : '(skipped)');
    console.log('→ CanonicalInboundEvent (feeds handleWhatsAppUpdate):');
    console.log(canonical ? pretty(canonical) : '(skipped)');
    adapterLines.push(JSON.stringify({ waha: evt, meta, canonical }));
  }
  if (adapterLines.length) {
    fs.writeFileSync(path.join(CAPTURED_DIR, 'adapter-output.jsonl'), adapterLines.join('\n') + '\n');
  }

  await finish(server, 0);
}

async function finish(server, code) {
  const lines = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean) : [];
  const capturedCount = webhookCount;
  const types = {};
  for (const line of lines) {
    const type = JSON.parse(line).body.event ?? 'unknown';
    types[type] = (types[type] ?? 0) + 1;
  }

  const summary = [
    '# WAHA spike — captured output',
    '',
    `- Run finished: ${new Date().toISOString()}`,
    `- Webhook events captured: ${capturedCount}`,
    `- By type: ${JSON.stringify(types)}`,
    `- Raw log: events.jsonl (headers + bodies)`,
    `- First example per type: examples/`,
    `- Adapter output (WAHA → Meta → Canonical): adapter-output.jsonl`,
    `- QR image: qr.png`,
    '',
    'The adapter is unit-tested — re-run:',
    '```bash',
    'node --test spikes/waha/scripts/lib/map-waha-to-meta.test.mjs',
    '```',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(CAPTURED_DIR, 'README.md'), summary);

  banner('📊 SUMMARY', `webhooks captured: ${capturedCount}\nby type: ${JSON.stringify(types, null, 2)}\n\nfiles:\n  captured/events.jsonl\n  captured/examples/\n  captured/adapter-output.jsonl\n  captured/README.md`);

  server?.close(); // may be null on SIGINT before the listener started
  process.exit(code);
}

process.on('SIGINT', async () => {
  console.log('\n\n⏹ Interrupted — finishing...');
  await finish(null, 130);
});

main().catch((err) => {
  console.error('\n💥 Spike failed:', err.message ?? err);
  if (err.body) console.error(pretty(err.body));
  process.exit(1);
});
