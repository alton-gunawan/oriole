import { describe, expect, it } from 'vitest';

import {
  formatSlotTime,
  parseSlotTime,
  renderAiDisabledReply,
  renderAiHandoffReply,
  renderAskPhoneReply,
  renderBookingReminder,
  renderBusinessInfoReply,
  renderFormInvitation,
  renderNoBookingReply,
  renderNoFormReply,
  renderPhoneMismatchReply,
  renderOptOutReply,
} from './render.ts';
import { buildCallbackData } from './parse.ts';

const BOOKING_ID = '550e8400-e29b-41d4-a716-446655440000';

const reminderInput = {
  businessName: 'Klinik Gigi Sehat',
  customerName: 'Budi',
  title: 'Scaling Gigi',
  scheduledAt: '2026-08-15T07:00:00.000Z',
  timezone: 'Asia/Jakarta',
};

describe('renderBookingReminder', () => {
  it('default bahasa Inggris: nama bisnis, judul booking, waktu terformat (en-US), tombol EN', () => {
    const rendered = renderBookingReminder(reminderInput, BOOKING_ID);
    expect(rendered.text).toContain('Klinik Gigi Sehat');
    expect(rendered.text).toContain('Scaling Gigi');
    expect(rendered.text).toContain('Hello Budi! 👋');
    expect(rendered.text).toContain('Please confirm your attendance:');
    // 07:00 UTC = 14:00 WIB (Asia/Jakarta, UTC+7) → en-US
    expect(rendered.text).toContain('2:00 PM');
    expect(rendered.text).toContain('August');

    expect(rendered.buttons.map((b) => b.label)).toEqual([
      '✅ Yes, I will attend',
      '📅 Reschedule',
      '❌ Cancel',
    ]);
  });

  it('bahasa Indonesia (id) → copy + tombol ID, waktu id-ID', () => {
    const rendered = renderBookingReminder(reminderInput, BOOKING_ID, 'id');
    expect(rendered.text).toContain('Halo Budi! 👋');
    expect(rendered.text).toContain('Silakan konfirmasi kehadiran Anda:');
    expect(rendered.text).toContain('14.00');
    expect(rendered.text).toContain('Agustus');
    expect(rendered.buttons.map((b) => b.label)).toEqual([
      '✅ Ya, hadir',
      '📅 Ubah jadwal',
      '❌ Batalkan',
    ]);
  });

  it('menghasilkan tombol confirm / reschedule / cancel dengan callback data booking', () => {
    const rendered = renderBookingReminder(reminderInput, BOOKING_ID);
    expect(rendered.buttons.map((b) => b.id)).toEqual([
      buildCallbackData(BOOKING_ID, 'confirm'),
      buildCallbackData(BOOKING_ID, 'reschedule'),
      buildCallbackData(BOOKING_ID, 'cancel'),
    ]);
  });
});

describe('renderFormInvitation', () => {
  it('default Inggris: sapaan customer, nama form, dan URL di baris sendiri', () => {
    const rendered = renderFormInvitation({
      businessName: 'Klinik Gigi Sehat',
      customerName: 'Budi',
      formName: 'Formulir Pendaftaran',
      formUrl: 'https://docs.google.com/forms/d/e/abc/viewform',
    });
    expect(rendered).toContain('Hello Budi! 👋');
    expect(rendered).toContain('Formulir Pendaftaran');
    expect(rendered).toContain('Klinik Gigi Sehat');
    expect(rendered).toContain('https://docs.google.com/forms/d/e/abc/viewform');
    expect(rendered).toContain('using the following link:');
  });

  it('tanpa nama customer → sapaan generik', () => {
    const rendered = renderFormInvitation({
      formName: 'Formulir Pendaftaran',
      formUrl: 'https://tally.so/r/xyz',
    });
    expect(rendered).toContain('Hello! 👋');
    expect(rendered).not.toContain('undefined');
  });
});

describe('renderAiHandoffReply', () => {
  it('default Inggris: arahkan ke tim (tanpa menyebut AI) + tidak ada placeholder menggantung', () => {
    const rendered = renderAiHandoffReply();
    expect(rendered).toContain('our team');
    expect(rendered).not.toMatch(/AI|bot|asisten|undefined/i);
  });

  it('bahasa Indonesia (id) → menyebut tim kami', () => {
    expect(renderAiHandoffReply('id')).toContain('tim kami');
  });
});

describe('renderAiDisabledReply', () => {
  it('default Inggris: layanan otomatis nonaktif + arahkan ke tim (tanpa placeholder menggantung)', () => {
    const rendered = renderAiDisabledReply();
    expect(rendered).toContain('our team');
    expect(rendered).not.toMatch(/undefined|AI/i);
  });
});

describe('renderNoFormReply', () => {
  it('default Inggris: booking otomatis belum tersedia + arahkan ke admin', () => {
    const rendered = renderNoFormReply();
    expect(rendered).toContain('booking');
    expect(rendered).toContain('admin');
    expect(rendered).not.toContain('undefined');
  });
});

