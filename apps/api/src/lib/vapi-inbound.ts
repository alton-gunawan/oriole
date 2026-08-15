import { and, eq, isNull } from 'drizzle-orm';
import { type Vapi } from '@vapi-ai/server-sdk';
import { bookings, vapiInboundNumbers, workspaces } from '@oriole/database';

import { db } from '../db/index.ts';
import { env } from './env.ts';
import { assertSlotAvailable, getAvailableSlots, type AvailabilityAssert } from './availability.ts';
import { loadServices, type ServiceSnapshot } from './service-catalog.ts';
import { syncBookingContact } from './contact-sync.ts';
import { emitAutoCallScheduled, emitBookingCreated } from './reminders.ts';
import {
  emitCalendarBookingEvent,
  emitOutgoingWebhookEvent,
  emitSlackBookingEvent,
  emitTelegramBookingAlert,
} from './integration-events.ts';
import { loadStaffAvailability } from './availability.ts';
import { zonedDayStart, zonedTimeToUtc } from './timezone.ts';
import {
  registerVapiInboundNumber,
  unregisterVapiInboundNumber,
} from '../services/vapi.ts';

/**
 * Panggilan MASUK via Vapi — customer menelepon nomor workspace dan dilayani
 * agen Voice AI yang bisa membuat booking langsung (real-time tool calls).
 *
 * Alur end-to-end:
 * 1. Register → nomor Vapi dibuat TANPA assistantId; server URL webhook kita
 *    dipasang di level nomor (services/vapi.ts).
 * 2. Customer menelepon → Vapi mengirim `assistant-request` ke webhook →
 *    kita me-resolve workspace dari `phoneNumber.id` (tabel
 *    vapi_inbound_numbers) → kembalikan asisten transient per-workspace
 *    (`buildInboundAssistantForWorkspace`) yang membawa daftar layanan nyata.
 * 3. Percakapan → agen memakai tool `check_availability` (cek slot nyata via
 *    slot engine) lalu `create_booking` (buat booking + kontak + reminder +
 *    auto-call + webhook keluar — pipeline sama dengan route POST /bookings).
 * 4. `end-of-call-report` → onVapiEvent mencatat panggilan inbound di
 *    calle_calls (bookingId null) untuk riwayat & analytics.
 *
 * Idempotensi booking: source='vapi-inbound', sourceRef=`<callId>:<toolCallId>`
 * (unique index bookings_source_ref_idx) — retry tool-calls tidak membuat
 * booking ganda.
 */

/* ────────────────────────────────────────────────────────────
 * Baris nomor inbound (DB)
 * ──────────────────────────────────────────────────────────── */

export interface InboundNumberInfo {
  id: string;
  vapiPhoneNumberId: string;
  number: string | null;
  name: string | null;
  provider: string;
  isActive: boolean;
  createdAt: string;
}

type InboundNumberRow = typeof vapiInboundNumbers.$inferSelect;

