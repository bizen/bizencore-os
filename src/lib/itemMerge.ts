/**
 * 同期の突き合わせ。ブラウザ（taskStore）、Convex の push（convex/sync.ts）、
 * MCP の書き込み（convex/mcpTasks.ts）の3か所が同じ規則で合わせる。
 *
 * 行ごとに新しい方を採ると、別々の欄を同時に触ったとき（AI が文言を、
 * 人がメモを直した、など）に片方が黙って消える。そこで欄ごとに
 * 「いつ変わったか」を持ち、欄ごとに新しい方を採る。
 *
 * 一緒に動く欄はまとめて1つの時刻にする（位置は parentId と order、
 * 完了は done と filed）。半分だけ採ると、ありえない組み合わせになるため。
 *
 * stamps を持たない古い行は、どの欄も updatedAt に変わったものとみなす。
 * そのときの振る舞いは、以前の「行ごとに新しい方」と同じになる。
 *
 * 添付（attachments）だけは新しい方を採らず、1件ずつ ID で合わせて足し合わせる。
 * 人と AI が同時に添えても、どちらも残るようにするため（src/lib/attachments.ts）。
 *
 * DOM にも Convex にも依存させないこと。両方から読まれる。
 */

import { mergeAttachments } from './attachments';

export const FIELD_GROUPS = {
  type: ['type'],
  origin: ['createdBy', 'createdByClient'],
  position: ['parentId', 'order'],
  text: ['text'],
  note: ['note'],
  completionCriteria: ['completionCriteria'],
  done: ['done', 'filed', 'completedBy', 'completedByClient'],
  lock: ['locked'],
  kind: ['kind'],
  color: ['color'],
  estimate: ['estimate'],
  today: ['assignedDate'],
  deadline: ['dueDate', 'dueTime'],
  deleted: ['deletedAt'],
  attachments: ['attachments'],
} as const;

export type FieldGroup = keyof typeof FIELD_GROUPS;
export type Stamps = Partial<Record<FieldGroup, number>>;

const GROUPS = Object.keys(FIELD_GROUPS) as FieldGroup[];

interface Stamped {
  updatedAt: number;
  stamps?: Stamps;
}

function field(item: Stamped, key: string): unknown {
  return (item as unknown as Record<string, unknown>)[key];
}

function stampOf(item: Stamped, group: FieldGroup): number {
  // Older clients do not know this field; omitting it must not unlock a task.
  if (group === 'lock') return item.stamps?.lock ?? (field(item, 'locked') === true ? item.updatedAt : 0);
  return item.stamps?.[group] ?? item.updatedAt;
}

function enforceLock<T extends Stamped>(item: T): T {
  if (field(item, 'type') !== 'task' || field(item, 'locked') !== true) return item;
  return { ...item, done: false, filed: undefined, completedBy: undefined, completedByClient: undefined };
}

/** 添付のような配列は中身で比べる */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

function sameGroup(a: Stamped, b: Stamped, group: FieldGroup): boolean {
  return FIELD_GROUPS[group].every((key) => sameValue(field(a, key), field(b, key)));
}

/** 時刻が並んだときの決め手。どちらの側で合わせても同じ答えになるようにする */
function groupKey(item: Stamped, group: FieldGroup): string {
  return JSON.stringify(FIELD_GROUPS[group].map((key) => field(item, key) ?? null));
}

export function coerceStamps(raw: unknown): Stamps | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const stamps: Stamps = {};
  let any = false;
  for (const group of GROUPS) {
    const value = (raw as Record<string, unknown>)[group];
    if (typeof value === 'number' && Number.isFinite(value)) {
      stamps[group] = value;
      any = true;
    }
  }
  return any ? stamps : undefined;
}

/**
 * 変更を書くときに呼ぶ。prev から変わった欄にだけ now を打つ。
 * prev が無ければ（新しく作ったもの）全部の欄に now。
 */
export function restamp<T extends Stamped>(prev: T | undefined, next: T, now: number): T {
  next = enforceLock(next);
  const stamps: Stamps = {};
  for (const group of GROUPS) {
    stamps[group] = prev && sameGroup(prev, next, group) ? stampOf(prev, group) : now;
  }
  return { ...next, stamps, updatedAt: now };
}

/** 欄ごとに新しい方を採る。merge(a, b) と merge(b, a) は同じ中身になる */
export function mergeItems<T extends Stamped>(a: T, b: T): T {
  const merged = { ...a } as unknown as Record<string, unknown>;
  const stamps: Stamps = {};

  for (const group of GROUPS) {
    const sa = stampOf(a, group);
    const sb = stampOf(b, group);
    stamps[group] = Math.max(sa, sb);
    if (group === 'attachments') {
      const attachments = mergeAttachments(field(a, 'attachments'), field(b, 'attachments'));
      if (attachments) merged.attachments = attachments;
      else delete merged.attachments;
      continue;
    }
    const takeB = sb > sa || (sb === sa && groupKey(b, group) > groupKey(a, group));
    if (!takeB) continue;
    for (const key of FIELD_GROUPS[group]) {
      const value = field(b, key);
      if (value === undefined) delete merged[key];
      else merged[key] = value;
    }
  }

  merged.stamps = stamps;
  merged.updatedAt = Math.max(a.updatedAt, b.updatedAt);
  if (merged.type === 'task' && merged.locked === true) stamps.done = Math.max(stamps.done ?? 0, stamps.lock ?? 0);
  return enforceLock(merged as unknown as T);
}

/** どの欄も同じ中身・同じ時刻か。送り直しが要らないかの判定に使う */
export function sameStampedState(a: Stamped, b: Stamped): boolean {
  return GROUPS.every(
    (group) => stampOf(a, group) === stampOf(b, group) && sameGroup(a, b, group)
  );
}

/** from から to で中身か時刻が変わった欄 */
export function changedGroups(from: Stamped, to: Stamped): FieldGroup[] {
  return GROUPS.filter(
    (group) => stampOf(from, group) !== stampOf(to, group) || !sameGroup(from, to, group)
  );
}

/** target の指定した欄だけを source のものに差し替える */
export function withGroups<T extends Stamped>(target: T, source: T, groups: FieldGroup[]): T {
  const next = { ...target } as unknown as Record<string, unknown>;
  const stamps: Stamps = { ...target.stamps };
  for (const group of groups) {
    for (const key of FIELD_GROUPS[group]) {
      const value = field(source, key);
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    stamps[group] = stampOf(source, group);
  }
  next.stamps = stamps;
  return next as unknown as T;
}
