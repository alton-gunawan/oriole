import { describe, expect, it } from 'vitest';

import { parseWhatsAppWebhook, type WhatsAppWebhookPayload } from './parse.ts';
import { buildCallbackData } from '../telegram/parse.ts';

const BOOKING_ID = '550e8400-e29b-41d4-a716-446655440000';
const WAMID = 'wamid.HBgLNTYyMDAwMDAwMDAwFQIAERgSMjAyNi0wOC0xNQo';

function payloadWithMessages(messages: NonNullable<NonNullable<NonNullable<NonNullable<WhatsAppWebhookPayload['entry']>[number]['changes']>[number]['value']>['messages']>): WhatsAppWebhookPayload {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '1234567890',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '6281234567890', phone_number_id: '0987654321' },
              contacts: [{ profile: { name: 'Budi' }, wa_id: '6281234567890' }],
              messages,
            },
          },
        ],
      },
    ],
  };
}

describe('parseWhatsAppWebhook', () => {
  it('meng-parse pesan teks biasa → intent text dengan wa_id sebagai sender', () => {
    const events = parseWhatsAppWebhook(
      payloadWithMessages([{ from: '6281234567890', id: WAMID, timestamp: '1755000000', type: 'text', text: { body: 'Halo!' } }]),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      channel: 'whatsapp',
      providerEventId: WAMID,
      senderIdentifier: '6281234567890',
      senderName: 'Budi',
      intent: 'text',
      content: 'Halo!',
    });
  });

  it('meng-parse balasan tombol confirm dengan bookingId', () => {
    const events = parseWhatsAppWebhook(
      payloadWithMessages([
        {
          from: '6281234567890',
          id: WAMID,
          timestamp: '1755000000',
          type: 'interactive',
          interactive: { type: 'button_reply', button_reply: { id: buildCallbackData(BOOKING_ID, 'confirm'), title: 'Ya, hadir' } },
        },
      ]),
    );
    expect(events[0]).toMatchObject({ intent: 'confirm', bookingId: BOOKING_ID });
  });

  it('meng-parse tombol stop → opt-out', () => {
    const events = parseWhatsAppWebhook(
      payloadWithMessages([
        {
          from: '6281234567890',
          id: WAMID,
          type: 'interactive',
          interactive: { type: 'button_reply', button_reply: { id: buildCallbackData(BOOKING_ID, 'stop') } },
        },
      ]),
    );
    expect(events[0]).toMatchObject({ intent: 'opt-out', bookingId: null });
  });

  it('meng-parse teks STOP → opt-out', () => {
    const events = parseWhatsAppWebhook(
      payloadWithMessages([{ from: '6281234567890', id: WAMID, type: 'text', text: { body: 'STOP' } }]),
    );
    expect(events[0]?.intent).toBe('opt-out');
  });

  it('menghasilkan satu event per pesan masuk', () => {
    const events = parseWhatsAppWebhook(
      payloadWithMessages([
        { from: '6281', id: 'wamid.1', type: 'text', text: { body: 'satu' } },
        { from: '6281', id: 'wamid.2', type: 'text', text: { body: 'dua' } },
      ]),
    );
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.providerEventId)).toEqual(['wamid.1', 'wamid.2']);
  });

  it('mengembalikan [] untuk payload tanpa pesan (verifikasi/status)', () => {
    expect(parseWhatsAppWebhook({ object: 'whatsapp_business_account', entry: [] })).toEqual([]);
    expect(
      parseWhatsAppWebhook({
        entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: WAMID, status: 'delivered' }] } }] }],
      }),
    ).toEqual([]);
  });

  it('melewatkan pesan tanpa id atau from', () => {
    const events = parseWhatsAppWebhook(
      payloadWithMessages([{ id: 'no-from', type: 'text', text: { body: 'x' } } as never]),
    );
    expect(events).toEqual([]);
  });
});
