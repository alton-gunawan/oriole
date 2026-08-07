export const INDUSTRIES = [
  'dental',
  'medspa',
  'hair_salon',
  'medical_clinic',
  'restaurant',
  'wellness',
  'fitness',
  'professional_services',
  'home_services',
  'automotive',
  'education_coaching',
  'photography_creative',
  'real_estate',
  'pet_care',
  'space_rental',
  'other',
] as const;

export type Industry = (typeof INDUSTRIES)[number];

export const GOAL_TYPES = [
  'confirm-attendance',
  'reminder-reconfirm',
  'confirm-with-accountability',
  'reschedule-assistance',
  'final-follow-up',
] as const;

export type GoalType = (typeof GOAL_TYPES)[number];

/** Nilai dropdown: goal eksplisit, atau `auto` untuk menyerahkan ke mesin keputusan. */
export type GoalTypeSelection = GoalType | 'auto';

export type BookingStatus = 'pending' | 'confirmed' | 'cancelled' | 'completed';

export type CallTone = 'friendly' | 'warm' | 'professional';

export type CallLanguage = 'en' | 'id';

export type VoicemailBehavior = 'brief' | 'call-back' | 'leave-details';

/** Konteks booking yang dikonsumsi mesin keputusan & template (server maupun client). */
export interface BookingGoalContext {
  id: string;
  title: string;
  status: BookingStatus;
  scheduledAt: string;
  timezone?: string | null;
  customerName?: string | null;
  phone?: string | null;
  changeRequested: boolean;
  noShowCount: number;
  previousCallAttempts: number;
  failedCallAttempts: number;
}

/**
 * Konteks bisnis (workspace) — memilih template berdasarkan industry dan
 * mengirim bahasa panggilan yang dikonfigurasi di pengaturan workspace.
 */
export interface BusinessGoalContext {
  id?: string | null;
  name?: string | null;
  industry?: Industry | null;
  /** Bahasa panggilan CALL-E dari workspace (default 'en'; 'id' = extension point). */
  language?: CallLanguage | null;
}

/** Opsi mesin keputusan — window reminder bisa dikonfigurasi per workspace. */
export interface GoalDecisionOptions {
  /** Jendela reminder (jam sebelum jadwal) — default 24. */
  reminderWindowHours?: number;
}

/** Hasil mesin keputusan. `goalType === null` berarti tidak perlu panggilan. */
export interface GoalDecision {
  goalType: GoalType | null;
  reason: string;
}

/** Konfigurasi goal final yang siap dikirim ke CALL-E. */
export interface CallGoalConfig {
  goalType: GoalType;
  title: string;
  /** Kalimat ringkas untuk UI ("AI will automatically confirm this booking"). */
  summary: string;
  prompt: string;
  resultSchema: Record<string, unknown>;
  tone: CallTone;
  language: CallLanguage;
  voicemailBehavior: VoicemailBehavior;
}

/** Kustomisasi dari user (progressive disclosure). `goalType` `'auto'` = tanpa override. */
export interface GoalCustomization {
  goalType?: GoalTypeSelection | null;
  customInstruction?: string | null;
}

export interface ComposeCallGoalInput {
  booking: BookingGoalContext;
  business: BusinessGoalContext;
  customization?: GoalCustomization | null;
}

/** Template satu kombinasi Industry × GoalType. `buildPrompt` menghasilkan task CALL-E. */
export interface CallGoalTemplate {
  goalType: GoalType;
  title: string;
  summary: string;
  buildPrompt: (context: BookingGoalContext, business: BusinessGoalContext) => string;
  resultSchema: Record<string, unknown>;
  tone: CallTone;
  language: CallLanguage;
  voicemailBehavior: VoicemailBehavior;
}