function serializeInboundNumber(row: InboundNumberRow): InboundNumberInfo {
  return {
    id: row.id,
    vapiPhoneNumberId: row.vapiPhoneNumberId,
    number: row.number,
    name: row.name,
    provider: row.provider,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Daftar nomor inbound milik workspace (untuk halaman Integrations). */
export async function listInboundNumbers(workspaceId: string): Promise<InboundNumberInfo[]> {
  const rows = await db
    .select()
    .from(vapiInboundNumbers)
    .where(eq(vapiInboundNumbers.workspaceId, workspaceId))
    .orderBy(vapiInboundNumbers.createdAt);
  return rows.map(serializeInboundNumber);
}

/**
 * Resolve workspace dari id nomor Vapi — dipakai webhook untuk memetakan
 * panggilan masuk / assistant-request / tool-calls ke workspace yang benar.
 * null = nomor tidak terdaftar di app ini (bukan milik kita).
 */
export async function resolveInboundWorkspaceId(phoneNumberId: string): Promise<string | null> {
  const [row] = await db
    .select({ workspaceId: vapiInboundNumbers.workspaceId })
    .from(vapiInboundNumbers)
    .where(eq(vapiInboundNumbers.vapiPhoneNumberId, phoneNumberId))
    .limit(1);
  return row?.workspaceId ?? null;
}

export class InboundNumberNotFoundError extends Error {
  constructor() {
    super('Nomor inbound tidak ditemukan di workspace ini.');
    this.name = 'InboundNumberNotFoundError';
  }
}

/** Daftarkan nomor inbound: buat di Vapi lalu simpan baris mapping. */
export async function registerInboundNumberForWorkspace(input: {
  userId: string | null;
  workspaceId: string;
  name?: string | null;
  areaCode?: string | null;
}): Promise<InboundNumberInfo> {
  const registered = await registerVapiInboundNumber({
    workspaceId: input.workspaceId,
    name: input.name?.trim() || `oriole-inbound-${input.workspaceId}`,
    areaCode: input.areaCode?.trim() || undefined,
  });
  const [row] = await db
    .insert(vapiInboundNumbers)
    .values({
      userId: input.userId,
      workspaceId: input.workspaceId,
      vapiPhoneNumberId: registered.vapiPhoneNumberId,
      number: registered.number,
      name: input.name?.trim() || null,
      provider: 'vapi',
      isActive: true,
    })
    .returning();
  return serializeInboundNumber(row);
}

/** Lepas nomor inbound: hapus dari Vapi (best-effort) lalu hapus baris. */
export async function unregisterInboundNumberForWorkspace(input: {
  workspaceId: string;
  inboundNumberId: string;
}): Promise<void> {
  const [row] = await db
    .select()
    .from(vapiInboundNumbers)
    .where(
      and(
        eq(vapiInboundNumbers.id, input.inboundNumberId),
        eq(vapiInboundNumbers.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);
  if (!row) throw new InboundNumberNotFoundError();

  // Gagal hapus di Vapi tidak menggagalkan lepas — baris lokal tetap dihapus
  // (nomor yang tersisa di Vapi bisa dirapikan manual / lewat re-register).
  try {
    await unregisterVapiInboundNumber(row.vapiPhoneNumberId);
  } catch (err) {
    console.warn('[vapi-inbound] hapus nomor di Vapi gagal (dilanjutkan):', err);
  }
  await db.delete(vapiInboundNumbers).where(eq(vapiInboundNumbers.id, row.id));
}

/* ────────────────────────────────────────────────────────────
 * Asisten transient inbound
 * ──────────────────────────────────────────────────────────── */

type WorkspaceRowType = typeof workspaces.$inferSelect;

/** Bahasa panggilan workspace (en / id) — sama dengan panggilan keluar. */
function workspaceLanguage(workspace: WorkspaceRowType): 'en' | 'id' {
  return workspace.callGoalLanguage === 'id' ? 'id' : 'en';
}

/** Satu baris daftar layanan untuk prompt (nama + durasi + harga bila ada). */
function formatServiceLine(service: ServiceSnapshot, language: 'en' | 'id'): string {
  const duration = `${service.durationMinutes} ${language === 'id' ? 'menit' : 'min'}`;
  const price =
    service.priceMinor != null
      ? `, ${formatPrice(service.priceMinor, service.currency)}`
      : '';
  return `- ${service.name} (${duration}${price})`;
}

/** Format harga minor units (sen) → "Rp 50.000" / "$50.00". */
export function formatPrice(priceMinor: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
      maximumFractionDigits: 0,
    }).format(priceMinor / 100);
  } catch {
    return `${(priceMinor / 100).toFixed(0)} ${currency}`;
  }
}

function inboundSystemPrompt(input: {
  language: 'en' | 'id';
  workspaceName: string;
  servicesText: string;
}): string {
  const { language, workspaceName, servicesText } = input;
  if (language === 'id') {
    return `Kamu adalah resepsionis AI dari ${workspaceName}. Kamu menjawab panggilan telepon masuk dari pelanggan dan membantu mereka membuat janji temu (booking).

LAYANAN YANG TERSEDIA:
${servicesText}

ATURAN:
1. Bersikap ramah, ringkas, dan profesional — seperti resepsionis front desk.
2. Untuk membuat booking, kamu harus mengumpulkan: layanan yang diinginkan, tanggal dan jam yang diminta, nama pelanggan, dan nomor teleponnya.
3. Gunakan tool "check_availability" untuk melihat slot kosong pada tanggal yang diminta SEBELUM menawarkan atau mengonfirmasi waktu apa pun. Jangan pernah mengarang ketersediaan.
4. Setelah pelanggan setuju dengan slot, gunakan tool "create_booking". Lalu konfirmasikan kembali janji temu (layanan, tanggal, jam) dan akhiri panggilan dengan sopan.
5. Bila pelanggan menanyakan harga, jawab HANYA dari daftar layanan di atas. Jangan pernah mengarang harga atau layanan.
6. Bila layanan yang diminta tidak ada di daftar, sebutkan layanan yang tersedia dan minta pelanggan memilih salah satu.
7. Bila pelanggan ingin mengubah jadwal atau membatalkan booking yang sudah ada, catat nama dan nomor teleponnya, minta maaf, dan katakan bahwa staf akan menghubungi mereka segera. JANGAN membuat booking ganda.
8. Bila slot tidak tersedia, beri tahu pelanggan dan tawarkan opsi lain dari hasil check_availability.
9. Nomor telepon pelanggan bisa didapat dari caller ID — minta konfirmasi bila ragu.`;
  }
  return `You are the AI receptionist of ${workspaceName}. You answer inbound phone calls from customers and help them book appointments.

AVAILABLE SERVICES:
${servicesText}

RULES:
1. Be warm, concise and professional — like a friendly front-desk receptionist.
2. To book an appointment you must gather: the service the customer wants, a preferred date and time, the customer's name, and their phone number.
3. Use the "check_availability" tool to look up open slots for the requested date BEFORE offering or confirming any time. Never invent availability.
4. Once the customer agrees on a slot, use the "create_booking" tool. Then confirm the appointment with the customer (service, date, time) and end the call politely.
5. If the customer asks about prices, answer ONLY from the services list above. Never invent prices or services.
6. If the requested service is not in the list, tell the customer which services are available and ask them to choose one.
7. If the customer wants to reschedule or cancel an existing booking, take their name and phone number, apologize, and tell them a team member will contact them shortly. Do NOT create a duplicate booking.
8. If a slot is unavailable, tell the customer and offer other options from the check_availability results.
9. The customer's phone number can come from caller ID — ask for confirmation if unsure.`;
}

/** Definisikan tool check_availability (OpenAI function schema). */
function checkAvailabilityTool(language: 'en' | 'id') {
  return {
    type: 'function' as const,
    function: {
      name: 'check_availability',
      description:
        language === 'id'
          ? 'Cek slot janji temu yang tersedia pada tanggal tertentu. Panggil tool ini SEBELUM menawarkan atau mengonfirmasi waktu janji temu apa pun.'
          : 'Check available appointment slots for a given date. Call this tool BEFORE offering or confirming any appointment time.',
      parameters: {
        type: 'object' as const,
        properties: {
          date: {
            type: 'string',
            description: 'Tanggal dalam format YYYY-MM-DD (contoh: 2026-08-20)',
          },
          serviceName: {
            type: 'string',
            description: 'Layanan yang ingin dipesan pelanggan',
          },
        },
        required: ['date'],
      },
    },
  };
}

/** Definisikan tool create_booking (OpenAI function schema). */
function createBookingTool(language: 'en' | 'id') {
  return {
    type: 'function' as const,
    function: {
      name: 'create_booking',
      description:
        language === 'id'
          ? 'Buat booking setelah pelanggan setuju dengan layanan, tanggal, dan jam. Mengembalikan konfirmasi yang harus disampaikan ke pelanggan.'
          : 'Create a booking once the customer agrees on a service, date and time. Returns the confirmation to relay to the customer.',
      parameters: {
        type: 'object' as const,
        properties: {
          serviceName: { type: 'string', description: 'Nama layanan yang dipesan' },
          date: { type: 'string', description: 'Tanggal dalam format YYYY-MM-DD' },
          time: {
            type: 'string',
            description: 'Jam mulai dalam format HH:MM 24 jam di zona waktu booking (dari hasil check_availability)',
          },
          customerName: { type: 'string', description: 'Nama lengkap pelanggan' },
          customerPhone: { type: 'string', description: 'Nomor telepon pelanggan (format internasional bila memungkinkan)' },
          notes: { type: 'string', description: 'Catatan tambahan (opsional)' },
        },
        required: ['serviceName', 'date', 'time', 'customerName', 'customerPhone'],
      },
    },
  };
}

/**
 * Bangun asisten transient untuk satu panggilan MASUK. Server URL sama dengan
 * webhook keluar (satu endpoint menangani assistant-request + tool-calls +
 * status + end-of-call-report). Tool-calls dikirim ke assistant.server.url
 * (tool TIDAK punya server sendiri) — sudah tercantum di `serverMessages`.
 */
export function buildInboundAssistant(input: {
  workspaceName: string;
  language: 'en' | 'id';
  services: ServiceSnapshot[];
  /** Fallback bila katalog kosong: teks bebas aiKnowledge.services. */
  servicesText?: string | null;
}): Vapi.CreateAssistantDto {
  const { workspaceName, language, services, servicesText } = input;

  const serviceLines =
    services.length > 0
      ? services.map((s) => formatServiceLine(s, language)).join('\n')
      : servicesText?.trim() || (language === 'id' ? '(belum ada daftar layanan)' : '(no services configured yet)');

  const server: NonNullable<Vapi.CreateAssistantDto['server']> = {
    url: `${env.API_URL}/api/webhooks/vapi`,
  };
  if (env.VAPI_WEBHOOK_SECRET) {
    server.headers = { Authorization: `Bearer ${env.VAPI_WEBHOOK_SECRET}` };
  }

  return {
    name: `oriole-inbound-${workspaceName.replace(/[^a-z0-9-]/gi, '-').slice(0, 40)}`,
    transcriber: {
      provider: 'deepgram',
      model: 'nova-2',
      language,
    },
    model: {
      provider: 'openai',
      model: env.VAPI_MODEL as Vapi.OpenAiModelModel,
      messages: [
        { role: 'system', content: inboundSystemPrompt({ language, workspaceName, servicesText: serviceLines }) },
      ],
      // Sedikit lebih rendah dari panggilan keluar — keandalan > kreativitas.
      temperature: 0.4,
      tools: [
        checkAvailabilityTool(language),
        createBookingTool(language),
      ] as Vapi.OpenAiModelToolsItem[],
    },
    voice: {
      provider: '11labs',
      voiceId: env.VAPI_VOICE_ID as Vapi.ElevenLabsVoiceId,
      language,
    },
    firstMessage:
      language === 'id'
        ? `Terima kasih sudah menghubungi ${workspaceName}. Saya resepsionis AI — ada yang bisa saya bantu?`
        : `Thank you for calling ${workspaceName}. I'm the AI receptionist — how can I help you today?`,
    endCallPhrases: ['goodbye', 'bye'],
    server,
    // tool-calls WAJIB ada — tanpa ini Vapi tidak mengirim panggilan tool.
    serverMessages: ['end-of-call-report', 'status-update', 'tool-calls'],
    // Panggilan masuk bisa lebih panjang dari keluar (percakapan booking).
    maxDurationSeconds: 900,
  };
}

/** Load workspace + layanan → asisten inbound siap dikembalikan webhook. */
export async function buildInboundAssistantForWorkspace(
  workspaceId: string,
): Promise<Vapi.CreateAssistantDto | null> {
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)))
    .limit(1);
  if (!workspace) return null;

  const services = await activeServicesById(workspace.id);
  const knowledge = workspace.aiKnowledge as { services?: string } | null;
  return buildInboundAssistant({
    workspaceName: workspace.name,
    language: workspaceLanguage(workspace),
    services,
    servicesText: knowledge?.services ?? null,
  });
}

