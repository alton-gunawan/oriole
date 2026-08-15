import { describe, expect, it, vi } from 'vitest';

// form-booking.ts mengimpor rantai db + inngest/client → env saat modul dimuat.
// Test ini hanya memakai fungsi ekstraksi murni — mock env + db stub cukup.
vi.mock('../lib/env.ts', () => ({
  env: { API_URL: 'https://api.example.com', NODE_ENV: 'test' },
}));
vi.mock('../db/index.ts', () => ({ db: {} }));

import {
  extractBookingFromGoogleResponse,
  extractBookingFromTally,
  parseFormBookingDateTime,
  type FormBookingExtract,
} from './form-booking.ts';
import type { GoogleFormQuestion } from './google-forms.ts';
import type { TallyWebhookPayload } from './tally.ts';

/* ────────────────────────────────────────────────────────────
 * Mapping field form → booking (pure extraction).
 * Tanggal dipakai di masa depan (2026-12) — parseSlotTime menolak
 * waktu yang sudah lewat.
 * ──────────────────────────────────────────────────────────── */

describe('extractBookingFromGoogleResponse', () => {
  const QUESTIONS: GoogleFormQuestion[] = [
    { id: 'q-service', title: 'Layanan' },
    { id: 'q-date', title: 'Tanggal' },
    { id: 'q-time', title: 'Jam' },
    { id: 'q-notes', title: 'Catatan' },
  ];

  const answers = {
    'q-service': { textAnswers: { answers: [{ value: 'Scaling Gigi' }] } },
    'q-date': { textAnswers: { answers: [{ value: '2026-12-20' }] } },
    'q-time': { textAnswers: { answers: [{ value: '14:00' }] } },
    'q-notes': { textAnswers: { answers: [{ value: 'Gigi depan' }] } },
  };

  it('memetakan layanan + tanggal + jam → booking dengan zona waktu default', () => {
    const booking = extractBookingFromGoogleResponse(QUESTIONS, { answers }, 'Form Booking');
    expect(booking.title).toBe('Scaling Gigi');
    expect(booking.scheduledAt).toBe('2026-12-20T07:00:00.000Z'); // 14:00 WIB
    expect(booking.timezone).toBe('Asia/Jakarta');
    expect(booking.description).toBe('Gigi depan');
  });

  it('judul pertanyaan kosong → fallback judul form', () => {
    const booking = extractBookingFromGoogleResponse(
      [{ id: 'q-date', title: 'Tanggal' }],
      { answers: { 'q-date': { textAnswers: { answers: [{ value: '2026-12-20' }] } } } },
      'Formulir Pendaftaran',
    );
    expect(booking.title).toBe('Formulir Pendaftaran');
  });

  it('pertanyaan zona waktu dihormati (bukan default)', () => {
    const questions = [...QUESTIONS, { id: 'q-tz', title: 'Zona waktu' }];
    const booking = extractBookingFromGoogleResponse(
      questions,
      {
        answers: {
          ...answers,
          'q-tz': { textAnswers: { answers: [{ value: 'Asia/Singapore' }] } },
        },
      },
      'Form Booking',
    );
    expect(booking.timezone).toBe('Asia/Singapore');
    // 14:00 SGT = 06:00 UTC.
    expect(booking.scheduledAt).toBe('2026-12-20T06:00:00.000Z');
  });

  it('tanpa tanggal/jam → bukan booking (scheduledAt null)', () => {
    const booking = extractBookingFromGoogleResponse(
      [{ id: 'q-service', title: 'Layanan' }],
      { answers: { 'q-service': { textAnswers: { answers: [{ value: 'X' }] } } } },
      'Form Booking',
    );
    expect(booking.scheduledAt).toBeNull();
  });

  it('tanggal sudah lewat → null (tidak bisa booking masa lalu)', () => {
    const booking = extractBookingFromGoogleResponse(
      QUESTIONS,
      {
        answers: {
          ...answers,
          'q-date': { textAnswers: { answers: [{ value: '2020-01-01' }] } },
        },
      },
      'Form Booking',
    );
    expect(booking.scheduledAt).toBeNull();
  });
});

