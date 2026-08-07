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
 * Setiap industri memiliki ALUR PANGGILAN sendiri (`confirmFlow` untuk
 * konfirmasi/reminder, `rescheduleFlow` untuk jadwal ulang/follow-up) plus
 * field hasil khusus industri (`resultExtras`) — bukan sekadar ganti kata
 * benda. Restaurant menanyakan jumlah tamu, automotive menanyakan model
 * kendaraan, pet care menanyakan vaksinasi, dst.
 *
 * Cara memperluas:
 * - Menambah industri → tambah nilai di `INDUSTRIES` (types.ts), label di
 *   `labels.ts`, dan satu entry di `INDUSTRY_PROFILES`.
 * - Menyesuaikan satu goal type lintas industri → ubah `GOAL_META` /
 *   `GOAL_RESULT_SCHEMAS` / builder terkait.
 */

interface ResultExtra {
  type: 'string' | 'integer' | 'boolean';
  enum?: string[];
  description: string;
}

interface IndustryProfile {
  appointmentNoun: string;
  serviceNote: string;
  businessNoun: string;
  /**
   * Langkah spesifik industri pada panggilan konfirmasi / reminder /
   * accountability. Ditulis sebagai kalimat lengkap ber-awalan verb —
   * disisipkan sebagai bullet objectives prompt CALL-E.
   */
  confirmFlow: string[];
  /** Langkah spesifik industri pada panggilan reschedule / final follow-up. */
  rescheduleFlow: string[];
  /** Field hasil tambahan spesifik industri (opsional, tidak wajib diisi AI). */
  resultExtras?: Record<string, ResultExtra>;
}

