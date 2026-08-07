import { createSign } from 'node:crypto';
import { z } from 'zod';

/**
 * Google service account (server-to-server) OAuth — dipakai integrasi
 * Google Forms & Google Calendar.
 *
 * User membuat service account di Google Cloud Console, mengaktifkan API
 * yang dibutuhkan, lalu membagikan resource-nya (form / kalender) ke email
 * service account. Kredensial (JSON key) ditempel di UI — TIDAK pernah
 * di-expose ke client setelah disimpan (disimpan di providerConfig).
 *
 * Alur: JWT (RS256) → token endpoint Google → access token (cache sampai
 * mendekati kedaluwarsa, minimal 60 detik buffer).
 */

/** Skema kredensial service account (file JSON dari Google Cloud Console). */
const serviceAccountSchema = z.object({
  type: z.literal('service_account').default('service_account'),
  project_id: z.string().min(1),
  private_key_id: z.string().min(1),
  private_key: z.string().min(1, 'private_key wajib ada'),
  client_email: z.string().email('client_email harus alamat email valid'),
  client_id: z.string().min(1),
  token_uri: z.string().url('token_uri harus berupa URL'),
});

export interface GoogleServiceAccount {
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
  projectId: string;
}

export class GoogleApiError extends Error {
  constructor(
    message: string,
    /** Status HTTP dari API Google (401/403/404/429/...). */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GoogleApiError';
  }
}

/** Parse + validasi JSON kredensial service account. Melempar GoogleApiError bila tidak valid. */
export function parseServiceAccount(raw: string): GoogleServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new GoogleApiError('File kredensial bukan JSON yang valid.', 400);
  }
  const result = serviceAccountSchema.safeParse(parsed);
  if (!result.success) {
    const field = result.error.issues[0]?.path.join('.') ?? '(root)';
    throw new GoogleApiError(`Kredensial service account tidak valid (${field}).`, 400);
  }
  return {
    clientEmail: result.data.client_email,
    privateKey: result.data.private_key,
    tokenUri: result.data.token_uri,
    projectId: result.data.project_id,
  };
}

/** Susun JWT assertion (header + claims) untuk grant type jwt-bearer. */
function buildAssertionJwt(serviceAccount: GoogleServiceAccount, scopes: string[]): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: serviceAccount.clientEmail,
    scope: scopes.join(' '),
    aud: serviceAccount.tokenUri,
    iat: now,
    exp: now + 3600, // token endpoint menerima max 1 jam
  };
  const base64Url = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  const signingInput = `${base64Url(header)}.${base64Url(claims)}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(
    // private_key dari Google adalah PEM (dengan \n literal di dalam JSON).
    serviceAccount.privateKey.replace(/\\n/g, '\n'),
    'base64url',
  );
  return `${signingInput}.${signature}`;
}

/**
 * Cache access token per service account (key: client_email+scopes).
 * Token Google berlaku 1 jam — cache 55 menit menyisakan buffer aman.
 */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/** Bersihkan cache token — dipakai saat kredensial dirotasi & di test. */
export function clearGoogleTokenCache(): void {
  tokenCache.clear();
}

export interface GoogleAccessToken {
  accessToken: string;
  expiresIn: number;
}

/**
 * Tukar JWT assertion → access token Google (POST token_uri).
 * Cache token yang masih berlaku (per client_email + scope).
 */
export async function getGoogleAccessToken(
  serviceAccount: GoogleServiceAccount,
  scopes: string[],
): Promise<GoogleAccessToken> {
  const cacheKey = `${serviceAccount.clientEmail}|${scopes.join(' ')}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return { accessToken: cached.token, expiresIn: Math.round((cached.expiresAt - Date.now()) / 1000) };
  }

  const assertion = buildAssertionJwt(serviceAccount, scopes);
  let res: Response;
  try {
    res = await fetch(serviceAccount.tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });
  } catch {
    throw new GoogleApiError('Gagal menghubungi Google (token endpoint). Coba lagi.', 502);
  }

  const body = (await res.json().catch(() => null)) as
    | { access_token?: string; expires_in?: number; error?: string; error_description?: string }
    | null;

  if (!res.ok || !body?.access_token) {
    const reason = body?.error_description ?? body?.error ?? `HTTP ${res.status}`;
    // 401 = assertion ditolak (private key salah / token_uri salah).
    const status = res.status === 401 ? 401 : 502;
    throw new GoogleApiError(`Google menolak kredensial: ${reason}`, status);
  }

  const expiresIn = body.expires_in ?? 3600;
  tokenCache.set(cacheKey, {
    token: body.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
  });
  return { accessToken: body.access_token, expiresIn };
}

/**
 * Fetch ke Google API dengan access token otomatis (ambil + cache).
 * Menormalkan error non-2xx menjadi GoogleApiError dengan status HTTP.
 */
export async function googleFetch<T>(
  serviceAccount: GoogleServiceAccount,
  scopes: string[],
  path: string,
  init: RequestInit = {},
  attempt = 0,
): Promise<T> {
  const { accessToken } = await getGoogleAccessToken(serviceAccount, scopes);
  const url = path.startsWith('http') ? path : `https://www.googleapis.com${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });

  // Rate limit Google: 429 → retry pendek dengan backoff (maks 2 kali).
  if (res.status === 429 && attempt < 2) {
    await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    return googleFetch<T>(serviceAccount, scopes, path, init, attempt + 1);
  }

  if (!res.ok) {
    let message = `Google API ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string; status?: string } };
      message = body.error?.message ?? message;
    } catch {
      // body bukan JSON — pakai pesan default.
    }
    throw new GoogleApiError(message, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
