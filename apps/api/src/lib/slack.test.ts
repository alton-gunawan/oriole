import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceIntegrations } from '@oriole/database';

import {
  buildSlackMessage,
  deliverSlackMessage,
  dispatchSlackNotification,
  escapeSlackMrkdwn,
  formatSlackTime,
  sendTestSlack,
} from './slack.ts';

// ── Fake Drizzle db (hanya select workspace_integrations) ────
const { dbState } = vi.hoisted(() => ({
  dbState: { tables: new Map<string, Record<string, unknown>[]>(), seq: 1 },
}));

vi.mock('../db/index.ts', async () => {
  const tableNames = new WeakMap<object, string>();
  tableNames.set(workspaceIntegrations, 'workspaceIntegrations');

  function columnKeyMap(table: object): Record<string, string> {
    const map: Record<string, string> = {};
    for (const [key, col] of Object.entries(table as Record<string, unknown>)) {
      if (col && typeof col === 'object' && 'name' in col && typeof (col as { name: unknown }).name === 'string') {
        map[(col as { name: string }).name] = key;
      }
    }
    return map;
  }

  function eqPairs(cond: unknown): { name: string; value: unknown }[] {
    const pairs: { name: string; value: unknown }[] = [];
    const walk = (node: unknown) => {
      if (!node || typeof node !== 'object') return;
      const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
      if (!Array.isArray(chunks)) return;
      chunks.forEach((chunk, i) => {
        if (chunk && typeof chunk === 'object' && typeof (chunk as { name?: unknown }).name === 'string') {
          const raw = chunks[i + 2];
          const value =
            raw && typeof raw === 'object' && 'value' in (raw as object)
              ? (raw as { value: unknown }).value
              : raw;
          pairs.push({ name: (chunk as { name: string }).name, value });
        } else {
          walk(chunk);
        }
      });
    };
    walk(cond);
    return pairs;
  }

  function makeSelectBuilder(name: string, table: object) {
    const colKey = columnKeyMap(table);
    const builder: {
      where: (...conds: unknown[]) => typeof builder;
      limit: (n: number) => typeof builder;
      then: (resolve: (rows: unknown[]) => unknown) => Promise<unknown>;
      _limit?: number;
      _filters: { name: string; value: unknown }[];
    } = {
      _limit: undefined,
      _filters: [],
      where(...conds) {
        builder._filters = conds.flatMap(eqPairs);
        return builder;
      },
      limit(n: number) {
        builder._limit = n;
        return builder;
      },
      then(resolve: (rows: unknown[]) => unknown) {
        let rows = [...(dbState.tables.get(name) ?? [])];
        if (builder._filters.length > 0) {
          rows = rows.filter((row) =>
            builder._filters.every((filter) => {
              const key = colKey[filter.name];
              return key === undefined || (row as Record<string, unknown>)[key] === filter.value;
            }),
          );
        }
        if (builder._limit != null) rows = rows.slice(0, builder._limit);
        return Promise.resolve(resolve(rows));
      },
    };
    return builder;
  }

  return { db: { select: () => ({ from: (table: object) => makeSelectBuilder(tableNames.get(table) ?? 'unknown', table) }) } };
});

