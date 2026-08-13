import { describe, expect, it } from 'vitest';

import { extractMetaMessagingEvents, parseMetaMessagingEvent, type MetaMessagingEvent, type MetaWebhookPayload } from './parse.ts';

describe('parseMetaMessagingEvent', () => {
  it('mengembalikan null untuk event tanpa message', () => {
    expect(parseMetaMessagingEvent('facebook', { sender: { id: 'u1' }, recipient: { id: 'p1' } }, 'p1')).toBeNull();
  });

  it('mengembalikan null untuk event echo', () => {
    expect(parseMetaMessagingEvent('facebook', { sender: { id: 'u1' }, recipient: { id: 'p1' }, message: { mid: 'mid1', text: 'hello', is_echo: true } }, 'p1')).toBeNull();
  });

  it('mengembalikan null untuk event tanpa text', () => {
    expect(parseMetaMessagingEvent('instagram', { sender: { id: 'u1' }, recipient: { id: 'p1' }, message: { mid: 'mid1' } }, 'p1')).toBeNull();
  });

  it('parse event teks facebook', () => {
    const result = parseMetaMessagingEvent(
      'facebook',
      { sender: { id: 'u1' }, recipient: { id: 'p1' }, timestamp: 1730000000, message: { mid: 'mid_abc', text: 'Ada promo?' } },
      'p1',
    );
    expect(result).not.toBeNull();
    expect(result!.channel).toBe('facebook');
    expect(result!.content).toBe('Ada promo?');
    expect(result!.senderIdentifier).toBe('u1');
    expect(result!.providerEventId).toBe('mid_abc');
    expect(result!.intent).toBe('text');
  });

  it('parse event teks instagram', () => {
    const result = parseMetaMessagingEvent(
      'instagram',
      { sender: { id: 'ig_user_1' }, recipient: { id: 'ig_page_1' }, message: { mid: 'mid_xyz', text: 'Booking dong' } },
      'ig_page_1',
    );
    expect(result).not.toBeNull();
    expect(result!.channel).toBe('instagram');
    expect(result!.content).toBe('Booking dong');
    expect(result!.senderIdentifier).toBe('ig_user_1');
  });

  it('fallback mid dari pageId:senderId:timestamp', () => {
    const result = parseMetaMessagingEvent(
      'facebook',
      { sender: { id: 'u1' }, recipient: { id: 'p1' }, timestamp: 1730000000, message: { text: 'halo' } },
      'p1',
    );
    expect(result).not.toBeNull();
    expect(result!.providerEventId).toBe('p1:u1:1730000000');
  });
});

describe('extractMetaMessagingEvents', () => {
  it('mengembalikan array kosong untuk payload tidak valid', () => {
    expect(extractMetaMessagingEvents({})).toEqual([]);
    expect(extractMetaMessagingEvents({ object: 'not_page' })).toEqual([]);
    expect(extractMetaMessagingEvents({ object: 'page', entry: [] })).toEqual([]);
  });

  it('mengekstrak event dari entry', () => {
    const payload: MetaWebhookPayload = {
      object: 'page',
      entry: [{
        id: 'page_1',
        messaging: [
          { sender: { id: 'u1' }, recipient: { id: 'p1' }, message: { mid: 'm1', text: 'Hi' } } as MetaMessagingEvent,
          { sender: { id: 'u2' }, recipient: { id: 'p1' }, message: { mid: 'm2', text: 'Hello' } } as MetaMessagingEvent,
        ],
      }],
    };
    const events = extractMetaMessagingEvents(payload);
    expect(events).toHaveLength(2);
    expect(events[0].pageId).toBe('page_1');
    expect(events[0].event.message?.text).toBe('Hi');
  });

  it('melewati entry tanpa messaging array', () => {
    const payload: MetaWebhookPayload = { object: 'page', entry: [{ id: 'p1' }] };
    expect(extractMetaMessagingEvents(payload)).toEqual([]);
  });
});