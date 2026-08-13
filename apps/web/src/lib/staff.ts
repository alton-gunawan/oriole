/** Mirrors GET /api/staff — baris staf + jadwal mingguan + cuti. */
export interface StaffSchedule {
  id: string;
  /** 0=Sunday .. 6=Saturday. */
  dayOfWeek: number;
  /** Menit sejak tengah malam (zona staf). */
  startMinutes: number;
  endMinutes: number;
}

export interface StaffTimeOff {
  id: string;
  startDate: string;
  endDate: string;
  reason: string | null;
}

export interface StaffRecord {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  color: string;
  timezone: string;
  isActive: boolean;
  bufferMinutes: number;
  createdAt: string;
  updatedAt: string;
  schedules: StaffSchedule[];
  timeOff: StaffTimeOff[];
}

export interface StaffListResponse {
  staff: StaffRecord[];
}

export interface StaffResponse {
  staff: StaffRecord;
}

export interface TimeOffResponse {
  timeOff: StaffTimeOff;
}

export interface CreateStaffPayload {
  name: string;
  email?: string;
  phone?: string;
  color?: string;
  timezone?: string;
  bufferMinutes?: number;
}

export interface UpdateStaffPayload {
  name?: string;
  email?: string | null;
  phone?: string | null;
  color?: string;
  timezone?: string;
  bufferMinutes?: number;
  isActive?: boolean;
}

/** Jadwal mingguan yang dikirim ke PUT /api/staff/:id/schedules (tanpa id). */
export interface ScheduleDraft {
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
}

/** Nama hari (0=Sun..6=Sat) — dipakai editor jadwal mingguan. */
export const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

export const WEEKDAY_LABEL_KEYS = [
  'staff.weekdaySunday',
  'staff.weekdayMonday',
  'staff.weekdayTuesday',
  'staff.weekdayWednesday',
  'staff.weekdayThursday',
  'staff.weekdayFriday',
  'staff.weekdaySaturday',
] as const;

/** Label hari singkat (2 huruf) untuk chip jadwal — locale-independent. */
export const WEEKDAY_SHORT = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const;
