import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiKnowledge } from '@oriole/database';

import { buildKnowledgeChunks, rankChunks, retrieveKnowledge, scoreChunk, tokenize } from './ai-rag.ts';

// ── Mocks ───────────────────────────────────────────────────────

const { dbState } = vi.hoisted(() => ({
  dbState: {} as Record<string, Record<string, unknown>[]>,
}));

vi.mock('../db/index.ts', async () => {
  const { workspaces } = await import('@oriole/database');
  const tableNames = new WeakMap<object, string>();
  tableNames.set(workspaces, 'workspaces');
  return {
    db: {
      select: () => ({
        from: (table: object) => ({
          where: () => ({
            limit: () => ({
              then: (resolve: (rows: unknown[]) => unknown) =>
                Promise.resolve(resolve([...(dbState[tableNames.get(table) ?? 'unknown'] ?? [])].slice(0, 1))),
            }),
          }),
        }),
      }),
    },
  };
});

// loadServices di-mock agar retrieveKnowledge (jalur DB) hanya melihat data tenant.
const { loadServicesMock } = vi.hoisted(() => ({ loadServicesMock: vi.fn() }));
vi.mock('./service-catalog.ts', () => ({ loadServices: loadServicesMock }));

// ── Fixtures ────────────────────────────────────────────────────

const KB_A: AiKnowledge = {
  description: 'Barbershop A di Jakarta.',
  services: 'Potong rambut 100rb, Creambath 150rb',
  hours: 'Sen–Sab 10.00–21.00',
  location: 'Jl. A No. 1',
  policy: 'Deposit 50% untuk reservasi.',
  faq: [{ q: 'Bisa booking online?', a: 'Ya, via WhatsApp.' }],
};

const SERVICES_A = [
  {
    id: 'svc-a-1',
    name: 'Potong Rambut',
    description: null,
    durationMinutes: 45,
    priceMinor: 10000,
    currency: 'IDR',
    color: '#000000',
    category: ['Haircut'],
    isActive: true,
    sortOrder: 0,
    staffIds: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

const SERVICES_B = [
  {
    id: 'svc-b-1',
    name: 'Keramas',
    description: null,
    durationMinutes: 30,
    priceMinor: 5000,
    currency: 'IDR',
    color: '#000000',
    category: ['Perawatan'],
    isActive: true,
    sortOrder: 0,
    staffIds: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

beforeEach(() => {
  dbState.workspaces = [];
  loadServicesMock.mockReset();
});

// ── tokenize ────────────────────────────────────────────────────

describe('tokenize', () => {
  it('huruf kecil + tanpa tanda baca', () => {
    expect(tokenize('Berapa Harga Scaling?')).toEqual(['harga', 'scaling']);
  });

  it('stopwords dibuang (berapa/di/untuk/dll)', () => {
    expect(tokenize('berapa harga untuk di jakarta')).toEqual(['harga', 'jakarta']);
  });

  it('teks kosong → []', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('!!!')).toEqual([]);
  });
});

// ── buildKnowledgeChunks ────────────────────────────────────────

describe('buildKnowledgeChunks', () => {
  it('membangun chunk dari KB + katalog layanan (dengan id stabil untuk grounding)', () => {
    const chunks = buildKnowledgeChunks({ knowledge: KB_A, services: SERVICES_A });
    const ids = chunks.map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining(['kb:description', 'kb:services', 'kb:hours', 'kb:location', 'kb:policy', 'faq:0', 'service:svc-a-1']),
    );
    const serviceChunk = chunks.find((c) => c.id === 'service:svc-a-1');
    expect(serviceChunk?.content).toContain('Potong Rambut');
    expect(serviceChunk?.content).toContain('45 menit');
  });

  it('layanan nonaktif TIDAK menjadi chunk', () => {
    const chunks = buildKnowledgeChunks({
      knowledge: null,
      services: [{ ...SERVICES_A[0], isActive: false }],
    });
    expect(chunks.some((c) => c.id === 'service:svc-a-1')).toBe(false);
  });

  it('KB parsial tidak menghasilkan chunk kosong', () => {
    const chunks = buildKnowledgeChunks({ knowledge: { hours: '08.00–20.00' }, services: [] });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].id).toBe('kb:hours');
  });
});

