import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/index.ts', () => ({
  db: {} as any,
}));

vi.mock('./env.ts', () => ({
  env: {} as any,
}));

vi.mock('./zoom.ts', () => ({
  isZoomConfigured: vi.fn(),
  createZoomMeeting: vi.fn(),
  ZoomApiError: class extends Error {
    constructor(m: string, readonly status?: number) {
      super(m);
      this.name = 'ZoomApiError';
    }
  },
}));

import { isZoomConfigured } from './zoom.ts';
import { availableVideoProviders } from './video.ts';

describe('availableVideoProviders', () => {
  afterEach(() => vi.clearAllMocks());

  it('zoom not ready bila env tidak dikonfigurasi', () => {
    vi.mocked(isZoomConfigured).mockReturnValue(false);
    const providers = availableVideoProviders();
    expect(providers.find(p => p.provider === 'zoom')?.ready).toBe(false);
    expect(providers.find(p => p.provider === 'meet')?.ready).toBe(true);
  });

  it('zoom ready bila env dikonfigurasi', () => {
    vi.mocked(isZoomConfigured).mockReturnValue(true);
    const providers = availableVideoProviders();
    expect(providers.find(p => p.provider === 'zoom')?.ready).toBe(true);
  });

  it('zoom not ready menyertakan reason', () => {
    vi.mocked(isZoomConfigured).mockReturnValue(false);
    const providers = availableVideoProviders();
    const zoom = providers.find(p => p.provider === 'zoom')!;
    expect(zoom.reason).toBeTruthy();
  });
});