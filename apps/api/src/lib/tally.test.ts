import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createHmac } from 'node:crypto';

// tally.ts mengimpor env + db → env divalidasi saat modul dimuat. Test ini
// hanya memakai fungsi murni + fetch mock — stub env & db cukup (pola sama
// dengan form-booking.test.ts).
vi.mock('../lib/env.ts', () => ({
  env: { API_URL: 'https://api.example.com', NODE_ENV: 'test' },
}));
vi.mock('../db/index.ts', () => ({ db: {} }));

import {
  extractContactFromTallySubmission,
  listTallyForms,
  registerTallyWebhook,
  verifyTallySignature,
  type TallyWebhookPayload,
} from './tally.ts';

/* ────────────────────────────────────────────────────────────
 * Signature webhook Tally (base64 HMAC-SHA256 dari raw body)
 * ──────────────────────────────────────────────────────────── */

describe('verifyTallySignature', () => {
  const secret = 'supersecret';
  const rawBody = JSON.stringify({
    eventId: 'evt-1',
    eventType: 'FORM_RESPONSE',
    data: { formId: 'form-abc', fields: [] },
  });

  function sign(body: string): string {
    return createHmac('sha256', secret).update(body, 'utf8').digest('base64');
  }

  it('menerima signature valid (base64)', () => {
    expect(verifyTallySignature(rawBody, secret, sign(rawBody))).toBe(true);
  });

  it('menolak signature salah', () => {
    expect(verifyTallySignature(rawBody, secret, sign(rawBody + 'x'))).toBe(false);
  });

  it('menolak body kosong / signature kosong', () => {
    expect(verifyTallySignature(rawBody, secret, '')).toBe(false);
  });
});

/* ────────────────────────────────────────────────────────────
 * Ekstraksi kontak dari submission
 * ──────────────────────────────────────────────────────────── */

describe('extractContactFromTallySubmission', () => {
  function payload(fields: Record<string, unknown>[]): TallyWebhookPayload {
    return {
      eventId: 'evt-1',
      eventType: 'FORM_RESPONSE',
      data: {
        responseId: 'r1',
        submissionId: 's1',
        formId: 'form-abc',
        fields: fields as TallyWebhookPayload['data']['fields'],
      },
    };
  }

  it('memetakan field bertipe phone/email + nama + catatan', () => {
    const contact = extractContactFromTallySubmission(
      payload([
        { key: 'q-name', label: 'Nama lengkap', type: 'INPUT_TEXT', value: 'Budi' },
        { key: 'q-phone', label: 'Nomor HP', type: 'INPUT_PHONE_NUMBER', value: '+62 812-3456-7890' },
        { key: 'q-email', label: 'Email', type: 'INPUT_EMAIL', value: 'budi@example.com' },
        { key: 'q-notes', label: 'Catatan', type: 'TEXTAREA', value: 'Minta ruang dekat jendela' },
      ]),
    );
    expect(contact.name).toBe('Budi');
    expect(contact.phone).toBe('+6281234567890');
    expect(contact.email).toBe('budi@example.com');
    expect(contact.notes).toBe('Minta ruang dekat jendela');
  });

  it('nilai pilihan (array ID) → teks option', () => {
    const contact = extractContactFromTallySubmission(
      payload([
        {
          key: 'q-phone',
          label: 'Phone number',
          type: 'MULTIPLE_CHOICE',
          value: ['opt-b'],
          options: [
            { id: 'opt-a', text: '0812 1111 2222' },
            { id: 'opt-b', text: '0813 3333 4444' },
          ],
        },
      ]),
    );
    // label "Phone number" + pilihan → nilai teks option yang terpilih
    // (normalizePhone hanya menghapus non-digit, format lokal dipertahankan).
    expect(contact.phone).toBe('081333334444');
  });

  it('submission tanpa data kontak → semua null', () => {
    const contact = extractContactFromTallySubmission(payload([]));
    expect(contact).toEqual({ name: null, phone: null, email: null, notes: null });
  });
});

/* ────────────────────────────────────────────────────────────
 * API Tally (list forms + register webhook) — fetch di-stub
 * ──────────────────────────────────────────────────────────── */

describe('Tally API', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('listTallyForms memetakan items → {id, title}', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        items: [
          { id: 'nGM0Py', name: 'Form Booking', numberOfSubmissions: 3 },
          { id: 'aBcDeF', name: 'Form Kontak' },
        ],
        total: 2,
        hasMore: false,
      }),
    });

    const forms = await listTallyForms('tly_test');
    expect(forms).toEqual([
      { id: 'nGM0Py', title: 'Form Booking' },
      { id: 'aBcDeF', title: 'Form Kontak' },
    ]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.tally.so/forms?limit=500');
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer tly_test' });
  });

  it('registerTallyWebhook mengirim eventTypes FORM_RESPONSE + signingSecret', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'wh-1', url: 'https://api.tally.so/webhooks/wh-1', isEnabled: true }),
    });

    const result = await registerTallyWebhook('tly_test', 'nGM0Py', 'https://api.example.com/api/webhooks/tally/ws-1', 'secret');
    expect(result.id).toBe('wh-1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.tally.so/webhooks');
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toMatchObject({
      formId: 'nGM0Py',
      url: 'https://api.example.com/api/webhooks/tally/ws-1',
      eventTypes: ['FORM_RESPONSE'],
      signingSecret: 'secret',
    });
  });

  it('non-2xx → TallyApiError dengan pesan API', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ message: 'Invalid API key' }),
    });
    await expect(listTallyForms('tly_bad')).rejects.toMatchObject({
      name: 'TallyApiError',
      status: 401,
    });
  });
});