describe('extractBookingFromTally', () => {
  function payload(overrides: Record<string, unknown> = {}): TallyWebhookPayload {
    return {
      eventId: 'evt-1',
      eventType: 'FORM_RESPONSE',
      createdAt: '2026-01-02T03:00:00.000Z',
      data: {
        responseId: 'resp-1',
        submissionId: 'sub-1',
        formId: 'form-abc',
        formName: 'Form Booking',
        createdAt: '2026-01-02T03:00:00.000Z',
        fields: [
          { key: 'q-service', label: 'Layanan', type: 'INPUT_TEXT', value: 'Konsultasi' },
          { key: 'q-date', label: 'Tanggal', type: 'INPUT_DATE', value: '2026-12-21' },
          { key: 'q-time', label: 'Jam', type: 'INPUT_TIME', value: '10:30' },
        ],
      },
      ...overrides,
    };
  }

  it('memetakan layanan + field bertipe date + jam → booking', () => {
    const booking = extractBookingFromTally(payload());
    expect(booking.title).toBe('Konsultasi');
    expect(booking.scheduledAt).toBe('2026-12-21T03:30:00.000Z'); // 10:30 WIB
    expect(booking.timezone).toBe('Asia/Jakarta');
  });

  it('pilihan multiple choice → teks option (nilai array ID)', () => {
    const p = payload({
      data: {
        responseId: 'resp-2',
        submissionId: 'sub-2',
        formId: 'form-abc',
        fields: [
          {
            key: 'q-service',
            label: 'Layanan',
            type: 'MULTIPLE_CHOICE',
            value: ['opt-b'],
            options: [
              { id: 'opt-a', text: 'Konsultasi' },
              { id: 'opt-b', text: 'Perawatan' },
            ],
          },
          { key: 'q-date', label: 'Tanggal', type: 'INPUT_DATE', value: '2026-12-21' },
          { key: 'q-time', label: 'Jam', type: 'INPUT_TIME', value: '10:30' },
        ],
      },
    });
    const booking = extractBookingFromTally(p);
    expect(booking.title).toBe('Perawatan');
    expect(booking.scheduledAt).toBe('2026-12-21T03:30:00.000Z');
  });

  it('dropdown layanan → teks option (nilai bisa ID string untuk single-select)', () => {
    const p = payload({
      data: {
        responseId: 'resp-2b',
        submissionId: 'sub-2b',
        formId: 'form-abc',
        fields: [
          {
            key: 'q-service',
            label: 'Layanan',
            type: 'DROPDOWN',
            // DROPDOWN single-select: Tally bisa mengirim ID option (string).
            value: 'opt-scaling',
            options: [{ id: 'opt-scaling', text: 'Scaling Gigi' }],
          },
          { key: 'q-date', label: 'Tanggal', type: 'INPUT_DATE', value: '2026-12-21' },
          { key: 'q-time', label: 'Jam', type: 'INPUT_TIME', value: '10:30' },
        ],
      },
    });
    const booking = extractBookingFromTally(p);
    expect(booking.title).toBe('Scaling Gigi');
    expect(booking.scheduledAt).toBe('2026-12-21T03:30:00.000Z');
  });

  it('submission tanpa layanan/tanggal → bukan booking', () => {
    const p = payload({
      data: {
        responseId: 'resp-3',
        submissionId: 'sub-3',
        formId: 'form-abc',
        fields: [],
      },
    });
    const booking: FormBookingExtract = extractBookingFromTally(p);
    expect(booking.title).toBeNull();
    expect(booking.scheduledAt).toBeNull();
  });
});

describe('parseFormBookingDateTime', () => {
  const now = new Date('2026-08-01T00:00:00.000Z');

  it('menggabungkan tanggal DD/MM/YYYY + jam', () => {
    const parsed = parseFormBookingDateTime('20/12/2026', '14:00', 'Asia/Jakarta', now);
    expect(parsed?.toISOString()).toBe('2026-12-20T07:00:00.000Z');
  });

  it('tanggal saja → default jam 09:00', () => {
    const parsed = parseFormBookingDateTime('2026-12-20', null, 'Asia/Jakarta', now);
    expect(parsed?.toISOString()).toBe('2026-12-20T02:00:00.000Z'); // 09:00 WIB
  });

  it('datetime penuh dalam satu jawaban', () => {
    const parsed = parseFormBookingDateTime('2026-12-20 14:00', null, 'Asia/Jakarta', now);
    expect(parsed?.toISOString()).toBe('2026-12-20T07:00:00.000Z');
  });

  it('format tak dikenal → null', () => {
    expect(parseFormBookingDateTime('nanti sore', null, 'Asia/Jakarta', now)).toBeNull();
  });

  it('waktu sudah lewat → null', () => {
    expect(parseFormBookingDateTime('2026-01-01', '10:00', 'Asia/Jakarta', now)).toBeNull();
  });

  it('zona waktu tidak valid → fallback UTC (tidak throw)', () => {
    const parsed = parseFormBookingDateTime('2026-12-20', '14:00', 'Bukan/Zona', now);
    expect(parsed?.toISOString()).toBe('2026-12-20T14:00:00.000Z');
  });
});
