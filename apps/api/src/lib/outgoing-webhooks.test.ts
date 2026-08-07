import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { workspaceIntegrations } from '@oriole/database';

import {
  buildWebhookDelivery,
  deliverWebhook,
  dispatchOutgoingWebhook,
  loadWebhookConfig,
  sendTestWebhook,
} from './outgoing-webhooks.ts';

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

function baseWebhookIntegration(overrides: Record<string, unknown> = {}) {
  return {
    id: 'int-w1',
    workspaceId: 'ws-1',
    integrationType: 'webhook',
    identifier: 'https://example.com/hook',
    providerConfig: { url: 'https://example.com/hook', secret: 'super-secret-123' },
    isActive: true,
    lastSyncAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  dbState.tables.set('workspaceIntegrations', [baseWebhookIntegration()]);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('buildWebhookDelivery', () => {
  it('memuat body + header event/timestamp (tanpa secret → tanpa signature)', () => {
    const delivery = buildWebhookDelivery(
      'https://example.com/hook',
      'booking.created',
      'ws-1',
      { id: 'b-1' },
      null,
      'webhook-1',
    );
    expect(delivery.url).toBe('https://example.com/hook');
    expect(delivery.headers['X-Oriole-Event']).toBe('booking.created');
    expect(delivery.headers['X-Oriole-Webhook-Id']).toBe('webhook-1');
    expect(delivery.headers['X-Oriole-Timestamp']).toMatch(/^\d+$/);
    expect(delivery.headers['X-Oriole-Signature']).toBeUndefined();

    const body = JSON.parse(delivery.rawBody) as { event: string; workspaceId: string; data: { id: string } };
    expect(body).toMatchObject({ event: 'booking.created', workspaceId: 'ws-1', data: { id: 'b-1' } });
  });

  it('dengan secret → signature sha256=hmac(ts.body) valid & diverifikasi ulang', () => {
    const secret = 'super-secret-123';
    const delivery = buildWebhookDelivery(
      'https://example.com/hook',
      'booking.updated',
      'ws-1',
      { id: 'b-2', status: 'confirmed' },
      secret,
      'webhook-2',
    );
    const signature = delivery.headers['X-Oriole-Signature'];
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);

    const expected = createHmac('sha256', secret)
      .update(`${delivery.headers['X-Oriole-Timestamp']}.${delivery.rawBody}`, 'utf8')
      .digest('hex');
    expect(signature).toBe(`sha256=${expected}`);
  });
});

describe('deliverWebhook', () => {
  it('penerima 2xx → ok', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response('ok', { status: 200 }))) as unknown as typeof fetch;

    const result = await deliverWebhook(
      buildWebhookDelivery('https://example.com/hook', 'ping', 'ws-1', {}, null),
    );
    expect(result).toEqual({ ok: true, status: 200 });
  });

  it('penerima non-2xx → WebhookDeliveryError dengan status', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response('nope', { status: 500 }))) as unknown as typeof fetch;

    await expect(
      deliverWebhook(buildWebhookDelivery('https://example.com/hook', 'ping', 'ws-1', {}, null)),
    ).rejects.toMatchObject({ name: 'WebhookDeliveryError', status: 500 });
  });

  it('jaringan gagal / timeout → WebhookDeliveryError tanpa status', async () => {
    globalThis.fetch = (() =>
      Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))) as unknown as typeof fetch;

    await expect(
      deliverWebhook(buildWebhookDelivery('https://example.com/hook', 'ping', 'ws-1', {}, null)),
    ).rejects.toMatchObject({ name: 'WebhookDeliveryError', status: 0 });
  });
});

describe('dispatchOutgoingWebhook', () => {
  it('terkonfigurasi & aktif → mengirim dengan header signature', async () => {
    const captured: { headers: Record<string, string>; body: string } = { headers: {}, body: '' };
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      captured.headers = init?.headers as Record<string, string>;
      captured.body = String(init?.body);
      return Promise.resolve(new Response('ok', { status: 200 }));
    }) as unknown as typeof fetch;

    const result = await dispatchOutgoingWebhook('ws-1', 'booking.created', { id: 'b-1' });
    expect(result).toMatchObject({ delivered: true });
    expect(captured.headers['X-Oriole-Event']).toBe('booking.created');
    expect(captured.headers['X-Oriole-Signature']).toMatch(/^sha256=/);
    const body = JSON.parse(captured.body) as { data: { id: string } };
    expect(body.data).toEqual({ id: 'b-1' });
  });

  it('webhookId dari pemanggil dipakai ulang (stabil antar retry)', async () => {
    const ids: string[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      ids.push((init?.headers as Record<string, string>)['X-Oriole-Webhook-Id']);
      return Promise.resolve(new Response('ok', { status: 200 }));
    }) as unknown as typeof fetch;

    const webhookId = 'stable-id-123';
    await dispatchOutgoingWebhook('ws-1', 'booking.created', { id: 'b-1' }, webhookId);
    await dispatchOutgoingWebhook('ws-1', 'booking.created', { id: 'b-1' }, webhookId);
    expect(ids).toEqual([webhookId, webhookId]);
  });

  it('integrasi tidak aktif → skipped (bukan error)', async () => {
    dbState.tables.set('workspaceIntegrations', [baseWebhookIntegration({ isActive: false })]);
    const result = await dispatchOutgoingWebhook('ws-1', 'booking.created', {});
    expect(result).toEqual({ skipped: 'not-configured' });
  });

  it('belum terhubung → skipped', async () => {
    dbState.tables.set('workspaceIntegrations', []);
    const result = await dispatchOutgoingWebhook('ws-1', 'booking.created', {});
    expect(result).toEqual({ skipped: 'not-configured' });
  });
});

describe('sendTestWebhook', () => {
  it('belum terhubung → WebhookDeliveryError 409', async () => {
    dbState.tables.set('workspaceIntegrations', []);
    await expect(sendTestWebhook('ws-1')).rejects.toMatchObject({ status: 409 });
  });

  it('terhubung → mengirim event ping', async () => {
    let capturedEvent = '';
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedEvent = (init?.headers as Record<string, string>)['X-Oriole-Event'];
      return Promise.resolve(new Response('ok', { status: 200 }));
    }) as unknown as typeof fetch;

    const result = await sendTestWebhook('ws-1');
    expect(result).toEqual({ delivered: true, status: 200 });
    expect(capturedEvent).toBe('ping');
  });
});

// loadWebhookConfig dipakai internal; pastikan tetap diekspor (guard).
void loadWebhookConfig;
void and;
void eq;
