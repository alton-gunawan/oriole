import type { CallTone, GoalType, Industry, VoicemailBehavior } from '@oriole/call-goals';

import type { TranslationKey } from './index';

/**
 * Peta nilai enum data (dari package/@oriole/call-goals dan API) → kunci i18n.
 * Nilai-nilai ini disimpan sebagai slug di database; label user-facing
 * diambil lewat t() agar mengikuti bahasa aktif.
 */

const INDUSTRY_KEYS: Record<Industry, TranslationKey> = {
  dental: 'industry.dental',
  medspa: 'industry.medspa',
  hair_salon: 'industry.hairSalon',
  medical_clinic: 'industry.medicalClinic',
  restaurant: 'industry.restaurant',
  wellness: 'industry.wellness',
  fitness: 'industry.fitness',
  professional_services: 'industry.professionalServices',
  home_services: 'industry.homeServices',
  automotive: 'industry.automotive',
  education_coaching: 'industry.educationCoaching',
  photography_creative: 'industry.photographyCreative',
  real_estate: 'industry.realEstate',
  pet_care: 'industry.petCare',
  space_rental: 'industry.spaceRental',
  other: 'industry.other',
};

export function industryKey(industry?: string | null): TranslationKey {
  return industry && industry in INDUSTRY_KEYS
    ? INDUSTRY_KEYS[industry as Industry]
    : INDUSTRY_KEYS.other;
}

const GOAL_TYPE_KEYS: Record<GoalType, TranslationKey> = {
  'confirm-attendance': 'goalType.confirmAttendance',
  'reminder-reconfirm': 'goalType.reminderReconfirm',
  'confirm-with-accountability': 'goalType.confirmWithAccountability',
  'reschedule-assistance': 'goalType.rescheduleAssistance',
  'final-follow-up': 'goalType.finalFollowUp',
};

/** Goal type dikenal → kunci i18n; selain itu null (caller fallback ke common.noCall). */
export function goalTypeKey(goalType: GoalType): TranslationKey;
export function goalTypeKey(goalType: string | null | undefined): TranslationKey | null;
export function goalTypeKey(goalType: string | null | undefined): TranslationKey | null {
  if (!goalType || !(goalType in GOAL_TYPE_KEYS)) return null;
  return GOAL_TYPE_KEYS[goalType as GoalType];
}

const BOOKING_STATUS_KEYS: Record<string, TranslationKey> = {
  pending: 'status.pending',
  confirmed: 'status.confirmed',
  completed: 'status.completed',
  cancelled: 'status.cancelled',
  draft: 'common.draft',
};

/** Status booking → kunci i18n; slug asing dikembalikan null agar ditampilkan mentah. */
export function bookingStatusKey(status: string | null | undefined): TranslationKey | null {
  if (!status) return 'common.draft';
  return BOOKING_STATUS_KEYS[status] ?? null;
}

const CALL_STATUS_KEYS: Record<string, TranslationKey> = {
  completed: 'callStatus.completed',
  success: 'callStatus.success',
  failed: 'callStatus.failed',
  error: 'callStatus.error',
  in_progress: 'callStatus.inProgress',
  'in-progress': 'callStatus.inProgress',
  pending: 'callStatus.pending',
  queued: 'callStatus.queued',
  canceled: 'callStatus.canceled',
  cancelled: 'callStatus.cancelled',
};

/** Status panggilan CALL-E → kunci i18n; slug asing dikembalikan null. */
export function callStatusKey(status: string | null | undefined): TranslationKey | null {
  if (!status) return 'callStatus.draft';
  return CALL_STATUS_KEYS[status] ?? null;
}

const TONE_KEYS: Record<CallTone, TranslationKey> = {
  friendly: 'goal.tone.friendly',
  warm: 'goal.tone.warm',
  professional: 'goal.tone.professional',
};

export function toneKey(tone: CallTone): TranslationKey {
  return TONE_KEYS[tone];
}

const VOICEMAIL_KEYS: Record<VoicemailBehavior, TranslationKey> = {
  brief: 'goal.voicemail.brief',
  'call-back': 'goal.voicemail.callBack',
  'leave-details': 'goal.voicemail.leaveDetails',
};

export function voicemailKey(behavior: VoicemailBehavior): TranslationKey {
  return VOICEMAIL_KEYS[behavior];
}
