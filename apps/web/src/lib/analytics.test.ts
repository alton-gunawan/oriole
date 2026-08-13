import { beforeEach, describe, expect, it, vi } from 'vitest';

// Fake posthog-js — catat semua panggilan, tanpa window/document (test
// berjalan di environment node).
const { fakePostHog } = vi.hoisted(() => ({
  fakePostHog: {
    init: vi.fn(),
    identify: vi.fn(),
    group: vi.fn(),
    reset: vi.fn(),
    capture: vi.fn(),
    captureException: vi.fn(),
    startSessionRecording: vi.fn(),
    stopSessionRecording: vi.fn(),
    getActiveMatchingSurveys: vi.fn(),
    renderSurvey: vi.fn(),
    isFeatureEnabled: vi.fn(),
    getFeatureFlagPayload: vi.fn(),
  },
}));

vi.mock('posthog-js', () => ({ default: fakePostHog }));

// Modul utama file ini: env DENGAN token → analitik aktif.
vi.mock('../config/env', () => ({
  env: {
    API_URL: '/api',
    NEON_AUTH_URL: '',
    POSTHOG_PROJECT_TOKEN: 'phc_test_token',
    POSTHOG_HOST: 'https://us.i.posthog.com',
  },
}));

import {
  applyAnalyticsConsent,
  captureClientError,
  getFeatureFlagPayload,
  groupAnalyticsWorkspace,
  identifyAnalyticsUser,
  initAnalytics,
  isAnalyticsEnabled,
  isFeatureFlagEnabled,
  resetAnalytics,
  trackEvent,
} from './analytics';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('analytics (frontend PostHog)', () => {

  it('isAnalyticsEnabled true saat token proyek disetel', () => {
    expect(isAnalyticsEnabled).toBe(true);
  });

  it('initAnalytics → posthog.init dengan token, host, SPA pageviews, error autocapture & replay masking', async () => {
    await initAnalytics();

    expect(fakePostHog.init).toHaveBeenCalledWith(
      'phc_test_token',
      expect.objectContaining({
        api_host: 'https://us.i.posthog.com',
        capture_pageview: 'history_change',
        capture_exceptions: true,
        session_recording: {
          maskAllInputs: true,
          maskTextSelector: '.ph-no-capture',
        },
        // Tanpa consent tersimpan → replay mati di init (node env: undecided).
        disable_session_recording: true,
        disable_surveys_automatic_display: true,
      }),
    );
  });

  it('identifyAnalyticsUser → identify (id stabil, bukan email) + group workspace', async () => {
    await identifyAnalyticsUser({ id: 'u-1', email: 'a@b.com', name: 'Ana', workspaceId: 'ws-1' });

    expect(fakePostHog.identify).toHaveBeenCalledWith('u-1', { email: 'a@b.com', name: 'Ana' });
    expect(fakePostHog.group).toHaveBeenCalledWith('workspace', 'ws-1');
  });

  it('identifyAnalyticsUser tanpa workspace → tidak group', async () => {
    await identifyAnalyticsUser({ id: 'u-1' });

    expect(fakePostHog.identify).toHaveBeenCalledWith('u-1', {});
    expect(fakePostHog.group).not.toHaveBeenCalled();
  });

  it('groupAnalyticsWorkspace → posthog.group (switch project)', async () => {
    await groupAnalyticsWorkspace('ws-2');

    expect(fakePostHog.group).toHaveBeenCalledWith('workspace', 'ws-2');
  });

  it('trackEvent → posthog.capture dengan properti', async () => {
    await trackEvent('signin_started', { method: 'google' });

    expect(fakePostHog.capture).toHaveBeenCalledWith('signin_started', { method: 'google' });
  });

  it('captureClientError → posthog.captureException', async () => {
    const error = new Error('boom');
    await captureClientError(error);

    expect(fakePostHog.captureException).toHaveBeenCalledWith(error);
  });

  it('resetAnalytics → posthog.reset (logout)', async () => {
    await resetAnalytics();

    expect(fakePostHog.reset).toHaveBeenCalled();
  });

  it('applyAnalyticsConsent(granted) → mulai replay + render survei yang match', async () => {
    const surveys = [{ id: 'survey-1' }, { id: 'survey-2' }];
    fakePostHog.getActiveMatchingSurveys.mockImplementation((cb: (s: unknown[]) => void) => cb(surveys));

    await applyAnalyticsConsent('granted');

    expect(fakePostHog.startSessionRecording).toHaveBeenCalled();
    expect(fakePostHog.stopSessionRecording).not.toHaveBeenCalled();
    expect(fakePostHog.getActiveMatchingSurveys).toHaveBeenCalled();
    expect(fakePostHog.renderSurvey).toHaveBeenCalledWith('survey-1', '#ph-surveys-root');
    expect(fakePostHog.renderSurvey).toHaveBeenCalledWith('survey-2', '#ph-surveys-root');
  });

  it('applyAnalyticsConsent(denied) → hentikan replay, survei tidak dirender', async () => {
    await applyAnalyticsConsent('denied');

    expect(fakePostHog.stopSessionRecording).toHaveBeenCalled();
    expect(fakePostHog.startSessionRecording).not.toHaveBeenCalled();
    expect(fakePostHog.getActiveMatchingSurveys).not.toHaveBeenCalled();
    expect(fakePostHog.renderSurvey).not.toHaveBeenCalled();
  });

  it('applyAnalyticsConsent(undecided) → replay mati (sama dengan denied)', async () => {
    await applyAnalyticsConsent('undecided');

    expect(fakePostHog.stopSessionRecording).toHaveBeenCalled();
    expect(fakePostHog.startSessionRecording).not.toHaveBeenCalled();
  });

  it('isFeatureFlagEnabled → nilai flag; undefined (belum dimuat) = fallback', async () => {
    fakePostHog.isFeatureEnabled.mockReturnValue(true);
    await expect(isFeatureFlagEnabled('beta-ui', false)).resolves.toBe(true);

    fakePostHog.isFeatureEnabled.mockReturnValue(undefined);
    await expect(isFeatureFlagEnabled('beta-ui', false)).resolves.toBe(false);
  });

  it('getFeatureFlagPayload → payload JSON; null = fallback (eksperimen A/B)', async () => {
    fakePostHog.getFeatureFlagPayload.mockReturnValue({ cta: 'Create free account' });
    await expect(getFeatureFlagPayload('signup-hero-variant', null)).resolves.toEqual({
      cta: 'Create free account',
    });

    fakePostHog.getFeatureFlagPayload.mockReturnValue(null);
    await expect(
      getFeatureFlagPayload('signup-hero-variant', { cta: 'fallback' }),
    ).resolves.toEqual({ cta: 'fallback' });
  });
});

