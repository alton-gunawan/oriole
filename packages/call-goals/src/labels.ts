import type { GoalType, Industry } from './types.ts';

export const INDUSTRY_LABELS: Record<Industry, string> = {
  barbershop: 'Barbershop',
  'nail-salon': 'Nail salon',
  'massage-spa': 'Massage/spa',
  'pet-grooming': 'Pet grooming',
  'car-detailing': 'Car detailing',
  'yoga-pilates': 'Yoga / Pilates studio',
  'personal-trainer': 'Personal trainer',
  'photography-studio': 'Photography Studio',
  clinic: 'Clinic',
  salon: 'Salon',
  fitness: 'Fitness',
  spa: 'Spa',
  dental: 'Dental',
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
