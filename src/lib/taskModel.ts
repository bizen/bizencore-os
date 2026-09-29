/**
 * タスクツリーの型と純粋関数。
 * - 1本の木で表現する: ルート直下に「ラベル(section)」とタスクが並び、
 *   タスクは子タスク（サブタスク）を持てる。ラベルもタスクを子に持てる。
 * - 並び順は兄弟内の fractional order。同期しても衝突しにくい。
 */

import type { Stamps } from './itemMerge';

export const MAX_DEPTH = 4;

export type TaskKind = 'main' | 'tanomi';
/** UI では「ラベル」と呼ぶ。保存済みデータとの互換のため値は 'section' のまま */
export type ItemType = 'task' | 'section';

export type LabelColor = 'blue' | 'violet' | 'pink' | 'amber' | 'green';

/** ラベルの色。完了（氷）・期限（黄／赤）と紛れない範囲で選んでいる */
export const LABEL_COLORS: Record<LabelColor, string> = {
  blue: '#5b9dff',
  violet: '#a78bfa',
  pink: '#f472b6',
  amber: '#f0b429',
  green: '#4ade80',
};

export const LABEL_COLOR_KEYS = Object.keys(LABEL_COLORS) as LabelColor[];

export function isLabelColor(value: unknown): value is LabelColor {
  return typeof value === 'string' && value in LABEL_COLORS;
}

/** 色なし → blue → … → green → 色なし */
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
  done: boolean;
  /** 「完了を整理」で完了済みの棚へ送ったか。完了を取り消すと外れる */
  filed?: boolean;
  kind?: TaskKind;
  /** ラベルの色（type === 'section' のときだけ使う） */
  color?: LabelColor;
  /** 作業想定時間（分） */
  estimate?: number;
  /** today に入れた日 YYYY-MM-DD */
  assignedDate?: string;
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
