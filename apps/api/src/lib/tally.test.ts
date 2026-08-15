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
  buildTallyBookingFormBlocks,
  createTallyBookingForm,
  extractContactFromTallySubmission,
  extractTallyChatRef,
  INDUSTRY_FORM_PROFILES,
  listTallyForms,
  registerTallyWebhook,
  tallyBookingFormTitle,
  updateTallyBookingForm,
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
 * Token chat asal form (hidden field orioleChatId)
 * ──────────────────────────────────────────────────────────── */

describe('extractTallyChatRef', () => {
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

  it('hidden field orioleChatId → nilai chat id', () => {
    const chatRef = extractTallyChatRef(
      payload([
        { key: 'q-name', label: 'Nama', type: 'INPUT_TEXT', value: 'Budi' },
        { key: 'orioleChatId', label: 'orioleChatId', type: 'HIDDEN_FIELDS', value: '123456789' },
      ]),
    );
    expect(chatRef).toBe('123456789');
  });

  it('tanpa token → null', () => {
    expect(
      extractTallyChatRef(payload([{ key: 'q-name', label: 'Nama', type: 'INPUT_TEXT', value: 'Budi' }])),
    ).toBeNull();
    expect(extractTallyChatRef(payload([]))).toBeNull();
  });

  it('nilai kosong / bukan string → null', () => {
    expect(
      extractTallyChatRef(payload([{ key: 'orioleChatId', label: 'orioleChatId', value: '  ' }])),
    ).toBeNull();
  });
});

/* ────────────────────────────────────────────────────────────
 * Pembuatan form booking (blocks + POST /forms)
 * ──────────────────────────────────────────────────────────── */