describe('renderBusinessInfoReply', () => {
  it('default Inggris: nama bisnis dan industri workspace', () => {
    const rendered = renderBusinessInfoReply({
      businessName: 'Klinik Gigi Sehat',
      industry: 'Kesehatan',
    });
    expect(rendered).toContain('Klinik Gigi Sehat');
    expect(rendered).toContain('Kesehatan');
    expect(rendered).toContain('Welcome to');
    expect(rendered).not.toContain('undefined');
  });

  it('tanpa industri → sapaan hanya menyebut nama bisnis', () => {
    const rendered = renderBusinessInfoReply({ businessName: 'Studio Kopi Nusantara' });
    expect(rendered).toContain('Studio Kopi Nusantara');
    // Baris sapaan tidak memuat separator industri.
    expect(rendered.split('\n')[0]).not.toContain('—');
    expect(rendered).not.toContain('undefined');
  });

  it('dengan tautan booking → menyertakan URL di baris sendiri', () => {
    const rendered = renderBusinessInfoReply({
      businessName: 'Klinik Gigi Sehat',
      bookingUrl: 'https://docs.google.com/forms/d/e/abc/viewform',
    });
    expect(rendered).toContain('https://docs.google.com/forms/d/e/abc/viewform');
    expect(rendered).toContain('book');
  });

  it('bila nama bisnis kosong → fallback tanpa nama menggantung', () => {
    const rendered = renderBusinessInfoReply({ businessName: '' });
    expect(rendered).toContain('Welcome to');
    expect(rendered).not.toContain('undefined');
  });
});

describe('renderAskPhoneReply', () => {
  it('default Inggris: minta nomor + keyboard request_contact dengan label EN', () => {
    const rendered = renderAskPhoneReply();
    expect(rendered.text).toContain('share your phone number');
    expect(rendered.text).toContain('+6281234567890');
    expect(rendered.requestContact).toEqual({ label: '📱 Share phone number' });
  });

  it('bahasa Indonesia (id): teks ID + label tombol ID, ketikan manual tetap disebutkan', () => {
    const rendered = renderAskPhoneReply('id');
    expect(rendered.text).toContain('bagikan nomor HP');
    expect(rendered.text).toContain('081234567890');
    expect(rendered.requestContact).toEqual({ label: '📱 Bagikan Nomor' });
  });
});

describe('renderNoBookingReply', () => {
  it('default Inggris: jelaskan tidak ada booking aktif + tautan form untuk booking dari awal', () => {
    const rendered = renderNoBookingReply('https://docs.google.com/forms/d/e/abc/viewform');
    expect(rendered).toContain('could not find an active booking');
    expect(rendered).toContain('make a new booking');
    expect(rendered).toContain('https://docs.google.com/forms/d/e/abc/viewform');
    expect(rendered).toContain('message us again');
    expect(rendered).not.toContain('undefined');
  });

  it('bahasa Indonesia (id): arahkan mengisi formulir untuk booking baru', () => {
    const rendered = renderNoBookingReply('https://tally.so/r/xyz', 'id');
    expect(rendered).toContain('tidak menemukan booking aktif');
    expect(rendered).toContain('Mau membuat booking baru?');
    expect(rendered).toContain('https://tally.so/r/xyz');
    expect(rendered).toContain('kirim pesan lagi di sini');
  });

  it('tanpa tautan form → penjelasan + ajakan hubungi lagi, tanpa URL', () => {
    const rendered = renderNoBookingReply(null);
    expect(rendered).toContain('could not find an active booking');
    expect(rendered).not.toContain('http');
    expect(rendered).toContain('message us again');
  });
});

describe('renderPhoneMismatchReply', () => {
  it('default Inggris: menjelaskan ketidakcocokan + hint format 08xx / +62 8xx', () => {
    const rendered = renderPhoneMismatchReply();
    expect(rendered).toContain('does not match');
    expect(rendered).toContain('081234567890');
    expect(rendered).toContain('+6281234567890');
    expect(rendered).not.toContain('undefined');
  });
});

describe('renderOptOutReply', () => {
  it('default Inggris: berhenti menerima pesan + cara berlangganan kembali', () => {
    const rendered = renderOptOutReply();
    expect(rendered).toContain('stopped receiving');
    expect(rendered).toContain('resubscribe');
    expect(rendered).not.toContain('undefined');
  });
});

describe('formatSlotTime', () => {
  it('default en-US + timezone booking', () => {
    const formatted = formatSlotTime('2026-08-15T07:00:00.000Z', 'Asia/Jakarta');
    expect(formatted).toContain('August');
    expect(formatted).toContain('2:00 PM');
  });

  it('id-ID saat language = id', () => {
    const formatted = formatSlotTime('2026-08-15T07:00:00.000Z', 'Asia/Jakarta', 'id');
    expect(formatted).toContain('Agustus');
    expect(formatted).toContain('14.00');
  });
});

describe('parseSlotTime', () => {
  it('mem-parse naive local time di timezone Asia/Jakarta (+7)', () => {
    const parsed = parseSlotTime('2026-08-15 14:00', 'Asia/Jakarta', new Date('2026-01-01T00:00:00Z'));
    expect(parsed?.toISOString()).toBe('2026-08-15T07:00:00.000Z');
  });

  it('mem-parse ISO datetime ber-offset apa adanya', () => {
    const parsed = parseSlotTime(
      '2026-08-15T14:00:00+07:00',
      'Asia/Jakarta',
      new Date('2026-01-01T00:00:00Z'),
    );
    expect(parsed?.toISOString()).toBe('2026-08-15T07:00:00.000Z');
  });

  it('menolak waktu yang sudah lewat', () => {
    expect(parseSlotTime('2020-01-01 10:00', 'UTC', new Date('2026-01-01T00:00:00Z'))).toBeNull();
  });

  it('menolak format yang tidak dikenali', () => {
    expect(parseSlotTime('nanti sore', 'UTC')).toBeNull();
    expect(parseSlotTime('14:00', 'UTC')).toBeNull();
    expect(parseSlotTime('2026-13-40 99:99', 'UTC')).toBeNull();
  });
});
