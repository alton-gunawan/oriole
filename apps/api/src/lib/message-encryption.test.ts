import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  decryptMessageContent,
  ENCRYPTED_PREFIX,
  encryptMessageContent,
  UNREADABLE_PLACEHOLDER,
} from './message-encryption.ts';

// Modul membaca MESSAGE_ENCRYPTION_KEY dari process.env secara lazy —
// test menyetel/menghapus key per kasus tanpa perlu mock env.
const KEY = 'a'.repeat(64); // 32 byte hex
const WS_A = 'workspace-aaa';
const WS_B = 'workspace-bbb';

describe('message-encryption', () => {
  beforeEach(() => {
    delete process.env.MESSAGE_ENCRYPTION_KEY;
  });
  afterEach(() => {
    delete process.env.MESSAGE_ENCRYPTION_KEY;
  });

  describe('tanpa master key (enabled=false)', () => {
    it('encrypt passthrough — plaintext disimpan apa adanya', () => {
      expect(encryptMessageContent(WS_A, 'halo customer')).toBe('halo customer');
    });

    it('decrypt baris plaintext apa adanya', () => {
      expect(decryptMessageContent(WS_A, 'halo customer')).toBe('halo customer');
    });

    it('decrypt baris terenkripsi → placeholder (key hilang)', () => {
      expect(decryptMessageContent(WS_A, `${ENCRYPTED_PREFIX}YWJjZA`)).toBe(UNREADABLE_PLACEHOLDER);
    });
  });

  describe('dengan master key', () => {
    beforeEach(() => {
      process.env.MESSAGE_ENCRYPTION_KEY = KEY;
    });

    it('encrypt menambahkan prefix enc:v1: dan bukan plaintext', () => {
      const encrypted = encryptMessageContent(WS_A, 'Halo, apakah Kamis jam 2 tersedia?');
      expect(encrypted.startsWith(ENCRYPTED_PREFIX)).toBe(true);
      expect(encrypted).not.toContain('Kamis');
    });

    it('round-trip encrypt → decrypt mengembalikan teks asli (termasuk unicode)', () => {
      const texts = [
        'halo',
        'Selamat siang! Apakah masih ada slot Sabtu? 🙏',
        'a\nb\nc',
        '',
        'x'.repeat(5_000),
      ];
      for (const text of texts) {
        const encrypted = encryptMessageContent(WS_A, text);
        expect(decryptMessageContent(WS_A, encrypted)).toBe(text);
      }
    });

    it('kunci per-workspace: ciphertext berbeda & tidak bisa saling dekripsi', () => {
      const a = encryptMessageContent(WS_A, 'pesan rahasia');
      const b = encryptMessageContent(WS_B, 'pesan rahasia');
      expect(a).not.toBe(b);
      // Dekripsi workspace A dengan kunci workspace B → gagal auth → placeholder.
      expect(decryptMessageContent(WS_B, a)).toBe(UNREADABLE_PLACEHOLDER);
    });

    it('baris plaintext legacy tetap terbaca (kompatibilitas mundur)', () => {
      expect(decryptMessageContent(WS_A, 'pesan lama plaintext')).toBe('pesan lama plaintext');
      expect(decryptMessageContent(WS_A, '')).toBe('');
    });

    it('ciphertext dirusak → placeholder (integritas GCM)', () => {
      const encrypted = encryptMessageContent(WS_A, 'data penting');
      const tampered = `${encrypted.slice(0, -2)}zz`;
      expect(decryptMessageContent(WS_A, tampered)).toBe(UNREADABLE_PLACEHOLDER);
    });

    it('iv acak: dua enkripsi plaintext sama menghasilkan ciphertext berbeda', () => {
      const a = encryptMessageContent(WS_A, 'sama');
      const b = encryptMessageContent(WS_A, 'sama');
      expect(a).not.toBe(b);
      expect(decryptMessageContent(WS_A, a)).toBe('sama');
      expect(decryptMessageContent(WS_A, b)).toBe('sama');
    });
  });

  describe('master key tidak valid', () => {
    it('key non-hex → dianggap nonaktif (passthrough) + warning', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      process.env.MESSAGE_ENCRYPTION_KEY = 'bukan-hex';
      expect(encryptMessageContent(WS_A, 'teks')).toBe('teks');
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });
});
