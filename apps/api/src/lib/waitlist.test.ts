import { describe, expect, it, vi } from 'vitest';

// Waitlist.ts meng-import env/db/inngest di module scope — mock dulu agar
// import aman, lalu hanya uji fungsi pure (pickWaitlistEntry).
vi.mock('../lib/env.ts', () => ({ env: new Proxy({}, { get: () => undefined }) }));
vi.mock('../inngest/client.ts', () => ({ inngest: { send: vi.fn() } }));
vi.mock('../db/index.ts', () => ({ db: {} }));

import { pickWaitlistEntry } from './waitlist.ts';

type Row = { id: string; serviceId: string | null; staffId: string | null };

const r = (id: string, serviceId: string | null, staffId: string | null): Row => ({
  id,
  serviceId,
  staffId,
});

describe('pickWaitlistEntry', () => {
  it('kosong → null', () => {
    expect(pickWaitlistEntry<Row>([], {})).toBeNull();
  });

  it('prioritas: layanan sama menang atas staf sama dan FIFO', () => {
    const rows = [r('a', null, 'staf-x'), r('b', 'svc-1', null), r('c', null, null)];
    expect(pickWaitlistEntry(rows, { serviceId: 'svc-1' })?.id).toBe('b');
  });

  it('tanpa layanan cocok → staf sama menang atas FIFO', () => {
    const rows = [r('a', null, null), r('b', null, 'staf-x')];
    expect(pickWaitlistEntry(rows, { serviceId: 'svc-9', staffId: 'staf-x' })?.id).toBe('b');
  });

  it('tanpa layanan & staf cocok → FIFO (tertua pertama)', () => {
    const rows = [r('a', null, null), r('b', 'svc-2', null)];
    expect(pickWaitlistEntry(rows, { serviceId: 'svc-9', staffId: 'staf-y' })?.id).toBe('a');
  });

  it('freed tanpa preferensi → FIFO', () => {
    const rows = [r('a', 'svc-1', null), r('b', 'svc-2', null)];
    expect(pickWaitlistEntry(rows, {})?.id).toBe('a');
  });
});
