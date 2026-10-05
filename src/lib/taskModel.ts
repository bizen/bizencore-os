/**
 * タスクツリーの型と純粋関数。
 * - 1本の木で表現する: ルート直下に「ラベル(section)」とタスクが並び、
 *   タスクは子タスク（サブタスク）を持てる。ラベルもタスクを子に持てる。
 * - 並び順は兄弟内の fractional order。同期しても衝突しにくい。
 */

import type { Attachment } from './attachments';
import type { Stamps } from './itemMerge';

export const MAX_DEPTH = 4;

export type TaskKind = 'main' | 'tanomi';
/** UI では「ラベル」と呼ぶ。保存済みデータとの互換のため値は 'section' のまま */
export type ItemType = 'task' | 'section';

export type LabelColor = 'blue' | 'violet' | 'pink' | 'amber' | 'green'
  | 'cyan' | 'teal' | 'red' | 'orange' | 'rose' | 'indigo' | 'gray';

/** 既存の色は保持し、ラベルの位置・形と合わせて状態表示と区別する。 */
export const LABEL_COLORS: Record<LabelColor, string> = {
  blue: '#5b9dff',
  violet: '#a78bfa',
  pink: '#f472b6',
  amber: '#f0b429',
  green: '#4ade80',
  cyan: '#38bdf8',
  teal: '#2dd4bf',
  red: '#f87171',
  orange: '#fb923c',
  rose: '#fb7185',
  indigo: '#818cf8',
  gray: '#9ca3af',
};

export const LABEL_COLOR_KEYS = Object.keys(LABEL_COLORS) as LabelColor[];

export const LABEL_COLOR_NAMES: Record<LabelColor, string> = {
  blue: '青', violet: '紫', pink: 'ピンク', amber: '黄', green: '緑',
  cyan: '水色', teal: 'ティール', red: '赤', orange: 'オレンジ',
  rose: 'ローズ', indigo: 'インディゴ', gray: 'グレー',
};

export function isLabelColor(value: unknown): value is LabelColor {
  return typeof value === 'string' && Object.hasOwn(LABEL_COLORS, value);
}

/** 色なし → パレット順 → 色なし */
export function nextLabelColor(color: LabelColor | undefined): LabelColor | undefined {
  if (color === undefined) return LABEL_COLOR_KEYS[0];
  const index = LABEL_COLOR_KEYS.indexOf(color);
  return LABEL_COLOR_KEYS[index + 1];
}

export interface Item {
  id: string;
  type: ItemType;
  parentId: string | null;
  /** 兄弟内での並び順（小さいほど上） */
  order: number;
  text: string;
  /** 補足メモ */
  note?: string;
  /** このタスクが終わったと判断する条件 */
  completionCriteria?: string;
  done: boolean;
  /** 常設の見出しとして使い、このタスク自体の完了を禁止する */
  locked?: boolean;
  /** 古いタスクは出所を推測せず未設定のままにする */
  createdBy?: 'user' | 'ai';
  createdByClient?: string;
  completedBy?: 'user' | 'ai';
  completedByClient?: string;
  /** 「完了を整理」で完了済みの棚へ送ったか。完了を取り消すと外れる */
  filed?: boolean;
  kind?: TaskKind;
  /** ラベルの色（type === 'section' のときだけ使う） */
  color?: LabelColor;
  /** 作業想定時間（分） */
  estimate?: number;
  /** today に入れた日 YYYY-MM-DD */
  assignedDate?: string;
  /** 期限。YYYY-MM-DD と任意の HH:mm（ユーザーのタイムゾーン） */
  dueDate?: string;
  dueTime?: string;
  /** 添えたコンテキスト（リンクと文章）。外したものも deletedAt 付きで残る */
  attachments?: Attachment[];
  createdAt: number;
  updatedAt: number;
  /** 論理削除（同期のトゥームストーン） */
  deletedAt?: number;
  /** 欄ごとの変更時刻。同期で欄ごとに突き合わせる（src/lib/itemMerge.ts） */
  stamps?: Stamps;
}

export type ItemMap = Record<string, Item>;

export interface Row {
  item: Item;
  depth: number;
  /** 完了済みの棚で、親から離れて置かれたサブタスクに添える親の名前 */
  context?: string;
}

export function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function isLive(item: Item | undefined): item is Item {
  return !!item && !item.deletedAt;
}

/** A bulk completion must not hide a locked container below the selected task. */
export function completionBlockedIds(items: ItemMap): Set<string> {
  const blocked = new Set<string>();
  for (const item of Object.values(items)) {
    if (!isLive(item) || item.type !== 'task' || !item.locked) continue;
    const visited = new Set<string>();
    let current: Item | undefined = item;
    while (isLive(current) && !visited.has(current.id)) {
      visited.add(current.id);
      blocked.add(current.id);
      current = current.parentId ? items[current.parentId] : undefined;
    }
  }
  return blocked;
}