describe('buildTallyBookingFormBlocks', () => {
  it('membangun FORM_TITLE + pasangan TITLE/INPUT untuk 6 field booking', () => {
    const blocks = buildTallyBookingFormBlocks({ businessName: 'Klinik Gigi Sehat' });

    // 1 judul form + 6 field × (TITLE + INPUT) = 13 block.
    expect(blocks).toHaveLength(13);
    expect(blocks[0]).toMatchObject({
      type: 'FORM_TITLE',
      groupType: 'TEXT',
      payload: { title: 'Booking Klinik Gigi Sehat' },
    });

    const labels = blocks
      .filter((b) => b.type === 'TITLE')
      .map((b) => b.payload.html);
    expect(labels).toEqual([
      'Nama',
      'Nomor HP / WhatsApp',
      'Layanan',
      'Tanggal',
      'Jam',
      'Catatan',
    ]);

    const inputs = blocks.filter((b) => b.type.startsWith('INPUT_'));
    expect(inputs.map((b) => b.type)).toEqual([
      'INPUT_TEXT',
      'INPUT_PHONE_NUMBER',
      'INPUT_TEXT',
      'INPUT_DATE',
      'INPUT_TIME',
      'INPUT_TEXT',
    ]);
    // Semua wajib kecuali Catatan; nomor memakai format internasional ID.
    expect(inputs.map((b) => b.payload.isRequired)).toEqual([true, true, true, true, true, false]);
    expect(inputs[1].payload).toMatchObject({ internationalFormat: true, defaultCountryCode: 'ID' });
  });

  it('tanpa nama bisnis → judul fallback "Booking"', () => {
    const blocks = buildTallyBookingFormBlocks();
    expect(blocks[0].payload).toMatchObject({ title: 'Booking', html: 'Booking' });
  });

  it('phonePrefill → hidden field `phone` + `name` + default answer pada input', () => {
    const blocks = buildTallyBookingFormBlocks({ phonePrefill: true });
    // 13 block booking + 1 blok HIDDEN_FIELDS (berisi 2 hidden field).
    expect(blocks).toHaveLength(14);
    const hidden = blocks.find((b) => b.type === 'HIDDEN_FIELDS');
    expect(hidden).toMatchObject({ type: 'HIDDEN_FIELDS', groupType: 'HIDDEN_FIELDS' });
    const hiddenFields = (hidden?.payload.hiddenFields as { uuid: string; name: string }[]) ?? [];
    // phone + name (prefill input) + orioleChatId (token chat asal form).
    expect(hiddenFields.map((f) => f.name)).toEqual(['phone', 'name', 'orioleChatId']);
    const phoneUuid = hiddenFields.find((f) => f.name === 'phone')?.uuid;
    const nameUuid = hiddenFields.find((f) => f.name === 'name')?.uuid;

    // Per OpenAPI Tally: hasDefaultAnswer=true + defaultAnswer = referensi
    // Field (type HIDDEN_FIELD) ke hidden field masing-masing, bukan string.
    const phoneInput = blocks.find((b) => b.type === 'INPUT_PHONE_NUMBER');
    expect(phoneInput?.payload.hasDefaultAnswer).toBe(true);
    expect(phoneInput?.payload.defaultAnswer).toMatchObject({
      type: 'HIDDEN_FIELD',
      questionType: 'HIDDEN_FIELDS',
      title: 'phone',
    });
    expect((phoneInput?.payload.defaultAnswer as { uuid: string }).uuid).toBe(phoneUuid);
    expect((phoneInput?.payload.defaultAnswer as { blockGroupUuid: string }).blockGroupUuid).toBe(
      hidden?.groupUuid,
    );

    // Input Nama juga mendapat default answer dari hidden field `name`.
    const nameInput = blocks.find((b) => b.type === 'INPUT_TEXT' && b.payload.hasDefaultAnswer === true);
    expect(nameInput?.payload.defaultAnswer).toMatchObject({
      type: 'HIDDEN_FIELD',
      questionType: 'HIDDEN_FIELDS',
      title: 'name',
    });
    expect((nameInput?.payload.defaultAnswer as { uuid: string }).uuid).toBe(nameUuid);

    // Tanpa phonePrefill → tidak ada default answer / hidden field.
    const plain = buildTallyBookingFormBlocks();
    expect(plain.find((b) => b.type === 'INPUT_PHONE_NUMBER')?.payload.hasDefaultAnswer).toBeUndefined();
    expect(plain.some((b) => b.type === 'HIDDEN_FIELDS')).toBe(false);
  });

  it('layanan dari katalog → DROPDOWN_OPTION per layanan (bukan INPUT_TEXT)', () => {
    const blocks = buildTallyBookingFormBlocks({
      industry: 'dental',
      services: [
        { id: 'svc-1', name: 'Scaling Gigi' },
        { id: 'svc-2', name: 'Bleaching' },
        { id: 'svc-3', name: 'Scaling Gigi' }, // nama dobel dibuang
      ],
    });
    // Service field diganti opsi dropdown — input teks layanan tidak ada lagi.
    // Profil dental: 7 field (nama, telepon, layanan, tanggal, jam, dokter,
    // catatan) minus layanan = 6 INPUT_* tersisa.
    expect(blocks.filter((b) => b.type.startsWith('INPUT_')).length).toBe(6);
    const options = blocks.filter((b) => b.type === 'DROPDOWN_OPTION');
    expect(options).toHaveLength(2);
    expect(options.map((b) => b.payload.text)).toEqual(['Scaling Gigi', 'Bleaching']);
    // Semua opsi berbagi satu groupUuid + urutan index/isFirst/isLast.
    expect(new Set(options.map((b) => b.groupUuid)).size).toBe(1);
    expect(options[0].payload).toMatchObject({ index: 0, isFirst: true, isLast: false });
    expect(options[1].payload).toMatchObject({ index: 1, isFirst: false, isLast: true });
    expect(options.every((b) => b.groupType === 'DROPDOWN')).toBe(true);
    // Judul pertanyaan layanan tetap ada (label industri).
    const title = blocks.find((b) => b.type === 'TITLE' && b.payload.html === 'Perawatan Gigi');
    expect(title).toBeTruthy();
  });

  it('tanpa layanan → layanan tetap INPUT_TEXT (fallback aman)', () => {
    const blocks = buildTallyBookingFormBlocks({ services: [] });
    expect(blocks.some((b) => b.type === 'DROPDOWN_OPTION')).toBe(false);
    expect(blocks.filter((b) => b.type.startsWith('INPUT_')).length).toBe(6);
  });

  it('industri menyesuaikan label layanan + field tambahan (restaurant)', () => {
    const blocks = buildTallyBookingFormBlocks({
      businessName: 'Nonna',
      industry: 'restaurant',
    });

    // 1 judul + (5 base + 2 tambahan + 1 catatan) × 2 block = 1 + 16 = 17.
    expect(blocks).toHaveLength(1 + 8 * 2);

    const labels = blocks
      .filter((b) => b.type === 'TITLE')
      .map((b) => b.payload.html);
    expect(labels).toEqual([
      'Nama',
      'Nomor HP / WhatsApp',
      'Jenis Reservasi',
      'Tanggal',
      'Jam',
      'Jumlah tamu',
      'Acara / keperluan',
      'Catatan',
    ]);
  });

  it('industri dental → label perawatan gigi + field dokter', () => {
    const blocks = buildTallyBookingFormBlocks({ businessName: 'Klinik', industry: 'dental' });
    const labels = blocks
      .filter((b) => b.type === 'TITLE')
      .map((b) => b.payload.html);
    expect(labels).toEqual([
      'Nama',
      'Nomor HP / WhatsApp',
      'Perawatan Gigi',
      'Tanggal',
      'Jam',
      'Dokter yang diinginkan',
      'Catatan',
    ]);
  });

  it('industri tidak dikenal → fallback profil other (Layanan, tanpa tambahan)', () => {
    const blocks = buildTallyBookingFormBlocks({ businessName: 'Bisnis', industry: 'unknown-industry' });
    const labels = blocks
      .filter((b) => b.type === 'TITLE')
      .map((b) => b.payload.html);
    expect(labels).toEqual(['Nama', 'Nomor HP / WhatsApp', 'Layanan', 'Tanggal', 'Jam', 'Catatan']);
  });

  it('setiap industri di INDUSTRY_FORM_PROFILES punya profil valid', () => {
    for (const industry of Object.keys(INDUSTRY_FORM_PROFILES)) {
      const profile = INDUSTRY_FORM_PROFILES[industry as keyof typeof INDUSTRY_FORM_PROFILES];
      expect(profile.serviceLabel.length).toBeGreaterThan(0);
    }
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

  it('createTallyBookingForm POST /forms dengan status PUBLISHED + blocks (prefill phone aktif)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: 'nGM0Py', name: 'Booking Klinik Gigi Sehat' }),
    });

    const form = await createTallyBookingForm('tly_test', { businessName: 'Klinik Gigi Sehat' });
    expect(form).toEqual({
      id: 'nGM0Py',
      name: 'Booking Klinik Gigi Sehat',
      url: 'https://tally.so/r/nGM0Py',
      phonePrefill: true,
      serviceDropdown: false,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.tally.so/forms');
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.status).toBe('PUBLISHED');
    // 13 block booking + 1 hidden field `phone` = 14.
    expect(body.blocks).toHaveLength(14);
    expect(body.blocks[0].type).toBe('FORM_TITLE');
    const phoneInput = body.blocks.find((b: { type: string }) => b.type === 'INPUT_PHONE_NUMBER');
    expect(phoneInput.payload.hasDefaultAnswer).toBe(true);
    expect(phoneInput.payload.defaultAnswer).toMatchObject({
      type: 'HIDDEN_FIELD',
      questionType: 'HIDDEN_FIELDS',
      title: 'phone',
    });
    // Hidden field `phone` + `name` — input nama juga di-prefill.
    const nameInput = body.blocks.find(
      (b: { type: string; payload: { hasDefaultAnswer?: boolean } }) =>
        b.type === 'INPUT_TEXT' && b.payload.hasDefaultAnswer === true,
    );
    expect(nameInput.payload.defaultAnswer).toMatchObject({ type: 'HIDDEN_FIELD', title: 'name' });
    const hidden = body.blocks.find((b: { type: string }) => b.type === 'HIDDEN_FIELDS');
    expect(hidden.payload.hiddenFields).toHaveLength(3);
    expect(hidden.payload.hiddenFields.map((f: { name: string }) => f.name)).toEqual([
      'phone',
      'name',
      'orioleChatId',
    ]);
  });

  it('createTallyBookingForm phonePrefill=false → tanpa hidden field', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: 'nGM0Py', name: 'Booking' }),
    });

    const form = await createTallyBookingForm('tly_test', { phonePrefill: false });
    expect(form.phonePrefill).toBe(false);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.blocks).toHaveLength(13);
    expect(body.blocks.some((b: { type: string }) => b.type === 'HIDDEN_FIELDS')).toBe(false);
    const phoneInput = body.blocks.find((b: { type: string }) => b.type === 'INPUT_PHONE_NUMBER');
    expect(phoneInput.payload.hasDefaultAnswer).toBeUndefined();
  });

  it('createTallyBookingForm — dropdown layanan + prefill diterima (tier 1)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: 'nGM0Py', name: 'Booking' }),
    });
    const form = await createTallyBookingForm('tly_test', {
      services: [{ id: 'svc-1', name: 'Scaling Gigi' }],
    });
    expect(form).toMatchObject({ id: 'nGM0Py', phonePrefill: true, serviceDropdown: true });
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.blocks.some((b: { type: string }) => b.type === 'DROPDOWN_OPTION')).toBe(true);
    expect(body.blocks.some((b: { type: string }) => b.type === 'HIDDEN_FIELDS')).toBe(true);
  });

  it('createTallyBookingForm — prefill ditolak tapi dropdown diterima → tier 2 (dropdown tetap, prefill off)', async () => {
    // Tier 1 (prefill+dropdown) ditolak; tier 2 (dropdown saja) sukses.
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ message: 'HIDDEN_FIELDS unsupported' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 'nGM0Py', name: 'Booking' }),
      });
    const form = await createTallyBookingForm('tly_test', {
      services: [{ id: 'svc-1', name: 'Scaling Gigi' }],
    });
    expect(form).toMatchObject({ id: 'nGM0Py', phonePrefill: false, serviceDropdown: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(secondBody.blocks.some((b: { type: string }) => b.type === 'DROPDOWN_OPTION')).toBe(true);
    expect(secondBody.blocks.some((b: { type: string }) => b.type === 'HIDDEN_FIELDS')).toBe(false);
  });

  it('createTallyBookingForm — semua tier ditolak → error terakhir dilempar', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ message: 'Forbidden' }),
    });
    await expect(
      createTallyBookingForm('tly_test', {
        services: [{ id: 'svc-1', name: 'Scaling Gigi' }],
      }),
    ).rejects.toMatchObject({ name: 'TallyApiError', message: expect.stringContaining('Forbidden') });
  });

  it('createTallyBookingForm — Tally menolak blok prefill → fallback ke form tanpa prefill (tidak gagal)', async () => {
    // Percobaan pertama (dengan prefill) ditolak Tally; retry tanpa prefill sukses.
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ message: 'Invalid block payload' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 'nGM0Py', name: 'Booking Klinik' }),
      });

    const form = await createTallyBookingForm('tly_test', { businessName: 'Klinik Gigi Sehat' });
    expect(form).toEqual({
      id: 'nGM0Py',
      name: 'Booking Klinik',
      url: 'https://tally.so/r/nGM0Py',
      phonePrefill: false,
      serviceDropdown: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(secondBody.blocks).toHaveLength(13);
    expect(secondBody.blocks.some((b: { type: string }) => b.type === 'HIDDEN_FIELDS')).toBe(false);
  });

  it('updateTallyBookingForm PATCH /forms/:id menimpa blocks (industri-aware)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'nGM0Py', name: 'Survey lama' }),
    });

    const form = await updateTallyBookingForm('tly_test', 'nGM0Py', {
      businessName: 'Klinik Gigi Sehat',
      industry: 'dental',
    });
    expect(form).toEqual({
      id: 'nGM0Py',
      name: 'Survey lama',
      url: 'https://tally.so/r/nGM0Py',
      phonePrefill: true,
      serviceDropdown: false,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.tally.so/forms/nGM0Py');
    expect((init as RequestInit).method).toBe('PATCH');
    const body = JSON.parse(String((init as RequestInit).body));
    // status + blocks saja — nama form dashboard tetap milik user.
    expect(body.status).toBe('PUBLISHED');
    expect(body).not.toHaveProperty('name');
    // 1 judul + (5 base + 1 tambahan dental + 1 catatan) × 2 + 1 hidden = 16.
    expect(body.blocks).toHaveLength(1 + 7 * 2 + 1);
    expect(body.blocks[0].type).toBe('FORM_TITLE');
    expect(body.blocks[0].payload).toMatchObject({ title: 'Booking Klinik Gigi Sehat' });
    const labels = body.blocks
      .filter((b: { type: string }) => b.type === 'TITLE')
      .map((b: { payload: { html: string } }) => b.payload.html);
    expect(labels).toContain('Perawatan Gigi');
    expect(labels).toContain('Dokter yang diinginkan');
  });

  it('tallyBookingFormTitle — fallback tanpa nama bisnis', () => {
    expect(tallyBookingFormTitle('Klinik')).toBe('Booking Klinik');
    expect(tallyBookingFormTitle('  ')).toBe('Booking');
    expect(tallyBookingFormTitle(null)).toBe('Booking');
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

  it('Tally tidak merespons dalam 30s → dibatalkan (bukan hang)', async () => {
    vi.useFakeTimers();
    try {
      // Fetch menggantung selamanya (Tally lambat) tapi tetap menghormati
      // signal — saat timer 30s abort, fetch menolak (perilaku fetch asli).
      fetchMock.mockImplementation(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
          }),
      );
      const promise = createTallyBookingForm('tly_test', { businessName: 'Klinik' });
      const assertion = expect(promise).rejects.toThrow('Tally API timeout');
      await vi.advanceTimersByTimeAsync(30_001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
