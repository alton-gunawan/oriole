import { describe, expect, it } from 'vitest';

import { signWebhookBody, verifyWebhookSignature } from './webhook-signature';

describe('verifyWebhookSignature', () => {
  it('menandatangani dan memverifikasi benar', () => {
    const body = '{"id":"evt-1"}';
    const sig = signWebhookBody(body, 'secret');
    expect(verifyWebhookSignature(body, 'secret', sig)).toBe(true);
  });

  it('menolak signature yang salah', () => {
    expect(verifyWebhookSignature('{"id":"evt-1"}', 'secret', 'deadbeef')).toBe(false);
  });

  it('menolak bila body berbeda dari yang ditandatangani', () => {
    const sig = signWebhookBody('{"id":"evt-1"}', 'secret');
    expect(verifyWebhookSignature('{"id":"evt-2"}', 'secret', sig)).toBe(false);
  });

  it('menolak bila secret berbeda', () => {
    const sig = signWebhookBody('{"id":"evt-1"}', 'secret-a');
    expect(verifyWebhookSignature('{"id":"evt-1"}', 'secret-b', sig)).toBe(false);
  });

  it('tidak melempar untuk panjang berbeda (timingSafeEqual guard)', () => {
    expect(verifyWebhookSignature('x', 'secret', 'short')).toBe(false);
    expect(verifyWebhookSignature('x', 'secret', '')).toBe(false);
  });
});