/* ────────────────────────────────────────────────────────────
 * Tool calls — check_availability & create_booking
 * ──────────────────────────────────────────────────────────── */

/** Hasil satu tool call — dikonversi ke result/error string oleh webhook. */
export type InboundToolOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

export async function handleInboundToolCall(
  workspaceId: string,
  ctx: { callId: string; toolCallId: string },
  call: { name: string; arguments: string },
): Promise<InboundToolOutcome> {
  let args: Record<string, unknown>;
  try {
    args = call.arguments ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
  } catch {
    return { ok: false, error: 'Tool arguments bukan JSON valid.' };
  }


  switch (call.name) {
    // Tool handler mengembalikan InboundToolOutcome langsung (ok/result atau
    // error) — tanpa bungkus ulang agar tidak dobel-nesting.
    case 'check_availability':
      return checkAvailabilityForInbound(workspaceId, args);
    case 'create_booking':
      return createBookingFromInbound(workspaceId, ctx, args);
    default:
      return { ok: false, error: `Tool tidak dikenal: ${call.name}` };
  }
}

/**
 * Cocokkan layanan dari nama (case-insensitive); tunggal → pakai itu.
 * Di-export agar dipakai ulang tool booking chat (ai-tools.ts) — perilaku
 * identik dengan panggilan inbound.
 */
