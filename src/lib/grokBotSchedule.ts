import { dateInTimeZone, isTimeString } from './taskDates';
import { deadlineInstant } from './taskNotifications';

export const maxClockIns = 6;
const minuteMs = 60_000;
const floorMinute = (at: number) => Math.floor(at / minuteMs) * minuteMs;

/** Valid HH:MM clock-in times, unique and ascending, at most six; falls back to the single legacy time. */
export function normalizeClockInTimes(times?: string[], fallbackTime?: string): string[] {
  const valid = [...new Set((times ?? []).map(time => time.trim()).filter(isTimeString))].sort().slice(0, maxClockIns);
  return valid.length || !fallbackTime || !isTimeString(fallbackTime) ? valid : [fallbackTime];
}

/** The next clock-in at or after this minute, looking up to four days ahead in the user's time zone. */
export function nextClockIn(times: string[], timeZone: string, now: number, lastRunAt?: number, lastSlotKey?: string): number | undefined {
  const today = dateInTimeZone(timeZone, now);
  const start = Date.parse(`${today}T00:00:00Z`);
  const from = floorMinute(now);
  // One time a day keeps the original rule: at most one patrol per calendar day.
  const lastDay = times.length === 1 && lastRunAt ? dateInTimeZone(timeZone, lastRunAt) : undefined;
  const lastMinute = lastRunAt === undefined ? undefined : floorMinute(lastRunAt);
  for (let offset = 0; offset < 4; offset++) {
    const day = new Date(start + offset * 86_400_000).toISOString().slice(0, 10);
    if (lastDay === day) continue;
    for (const time of times) {
      const at = deadlineInstant(day, time, timeZone);
      if (at === null || at < from) continue;
      if (times.length > 1 && (lastSlotKey === String(at) || lastMinute === at)) continue;
      return at;
    }
  }
}
