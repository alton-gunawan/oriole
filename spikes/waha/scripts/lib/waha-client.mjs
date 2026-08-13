/**
 * Minimal WAHA REST client — zero dependencies (Node 18+ fetch).
 *
 * Endpoints implemented (all verified against the official docs, 2026.7):
 *   GET  /api/sessions?all=true                 list sessions
 *   GET  /api/sessions/{name}                   get session
 *   POST /api/sessions                          create + start session
 *   POST /api/sessions/{name}/start|stop        control
 *   GET  /api/sessions/{name}/me                own contact (when WORKING)
 *   POST /api/{name}/auth/qr                    get QR (GET worked historically)
 *   POST /api/{name}/auth/request-code          pairing code
 *   POST /api/sendText                          send text message
 *   POST /api/sendSeen                          mark chat as read
 *
 * Auth: X-Api-Key header (WAHA_API_KEY env of the container).
 */

export class WahaError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'WahaError';
    this.status = status;
    this.body = body;
  }
}

export class WahaClient {
  constructor({ baseUrl = 'http://localhost:3000', apiKey = '' } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
  }

  headers(extra = {}) {
    return {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-api-key': this.apiKey,
      ...extra,
    };
  }

  /** Raw request — resolves to { ok, status, json } instead of throwing (for QR probing). */
  async requestRaw(method, path, body) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, json };
  }

  async request(method, path, body) {
    const { ok, status, json } = await this.requestRaw(method, path, body);
    if (!ok) {
      throw new WahaError(`WAHA ${method} ${path} → ${status}: ${JSON.stringify(json)}`, status, json);
    }
    return json;
  }

  // ── Sessions ────────────────────────────────────────────────

  listSessions() {
    return this.request('GET', '/api/sessions?all=true');
  }

  getSession(name) {
    return this.request('GET', `/api/sessions/${name}`);
  }

  createSession(name, config = {}) {
    return this.request('POST', '/api/sessions', { name, config });
  }

  startSession(name) {
    return this.request('POST', `/api/sessions/${name}/start`);
  }

  stopSession(name) {
    return this.request('POST', `/api/sessions/${name}/stop`);
  }

  getMe(name) {
    return this.request('GET', `/api/sessions/${name}/me`);
  }

  // ── Auth ────────────────────────────────────────────────────

  /**
   * Fetch the QR code. Current docs (2026.7) list POST /api/{session}/auth/qr;
   * GET was the historical verb — try both so the spike works across versions.
   * Response shape (version-dependent — see README): the QR data URI lives at
   * `.qr.url` (base64 PNG) and the pairing-code text at `.qr.expected`.
   */
  async getQr(name) {
    const attempts = [
      ['POST', `/api/${name}/auth/qr`],
      ['GET', `/api/${name}/auth/qr`],
    ];
    let lastError;
    for (const [method, path] of attempts) {
      const res = await this.requestRaw(method, path);
      if (res.ok && res.json) return res.json;
      lastError = res.json ?? null;
    }
    throw new WahaError(`QR fetch failed (POST+GET): ${JSON.stringify(lastError)}`);
  }

  /** Request a pairing code (NOWEB flow — "Link with phone number instead"). */
  requestPairingCode(name, phoneNumber) {
    return this.request('POST', `/api/${name}/auth/request-code`, { phoneNumber });
  }

  // ── Messaging ───────────────────────────────────────────────

  /** chatId format: <international number without +>@c.us, e.g. 6281234567890@c.us */
  sendText(session, chatId, text) {
    return this.request('POST', '/api/sendText', { session, chatId, text });
  }

  sendSeen(session, chatId, messageIds) {
    const body = { session, chatId };
    if (messageIds?.length) body.messageIds = messageIds;
    return this.request('POST', '/api/sendSeen', body);
  }
}
