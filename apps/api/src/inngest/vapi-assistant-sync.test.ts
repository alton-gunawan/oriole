import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks (scaffolding import functions.ts) ────────────────────

const { createFunctionMock } = vi.hoisted(() => ({
  createFunctionMock: vi.fn((opts: unknown, handler: unknown) => ({ opts, handler })),
}));

vi.mock('./client.ts', () => ({
  inngest: { createFunction: createFunctionMock, send: vi.fn().mockResolvedValue(undefined) },
  inngestEventBaseUrl: () => 'http://localhost:8288/',
  inngestMode: () => 'dev',
}));

const { envState } = vi.hoisted(() => ({
  envState: {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/oriole_test',
    NEON_AUTH_URL: 'https://ep-test.neon.tech/neondb/auth',
    PADDLE_API_KEY: 'pdl_sdbx_test',
    PADDLE_WEBHOOK_SECRET: 'pdl_ntfset_test',
    RESEND_API_KEY: 're_test',
    VAPI_API_KEY: 'vapi_test',
    VAPI_PHONE_NUMBER_ID: 'phone-number-test',
    INNGEST_EVENT_KEY: '',
    NODE_ENV: 'test',
  } as Record<string, string>,
}));

vi.mock('../lib/env.ts', () => ({ env: envState }));

vi.mock('@oriole/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@oriole/config')>();
  return { ...actual, loadRootEnv: vi.fn() };
});

// Fungsi sync hanya memakai lib vapi-inbound (di-mock) — db tidak dipakai.
vi.mock('../db/index.ts', () => ({ db: {} }));

const { getInboundAssistantMock, provisionInboundAssistantMock } = vi.hoisted(() => ({
  getInboundAssistantMock: vi.fn(),
  provisionInboundAssistantMock: vi.fn(),
}));

vi.mock('../lib/vapi-inbound.ts', () => ({
  resolveInboundWorkspaceId: vi.fn(),
  getInboundAssistantForWorkspace: getInboundAssistantMock,
  provisionInboundAssistantForWorkspace: provisionInboundAssistantMock,
}));

import { syncVapiAssistant } from './functions.ts';

type SyncHandler = (args: {
  event: { data: Record<string, unknown> };
  step: { run: (name: string, fn: () => unknown) => Promise<unknown> };
}) => Promise<unknown>;

const handler = (syncVapiAssistant as unknown as { handler: SyncHandler }).handler;

function run(event: Record<string, unknown>) {
  return handler({
    event: { data: event },
    step: { run: vi.fn(async (_name: string, fn: () => unknown) => fn()) } as never,
  });
}

beforeEach(() => {
  getInboundAssistantMock.mockReset();
  provisionInboundAssistantMock.mockReset();
});

describe('syncVapiAssistant — vapi/assistant.sync (otomatis sesuai business)', () => {
  it('belum di-provision & create=false (perubahan layanan/KB) → skip, tanpa auto-create', async () => {
    getInboundAssistantMock.mockResolvedValue(null);

    const result = await run({ workspaceId: 'ws-1', create: false });
    expect(result).toEqual({ skipped: 'not-provisioned' });
    expect(provisionInboundAssistantMock).not.toHaveBeenCalled();
  });

  it('belum di-provision & create=true (opt-in nomor inbound) → create', async () => {
    getInboundAssistantMock.mockResolvedValue(null);
    provisionInboundAssistantMock.mockResolvedValue({
      assistantId: 'vapi-assistant-1',
      name: 'oriole-receptionist-x',
      updated: false,
    });

    const result = await run({ workspaceId: 'ws-1', create: true });
    expect(result).toEqual({
      synced: true,
      assistantId: 'vapi-assistant-1',
      name: 'oriole-receptionist-x',
      updated: false,
    });
    expect(provisionInboundAssistantMock).toHaveBeenCalledWith('ws-1');
  });

  it('sudah di-provision → update (re-sync otomatis setelah layanan/KB/ nama berubah)', async () => {
    getInboundAssistantMock.mockResolvedValue({ assistantId: 'vapi-assistant-1', name: 'x' });
    provisionInboundAssistantMock.mockResolvedValue({
      assistantId: 'vapi-assistant-1',
      name: 'oriole-receptionist-x',
      updated: true,
    });

    const result = await run({ workspaceId: 'ws-1', create: false });
    expect(result).toEqual({
      synced: true,
      assistantId: 'vapi-assistant-1',
      name: 'oriole-receptionist-x',
      updated: true,
    });
  });

  it('tanpa workspaceId → skipped', async () => {
    const result = await run({});
    expect(result).toEqual({ skipped: 'no-workspace-id' });
    expect(provisionInboundAssistantMock).not.toHaveBeenCalled();
  });
});