export async function matchService(
  workspaceId: string,
  serviceName: string | undefined,
): Promise<{ service: ServiceSnapshot; services: ServiceSnapshot[] } | { error: string }> {
  const services = await activeServicesById(workspaceId);
  if (services.length === 0) {
    return { error: 'Belum ada layanan yang dikonfigurasi di katalog.' };
  }
  const name = serviceName?.trim().toLowerCase();
  if (name) {
    const hit = services.find((s) => s.name.toLowerCase() === name);
    if (hit) return { service: hit, services };
    // Satu-satunya layanan → toleransi typo kecil (agen menyebut mirip).
    if (services.length === 1) return { service: services[0], services };
    return {
      error: `Layanan "${serviceName}" tidak ditemukan. Layanan tersedia: ${services.map((s) => s.name).join(', ')}.`,
    };
  }
  if (services.length === 1) return { service: services[0], services };
  return {
    error: `Layanan belum dipilih. Layanan tersedia: ${services.map((s) => s.name).join(', ')}.`,
  };
}

function activeServicesById(workspaceId: string): Promise<ServiceSnapshot[]> {
  return loadServices(workspaceId).then((rows) => rows.filter((s) => s.isActive));
}

/**
 * Zona waktu & staf untuk booking inbound:
 * - layanan dengan TEPAT SATU staf → pakai staf itu + zona waktunya,
 * - selain itu → tanpa staf, zona 'UTC' (default booking aplikasi).
 * Konsisten dipakai check_availability & create_booking agar waktu yang
 * ditawarkan agen = waktu yang disimpan. Di-export untuk tool chat.
 */
