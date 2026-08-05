import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock Inngest agar emit helper tidak mengirim event sungguhan.
// Catatan: file ini di src/lib/ → path ke inngest/client adalah ../inngest.
const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
vi.mock('../inngest/client.ts', () => ({
  inngest: { send: sendMock },
}));

// `.env` root (milik environment) menimpa env proses — no-op agar test
// bisa mengendalikan env sendiri (pola sama seperti whatsapp.test.ts).
vi.mock('@oriole/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@oriole/config')>();
  return { ...actual, loadRootEnv: vi.fn() };
});

let reminders: typeof import('./reminders.ts');

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/oriole_test';
  process.env.NEON_AUTH_URL = 'https://ep-test.neon.tech/neondb/auth';
  process.env.PADDLE_API_KEY = 'pdl_sdbx_test';
  process.env.PADDLE_WEBHOOK_SECRET = 'pdl_ntfset_test';
  process.env.RESEND_API_KEY = 're_test';
  process.env.CALLE_API_KEY = 'calle_test';
});

// Import dinamis SETELAH env lengkap — db/index.ts memvalidasi env saat boot.
beforeAll(async () => {
  reminders = await import('./reminders.ts');
});

beforeEach(() => {
  sendMock.mockReset();
});

describe('computeReminderAt', () => {
  it('mengurangi lead minutes dari scheduledAt', () => {
    const scheduledAt = new Date('2026-08-15T14:00:00.000Z');
    expect(reminders.computeReminderAt(scheduledAt, 120).toISOString()).toBe(
      '2026-08-15T12:00:00.000Z',
    );
    expect(reminders.computeReminderAt(scheduledAt, 60).toISOString()).toBe(
      '2026-08-15T13:00:00.000Z',
    );
    expect(reminders.computeReminderAt(scheduledAt, 1440).toISOString()).toBe(
      '2026-08-14T14:00:00.000Z',
    );
  });

  it('menangani lintas tengah malam', () => {
    const scheduledAt = new Date('2026-08-16T00:30:00.000Z');
    expect(reminders.computeReminderAt(scheduledAt, 45).toISOString()).toBe(
      '2026-08-15T23:45:00.000Z',
    );
  });
});

describe('emitBookingCreated', () => {
  it('mengirim booking/created dengan reminderAt = scheduledAt − lead', async () => {
    await reminders.emitBookingCreated({
      workspaceId: 'ws-1',
      bookingId: 'bk-1',
      scheduledAt: new Date('2026-08-15T14:00:00.000Z'),
      timezone: 'Asia/Jakarta',
      leadMinutes: 120,
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith({
      name: 'booking/created',
      data: expect.objectContaining({
        bookingId: 'bk-1',
        workspaceId: 'ws-1',
        scheduledAt: '2026-08-15T14:00:00.000Z',
        reminderAt: '2026-08-15T12:00:00.000Z',
        timezone: 'Asia/Jakarta',
      }),
    });
  });

  it('tidak menjadwalkan bila reminderAt sudah lewat (booking mendadak)', async () => {
    await reminders.emitBookingCreated({
      workspaceId: 'ws-1',
      bookingId: 'bk-1',
      scheduledAt: new Date(Date.now() + 60_000), // 1 menit lagi
      leadMinutes: 120,
    });
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('emitBookingCancelled', () => {
  it('mengirim booking/cancelled untuk membatalkan run terjadwal', async () => {
    await reminders.emitBookingCancelled('ws-1', 'bk-1');
    expect(sendMock).toHaveBeenCalledWith({
      name: 'booking/cancelled',
      data: expect.objectContaining({ bookingId: 'bk-1', workspaceId: 'ws-1' }),
    });
  });

  it('tidak melempar error bila Inngest gagal (mis. event key belum disetel)', async () => {
    sendMock.mockRejectedValueOnce(new Error('no event key'));
    await expect(reminders.emitBookingCancelled('ws-1', 'bk-1')).resolves.toBeUndefined();
  });
});
