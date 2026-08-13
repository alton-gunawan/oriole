import { inngestEventBaseUrl, inngestMode } from '../inngest/client.ts';

/**
 * Health pipeline Inngest — dipakai GET /api/health/inngest agar UI bisa
 * menampilkan peringatan nyata saat webhook berbalas 503 diam-diam
 * (Dev Server lokal mati / cloud tidak terjangkau).
 *
 * Webhook WAHA mengembalikan 503 saat `inngest.send` gagal (lihat
 * routes/webhooks/waha.ts) — pesan masuk di-retry WAHA tapi tidak pernah
 * diproses sampai pipeline hidup. Endpoint ini membuat kegagalan itu terlihat
 * di UI alih-alih berjalan diam-diam.
 */

export const INNGEST_PROBE_TIMEOUT_MS = 2500;

export interface InngestPipelineHealth {
  status: 'ok' | 'down';
  /** dev = Dev Server lokal; cloud = Inngest Cloud (event key dipakai). */
  mode: 'dev' | 'cloud';
  /** URL tempat SDK mengirim event (dari resolusi internal SDK). */
  baseUrl: string;
  checkedAt: string;
}

/**
 * Probe ringan ke base URL event Inngest: APA PUN respons HTTP = hidup
 * (membuktikan endpoint terjangkau); timeout/connection-refused = mati.
 * fetchImpl di-inject agar test tidak menyentuh jaringan.
 */
export async function probeInngestBaseUrl(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = INNGEST_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetchImpl(baseUrl, { method: 'GET', signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function checkInngestPipeline(): Promise<InngestPipelineHealth> {
  const baseUrl = inngestEventBaseUrl();
  const ok = await probeInngestBaseUrl(baseUrl);
  return {
    status: ok ? 'ok' : 'down',
    mode: inngestMode(),
    baseUrl,
    checkedAt: new Date().toISOString(),
  };
}
