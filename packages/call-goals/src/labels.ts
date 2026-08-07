import type { GoalType, Industry } from './types.ts';

export const INDUSTRY_LABELS: Record<Industry, string> = {
  dental: 'Dental',
  medspa: 'Medspa / Aesthetic',
  hair_salon: 'Hair Salon & Barber',
  medical_clinic: 'Medical Clinic',
  restaurant: 'Restaurant',
  wellness: 'Wellness / Therapy',
  fitness: 'Fitness & Gym',
  professional_services: 'Professional Services',
  home_services: 'Home Services',
  automotive: 'Automotive',
  education_coaching: 'Education & Coaching',
  photography_creative: 'Photography & Creative',
  real_estate: 'Real Estate',
  pet_care: 'Pet Care',
  space_rental: 'Space Rental',
  other: 'Other',
};

export const GOAL_TYPE_LABELS: Record<GoalType, string> = {
  'confirm-attendance': 'Confirm Attendance',
  'reminder-reconfirm': 'Reminder + Re-confirm',
  'confirm-with-accountability': 'Confirm with Soft Accountability',
  'reschedule-assistance': 'Reschedule Assistance',
  'final-follow-up': 'Final Follow-up',
};

export function industryLabel(industry?: string | null): string {
  if (industry && industry in INDUSTRY_LABELS) return INDUSTRY_LABELS[industry as Industry];
  return INDUSTRY_LABELS.other;
}

export function goalTypeLabel(goalType: GoalType): string {
  return GOAL_TYPE_LABELS[goalType];
}
