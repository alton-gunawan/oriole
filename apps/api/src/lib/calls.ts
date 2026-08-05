/**
 * Ambil durasi panggilan (detik) dari payload result CALL-E secara defensif.
 * Key yang dicek mengikuti bentuk payload webhook CALL-E; bila tidak ada
 * satupun yang cocok, durasi dianggap 0 (tidak memakai panggilan).
 */
const DURATION_KEYS = [
  'durationSeconds',
  'duration',
  'seconds',
  'totalSeconds',
  'callDuration',
] as const;

export function extractCallSeconds(result: Record<string, unknown> | null | undefined): number {
  if (!result || typeof result !== 'object') return 0;
  for (const key of DURATION_KEYS) {
    const value = (result as Record<string, unknown>)[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}
