import { describe, expect, it } from 'vitest';

import {
  signWahaWebhookBody,
  signWebhookBody,
  verifyWahaWebhookSignature,
  verifyWebhookSignature,
} from './webhook-signature';

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

describe('verifyWahaWebhookSignature (HMAC-SHA512)', () => {
  it('menandatangani dan memverifikasi benar', () => {
    const body = '{"event":"message","session":"default"}';
    const sig = signWahaWebhookBody(body, 'secret');
    expect(verifyWahaWebhookSignature(body, 'secret', sig)).toBe(true);
  });

  it('menolak signature yang salah', () => {
    expect(verifyWahaWebhookSignature('{"a":1}', 'secret', 'deadbeef')).toBe(false);
  });

  it('menolak bila body / secret berbeda', () => {
    const sig = signWahaWebhookBody('{"a":1}', 'secret');
    expect(verifyWahaWebhookSignature('{"a":2}', 'secret', sig)).toBe(false);
    expect(verifyWahaWebhookSignature('{"a":1}', 'secret-x', sig)).toBe(false);
  });

  it('panjang berbeda → false tanpa throw', () => {
    expect(verifyWahaWebhookSignature('x', 'secret', 'short')).toBe(false);
    expect(verifyWahaWebhookSignature('x', 'secret', '')).toBe(false);
  });

  it('tidak tertukar dengan varian SHA-256 (Meta)', () => {
    const body = '{"a":1}';
    const sha256sig = signWebhookBody(body, 'secret');
    expect(verifyWahaWebhookSignature(body, 'secret', sha256sig)).toBe(false);
  });
});