// ── scoreChunk / rankChunks ─────────────────────────────────────

describe('rankChunks', () => {
  it('chunk tak relevan dikeluarkan; yang relevan diurutkan menurun', () => {
    const chunks = buildKnowledgeChunks({ knowledge: KB_A, services: SERVICES_A });
    const result = rankChunks(chunks, 'Berapa harga potong rambut?', 10);
    expect(result.chunks.length).toBeGreaterThan(0);
    // Chunk katalog layanan (harga) harus paling atas untuk pertanyaan harga.
    expect(result.chunks[0].type).toBe('service');
    expect(result.chunks[0].id).toBe('service:svc-a-1');
  });

  it('query tanpa kecocokan → chunks kosong, hasRelevant false', () => {
    const chunks = buildKnowledgeChunks({ knowledge: KB_A, services: SERVICES_A });
    const result = rankChunks(chunks, 'zzzzzqqqq', 10);
    expect(result.chunks).toEqual([]);
    expect(result.hasRelevant).toBe(false);
  });

  it('limit diterapkan', () => {
    const chunks = buildKnowledgeChunks({ knowledge: KB_A, services: SERVICES_A });
    const result = rankChunks(chunks, 'jakarta', 1);
    expect(result.chunks.length).toBeLessThanOrEqual(1);
  });

  it('scoreChunk konsisten: query jam → chunk hours relevan', () => {
    const chunks = buildKnowledgeChunks({ knowledge: KB_A, services: [] });
    const hours = chunks.find((c) => c.id === 'kb:hours')!;
    expect(scoreChunk('jam buka kapan?', hours)).toBeGreaterThan(0);
    expect(scoreChunk('lokasi di mana?', hours)).toBe(0);
  });
});

// ── retrieveKnowledge — tenant isolation ────────────────────────

describe('retrieveKnowledge (tenant-scoped)', () => {
  it('jalur DB: hanya knowledge tenant yang diminta yang dikembalikan', async () => {
    dbState.workspaces = [
      {
        id: 'ws-A',
        aiKnowledge: KB_A,
      },
    ];
    // loadServices (mock) = "DB" yang sudah difilter workspaceId → hanya tenant A.
    loadServicesMock.mockResolvedValue(SERVICES_A);

    const result = await retrieveKnowledge({ tenantId: 'ws-A', query: 'harga potong rambut' });

    // Chunk service tenant A ada; data tenant B (Keramas) tidak pernah muncul.
    const allContent = result.chunks.map((c) => c.content).join(' ');
    expect(allContent).toContain('Potong Rambut');
    expect(allContent).not.toContain('Keramas');
    // loadServices dipanggil dengan tenantId (bukan query global).
    expect(loadServicesMock).toHaveBeenCalledWith('ws-A');
  });

  it('jalur injeksi: hanya chunk dari data tenant itu (tidak ada kebocoran antar-tenant)', async () => {
    const resultA = await retrieveKnowledge({
      tenantId: 'ws-A',
      query: 'harga',
      knowledge: KB_A,
      services: SERVICES_A,
    });
    const resultB = await retrieveKnowledge({
      tenantId: 'ws-B',
      query: 'harga',
      knowledge: { services: 'Keramas 50rb' },
      services: SERVICES_B,
    });

    expect(resultA.chunks.every((c) => c.content.includes('Potong Rambut') || c.id.startsWith('kb:'))).toBe(true);
    expect(resultB.chunks.map((c) => c.content).join(' ')).not.toContain('Potong Rambut');
    // Tenant B tidak pernah melihat id service tenant A.
    expect(resultB.chunks.some((c) => c.id === 'service:svc-a-1')).toBe(false);
  });

  it('retrieval kosong (KB kosong + tidak ada layanan) → hasRelevant false', async () => {
    const result = await retrieveKnowledge({ tenantId: 'ws-A', query: 'apa saja', knowledge: null, services: [] });
    expect(result.chunks).toEqual([]);
    expect(result.hasRelevant).toBe(false);
  });
});
