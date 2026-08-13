import { afterEach, describe, expect, it, vi } from 'vitest';

// Lib hanya memakai inngestEventBaseUrl + inngestMode dari client — mock
// seluruh client agar test tidak butuh env Inngest / Dev Server.
vi.mock('../inngest/client.ts', () => ({
  inngestEventBaseUrl: () => 'http://dev.inngest.test:8288',
  inngestMode: () => 'dev' as const,
}));

import { checkInngestPipeline, probeInngestBaseUrl } from './inngest-health.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('probeInngestBaseUrl', () => {
  it('respons HTTP apa pun → hidup', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok', { status: 200 })));
    await expect(probeInngestBaseUrl('http://inngest.test:8288')).resolves.toBe(true);
  });

  it('connection-refused → mati', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(probeInngestBaseUrl('http://inngest.test:8288')).resolves.toBe(false);
  });

  it('timeout (abort) → mati', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: { signal?: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
      }),
    );
    await expect(probeInngestBaseUrl('http://inngest.test:8288', fetch, 20)).resolves.toBe(false);
  });
});

describe('checkInngestPipeline', () => {
  it('ok + mode dev + baseUrl dari client saat probe sukses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 200 })));
    const result = await checkInngestPipeline();
    expect(result).toMatchObject({
      status: 'ok',
      mode: 'dev',
      baseUrl: 'http://dev.inngest.test:8288',
    });
    expect(result.checkedAt).toBeTruthy();
  });

  it('status down saat probe gagal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const result = await checkInngestPipeline();
    expect(result.status).toBe('down');
    expect(result.baseUrl).toBe('http://dev.inngest.test:8288');
  });
});
