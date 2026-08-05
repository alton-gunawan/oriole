import { formatAppointment } from './format.ts';
import type {
  BookingGoalContext,
  BusinessGoalContext,
  CallGoalTemplate,
  CallTone,
  CallLanguage,
  GoalType,
  Industry,
  VoicemailBehavior,
} from './types.ts';

/**
 * Sistem template goal — kombinasi Industry × GoalType menghasilkan
 * `CallGoalTemplate` lengkap (prompt, resultSchema, tone, language, voicemail).
 *
 * Cara memperluas:
 * - Menambah industri  → tambah satu entry di `INDUSTRY_PROFILES`.
 * - Menyesuaikan satu goal type lintas industri → ubah `GOAL_META` /
 *   `GOAL_RESULT_SCHEMAS` / builder terkait.
 * - Override per (industri, goalType) tertentu → isi `INDUSTRY_OVERRIDES`.
 */

interface IndustryProfile {
  appointmentNoun: string;
  serviceNote: string;
  businessNoun: string;
}

export const INDUSTRY_PROFILES: Record<Industry, IndustryProfile> = {
  dental: {
    appointmentNoun: 'dental appointment',
    serviceNote: 'appointment with the dentist',
    businessNoun: 'dental practice',
  },
  medspa: {
    appointmentNoun: 'aesthetic treatment',
    serviceNote: 'treatment session',
    businessNoun: 'medspa',
  },
  hair_salon: {
    appointmentNoun: 'hair appointment',
    serviceNote: 'styling appointment',
    businessNoun: 'salon',
  },
  medical_clinic: {
    appointmentNoun: 'medical appointment',
    serviceNote: 'clinic visit',
    businessNoun: 'clinic',
  },
  restaurant: {
    appointmentNoun: 'reservation',
    serviceNote: 'dining reservation',
    businessNoun: 'restaurant',
  },
  wellness: {
    appointmentNoun: 'wellness session',
    serviceNote: 'wellness or therapy session',
    businessNoun: 'wellness studio',
  },
  other: {
    appointmentNoun: 'appointment',
    serviceNote: 'appointment',
    businessNoun: 'business',
  },
};

interface GoalMeta {
  title: string;
  summary: string;
  tone: CallTone;
  language: CallLanguage;
  voicemailBehavior: VoicemailBehavior;
}

const GOAL_META: Record<GoalType, GoalMeta> = {
  'confirm-attendance': {
    title: 'Confirm Attendance',
    summary: 'AI will automatically confirm this booking',
    tone: 'warm',
    language: 'en',
    voicemailBehavior: 'brief',
  },
  'reminder-reconfirm': {
    title: 'Reminder + Re-confirm',
    summary: 'AI will remind and re-confirm this booking',
    tone: 'friendly',
    language: 'en',
    voicemailBehavior: 'call-back',
  },
  'confirm-with-accountability': {
    title: 'Confirm with Soft Accountability',
    summary: 'AI will confirm with gentle accountability',
    tone: 'professional',
    language: 'en',
    voicemailBehavior: 'call-back',
  },
  'reschedule-assistance': {
    title: 'Reschedule Assistance',
    summary: 'AI will help reschedule this booking',
    tone: 'friendly',
    language: 'en',
    voicemailBehavior: 'call-back',
  },
  'final-follow-up': {
    title: 'Final Follow-up',
    summary: 'AI will make a final follow-up call',
    tone: 'professional',
    language: 'en',
    voicemailBehavior: 'leave-details',
  },
};

