import { describe, expect, it } from 'vitest';

import {
  chatIdToWaId,
  mapWahaEventToMeta,
  type WahaWebhookEvent,
} from './waha-mapping.ts';

const WAHA_MESSAGE_ID = 'false_6281234567890@c.us_3EB0CAAAAAAAAAAAAAAAAAAAAAAAA';
const EVENT_ID = 'evt_01k3xyz0000000000000000000';

function wahaMessageEvent(overrides: Partial<WahaWebhookEvent> = {}): WahaWebhookEvent {
  return {
    id: EVENT_ID,
    timestamp: 1755000000000,
    event: 'message',
    session: 'spike',
    me: { id: '6281111111111@c.us', pushName: 'Oriole' },
    engine: 'NOWEB',
    environment: { version: '2026.7.2' },
    payload: {
      id: WAHA_MESSAGE_ID,
      timestamp: 1755000000,
      from: '6281234567890@c.us',
      fromMe: false,
      to: 'me',
      body: 'Halo!',
      hasMedia: false,
      ack: 1,
    },
    ...overrides,
  };
}

describe('chatIdToWaId', () => {
  it('menghilangkan @c.us / @s.whatsapp.net / @lid', () => {
    expect(chatIdToWaId('6281234567890@c.us')).toBe('6281234567890');
    expect(chatIdToWaId('6281234567890@s.whatsapp.net')).toBe('6281234567890');
    expect(chatIdToWaId('12345@lid')).toBe('12345');
    expect(chatIdToWaId(null)).toBeNull();
    expect(chatIdToWaId(undefined)).toBeNull();
  });
});

describe('mapWahaEventToMeta', () => {
  it('pesan teks masuk → bentuk Meta yang diterima parseWhatsAppWebhook', () => {
    const meta = mapWahaEventToMeta(wahaMessageEvent());
    expect(meta).not.toBeNull();
    const value = meta!.entry![0].changes![0].value!;
    const message = value.messages![0];

    expect(meta!.object).toBe('whatsapp_business_account');
    expect(meta!.entry![0].id).toBe('spike');
    expect(meta!.entry![0].changes![0].field).toBe('messages');
    expect(value.messaging_product).toBe('whatsapp');
    // wa_id = from minus @c.us — inilah yang dibaca parseWhatsAppWebhook
    expect(message.from).toBe('6281234567890');
    // id WAHA menggandakan kunci idempotency ("wamid")
    expect(message.id).toBe(WAHA_MESSAGE_ID);
    expect(message.timestamp).toBe('1755000000');
    expect(message.type).toBe('text');
    expect(message.text?.body).toBe('Halo!');
    // nomor sendiri → metadata (phone_number_id = wa_id akun)
    expect(value.metadata).toEqual({
      display_phone_number: '6281111111111',
      phone_number_id: '6281111111111',
    });
  });

  it('echo outbound (fromMe true) → null', () => {
    expect(
      mapWahaEventToMeta(
        wahaMessageEvent({ payload: { ...(wahaMessageEvent().payload as object), fromMe: true } }),
      ),
    ).toBeNull();
  });

  it('event non-message (session.status, message.ack) → null', () => {
    expect(mapWahaEventToMeta({ id: EVENT_ID, event: 'session.status', payload: { status: 'WORKING' } })).toBeNull();
    expect(mapWahaEventToMeta({ id: EVENT_ID, event: 'message.ack', payload: { id: WAHA_MESSAGE_ID } })).toBeNull();
    expect(mapWahaEventToMeta(null as unknown as WahaWebhookEvent)).toBeNull();
  });

  it('event message.any (pesan teks masuk) → tetap dipetakan', () => {
    const meta = mapWahaEventToMeta(wahaMessageEvent({ event: 'message.any' }));
    expect(meta).not.toBeNull();
    expect(meta!.entry![0].changes![0].value!.messages![0]!.text?.body).toBe('Halo!');
  });

  it('pesan media → null (parser app juga mengabaikan non-teks)', () => {
    expect(
      mapWahaEventToMeta(
        wahaMessageEvent({ payload: { ...(wahaMessageEvent().payload as object), hasMedia: true } }),
      ),
    ).toBeNull();
  });

  it('tanpa me → metadata tidak ada (bukan undefined)', () => {
    const meta = mapWahaEventToMeta(wahaMessageEvent({ me: null }));
    expect(meta!.entry![0].changes![0].value!.metadata).toBeUndefined();
    expect('metadata' in meta!.entry![0].changes![0].value!).toBe(false);
  });
});


