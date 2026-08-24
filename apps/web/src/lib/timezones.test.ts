import { describe, expect, it } from 'vitest';
import worldCountries from 'world-countries';

import { browserCountryCode, COUNTRY_BY_TIMEZONE, TIMEZONE_CURATED } from './timezones';

describe('country/timezone detection', () => {
  it('maps a known IANA zone to a valid country code', () => {
    const code = browserCountryCode();
    expect(code).toMatch(/^[A-Z]{2}$/);
    expect(worldCountries.some((c) => c.cca2 === code)).toBe(true);
  });

  it('covers every curated timezone so onboarding never defaults to a blank country', () => {
    for (const zone of TIMEZONE_CURATED) {
      if (zone === 'UTC') continue; // zona netral, tak punya negara
      expect(COUNTRY_BY_TIMEZONE[zone], `missing map entry for ${zone}`).toBeTruthy();
    }
  });

  it('only maps to real ISO 3166-1 alpha-2 codes', () => {
    for (const code of new Set(Object.values(COUNTRY_BY_TIMEZONE))) {
      expect(worldCountries.some((c) => c.cca2 === code), `unknown code ${code}`).toBe(true);
    }
  });
});