export const INDUSTRY_PROFILES: Record<Industry, IndustryProfile> = {
  dental: {
    appointmentNoun: 'dental appointment',
    serviceNote: 'dental treatment',
    businessNoun: 'dental practice',
    confirmFlow: [
      'Confirm which treatment is scheduled and ask if there is any pain or urgent concern.',
      'Remind the customer to bring their insurance card and a government-issued ID.',
      'Ask them to list any current medications they take.',
      'Tell them to arrive 15 minutes early to complete paperwork.',
    ],
    rescheduleFlow: [
      'Offer available slots with the same dentist whenever possible.',
      'If the customer mentions pain or urgency, note it and offer the earliest possible slot.',
      'Confirm the new date and time clearly before ending the call.',
    ],
    resultExtras: {
      treatmentType: { type: 'string', description: 'The treatment that was confirmed.' },
      insuranceConfirmed: { type: 'boolean', description: 'Whether the customer confirmed they will bring insurance documents.' },
    },
  },
  medspa: {
    appointmentNoun: 'aesthetic treatment',
    serviceNote: 'treatment session',
    businessNoun: 'medspa',
    confirmFlow: [
      'Confirm which aesthetic treatment is booked and ask about any allergies or skin concerns.',
      'Remind the customer of pre-treatment preparation, such as avoiding sun exposure and exfoliation beforehand.',
      'Ask them to arrive 10 minutes early so the session starts on time.',
      'Offer to book any add-on service they mention wanting.',
    ],
    rescheduleFlow: [
      'Offer a new slot with the same practitioner when possible.',
      'Re-confirm pre-treatment preparation for the new date.',
      'Confirm the new date and time clearly before ending the call.',
    ],
    resultExtras: {
      treatment: { type: 'string', description: 'The aesthetic treatment that was confirmed.' },
      prepped: { type: 'boolean', description: 'Whether the customer understood the pre-treatment preparation.' },
    },
  },
  hair_salon: {
    appointmentNoun: 'hair appointment',
    serviceNote: 'styling appointment',
    businessNoun: 'salon',
    confirmFlow: [
      'Confirm which stylist the appointment is with and ask if they want the same one.',
      'Ask what service they are planning, such as a cut, color, or treatment.',
      'Suggest bringing a photo reference of the look they want.',
      'Remind them to arrive on time so the stylist can keep the schedule.',
    ],
    rescheduleFlow: [
      'Offer a new slot with the same stylist whenever possible.',
      'Note the salon late-arrival policy when confirming the new time.',
      'Confirm the new date and time clearly before ending the call.',
    ],
    resultExtras: {
      stylist: { type: 'string', description: 'The stylist confirmed for the appointment.' },
      service: { type: 'string', description: 'The hair service the customer wants.' },
    },
  },
  medical_clinic: {
    appointmentNoun: 'medical appointment',
    serviceNote: 'clinic visit',
    businessNoun: 'clinic',
    confirmFlow: [
      'Confirm the purpose of the visit and ask whether symptoms have changed since booking.',
      'Remind the customer to bring their insurance card, ID, and a list of current medications.',
      'Ask them to arrive 15 minutes early to complete registration.',
      'If the customer is unwell, offer to reschedule to protect staff and other patients.',
    ],
    rescheduleFlow: [
      'Offer a slot with the same doctor when possible.',
      'Ask if the issue is urgent so the right appointment is booked.',
      'Confirm the new date and time clearly before ending the call.',
    ],
    resultExtras: {
      appointmentType: { type: 'string', description: 'The type of visit confirmed (e.g. checkup, follow-up).' },
      symptomsChanged: { type: 'boolean', description: 'Whether the customer reported changed symptoms.' },
    },
  },
  restaurant: {
    appointmentNoun: 'reservation',
    serviceNote: 'dining reservation',
    businessNoun: 'restaurant',
    confirmFlow: [
      'Confirm the number of guests and update the reservation if the party size changed.',
      'Ask about special occasions such as birthdays or anniversaries.',
      'Note any allergies or dietary requirements and pass them along.',
      'Confirm if a high chair, accessibility seating, or any special setup is needed.',
      'If there is a wait time for the party size, mention it so the customer can plan.',
    ],
    rescheduleFlow: [
      'Offer a new date and time that fits the updated party size.',
      'Mention the reservation policy, such as deposits or late-cancellation notice, if applicable.',
      'Confirm the new reservation details clearly before ending the call.',
    ],
    resultExtras: {
      partySize: { type: 'integer', description: 'The number of guests confirmed for the reservation.' },
      specialOccasion: { type: 'string', description: 'Any special occasion the customer mentioned.' },
      allergies: { type: 'string', description: 'Any allergies or dietary requirements noted.' },
    },
  },
  wellness: {
    appointmentNoun: 'wellness session',
    serviceNote: 'wellness or therapy session',
    businessNoun: 'wellness studio',
    confirmFlow: [
      'Confirm which service and practitioner the session is booked with.',
      'Ask about any new injuries, conditions, or sensitivities the practitioner should know.',
      'Remind the customer to arrive 10 minutes early to settle in.',
      'Offer to add any extra service they express interest in.',
    ],
    rescheduleFlow: [
      'Offer a new slot with the same practitioner when possible.',
      'Re-confirm the service so the right session is booked.',
      'Confirm the new date and time clearly before ending the call.',
    ],
    resultExtras: {
      practitioner: { type: 'string', description: 'The practitioner confirmed for the session.' },
      service: { type: 'string', description: 'The wellness service confirmed.' },
    },
  },
  fitness: {
    appointmentNoun: 'class or training session',
    serviceNote: 'training session',
    businessNoun: 'fitness studio',
    confirmFlow: [
      'Confirm whether the booking is for a group class or personal training.',
      'Check that the customer has a valid class pass or membership for this session.',
      'Ask about any injuries or limitations so the trainer can adapt.',
      'Remind them to bring a towel and water and arrive 10 minutes early.',
    ],
    rescheduleFlow: [
      'Offer another class time or training slot that fits their schedule.',
      'Check that their pass or membership covers the new session.',
      'Note the no-show policy when confirming the new time.',
    ],
    resultExtras: {
      sessionType: { type: 'string', enum: ['group-class', 'personal-training'], description: 'The type of fitness session confirmed.' },
      passValid: { type: 'boolean', description: 'Whether the customer has a valid pass or membership.' },
    },
  },
  professional_services: {
    appointmentNoun: 'consultation',
    serviceNote: 'consultation meeting',
    businessNoun: 'firm',
    confirmFlow: [
      'Confirm the topic or purpose of the consultation so the right person is available.',
      'Remind the customer to bring any relevant documents or records.',
      'Offer to send a short prep agenda for the meeting.',
      'Confirm whether the meeting is in person or on a call and share the joining details.',
    ],
    rescheduleFlow: [
      'Offer a new time that works with the same advisor when possible.',
      'Re-confirm which documents the customer should prepare for the new date.',
      'Confirm the new date and time clearly before ending the call.',
    ],
    resultExtras: {
      purpose: { type: 'string', description: 'The purpose or topic of the consultation.' },
      documentsConfirmed: { type: 'boolean', description: 'Whether the customer confirmed they will bring the documents.' },
    },
  },
  home_services: {
    appointmentNoun: 'service visit',
    serviceNote: 'home service appointment',
    businessNoun: 'service provider',
    confirmFlow: [
      'Confirm the exact address and any access details such as a gate code or parking instructions.',
      'Ask whether pets are on the premises and how the technician should handle them.',
      'Confirm the scope of the job so the right tools and parts are brought.',
      'Give the customer the estimated arrival window for the visit.',
    ],
    rescheduleFlow: [
      'Offer a new slot that fits the customer and the crew.',
      'Re-confirm access details and pet information for the new date.',
      'Note the cancellation policy when confirming the new time.',
    ],
    resultExtras: {
      accessCode: { type: 'string', description: 'Gate code or access instructions for the visit.' },
      petsOnPremises: { type: 'boolean', description: 'Whether pets are on the premises.' },
    },
  },
  automotive: {
    appointmentNoun: 'service booking',
    serviceNote: 'vehicle service appointment',
    businessNoun: 'workshop',
    confirmFlow: [
      'Confirm the vehicle make, model, and year so the right parts are prepared.',
      'Ask about the issue or the service the customer needs, and describe what will be done.',
      'Remind the customer to bring the vehicle keys and registration.',
      'Give the estimated duration of the service so they can plan their day.',
    ],
    rescheduleFlow: [
      'Offer a new slot and re-confirm the vehicle details.',
      'Check whether a loaner or courtesy car is available if needed.',
      'Confirm the new date and time clearly before ending the call.',
    ],
    resultExtras: {
      vehicleModel: { type: 'string', description: 'The vehicle make and model confirmed.' },
      serviceType: { type: 'string', description: 'The service or issue the customer described.' },
      keysProvided: { type: 'boolean', description: 'Whether the customer confirmed they will bring the keys.' },
    },
  },
  education_coaching: {
    appointmentNoun: 'lesson',
    serviceNote: 'tutoring session',
    businessNoun: 'coach',
    confirmFlow: [
      'Confirm which subject or topic the lesson will cover and what to prepare.',
      'Remind the student to bring any books, homework, or materials for the session.',
      'Confirm whether the lesson is online or in person and share the link or venue.',
      'Confirm the lesson duration so both sides plan the time.',
    ],
    rescheduleFlow: [
      'Offer a new slot with the same coach or teacher when possible.',
      'Note the make-up lesson policy when confirming the new time.',
      'Confirm the new date and time clearly before ending the call.',
    ],
    resultExtras: {
      topic: { type: 'string', description: 'The topic or subject for the lesson.' },
      format: { type: 'string', enum: ['online', 'in-person'], description: 'Lesson format confirmed.' },
    },
  },
  photography_creative: {
    appointmentNoun: 'photo shoot',
    serviceNote: 'photo session',
    businessNoun: 'studio',
    confirmFlow: [
      'Confirm the shoot location and the exact start time.',
      'Discuss wardrobe and any props or items the customer should bring.',
      'If the shoot is outdoors, check a weather backup plan with the customer.',
      'Confirm how long the session is expected to last.',
    ],
    rescheduleFlow: [
      'Offer a new date and check venue availability.',
      'Note the deposit or rescheduling policy when confirming.',
      'Confirm the new date and time clearly before ending the call.',
    ],
    resultExtras: {
      location: { type: 'string', description: 'The confirmed shoot location.' },
      wardrobeConfirmed: { type: 'boolean', description: 'Whether wardrobe and props were discussed and confirmed.' },
    },
  },
  real_estate: {
    appointmentNoun: 'property viewing',
    serviceNote: 'viewing appointment',
    businessNoun: 'agency',
    confirmFlow: [
      'Confirm the property address and the viewing time.',
      'Ask about any questions the customer has about the property.',
      'Remind them to bring an ID for the viewing.',
      'Check whether they are pre-approved or financing-ready, so the agent can prepare.',
    ],
    rescheduleFlow: [
      'Offer a new viewing time with the same agent when possible.',
      'Note that the listing may change, so the new slot should be confirmed quickly.',
      'Confirm the new date and time clearly before ending the call.',
    ],
    resultExtras: {
      propertyAddress: { type: 'string', description: 'The property address confirmed for the viewing.' },
      preApproved: { type: 'boolean', description: 'Whether the customer is financing-ready or pre-approved.' },
    },
  },
  pet_care: {
    appointmentNoun: 'pet appointment',
    serviceNote: 'pet care visit',
    businessNoun: 'pet care',
    confirmFlow: [
      'Confirm the pet name and breed for the visit.',
      'Ask whether the pet has up-to-date vaccination records and to bring them.',
      'Confirm any medications, special needs, or behavior notes the staff should know.',
      'Confirm the drop-off and pick-up window for the appointment.',
    ],
    rescheduleFlow: [
      'Offer a new slot and re-confirm the pet details.',
      'Note the late pick-up policy when confirming the new time.',
      'Confirm the new date and time clearly before ending the call.',
    ],
    resultExtras: {
      petName: { type: 'string', description: 'The pet name confirmed.' },
      vaccinationRecords: { type: 'boolean', description: 'Whether the customer confirmed vaccination records are available.' },
    },
  },
  space_rental: {
    appointmentNoun: 'space booking',
    serviceNote: 'space rental booking',
    businessNoun: 'venue',
    confirmFlow: [
      'Confirm the number of attendees expected for the booking.',
      'Confirm setup needs such as chairs, tables, AV equipment, or catering.',
      'Confirm the arrival time and how long the space will be used.',
      'Confirm whether a deposit or final confirmation is needed to hold the slot.',
    ],
    rescheduleFlow: [
      'Offer a new date and confirm the equipment and setup will still be available.',
      'Note the rescheduling policy when confirming.',
      'Confirm the new date and time clearly before ending the call.',
    ],
    resultExtras: {
      attendeeCount: { type: 'integer', description: 'The number of attendees confirmed.' },
      setupNeeds: { type: 'string', description: 'Setup or equipment needs the customer confirmed.' },
    },
  },
  other: {
    appointmentNoun: 'appointment',
    serviceNote: 'appointment',
    businessNoun: 'business',
    confirmFlow: [
      'Confirm the customer will attend at the scheduled time.',
      'Ask if they have any questions about the appointment.',
      'Answer questions about location or preparation in one or two short sentences.',
    ],
    rescheduleFlow: [
      'Ask for their preferred new date and time and capture it precisely.',
      'Read the new slot back and get an explicit confirmation.',
    ],
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

/**
 * Clone dalam untuk objek JSON-safe (skema goal adalah plain JSON).
 * Dipakai pengganti `structuredClone` agar paket tetap bebas lib DOM.
 */
function deepClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item)) as T;
  }
  if (value !== null && typeof value === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      copy[key] = deepClone(item);
    }
    return copy as T;
  }
  return value;
}

