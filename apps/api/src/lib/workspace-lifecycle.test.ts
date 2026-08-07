import { describe, expect, it, vi } from 'vitest';

// workspace-lifecycle.ts mengimpor db (→ env). Mock keduanya — tes ini
// hanya menyentuh fungsi murni (isWorkspacePurgeDue) + konstanta.
vi.mock('../db/index.ts', () => ({
  db: {},
}));
vi.mock('../lib/env.ts', () => ({
  env: { API_URL: 'http://localhost:3000', NEON_AUTH_URL: 'https://ep-test.neon.tech/neondb/auth' },
}));

import {
  isWorkspacePurgeDue,
  WORKSPACE_DELETE_GRACE_DAYS,
  WORKSPACE_DELETE_GRACE_MS,
} from './workspace-lifecycle.ts';

const NOW = new Date('2026-01-10T00:00:00.000Z');

describe('workspace-lifecycle (soft-delete → purge permanen)', () => {
  it('masa tenggang default = 3 hari', () => {
    expect(WORKSPACE_DELETE_GRACE_DAYS).toBe(3);
    expect(WORKSPACE_DELETE_GRACE_MS).toBe(3 * 24 * 60 * 60 * 1000);
  });

  it('deletedAt 3 hari lalu tepat di batas → sudah pantas dihapus', () => {
    const deletedAt = new Date(NOW.getTime() - WORKSPACE_DELETE_GRACE_MS);
    expect(isWorkspacePurgeDue(deletedAt, NOW)).toBe(true);
  });

  it('deletedAt belum 3 hari (2,9 hari) → belum pantas dihapus', () => {
    const deletedAt = new Date(NOW.getTime() - WORKSPACE_DELETE_GRACE_MS + 86_400_000);
    expect(isWorkspacePurgeDue(deletedAt, NOW)).toBe(false);
  });

  it('deletedAt lebih dari 3 hari lalu → pantas dihapus', () => {
    const deletedAt = new Date(NOW.getTime() - WORKSPACE_DELETE_GRACE_MS - 60_000);
    expect(isWorkspacePurgeDue(deletedAt, NOW)).toBe(true);
  });

  it('deletedAt di masa depan (soft-delete belum lama) → belum pantas dihapus', () => {
    expect(isWorkspacePurgeDue(new Date(NOW.getTime() - 3_600_000), NOW)).toBe(false);
  });
});
