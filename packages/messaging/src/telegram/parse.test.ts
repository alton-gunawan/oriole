import { describe, expect, it } from 'vitest';

import { buildCallbackData, parseCallbackData, parseTelegramUpdate, isOptOutText } from './parse.ts';
import type { TelegramUpdate } from './parse.ts';

const BOOKING_ID = '550e8400-e29b-41d4-a716-446655440000';

function messageUpdate(text: string, chatId = 12345): TelegramUpdate {
  return {
    update_id: 1001,
    message: {
      message_id: 7,
      date: 1_700_000_000,
      chat: { id: chatId, first_name: 'Budi', type: 'private' },
      text,
    },
  };
}

describe('parseCallbackData', () => {
  it('mem-parse callback data tombol booking', () => {
    const data = buildCallbackData(BOOKING_ID, 'confirm');
    expect(data).toBe(`bk:${BOOKING_ID}:confirm`);
    expect(parseCallbackData(data)).toEqual({ bookingId: BOOKING_ID, action: 'confirm' });
  });

  it('menolak data yang bukan format tombol booking', () => {
    expect(parseCallbackData('confirm')).toBeNull();
    expect(parseCallbackData(`bk:not-a-uuid:confirm`)).toBeNull();
    expect(parseCallbackData(undefined)).toBeNull();
  });
});

describe('isOptOutText', () => {
  it('mengenali perintah berhenti EN & ID', () => {
    expect(isOptOutText('STOP')).toBe(true);
    expect(isOptOutText('stop')).toBe(true);
    expect(isOptOutText('STOP ALL')).toBe(true);
    expect(isOptOutText('BERHENTI')).toBe(true);
  });

  it('tidak mengenali teks biasa', () => {
    expect(isOptOutText('Saya hadir')).toBe(false);
    expect(isOptOutText(undefined)).toBe(false);
  });
});

describe('parseTelegramUpdate', () => {
  it('meng-parse callback query confirm dengan bookingId', () => {
    const event = parseTelegramUpdate({
      update_id: 1001,
      callback_query: {
        id: 'cq-1',
        message: { message_id: 9, chat: { id: 12345 } },
        data: buildCallbackData(BOOKING_ID, 'confirm'),
        from: { first_name: 'Budi' },
      },
    });

    expect(event).toMatchObject({
      channel: 'telegram',
      providerEventId: '1001',
      senderIdentifier: '12345',
      senderName: 'Budi',
      intent: 'confirm',
      bookingId: BOOKING_ID,
    });
  });

  it('meng-parse callback stop → intent opt-out tanpa bookingId', () => {
    const event = parseTelegramUpdate({
      update_id: 1002,
      callback_query: {
        id: 'cq-2',
        message: { message_id: 10, chat: { id: 12345 } },
        data: buildCallbackData(BOOKING_ID, 'stop'),
      },
    });
    expect(event?.intent).toBe('opt-out');
    expect(event?.bookingId).toBeNull();
  });

  it('meng-parse pesan teks biasa → intent text', () => {
    const event = parseTelegramUpdate(messageUpdate('Halo!'));
    expect(event).toMatchObject({ intent: 'text', content: 'Halo!', senderIdentifier: '12345' });
  });

  it('meng-parse kontak (request_contact) → intent contact dengan nomor verified', () => {
    const event = parseTelegramUpdate({
      update_id: 1006,
      message: {
        message_id: 8,
        date: 1_700_000_000,
        chat: { id: 12345, first_name: 'Budi', type: 'private' },
        contact: { phone_number: '+6281234567890', first_name: 'Budi', last_name: 'Santoso', user_id: 98765 },
      },
    });

    expect(event).toMatchObject({
      channel: 'telegram',
      providerEventId: '1006',
      senderIdentifier: '12345',
      senderName: 'Budi Santoso',
      intent: 'contact',
      bookingId: null,
      content: '+6281234567890',
    });
  });

  it('kontak tanpa nomor → diabaikan (bukan intent contact)', () => {
    const event = parseTelegramUpdate({
      update_id: 1007,
      message: {
        message_id: 9,
        date: 1_700_000_000,
        chat: { id: 12345, first_name: 'Budi', type: 'private' },
        contact: { first_name: 'Budi' },
      },
    });
    expect(event).toBeNull();
  });

  it('meng-parse pesan STOP → intent opt-out', () => {
    const event = parseTelegramUpdate(messageUpdate('STOP'));
    expect(event?.intent).toBe('opt-out');
  });

  it('meng-parse user yang memblokir bot → opt-out', () => {
    const event = parseTelegramUpdate({
      update_id: 1003,
      my_chat_member: {
        chat: { id: 12345 },
        new_chat_member: { status: 'kicked' },
      },
    });
    expect(event).toMatchObject({ intent: 'opt-out', senderIdentifier: '12345' });
  });

  it('menolak update dari grup', () => {
    const event = parseTelegramUpdate({
      update_id: 1004,
      message: {
        message_id: 1,
        date: 1,
        chat: { id: -100, type: 'supergroup' },
        text: 'hai',
      },
    });
    expect(event).toBeNull();
  });

  it('menolak update tanpa event relevan', () => {
    expect(parseTelegramUpdate({ update_id: 1005 })).toBeNull();
  });
});