function baseSlackIntegration(overrides: Record<string, unknown> = {}) {
  return {
    id: 'int-slack-1',
    workspaceId: 'ws-1',
    integrationType: 'slack',
    identifier: '#general',
    providerConfig: {
      webhookUrl: 'https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXX',
      channel: '#general',
    },
    isActive: true,
    lastSyncAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  dbState.tables.set('workspaceIntegrations', [baseSlackIntegration()]);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('escapeSlackMrkdwn', () => {
  it('escape & < > agar input user tidak merusak mrkdwn', () => {
    expect(escapeSlackMrkdwn('A & B <tag> > x')).toBe('A &amp; B &lt;tag&gt; &gt; x');
  });
});

describe('formatSlackTime', () => {
  it('ISO → format ramah (UTC default)', () => {
    const result = formatSlackTime('2026-08-14T14:00:00.000Z');
    expect(result).toContain('Aug');
    expect(result).toContain('14');
  });

  it('timezone tidak dikenal → fallback UTC tanpa throw', () => {
    const result = formatSlackTime('2026-08-14T14:00:00.000Z', 'Not/AZone');
    expect(result).toContain('Aug');
  });
});

describe('buildSlackMessage', () => {
  it('booking.created → header + judul + field customer/waktu/status', () => {
    const payload = buildSlackMessage('booking.created', {
      id: 'b-1',
      title: 'Konsultasi & Pajak <penting>',
      status: 'pending',
      scheduledAt: '2026-08-14T14:00:00.000Z',
      timezone: 'UTC',
      customerName: 'Budi',
      phone: '+6281234567890',
      durationMinutes: 60,
    });
    expect(payload.text).toBe('🆕 New booking — Konsultasi & Pajak <penting>');
    const header = payload.blocks[0] as { type: string; text: { text: string } };
    expect(header.type).toBe('header');
    expect(header.text.text).toBe('🆕 New booking');

    // Judul di-escape mrkdwn; field section berisi customer + waktu + status.
    const joined = JSON.stringify(payload.blocks);
    expect(joined).toContain('&lt;penting&gt;');
    expect(joined).toContain('*Customer:*');
    expect(joined).toContain('Budi');
    expect(joined).toContain('*Status:*');
    expect(joined).toContain('pending');
  });

  it('event tidak dikenal → fallback emoji + nama event', () => {
    const payload = buildSlackMessage('booking.mystery', {});
    expect(payload.text).toContain('booking.mystery');
  });

  it('data kosong (ping) → hanya header, tanpa section', () => {
    const payload = buildSlackMessage('ping', {});
    expect(payload.blocks).toHaveLength(1);
  });
});

describe('deliverSlackMessage', () => {
  it('Slack 2xx → ok', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response('ok', { status: 200 }))) as unknown as typeof fetch;

    const result = await deliverSlackMessage(
      'https://hooks.slack.com/services/T/B/X',
      buildSlackMessage('ping', {}),
    );
    expect(result).toEqual({ ok: true, status: 200 });
  });

  it('Slack non-2xx → SlackDeliveryError dengan status', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response('invalid_payload', { status: 400 }))) as unknown as typeof fetch;

    await expect(
      deliverSlackMessage('https://hooks.slack.com/services/T/B/X', buildSlackMessage('ping', {})),
    ).rejects.toMatchObject({ name: 'SlackDeliveryError', status: 400 });
  });

  it('jaringan gagal / timeout → SlackDeliveryError tanpa status', async () => {
    globalThis.fetch = (() =>
      Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))) as unknown as typeof fetch;

    await expect(
      deliverSlackMessage('https://hooks.slack.com/services/T/B/X', buildSlackMessage('ping', {})),
    ).rejects.toMatchObject({ name: 'SlackDeliveryError', status: 0 });
  });
});

describe('dispatchSlackNotification', () => {
  it('terkonfigurasi & aktif → mengirim pesan ber-blocks', async () => {
    const captured: { url: string; body: string } = { url: '', body: '' };
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      captured.url = url;
      captured.body = String(init?.body);
      return Promise.resolve(new Response('ok', { status: 200 }));
    }) as unknown as typeof fetch;

    const result = await dispatchSlackNotification('ws-1', 'booking.created', {
      title: 'Konsultasi',
      customerName: 'Budi',
    });
    expect(result).toEqual({ delivered: true });
    expect(captured.url).toBe('https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXX');
    const body = JSON.parse(captured.body) as { blocks: unknown[]; text: string };
    expect(body.text).toContain('New booking');
    expect(body.blocks.length).toBeGreaterThan(0);
  });

  it('integrasi tidak aktif → skipped (bukan error)', async () => {
    dbState.tables.set('workspaceIntegrations', [baseSlackIntegration({ isActive: false })]);
    const result = await dispatchSlackNotification('ws-1', 'booking.created', {});
    expect(result).toEqual({ skipped: 'not-configured' });
  });

  it('belum terhubung → skipped', async () => {
    dbState.tables.set('workspaceIntegrations', []);
    const result = await dispatchSlackNotification('ws-1', 'booking.created', {});
    expect(result).toEqual({ skipped: 'not-configured' });
  });
});

describe('sendTestSlack', () => {
  it('belum terhubung → SlackDeliveryError 409', async () => {
    dbState.tables.set('workspaceIntegrations', []);
    await expect(sendTestSlack('ws-1')).rejects.toMatchObject({ status: 409 });
  });

  it('terhubung → mengirim event ping', async () => {
    let capturedBody = '';
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = String(init?.body);
      return Promise.resolve(new Response('ok', { status: 200 }));
    }) as unknown as typeof fetch;

    const result = await sendTestSlack('ws-1');
    expect(result).toEqual({ delivered: true, status: 200 });
    expect(JSON.parse(capturedBody).text).toContain('test');
  });
});
