import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, verify as verifySignature } from 'node:crypto';

import {
  clearGoogleTokenCache,
  GoogleApiError,
  getGoogleAccessToken,
  googleFetch,
  parseServiceAccount,
  type GoogleServiceAccount,
} from './google-auth.ts';

/** Real RSA keypair — JWT benar-benar ditandatangani & diverifikasi. */
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function buildServiceAccountJson(overrides: Record<string, string> = {}): string {
  return JSON.stringify({
    type: 'service_account',
    project_id: 'oriole-test',
    private_key_id: 'key-1',
    private_key: privateKey,
    client_email: 'sa-test@oriole-test.iam.gserviceaccount.com',
    client_id: '1234567890',
    token_uri: 'https://oauth2.googleapis.com/token',
    ...overrides,
  });
}

function toServiceAccount(raw: string): GoogleServiceAccount {
  return parseServiceAccount(raw);
}

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.restoreAllMocks();
  clearGoogleTokenCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('parseServiceAccount', () => {
  it('mengurai JSON kredensial yang valid', () => {
    const account = parseServiceAccount(buildServiceAccountJson());
    expect(account.clientEmail).toBe('sa-test@oriole-test.iam.gserviceaccount.com');
    expect(account.privateKey).toContain('BEGIN PRIVATE KEY');
    expect(account.tokenUri).toBe('https://oauth2.googleapis.com/token');
    expect(account.projectId).toBe('oriole-test');
  });

  it('menolak JSON yang bukan objek kredensial', () => {
    expect(() => parseServiceAccount('{nope')).toThrow(GoogleApiError);
    expect(() => parseServiceAccount('"just a string"')).toThrow(GoogleApiError);
  });

  it('menolak kredensial tanpa private_key / client_email', () => {
    const missingKey = buildServiceAccountJson({ private_key: '' });
    expect(() => parseServiceAccount(missingKey)).toThrow(/private_key/);

    const missingEmail = buildServiceAccountJson({ client_email: 'not-an-email' });
    expect(() => parseServiceAccount(missingEmail)).toThrow(GoogleApiError);
  });
});

describe('getGoogleAccessToken', () => {
  it('menukar JWT assertion → access token dan men-cache-nya', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'ya29.token', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const account = toServiceAccount(buildServiceAccountJson());
    const first = await getGoogleAccessToken(account, SCOPES);
    expect(first.accessToken).toBe('ya29.token');

    // Panggilan kedua dalam masa cache → tidak ada fetch tambahan.
    const second = await getGoogleAccessToken(account, SCOPES);
    expect(second.accessToken).toBe('ya29.token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('assertion JWT berisi iss/aud/scope yang benar dan tanda tangan valid', async () => {
    let capturedBody = '';
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = String(init?.body);
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const account = toServiceAccount(buildServiceAccountJson());
    await getGoogleAccessToken(account, SCOPES);

    const form = new URLSearchParams(capturedBody);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const assertion = form.get('assertion') ?? '';
    const [headerB64, claimsB64, signatureB64] = assertion.split('.');

    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    const claims = JSON.parse(Buffer.from(claimsB64, 'base64url').toString('utf8'));
    expect(header).toMatchObject({ alg: 'RS256', typ: 'JWT' });
    expect(claims.iss).toBe('sa-test@oriole-test.iam.gserviceaccount.com');
    expect(claims.aud).toBe('https://oauth2.googleapis.com/token');
    expect(claims.scope).toBe(SCOPES.join(' '));
    expect(claims.exp - claims.iat).toBe(3600);

    // Verifikasi tanda tangan dengan kunci publik — bukti assertion valid.
    const verified = verifySignature(
      'sha256',
      Buffer.from(`${headerB64}.${claimsB64}`),
      publicKey,
      Buffer.from(signatureB64, 'base64url'),
    );
    expect(verified).toBe(true);
  });

  it('token endpoint menolak (401) → GoogleApiError 401', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: 'invalid_grant', error_description: 'Bad credentials' }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        ),
      )) as unknown as typeof fetch;

    const account = toServiceAccount(buildServiceAccountJson());
    await expect(getGoogleAccessToken(account, SCOPES)).rejects.toMatchObject({
      name: 'GoogleApiError',
      status: 401,
    });
  });

  it('jaringan gagal → GoogleApiError 502', async () => {
    globalThis.fetch = (() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch;
    const account = toServiceAccount(buildServiceAccountJson());
    await expect(getGoogleAccessToken(account, SCOPES)).rejects.toMatchObject({ status: 502 });
  });
});

describe('googleFetch', () => {
  /** Mock fetch yang membedakan token endpoint (grant_type) vs API Google. */
  function mockGoogleFetch(apiHandler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (String(init?.body).includes('grant_type')) {
        return new Response(JSON.stringify({ access_token: 'ya29.token', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return apiHandler(href, init);
    }) as unknown as typeof fetch;
  }

  it('melampirkan Bearer token dan mengembalikan JSON', async () => {
    let authHeader = '';
    mockGoogleFetch((_url: string, init?: RequestInit) => {
      authHeader = String(init?.headers && (init.headers as Record<string, string>)['Authorization']);
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const account = toServiceAccount(buildServiceAccountJson());
    const result = await googleFetch<{ items: unknown[] }>(account, SCOPES, '/calendar/v3/users/me/calendarList');
    expect(result).toEqual({ items: [] });
    expect(authHeader).toBe('Bearer ya29.token');
  });

  it('non-2xx → GoogleApiError dengan pesan dari body', async () => {
    mockGoogleFetch(() =>
      new Response(JSON.stringify({ error: { message: 'Calendar not found' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const account = toServiceAccount(buildServiceAccountJson());
    await expect(
      googleFetch(account, SCOPES, '/calendar/v3/calendars/nope'),
    ).rejects.toMatchObject({ name: 'GoogleApiError', status: 404, message: 'Calendar not found' });
  });

  it('429 → retry sekali lalu berhasil', async () => {
    let calls = 0;
    mockGoogleFetch(() => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: { message: 'rate limit' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const account = toServiceAccount(buildServiceAccountJson());
    const result = await googleFetch<{ ok: boolean }>(account, SCOPES, '/forms/v1/forms/x');
    expect(result).toEqual({ ok: true });
    expect(calls).toBe(2);
  });
});
