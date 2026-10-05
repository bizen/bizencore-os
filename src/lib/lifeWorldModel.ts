import { isDateString } from './taskDates';

export type LifeRepeat = 'once' | 'daily' | 'weekdays';
export const LIFE_REPEAT_NAMES: Record<LifeRepeat, string> = {
  once: 'この日だけ', daily: '毎日', weekdays: '平日',
};
export const LIFE_ENTRY_GROUPS = ['text', 'note', 'schedule', 'order', 'deletion'] as const;
export type LifeEntryGroup = typeof LIFE_ENTRY_GROUPS[number];

export interface LifeEntry {
  id: string;
  text: string;
  note: string;
  startDate: string;
  repeat: LifeRepeat;
  order: number;
  updatedAt: number;
  deletedAt?: number;
  stamps?: Partial<Record<LifeEntryGroup, number>>;
}

export interface LifeCheck {
  entryId: string;
  date: string;
  done: boolean;
  updatedAt: number;
}

export interface LifeData {
  version: 1;
  entries: Record<string, LifeEntry>;
  checks: Record<string, LifeCheck>;
}

export function emptyLifeData(): LifeData {
  return { version: 1, entries: {}, checks: {} };
}

export function lifeCheckKey(id: string, date: string): string {
  return `${id}:${date}`;
}

export function shiftLifeDate(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function lifeEntriesForDate(data: LifeData, date: string): LifeEntry[] {
  if (!isDateString(date)) return [];
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  return Object.values(data.entries).filter((entry) => {
    if (entry.deletedAt || entry.startDate > date) return false;
    if (entry.repeat === 'once') return entry.startDate === date;
    return entry.repeat === 'daily' || (weekday !== 0 && weekday !== 6);
  }).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function lifeWeek(data: LifeData, entry: LifeEntry, todayDate: string) {
  return Array.from({ length: 7 }, (_, i) => {
    const date = shiftLifeDate(todayDate, i - 6);
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    const scheduled = date >= entry.startDate && (entry.repeat === 'daily' ||
      (entry.repeat === 'weekdays' && weekday !== 0 && weekday !== 6) ||
      (entry.repeat === 'once' && date === entry.startDate));
    return { date, scheduled, done: data.checks[lifeCheckKey(entry.id, date)]?.done === true, today: date === todayDate };
  });
}

function groupValue(entry: LifeEntry, group: LifeEntryGroup): unknown[] {
  if (group === 'schedule') return [entry.startDate, entry.repeat];
  if (group === 'deletion') return [entry.deletedAt];
  return [entry[group]];
}

export function restampLifeEntry(before: LifeEntry | undefined, after: LifeEntry, now: number): LifeEntry {
  const stamps = { ...before?.stamps };
  for (const group of LIFE_ENTRY_GROUPS) {
    const changed = !before || JSON.stringify(groupValue(before, group)) !== JSON.stringify(groupValue(after, group));
    stamps[group] = changed ? now : before.stamps?.[group] ?? before.updatedAt;
  }
  return { ...after, updatedAt: now, stamps };
}

/** Merge edits to different entry fields without losing a concurrent note or schedule. */
export function mergeLifeEntry(a: LifeEntry, b: LifeEntry): LifeEntry {
  const result = { ...a, updatedAt: Math.max(a.updatedAt, b.updatedAt), stamps: {} as NonNullable<LifeEntry['stamps']> };
  for (const group of LIFE_ENTRY_GROUPS) {
    const sa = a.stamps?.[group] ?? a.updatedAt;
    const sb = b.stamps?.[group] ?? b.updatedAt;
    const chosen = sb > sa || (sb === sa && JSON.stringify(groupValue(b, group)) > JSON.stringify(groupValue(a, group))) ? b : a;
    result.stamps[group] = Math.max(sa, sb);
    if (group === 'schedule') { result.startDate = chosen.startDate; result.repeat = chosen.repeat; }
    else if (group === 'deletion') result.deletedAt = chosen.deletedAt;
    else if (group === 'order') result.order = chosen.order;
    else result[group] = chosen[group];
  }
  return result;
}

export function coerceLifeData(value: unknown): LifeData {
  const data = emptyLifeData();
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1) return data;
  const source = value as Record<string, unknown>;
  if (source.entries && typeof source.entries === 'object') {
    for (const entry of Object.values(source.entries)) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.id !== 'string' || !e.id || typeof e.text !== 'string' ||
          typeof e.startDate !== 'string' || !isDateString(e.startDate) ||
          typeof e.order !== 'number' || !Number.isFinite(e.order) ||
          typeof e.updatedAt !== 'number' || !Number.isFinite(e.updatedAt) ||
          typeof e.repeat !== 'string' || !['once', 'daily', 'weekdays'].includes(e.repeat)) continue;
      const stamps: LifeEntry['stamps'] = {};
      if (e.stamps && typeof e.stamps === 'object') {
        for (const group of LIFE_ENTRY_GROUPS) {
          const stamp = (e.stamps as Record<string, unknown>)[group];
          if (typeof stamp === 'number' && Number.isFinite(stamp) && stamp >= 0 && stamp <= e.updatedAt) stamps[group] = stamp;
        }
      }
      Object.defineProperty(data.entries, e.id, { enumerable: true, configurable: true, writable: true, value: {
        id: e.id, text: e.text, note: typeof e.note === 'string' ? e.note : '',
        startDate: e.startDate, repeat: e.repeat as LifeRepeat, order: e.order,
        updatedAt: e.updatedAt, deletedAt: typeof e.deletedAt === 'number' ? e.deletedAt : undefined,
        stamps: Object.keys(stamps).length ? stamps : undefined,
      } });
    }
  }
  if (source.checks && typeof source.checks === 'object') {
    for (const check of Object.values(source.checks)) {
      if (!check || typeof check !== 'object') continue;
      const c = check as Record<string, unknown>;
      if (typeof c.entryId !== 'string' || !Object.hasOwn(data.entries, c.entryId) ||
          typeof c.date !== 'string' || !isDateString(c.date) || typeof c.done !== 'boolean' ||
          typeof c.updatedAt !== 'number' || !Number.isFinite(c.updatedAt)) continue;
      data.checks[lifeCheckKey(c.entryId, c.date)] = {
        entryId: c.entryId, date: c.date, done: c.done, updatedAt: c.updatedAt,
      };
    }
  }
  return data;
}