export function compareItems(a: Item, b: Item): number {
  if (a.order !== b.order) return a.order - b.order;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 親が消えている／削除済みなら root 扱い（同期で孤児が出ても壊れないように） */
export function effectiveParentId(items: ItemMap, item: Item): string | null {
  if (!item.parentId) return null;
  const parent = items[item.parentId];
  return isLive(parent) ? parent.id : null;
}

export function groupByParent(items: ItemMap): Map<string | null, Item[]> {
  const byParent = new Map<string | null, Item[]>();
  for (const item of Object.values(items)) {
    if (!isLive(item)) continue;
    const pid = effectiveParentId(items, item);
    const bucket = byParent.get(pid);
    if (bucket) bucket.push(item);
    else byParent.set(pid, [item]);
  }
  for (const bucket of byParent.values()) bucket.sort(compareItems);
  return byParent;
}

export function childrenOf(items: ItemMap, parentId: string | null): Item[] {
  return groupByParent(items).get(parentId) ?? [];
}

/** 深さ優先・前順。親の直後に子が続くことを保証する */
export function flattenAll(items: ItemMap): Row[] {
  const byParent = groupByParent(items);
  const rows: Row[] = [];
  const visited = new Set<string>();

  const walk = (parentId: string | null, depth: number) => {
    for (const item of byParent.get(parentId) ?? []) {
      if (visited.has(item.id)) continue; // 同期事故による循環よけ
      visited.add(item.id);
      rows.push({ item, depth });
      walk(item.id, depth + 1);
    }
  };

  walk(null, 0);
  return rows;
}

/** ラベル自身とその子孫だけを、all と同じ深さ・並びで取り出す */
export function rowsForLabel(rows: Row[], labelId: string): Row[] {
  const start = rows.findIndex((row) => row.depth === 0 && row.item.type === 'section' && row.item.id === labelId);
  if (start < 0) return [];
  let end = start + 1;
  while (end < rows.length && rows[end].depth > 0) end++;
  return rows.slice(start, end);
}

/** today 割り当てタスクとその子孫だけを、today を深さ0として並べ直す */
export function flattenToday(items: ItemMap, todayDate: string): Row[] {
  const rows: Row[] = [];
  let baseDepth: number | null = null;

  for (const row of flattenAll(items)) {
    if (baseDepth !== null && row.depth > baseDepth) {
      rows.push({ item: row.item, depth: row.depth - baseDepth });
      continue;
    }
    baseDepth = null;
    if (row.item.type === 'task' && row.item.assignedDate === todayDate) {
      baseDepth = row.depth;
      rows.push({ item: row.item, depth: 0 });
    }
  }

  return rows;
}

export function subtreeIds(items: ItemMap, rootId: string): string[] {
  const byParent = groupByParent(items);
  const ids: string[] = [];
  const stack = [rootId];
  const seen = new Set<string>();

  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    for (const child of byParent.get(id) ?? []) stack.push(child.id);
  }

  return ids;
}

export function depthOf(items: ItemMap, id: string): number {
  let depth = 0;
  let current = items[id];
  const seen = new Set<string>();
  while (current && current.parentId && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = items[current.parentId];
    if (!isLive(parent)) break;
    depth += 1;
    current = parent;
  }
  return depth;
}

/** 部分木の最大深さ（自分自身を0とした相対） */
export function subtreeHeight(items: ItemMap, rootId: string): number {
  const byParent = groupByParent(items);
  const walk = (id: string, seen: Set<string>): number => {
    if (seen.has(id)) return 0;
    seen.add(id);
    let max = 0;
    for (const child of byParent.get(id) ?? []) {
      max = Math.max(max, 1 + walk(child.id, seen));
    }
    return max;
  };
  return walk(rootId, new Set());
}

export const ORDER_GAP = 1;
const MIN_ORDER_GAP = 1e-6;

export function orderBetween(prev?: number, next?: number): number {
  if (prev === undefined && next === undefined) return 0;
  if (prev === undefined) return next! - ORDER_GAP;
  if (next === undefined) return prev + ORDER_GAP;
  return (prev + next) / 2;
}

export function needsRebalance(prev?: number, next?: number): boolean {
  if (prev === undefined || next === undefined) return false;
  return Math.abs(next - prev) < MIN_ORDER_GAP;
}

export function isTodayItem(item: Item, todayDate: string): boolean {
  return item.type === 'task' && item.assignedDate === todayDate;
}

/** なし → 頼みごと（オレンジ）→ メインクエスト（青）→ なし */
export function nextKind(kind: TaskKind | undefined): TaskKind | undefined {
  if (kind === undefined) return 'tanomi';
  if (kind === 'tanomi') return 'main';
  return undefined;
}
