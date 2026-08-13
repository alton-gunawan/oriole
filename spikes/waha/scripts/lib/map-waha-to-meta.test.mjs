/**
 * Unit tests for the WAHA → Meta adapter.
 * Run: node --test spikes/waha/scripts/lib/map-waha-to-meta.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  chatIdToWaId,
  mapWahaEventToCanonical,
  mapWahaEventToMeta,
} from './map-waha-to-meta.mjs';

const WAHA_MESSAGE_ID = 'false_6281234567890@c.us_3EB0CAAAAAAAAAAAAAAAAAAAAAAAA';
const EVENT_ID = 'evt_01k3xyz0000000000000000000';

function wahaMessageEvent(overrides = {}) {
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

test('chatIdToWaId strips @c.us / @s.whatsapp.net / @lid', () => {
  assert.equal(chatIdToWaId('6281234567890@c.us'), '6281234567890');
  assert.equal(chatIdToWaId('6281234567890@s.whatsapp.net'), '6281234567890');
  assert.equal(chatIdToWaId('12345@lid'), '12345');
  assert.equal(chatIdToWaId(null), null);
});

test('inbound text message → Meta shape the existing parser accepts', () => {
  const meta = mapWahaEventToMeta(wahaMessageEvent());
  const value = meta.entry[0].changes[0].value;
  const message = value.messages[0];

  assert.equal(meta.object, 'whatsapp_business_account');
  assert.equal(meta.entry[0].id, 'spike');
  assert.equal(meta.entry[0].changes[0].field, 'messages');
  assert.equal(value.messaging_product, 'whatsapp');
  // wa_id = from minus @c.us (this is what parseWhatsAppWebhook reads)
  assert.equal(message.from, '6281234567890');
  // WAHA message id doubles as the idempotency key ("wamid")
  assert.equal(message.id, WAHA_MESSAGE_ID);
  assert.equal(message.timestamp, '1755000000');
  assert.equal(message.type, 'text');
  assert.equal(message.text.body, 'Halo!');
  // own number → metadata (phone_number_id is what the app maps to wa_id)
  assert.deepEqual(value.metadata, {
    display_phone_number: '6281111111111',
    phone_number_id: '6281111111111',
  });
});

test('outbound echo (fromMe: true) → null', () => {
  assert.equal(mapWahaEventToMeta(wahaMessageEvent({ payload: { ...wahaMessageEvent().payload, fromMe: true } })), null);
});

test('non-message events (session.status, message.ack) → null', () => {
  assert.equal(mapWahaEventToMeta({ id: EVENT_ID, event: 'session.status', payload: { status: 'WORKING' } }), null);
  assert.equal(mapWahaEventToMeta({ id: EVENT_ID, event: 'message.ack', payload: { id: WAHA_MESSAGE_ID } }), null);
  assert.equal(mapWahaEventToMeta(null), null);
});

test('media messages → null (parser ignores non-text too)', () => {
  assert.equal(
    mapWahaEventToMeta(
      wahaMessageEvent({ payload: { ...wahaMessageEvent().payload, hasMedia: true } }),
    ),
    null,
  );
});

test('canonical mapping mirrors parseWhatsAppWebhook field expectations', () => {
  const canonical = mapWahaEventToCanonical(wahaMessageEvent());
  assert.equal(canonical.channel, 'whatsapp');
  assert.equal(canonical.providerEventId, WAHA_MESSAGE_ID);
  assert.equal(canonical.senderIdentifier, '6281234567890');
  assert.equal(canonical.content, 'Halo!');
  assert.equal(canonical.intent, 'text');
  assert.equal(canonical.receivedAt, new Date(1755000000 * 1000).toISOString());
  assert.equal(canonical.senderName, null);
  assert.equal(canonical.raw.session, 'spike');
});