describe('analytics nonaktif (tanpa token)', () => {
  it('semua helper no-op dan posthog-js tidak pernah di-init', async () => {
    // Modul baru dengan env TANPA token — menguji jalur nonaktif.
    vi.resetModules();
    vi.doUnmock('../config/env');
    vi.doMock('../config/env', () => ({
      env: {
        API_URL: '/api',
        NEON_AUTH_URL: '',
        POSTHOG_PROJECT_TOKEN: '',
        POSTHOG_HOST: 'https://us.i.posthog.com',
      },
    }));

    const analytics = await import('./analytics');

    expect(analytics.isAnalyticsEnabled).toBe(false);
    await analytics.initAnalytics();
    await analytics.identifyAnalyticsUser({ id: 'u-1', workspaceId: 'ws-1' });
    await analytics.groupAnalyticsWorkspace('ws-1');
    await analytics.trackEvent('x', { a: 1 });
    await analytics.captureClientError(new Error('x'));
    await analytics.resetAnalytics();
    await analytics.applyAnalyticsConsent('granted');
    await expect(analytics.isFeatureFlagEnabled('beta-ui', true)).resolves.toBe(true);
    await expect(analytics.getFeatureFlagPayload('signup-hero-variant', { v: 1 })).resolves.toEqual({
      v: 1,
    });

    expect(fakePostHog.init).not.toHaveBeenCalled();
    expect(fakePostHog.identify).not.toHaveBeenCalled();
    expect(fakePostHog.group).not.toHaveBeenCalled();
    expect(fakePostHog.capture).not.toHaveBeenCalled();
    expect(fakePostHog.captureException).not.toHaveBeenCalled();
    expect(fakePostHog.reset).not.toHaveBeenCalled();
    expect(fakePostHog.startSessionRecording).not.toHaveBeenCalled();
    expect(fakePostHog.stopSessionRecording).not.toHaveBeenCalled();
    expect(fakePostHog.renderSurvey).not.toHaveBeenCalled();
  });
});
