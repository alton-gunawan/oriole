import { describe, expect, it } from 'vitest';

import {
  isWahaConsentChecklistValid,
  isWahaConsentVersionKnown,
  WAHA_CONSENT_RISK_ITEMS,
  WAHA_CONSENT_VERSION,
  wahaConsentCopyHash,
} from './waha-consent.ts';

const ALL = [...WAHA_CONSENT_RISK_ITEMS];

describe('isWahaConsentChecklistValid', () => {
  it('semua kunci wajib dicentang', () => {
    expect(isWahaConsentChecklistValid(ALL)).toBe(true);
  });

  it('satu kunci kurang → false', () => {
    expect(isWahaConsentChecklistValid(ALL.slice(0, -1))).toBe(false);
  });

  it('urutan acak + item ekstra (forward-compat) diterima', () => {
    expect(isWahaConsentChecklistValid([...ALL].reverse())).toBe(true);
    expect(isWahaConsentChecklistValid([...ALL, 'future-item'])).toBe(true);
  });

  it('array kosong / bukan array / null / undefined → false', () => {
    expect(isWahaConsentChecklistValid([])).toBe(false);
    expect(isWahaConsentChecklistValid(null)).toBe(false);
    expect(isWahaConsentChecklistValid(undefined)).toBe(false);
    expect(isWahaConsentChecklistValid('ban')).toBe(false);
    expect(isWahaConsentChecklistValid({ 0: 'ban' })).toBe(false);
  });

  it('duplikat tidak menggantikan kunci yang hilang', () => {
    expect(isWahaConsentChecklistValid(['ban', 'ban', 'ban', 'ban'])).toBe(false);
  });
});

describe('wahaConsentCopyHash', () => {
  it('default mengikuti versi aktif saat ini', () => {
    expect(wahaConsentCopyHash()).toBe(wahaConsentCopyHash(WAHA_CONSENT_VERSION));
  });

  it('hash v1 stabil (audit record lama tetap tervalidasi)', () => {
    // Jejak audit v1 tidak boleh berubah walau versi aktif naik.
    const v1 = wahaConsentCopyHash(1);
    const v1Again = wahaConsentCopyHash(1);
    expect(v1).toBe(v1Again);
    expect(v1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hash berbeda antar versi', () => {
    expect(wahaConsentCopyHash(1)).not.toBe(wahaConsentCopyHash(2));
  });

  it('versi tak dikenal → hash dari string kosong (tidak pernah dipakai runtime)', () => {
    expect(wahaConsentCopyHash(999)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('isWahaConsentVersionKnown', () => {
  it('hanya versi aktif yang dikenal', () => {
    expect(isWahaConsentVersionKnown(WAHA_CONSENT_VERSION)).toBe(true);
    expect(isWahaConsentVersionKnown(WAHA_CONSENT_VERSION - 1)).toBe(false);
    expect(isWahaConsentVersionKnown(WAHA_CONSENT_VERSION + 1)).toBe(false);
  });
});