export async function resolveInboundStaffAndTimezone(service: ServiceSnapshot): Promise<{
  staffId: string | null;
  timezone: string;
}> {
  if (service.staffIds.length === 1) {
    const loaded = await loadStaffAvailability(service.staffIds[0]);
    if (loaded) return { staffId: loaded.staff.id, timezone: loaded.staff.timezone || 'UTC' };
  }
  return { staffId: null, timezone: 'UTC' };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseYmd(value: string): { year: number; month: number; day: number } | null {
  if (!DATE_RE.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return { year, month, day };
}

/** Format jam lokal "HH:MM" dari instant (zona tertentu). */
export function formatLocalTime(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('hour')}:${get('minute')}`;
}

/** Pesan konflik slot yang ramah (mirror route bookings, bahasa konsisten). */
export function conflictMessage(check: Extract<AvailabilityAssert, { ok: false }>): string {
  switch (check.reason) {
    case 'staff-not-found':
      return 'Staf tidak ditemukan.';
    case 'outside-working-hours':
      return 'Waktu yang dipilih berada di luar jam kerja staf.';
    case 'time-off':
      return check.detail ? `Staf sedang cuti (${check.detail}).` : 'Staf sedang cuti pada tanggal tersebut.';
    case 'conflict':
      return check.detail ? `Slot sudah terisi: ${check.detail}` : 'Slot sudah terisi oleh booking lain.';
  }
}

async function checkAvailabilityForInbound(
  workspaceId: string,
  args: Record<string, unknown>,
): Promise<InboundToolOutcome> {
  const date = typeof args.date === 'string' ? args.date : '';
  const parsed = parseYmd(date);
  if (!parsed) {
    return { ok: false, error: 'Format tanggal tidak valid. Gunakan YYYY-MM-DD.' };
  }

  const matched = await matchService(workspaceId, typeof args.serviceName === 'string' ? args.serviceName : undefined);
  if ('error' in matched) return { ok: false, error: matched.error };

  const { staffId, timezone } = await resolveInboundStaffAndTimezone(matched.service);
  const dayStart = zonedDayStart(parsed.year, parsed.month, parsed.day, timezone);
  const dayEnd = zonedDayStart(parsed.year, parsed.month, parsed.day + 1, timezone);

  const result = await getAvailableSlots({
    workspaceId,
    staffId,
    from: dayStart,
    to: dayEnd,
    durationMinutes: matched.service.durationMinutes,
  });
  if (!result.ok) return { ok: false, error: 'Staf tidak ditemukan.' };

  const slots = result.slots.map((slot) => ({
    start: slot.start.toISOString(),
    time: formatLocalTime(slot.start, timezone),
  }));

  return {
    ok: true,
    result: {
      date,
      serviceName: matched.service.name,
      serviceId: matched.service.id,
      durationMinutes: matched.service.durationMinutes,
      timezone,
      slots: slots.slice(0, 20),
      message:
        slots.length === 0
          ? `Tidak ada slot tersedia pada ${date}. Tawarkan tanggal lain.`
          : `Ditemukan ${slots.length} slot tersedia. Sebutkan waktu-waktunya ke pelanggan.`,
    },
  };
}

async function createBookingFromInbound(
  workspaceId: string,
  ctx: { callId: string; toolCallId: string },
  args: Record<string, unknown>,
): Promise<InboundToolOutcome> {
  const serviceName = typeof args.serviceName === 'string' ? args.serviceName.trim() : '';
  const date = typeof args.date === 'string' ? args.date : '';
  const time = typeof args.time === 'string' ? args.time.trim() : '';
  const customerName = typeof args.customerName === 'string' ? args.customerName.trim() : '';
  const customerPhone = typeof args.customerPhone === 'string' ? args.customerPhone.trim() : '';
  const notes = typeof args.notes === 'string' ? args.notes.trim() : '';

  if (!serviceName || !customerName || !customerPhone) {
    return { ok: false, error: 'Layanan, nama, dan nomor telepon pelanggan wajib diisi.' };
  }

  const parsedDate = parseYmd(date);
  const timeMatch = TIME_RE.exec(time);
  if (!parsedDate || !timeMatch) {
    return { ok: false, error: 'Format tanggal/jam tidak valid. Gunakan tanggal YYYY-MM-DD dan jam HH:MM.' };
  }

  const matched = await matchService(workspaceId, serviceName);
  if ('error' in matched) return { ok: false, error: matched.error };

  const { staffId, timezone } = await resolveInboundStaffAndTimezone(matched.service);
  const start = zonedTimeToUtc(
    parsedDate.year,
    parsedDate.month,
    parsedDate.day,
    Number(timeMatch[1]),
    Number(timeMatch[2]),
    timezone,
  );
  if (Number.isNaN(start.getTime())) {
    return { ok: false, error: 'Tanggal/jam tidak valid.' };
  }
  // Tolak slot di masa lalu (pesan ramah — agen menawarkan tanggal lain).
  if (start.getTime() <= Date.now()) {
    return { ok: false, error: 'Slot tersebut sudah lewat. Minta pelanggan memilih tanggal lain.' };
  }

  const [workspace] = await db
    .select({ userId: workspaces.userId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!workspace) return { ok: false, error: 'Workspace tidak ditemukan.' };

  // Idempotensi DULU: retry tool-call (Vapi mengulang saat webhook timeout)
  // harus mengembalikan booking yang sudah ada — bukan "slot terisi".
  // Unique index (workspaceId, source, sourceRef) menjamin satu booking.
  const sourceRef = `${ctx.callId}:${ctx.toolCallId}`;
  const [existing] = await db
    .select({ id: bookings.id, scheduledAt: bookings.scheduledAt })
    .from(bookings)
    .where(
      and(
        eq(bookings.workspaceId, workspaceId),
        eq(bookings.source, 'vapi-inbound'),
        eq(bookings.sourceRef, sourceRef),
      ),
    )
    .limit(1);
  if (existing) {
    return {
      ok: true,
      result: {
        bookingId: existing.id,
        title: matched.service.name,
        scheduledAt: existing.scheduledAt.toISOString(),
        timezone,
        customerName,
        message: `Booking untuk ${customerName} sudah dibuat sebelumnya: ${matched.service.name} pada ${date} pukul ${time}.`,
      },
    };
  }

  const end = new Date(start.getTime() + matched.service.durationMinutes * 60_000);
  const check = await assertSlotAvailable({ workspaceId, staffId, start, end });
  if (!check.ok) {
    return { ok: false, error: conflictMessage(check) };
  }

  // Idempotensi: unique (workspaceId, source, sourceRef) — onConflictDoNothing
  // menangani race dua tool-call sama yang masuk bersamaan.
  const [row] = await db
    .insert(bookings)
    .values({
      userId: workspace.userId,
      workspaceId,
      description: notes ? notes : null,
      scheduledAt: start,
      timezone,
      status: 'pending',
      customerName,
      phone: customerPhone,
      staffId,
      durationMinutes: matched.service.durationMinutes,
      serviceId: matched.service.id,
      source: 'vapi-inbound',
      sourceRef,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) {
    // Race langka: dua tool-call sama masuk bersamaan — booking pemenang
    // (yang tersimpan) dikembalikan sebagai konfirmasi, bukan error.
    const [winner] = await db
      .select({ id: bookings.id, scheduledAt: bookings.scheduledAt })
      .from(bookings)
      .where(
        and(
          eq(bookings.workspaceId, workspaceId),
          eq(bookings.source, 'vapi-inbound'),
          eq(bookings.sourceRef, sourceRef),
        ),
      )
      .limit(1);
    if (winner) {
      return {
        ok: true,
        result: {
          bookingId: winner.id,
          title: matched.service.name,
          scheduledAt: winner.scheduledAt.toISOString(),
          timezone,
          customerName,
          message: `Booking untuk ${customerName} sudah dibuat sebelumnya: ${matched.service.name} pada ${date} pukul ${time}.`,
        },
      };
    }
    return { ok: false, error: 'Gagal membuat booking. Coba lagi.' };
  }

  // Pipeline pasca-buat identik dengan route POST /bookings & form-booking.
  await syncBookingContact({
    userId: workspace.userId,
    workspaceId,
    bookingId: row.id,
    customerName: row.customerName,
    phone: row.phone,
  });
  await emitBookingCreated({ workspaceId, bookingId: row.id, scheduledAt: start, timezone });
  if (row.phone) {
    await emitAutoCallScheduled({ workspaceId, bookingId: row.id, scheduledAt: start, timezone });
  }
  await emitCalendarBookingEvent(workspaceId, row.id, 'upsert');
  await emitOutgoingWebhookEvent(workspaceId, 'booking.created', {
    id: row.id,
    workspaceId,
    title: matched.service.name,
    status: row.status,
    scheduledAt: row.scheduledAt.toISOString(),
    timezone: row.timezone,
    customerName: row.customerName,
    phone: row.phone,
    source: row.source,
    sourceRef: row.sourceRef,
  });
  await emitSlackBookingEvent(workspaceId, 'booking.created', {
    id: row.id,
    workspaceId,
    title: matched.service.name,
    status: row.status,
  });
  // Telegram alerts — kartu lengkap (customer/waktu/telepon) untuk bisnis.
  await emitTelegramBookingAlert(workspaceId, 'booking.created', {
    id: row.id,
    workspaceId,
    title: matched.service.name,
    status: row.status,
    scheduledAt: row.scheduledAt.toISOString(),
    timezone: row.timezone,
    customerName: row.customerName,
    phone: row.phone,
  });

  return {
    ok: true,
    result: {
      bookingId: row.id,
      title: matched.service.name,
      scheduledAt: start.toISOString(),
      timezone,
      customerName,
      message: `Booking berhasil dibuat untuk ${customerName}: ${matched.service.name} pada ${date} pukul ${time}.`,
    },
  };
}
