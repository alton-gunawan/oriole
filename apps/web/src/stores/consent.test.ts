import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Environment vitest = node (tanpa window/localStorage). Stub localStorage
// sederhana in-memory untuk menguji persistensi consent.
const STORAGE_KEY = 'oriole.analytics.consent.v1';

function createMemoryStorage() {
  let store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  };
}

describe('consent store (privasi replay/survei)', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { localStorage: createMemoryStorage() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // Reset cache module — store zustand dibuat saat import; tiap test
    // harus memuat ulang agar state awal dibaca dari storage yang baru.
    vi.resetModules();
  });

  it('default undecided → replay mati sampai ada keputusan', async () => {
    const { useConsentStore, readStoredConsent } = await import('./consent');
    expect(useConsentStore.getState().replayConsent).toBe('undecided');
    expect(readStoredConsent()).toBe('undecided');
  });

  it('grantReplayConsent → granted + tersimpan di localStorage', async () => {
    const { useConsentStore, readStoredConsent } = await import('./consent');
    useConsentStore.getState().grantReplayConsent();

    expect(useConsentStore.getState().replayConsent).toBe('granted');
    expect(readStoredConsent()).toBe('granted');
    expect((window as unknown as { localStorage: Storage }).localStorage.getItem(STORAGE_KEY)).toBe(
      'granted',
    );
  });

  it('denyReplayConsent → denied + tersimpan', async () => {
    const { useConsentStore, readStoredConsent } = await import('./consent');
    useConsentStore.getState().denyReplayConsent();

    expect(useConsentStore.getState().replayConsent).toBe('denied');
    expect(readStoredConsent()).toBe('denied');
  });

  it('setReplayConsent → nilai apa pun, termasuk kembali ke undecided', async () => {
    const { useConsentStore } = await import('./consent');
    useConsentStore.getState().setReplayConsent('granted');
    expect(useConsentStore.getState().replayConsent).toBe('granted');

    useConsentStore.getState().setReplayConsent('undecided');
    expect(useConsentStore.getState().replayConsent).toBe('undecided');
    expect((window as unknown as { localStorage: Storage }).localStorage.getItem(STORAGE_KEY)).toBe(
      'undecided',
    );
  });

  it('nilai localStorage tidak dikenal → undecided (corrupt-safe)', async () => {
    (window as unknown as { localStorage: Storage }).localStorage.setItem(STORAGE_KEY, 'maybe');
    const { readStoredConsent } = await import('./consent');
    expect(readStoredConsent()).toBe('undecided');
  });

  it('keputusan sebelumnya terbaca saat module dimuat (persist antar sesi)', async () => {
    (window as unknown as { localStorage: Storage }).localStorage.setItem(STORAGE_KEY, 'granted');
    const { useConsentStore } = await import('./consent');
    expect(useConsentStore.getState().replayConsent).toBe('granted');
  });

  it('tanpa window (SSR/node) → aman: default undecided, aksi tanpa throw', async () => {
    vi.unstubAllGlobals(); // hapus stub → tidak ada window sama sekali
    const { useConsentStore, readStoredConsent } = await import('./consent');

    expect(readStoredConsent()).toBe('undecided');
    expect(() => useConsentStore.getState().grantReplayConsent()).not.toThrow();
    expect(useConsentStore.getState().replayConsent).toBe('granted');
  });
});
