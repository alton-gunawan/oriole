import { describe, expect, it } from 'vitest';

import { parseLineWebhook, type LineWebhookPayload } from './parse.ts';

function textEvent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    type: 'message',
    timestamp: 1462629479859,
    source: { type: 'user', userId: 'U4af4980629abcdef0123456789' },
    replyToken: 'nHuyWiB7CZP1k',
    message: { id: '325708', type: 'text', text: 'Halo' },
    ...overrides,
  };
}

function payload(events: unknown[]): LineWebhookPayload {
  return { destination: 'Uxxxxxxxxxxxx', events: events as LineWebhookPayload['events'] };
}

describe('parseLineWebhook', () => {
  it('pesan teks biasa → intent text', () => {
    const [event] = parseLineWebhook(payload([textEvent()]));
    expect(event).toMatchObject({
      channel: 'line',
      senderIdentifier: 'U4af4980629abcdef0123456789',
      intent: 'text',
      content: 'Halo',
      providerEventId: 'msg:325708',
    });
    expect(event.raw).toMatchObject({ replyToken: 'nHuyWiB7CZP1k' });
  });

  it('pesan STOP → intent opt-out', () => {
    const [event] = parseLineWebhook(payload([textEvent({ message: { id: '1', type: 'text', text: 'STOP' } })]));
    expect(event.intent).toBe('opt-out');
  });

  it('pesan "mau booking" → intent booking-request', () => {
    const [event] = parseLineWebhook(
      payload([textEvent({ message: { id: '2', type: 'text', text: 'mau booking' } })]),
    );
    expect(event.intent).toBe('booking-request');
  });

  it('pesan non-teks (sticker) → intent text dengan placeholder', () => {
    const [event] = parseLineWebhook(
      payload([textEvent({ message: { id: '3', type: 'sticker', packageId: '1', stickerId: '2' } })]),
    );
    expect(event.intent).toBe('text');
    expect(event.content).toBe('[Stiker]');
  });

  it('postback tombol → intent + bookingId', () => {
    const postback = {
      type: 'postback',
      timestamp: 1462629479859,
      source: { type: 'user', userId: 'U4af4980629abcdef0123456789' },
      replyToken: 'postback-token-1',
      postback: { data: 'bk:550e8400-e29b-41d4-a716-446655440000:confirm' },
    };
    const [event] = parseLineWebhook(payload([postback]));
    expect(event).toMatchObject({
      intent: 'confirm',
      bookingId: '550e8400-e29b-41d4-a716-446655440000',
      content: 'bk:550e8400-e29b-41d4-a716-446655440000:confirm',
      providerEventId: 'postback:postback-token-1',
    });
  });

  it('postback stop → intent opt-out tanpa bookingId', () => {
    const postback = {
      type: 'postback',
      timestamp: 1462629479859,
      source: { type: 'user', userId: 'U4af4980629abcdef0123456789' },
      replyToken: 'postback-token-2',
      postback: { data: 'bk:550e8400-e29b-41d4-a716-446655440000:stop' },
    };
    const [event] = parseLineWebhook(payload([postback]));
    expect(event.intent).toBe('opt-out');
    expect(event.bookingId).toBeNull();
  });

  it('postback data tidak dikenal → dilewati', () => {
    const events = parseLineWebhook(
      payload([
        {
          type: 'postback',
          timestamp: 1,
          source: { type: 'user', userId: 'U1' },
          replyToken: 't',
          postback: { data: 'foo' },
        },
      ]),
    );
    expect(events).toHaveLength(0);
  });

  it('event follow / join / leave diabaikan', () => {
    const events = parseLineWebhook(
      payload([
        { type: 'follow', timestamp: 1, source: { type: 'user', userId: 'U1' } },
        { type: 'join', timestamp: 2, source: { type: 'group', groupId: 'G1' } },
        { type: 'leave', timestamp: 3, source: { type: 'group', groupId: 'G1' } },
        { type: 'beacon', timestamp: 4, source: { type: 'user', userId: 'U1' }, beacon: {} },
      ]),
    );
    expect(events).toHaveLength(0);
  });

  it('pesan dari group/room chat diabaikan', () => {
    const events = parseLineWebhook(
      payload([
        textEvent({ source: { type: 'group', groupId: 'G1', userId: 'U1' } }),
        textEvent({ source: { type: 'room', roomId: 'R1', userId: 'U1' } }),
      ]),
    );
    expect(events).toHaveLength(0);
  });

  it('event tanpa userId / message.id / replyToken → diabaikan', () => {
    const events = parseLineWebhook(
      payload([
        { type: 'message', timestamp: 1, source: { type: 'user' }, message: { id: '1', type: 'text', text: 'x' } },
        { type: 'message', timestamp: 2, source: { type: 'user', userId: 'U1' }, message: { type: 'text', text: 'x' } },
      ]),
    );
    expect(events).toHaveLength(0);
  });

  it('multi-event dalam satu payload → semua diproses urut', () => {
    const events = parseLineWebhook(
      payload([textEvent(), textEvent({ message: { id: '10', type: 'text', text: '081234567890' } })]),
    );
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.content)).toEqual(['Halo', '081234567890']);
  });

  it('redelivery (deliveryContext.isRedelivery) tetap menghasilkan event yang sama', () => {
    const [a] = parseLineWebhook(payload([textEvent({ deliveryContext: { isRedelivery: true } })]));
    const [b] = parseLineWebhook(payload([textEvent({ deliveryContext: { isRedelivery: true } })]));
    expect(a.providerEventId).toBe(b.providerEventId);
  });
});