const GOAL_RESULT_SCHEMAS: Record<GoalType, Record<string, unknown>> = {
  'confirm-attendance': {
    type: 'object',
    description: 'Outcome of the attendance confirmation call.',
    properties: {
      confirmed: { type: 'boolean', description: 'Whether the customer confirmed attendance.' },
      cancelled: { type: 'boolean', description: 'Whether the customer cancelled the appointment.' },
      rescheduled: { type: 'boolean', description: 'Whether the appointment was rescheduled.' },
      newScheduledAt: { type: 'string', description: 'ISO 8601 new appointment time if rescheduled.' },
      notes: { type: 'string', description: 'Relevant notes from the conversation.' },
    },
    required: ['confirmed', 'cancelled'],
  },
  'reminder-reconfirm': {
    type: 'object',
    description: 'Outcome of the reminder and re-confirmation call.',
    properties: {
      reached: { type: 'boolean', description: 'Whether the customer was reached.' },
      answered: { type: 'boolean', description: 'Whether the customer answered the phone.' },
      confirmed: { type: 'boolean', description: 'Whether attendance was confirmed.' },
      cancelled: { type: 'boolean', description: 'Whether the appointment was cancelled.' },
      rescheduled: { type: 'boolean', description: 'Whether the appointment was rescheduled.' },
      newScheduledAt: { type: 'string', description: 'ISO 8601 new appointment time if rescheduled.' },
      voicemailLeft: { type: 'boolean', description: 'Whether a voicemail was left.' },
      notes: { type: 'string', description: 'Relevant notes from the conversation.' },
    },
    required: ['reached', 'confirmed'],
  },
  'confirm-with-accountability': {
    type: 'object',
    description: 'Outcome of the confirmation call with soft accountability.',
    properties: {
      confirmed: { type: 'boolean', description: 'Whether the customer confirmed attendance.' },
      commitmentLevel: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description: 'Estimated commitment level to attend.',
      },
      rescheduled: { type: 'boolean', description: 'Whether the appointment was rescheduled.' },
      newScheduledAt: { type: 'string', description: 'ISO 8601 new appointment time if rescheduled.' },
      notes: { type: 'string', description: 'Relevant notes from the conversation.' },
    },
    required: ['confirmed', 'commitmentLevel'],
  },
  'reschedule-assistance': {
    type: 'object',
    description: 'Outcome of the reschedule assistance call.',
    properties: {
      keptOriginal: { type: 'boolean', description: 'Whether the customer kept the original slot.' },
      newScheduledAt: { type: 'string', description: 'ISO 8601 new appointment time.' },
      confirmedNewSlot: { type: 'boolean', description: 'Whether the new slot was confirmed.' },
      notes: { type: 'string', description: 'Relevant notes from the conversation.' },
    },
    required: ['confirmedNewSlot'],
  },
  'final-follow-up': {
    type: 'object',
    description: 'Outcome of the final follow-up call.',
    properties: {
      reached: { type: 'boolean', description: 'Whether anyone was reached.' },
      outcome: {
        type: 'string',
        enum: ['confirmed', 'rescheduled', 'cancelled', 'no-answer', 'voicemail'],
        description: 'Final outcome of the follow-up.',
      },
      newScheduledAt: { type: 'string', description: 'ISO 8601 new appointment time if rescheduled.' },
      notes: { type: 'string', description: 'Relevant notes from the conversation.' },
    },
    required: ['reached', 'outcome'],
  },
};

type GoalBuilder = (
  context: BookingGoalContext,
  business: BusinessGoalContext,
  profile: IndustryProfile,
) => string;

/** Header umum dipakai semua builder. */
function describeAppointment(
  context: BookingGoalContext,
  business: BusinessGoalContext,
  profile: IndustryProfile,
): string {
  const customer = context.customerName?.trim() || 'the customer';
  const businessName = business.name?.trim() || profile.businessNoun;
  const when = formatAppointment(context.scheduledAt, context.timezone);
  return `Call ${customer} on behalf of ${businessName} about their ${profile.appointmentNoun} scheduled for ${when}.`;
}

