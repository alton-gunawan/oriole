import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHmac } from 'node:crypto';
import { MetaApiError, metaGetPageIdentity, metaSendTextMessage, verifyMetaSignature } from './meta.ts';

const mockFetch = vi.fn();
beforeEach(() => vi.stubGlobal('fetch', mockFetch));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('metaGetPageIdentity', () => {
  it('melempar MetaApiError bila fetch gagal', async () => {
    mockFetch.mockRejectedValue(new Error('ENETUNREACH'));
    await expect(metaGetPageIdentity('token')).rejects.toThrow(MetaApiError);
  });

  it('melempar MetaApiError bila respons bukan 2xx', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403, json: () => Promise.resolve({ error: { message: 'permission denied' } }) });
    await expect(metaGetPageIdentity('bad_token')).rejects.toThrow(MetaApiError);
  });

  it('mengembalikan identitas page (tanpa IG business account)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: '12345', name: 'Test Page' }),
    });
    const identity = await metaGetPageIdentity('valid_token');
    expect(identity.id).toBe('12345');
    expect(identity.name).toBe('Test Page');
    expect(identity.instagramBusinessAccount).toBeNull();
  });

  it('mengembalikan identitas page + IG business account', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: '12345',
        name: 'Test Page',
        instagram_business_account: { id: 'ig_678', username: 'test_biz' },
      }),
    });
    const identity = await metaGetPageIdentity('token');
    expect(identity.instagramBusinessAccount).not.toBeNull();
    expect(identity.instagramBusinessAccount!.id).toBe('ig_678');
    expect(identity.instagramBusinessAccount!.username).toBe('test_biz');
  });
});

describe('metaSendTextMessage', () => {
  it('mengirim dan mengembalikan message_id', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ message_id: 'mid_abc' }),
    });
    const result = await metaSendTextMessage({
      accessToken: 'tok',
      pageId: '123',
      recipientId: 'user_456',
      text: 'Hi there!',
    });
    expect(result.messageId).toBe('mid_abc');
  });

  it('mengembalikan messageId null bila tidak ada', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({}),
    });
    const result = await metaSendTextMessage({
      accessToken: 'tok', pageId: '123', recipientId: 'user_456', text: 'Hi',
    });
    expect(result.messageId).toBeNull();
  });

  it('melempar MetaApiError bila gagal', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, json: () => Promise.resolve({ error: { message: 'invalid token' } }) });
    await expect(metaSendTextMessage({ accessToken: 'bad', pageId: '123', recipientId: 'u', text: 'x' })).rejects.toThrow(MetaApiError);
  });
});

describe('verifyMetaSignature', () => {
  it('mengembalikan true bila signature cocok', () => {
    const secret = 'app_secret_123';
    const rawBody = JSON.stringify({ foo: 'bar' });
    const signature = 'sha256=' + createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
    expect(verifyMetaSignature(rawBody, signature, secret)).toBe(true);
  });

  it('mengembalikan false bila signature tidak cocok', () => {
    expect(verifyMetaSignature('body', 'sha256=bad', 'secret')).toBe(false);
  });

  it('mengembalikan false bila signature header null/undefined', () => {
    expect(verifyMetaSignature('body', null, 'secret')).toBe(false);
  });
});