/** Each day's check merges independently, so a new day never resets yesterday. */
export function mergeLifeData(a: LifeData, b: LifeData): LifeData {
  const merge = <T extends { updatedAt: number }>(left: Record<string, T>, right: Record<string, T>) => {
    const result = { ...left };
    for (const [id, incoming] of Object.entries(right)) {
      const current = Object.hasOwn(result, id) ? result[id] : undefined;
      if (!current || incoming.updatedAt > current.updatedAt ||
          (incoming.updatedAt === current.updatedAt && JSON.stringify(incoming) > JSON.stringify(current))) {
        Object.defineProperty(result, id, { value: incoming, writable: true, enumerable: true, configurable: true });
      }
    }
    return result;
  };
  const entries = { ...a.entries };
  for (const [id, incoming] of Object.entries(b.entries)) {
    Object.defineProperty(entries, id, { value: Object.hasOwn(entries, id) ? mergeLifeEntry(entries[id], incoming) : incoming,
      enumerable: true, configurable: true, writable: true });
  }
  return { version: 1, entries, checks: merge(a.checks, b.checks) };
}

export function lifePendingChanges(local: LifeData, remote: LifeData) {
  const entryKey = (entry: LifeEntry) => JSON.stringify([entry.id, entry.text, entry.note, entry.startDate,
    entry.repeat, entry.order, entry.updatedAt, entry.deletedAt,
    LIFE_ENTRY_GROUPS.map(group => entry.stamps?.[group] ?? entry.updatedAt)]);
  const checkKey = (check: LifeCheck) => JSON.stringify([check.entryId, check.date, check.done, check.updatedAt]);
  return {
    entries: Object.values(local.entries).filter(entry => !Object.hasOwn(remote.entries, entry.id) || entryKey(entry) !== entryKey(remote.entries[entry.id])),
    checks: Object.values(local.checks).filter(check => {
      const key = lifeCheckKey(check.entryId, check.date);
      return !Object.hasOwn(remote.checks, key) || checkKey(check) !== checkKey(remote.checks[key]);
    }),
  };
}