const GOAL_BUILDERS: Record<GoalType, GoalBuilder> = {
  'confirm-attendance': (ctx, business, profile) =>
    [
      `${describeAppointment(ctx, business, profile)}`,
      ``,
      `Objectives:`,
      `- Introduce yourself and the business warmly.`,
      `- Confirm the customer will attend the ${profile.appointmentNoun} at the scheduled time.`,
      `- If they cannot attend, offer to reschedule to another available slot and capture the new date and time.`,
      `- Answer simple questions about location or preparation for the ${profile.serviceNote} in one or two short sentences.`,
      `- End the call politely with a clear statement of the confirmed next step.`,
      ``,
      `After the call, fill in the structured result fields described in resultSchema.`,
    ].join('\n'),
  'reminder-reconfirm': (ctx, business, profile) =>
    [
      `${describeAppointment(ctx, business, profile)}`,
      ``,
      `Objectives:`,
      `- Greet warmly, state the business name, and remind the customer about their upcoming ${profile.appointmentNoun}.`,
      `- Ask the customer to confirm they will still attend.`,
      `- If they mention needing to reschedule or cancel, offer to reschedule and capture the new slot.`,
      `- If the call goes to voicemail, leave a short message asking them to call back to confirm.`,
      `- Keep the tone friendly and the call under 60 seconds when possible.`,
      ``,
      `After the call, fill in the structured result fields described in resultSchema.`,
    ].join('\n'),
  'confirm-with-accountability': (ctx, business, profile) =>
    [
      `${describeAppointment(ctx, business, profile)}`,
      ``,
      `Context: this customer has missed appointments before, so be friendly but gently reinforce commitment without sounding accusatory.`,
      ``,
      `Objectives:`,
      `- Confirm they plan to attend the ${profile.appointmentNoun}.`,
      `- Politely mention that if plans change, letting the ${profile.businessNoun} know ahead of time helps the slot go to another customer.`,
      `- Ask for a clear confirmation and capture it.`,
      `- If they cannot attend, offer to reschedule and capture the new slot.`,
      `- Maintain a warm yet professional tone throughout.`,
      ``,
      `After the call, fill in the structured result fields described in resultSchema.`,
    ].join('\n'),
  'reschedule-assistance': (ctx, business, profile) =>
    [
      `${describeAppointment(ctx, business, profile)}`,
      ``,
      `Objectives:`,
      `- Greet the customer and acknowledge that they asked to change their ${profile.appointmentNoun}.`,
      `- Confirm the current scheduled time so they know exactly what is being changed.`,
      `- Ask for their preferred new date and time and capture it precisely.`,
      `- Read the new slot back to the customer and get an explicit confirmation before ending the call.`,
      `- If the customer decides to keep the original slot, confirm that instead.`,
      ``,
      `After the call, fill in the structured result fields described in resultSchema.`,
    ].join('\n'),
  'final-follow-up': (ctx, business, profile) =>
    [
      `${describeAppointment(ctx, business, profile)}`,
      ``,
      `Objectives:`,
      `- State clearly that this is the final follow-up from the ${profile.businessNoun}.`,
      `- Ask whether the customer still wants the ${profile.appointmentNoun} or prefers to reschedule.`,
      `- If they confirm, capture the confirmation. If they want to reschedule, capture the new slot.`,
      `- If there is no answer, leave a voicemail with the ${profile.businessNoun} name and a callback number, and record the missed call for staff follow-up.`,
      `- Keep the message concise and unambiguous.`,
      ``,
      `After the call, fill in the structured result fields described in resultSchema.`,
    ].join('\n'),
};

/** Override per (industry, goalType) untuk kasus khusus — kosong secara default. */
const INDUSTRY_OVERRIDES: Partial<Record<Industry, Partial<Record<GoalType, CallGoalTemplate>>>> =
  {};

/**
 * Ambil template untuk kombinasi industri × goal type. Industri kosong/tidak
 * dikenal di-koersi ke `other`; override per kombinasi menang jika ada.
 */
export function getGoalTemplate(
  industry: Industry | null | undefined,
  goalType: GoalType,
): CallGoalTemplate {
  const key = industry && industry in INDUSTRY_PROFILES ? industry : 'other';
  const override = INDUSTRY_OVERRIDES[key]?.[goalType];
  if (override) return override;

  const profile = INDUSTRY_PROFILES[key];
  const meta = GOAL_META[goalType];
  const buildPrompt = GOAL_BUILDERS[goalType];

  return {
    goalType,
    title: meta.title,
    summary: meta.summary,
    tone: meta.tone,
    language: meta.language,
    voicemailBehavior: meta.voicemailBehavior,
    resultSchema: GOAL_RESULT_SCHEMAS[goalType],
    buildPrompt: (context, business) => buildPrompt(context, business, profile),
  };
}