/** Gabungkan field hasil khusus industri ke skema dasar goal type. */
function buildResultSchema(
  goalType: GoalType,
  profile: IndustryProfile,
): Record<string, unknown> {
  const extras = profile.resultExtras;
  if (!extras) return GOAL_RESULT_SCHEMAS[goalType];

  const schema = deepClone(GOAL_RESULT_SCHEMAS[goalType]);
  const properties = schema.properties as Record<string, unknown>;
  for (const [key, extra] of Object.entries(extras)) {
    const field: Record<string, unknown> = { type: extra.type, description: extra.description };
    if (extra.enum) field.enum = extra.enum;
    properties[key] = field;
  }
  // Field industri sengaja TIDAK wajib — AI boleh mengosongkan bila tidak
  // terjawab (mis. party size saat customer tidak diangkat).
  return schema;
}

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
      '',
      `Objectives:`,
      `- Introduce yourself and the business warmly.`,
      `- Confirm the customer will attend the ${profile.appointmentNoun} at the scheduled time.`,
      ...profile.confirmFlow.map((step) => `- ${step}`),
      `- If they cannot attend, offer to reschedule to another available slot and capture the new date and time.`,
      `- Answer simple questions about location or preparation in one or two short sentences.`,
      `- End the call politely with a clear statement of the confirmed next step.`,
      '',
      `After the call, fill in the structured result fields described in resultSchema.`,
    ].join('\n'),
  'reminder-reconfirm': (ctx, business, profile) =>
    [
      `${describeAppointment(ctx, business, profile)}`,
      '',
      `Objectives:`,
      `- Greet warmly, state the business name, and remind the customer about their upcoming ${profile.appointmentNoun}.`,
      `- Ask the customer to confirm they will still attend.`,
      ...profile.confirmFlow.map((step) => `- ${step}`),
      `- If they mention needing to reschedule or cancel, offer to reschedule and capture the new slot.`,
      `- If the call goes to voicemail, leave a short message asking them to call back to confirm.`,
      `- Keep the tone friendly and the call under 60 seconds when possible.`,
      '',
      `After the call, fill in the structured result fields described in resultSchema.`,
    ].join('\n'),
  'confirm-with-accountability': (ctx, business, profile) =>
    [
      `${describeAppointment(ctx, business, profile)}`,
      '',
      `Context: this customer has missed appointments before, so be friendly but gently reinforce commitment without sounding accusatory.`,
      '',
      `Objectives:`,
      `- Confirm they plan to attend the ${profile.appointmentNoun}.`,
      ...profile.confirmFlow.map((step) => `- ${step}`),
      `- Politely mention that if plans change, letting the ${profile.businessNoun} know ahead of time helps the slot go to another customer.`,
      `- Ask for a clear confirmation and capture it.`,
      `- If they cannot attend, offer to reschedule and capture the new slot.`,
      `- Maintain a warm yet professional tone throughout.`,
      '',
      `After the call, fill in the structured result fields described in resultSchema.`,
    ].join('\n'),
  'reschedule-assistance': (ctx, business, profile) =>
    [
      `${describeAppointment(ctx, business, profile)}`,
      '',
      `Objectives:`,
      `- Greet the customer and acknowledge that they asked to change their ${profile.appointmentNoun}.`,
      `- Confirm the current scheduled time so they know exactly what is being changed.`,
      `- Ask for their preferred new date and time and capture it precisely.`,
      ...profile.rescheduleFlow.map((step) => `- ${step}`),
      `- Read the new slot back to the customer and get an explicit confirmation before ending the call.`,
      `- If the customer decides to keep the original slot, confirm that instead.`,
      '',
      `After the call, fill in the structured result fields described in resultSchema.`,
    ].join('\n'),
  'final-follow-up': (ctx, business, profile) =>
    [
      `${describeAppointment(ctx, business, profile)}`,
      '',
      `Objectives:`,
      `- State clearly that this is the final follow-up from the ${profile.businessNoun}.`,
      `- Ask whether the customer still wants the ${profile.appointmentNoun} or prefers to reschedule.`,
      ...profile.rescheduleFlow.map((step) => `- ${step}`),
      `- If they confirm, capture the confirmation. If they want to reschedule, capture the new slot.`,
      `- If there is no answer, leave a voicemail with the ${profile.businessNoun} name and a callback number, and record the missed call for staff follow-up.`,
      `- Keep the message concise and unambiguous.`,
      '',
      `After the call, fill in the structured result fields described in resultSchema.`,
    ].join('\n'),
};

/**
 * Ambil template untuk kombinasi industri × goal type. Industri kosong/tidak
 * dikenal di-koersi ke `other`.
 */
export function getGoalTemplate(
  industry: Industry | null | undefined,
  goalType: GoalType,
): CallGoalTemplate {
  const key = industry && industry in INDUSTRY_PROFILES ? industry : 'other';
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
    resultSchema: buildResultSchema(goalType, profile),
    buildPrompt: (context, business) => buildPrompt(context, business, profile),
  };
}
