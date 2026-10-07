import { isLabelColor, type LabelColor } from './taskModel';
import { isDateString } from './taskDates';

export interface PartnerItem {
  id: string;
  type: 'section' | 'task';
  parentId: string | null;
  order: number;
  text: string;
  done: boolean;
  locked?: boolean;
  filed?: boolean;
  color?: LabelColor;
  dueDate?: string;
  dueTime?: string;
}

export interface PartnerSourceRow {
  itemId: string;
  payload: string;
  deletedAt?: number;
}

function readPublicFields(row: PartnerSourceRow): PartnerItem | null {
  try {
    const item = JSON.parse(row.payload) as Record<string, unknown>;
    if (!item || item.id !== row.itemId || row.deletedAt !== undefined || item.deletedAt !== undefined ||
        (item.type !== 'section' && item.type !== 'task') || typeof item.text !== 'string' ||
        (item.parentId !== null && typeof item.parentId !== 'string') ||
        typeof item.order !== 'number' || !Number.isFinite(item.order)) return null;
    // Construct a whitelist, never forward payloads or spread private task fields.
    return {
      id: row.itemId, type: item.type, parentId: item.parentId, order: item.order, text: item.text,
      done: item.type === 'task' && item.locked !== true && item.done === true,
      ...(item.type === 'section' && isLabelColor(item.color) ? { color: item.color } : {}),
      ...(item.type === 'task' && item.locked === true ? { locked: true } : {}),
      ...(item.type === 'task' && item.locked !== true && item.filed === true ? { filed: true } : {}),
      ...(item.type === 'task' && typeof item.dueDate === 'string' && isDateString(item.dueDate)
        ? { dueDate: item.dueDate, ...(typeof item.dueTime === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(item.dueTime) ? { dueTime: item.dueTime } : {}) } : {}),
    };
  } catch { return null; }
}

export function partnerLabels(rows: PartnerSourceRow[]) {
  return rows.map(readPublicFields).filter((item): item is PartnerItem => !!item && item.type === 'section' && item.parentId === null)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map(({ id, text, color }) => ({ id, text, ...(color ? { color } : {}) }));
}

export function publicPartnerItems(rows: PartnerSourceRow[], labelIds: readonly string[]): PartnerItem[] {
  const allowed = new Set(labelIds);
  const items = rows.map(readPublicFields).filter((item): item is PartnerItem => item !== null);
  const roots = items.filter(item => item.type === 'section' && item.parentId === null && allowed.has(item.id));
  const children = new Map<string, PartnerItem[]>();
  for (const item of items) {
    if (item.type !== 'task' || item.parentId === null) continue;
    const siblings = children.get(item.parentId) ?? [];
    siblings.push(item); children.set(item.parentId, siblings);
  }
  const sort = (list: PartnerItem[]) => list.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  sort(roots); for (const list of children.values()) sort(list);
  const pending = [...roots].reverse();
  const visited = new Set<string>();
  const result: PartnerItem[] = [];
  while (pending.length) {
    const item = pending.pop()!;
    if (visited.has(item.id)) continue;
    visited.add(item.id); result.push(item);
    pending.push(...[...(children.get(item.id) ?? [])].reverse());
  }
  return result;
}

export function partnerDisplayRows(items: PartnerItem[]) {
  const depths = new Map<string, number>();
  const parents = new Set(items.map(item => item.parentId));
  const active: { item: PartnerItem; depth: number; hasChildren: boolean }[] = [];
  const done: typeof active = [];
  let shelfDepth: number | null = null;
  for (const item of items) {
    const depth = item.parentId === null ? 0 : (depths.get(item.parentId) ?? -1) + 1;
    depths.set(item.id, depth);
    if (shelfDepth !== null && depth <= shelfDepth) shelfDepth = null;
    if (shelfDepth === null && item.type === 'task' && item.done && item.filed) shelfDepth = depth;
    const row = { item, depth: shelfDepth === null ? depth : depth - shelfDepth, hasChildren: parents.has(item.id) };
    (shelfDepth === null ? active : done).push(row);
  }
  return { active, done };
}

export function partnerInviteCode(value: string): string | null {
  const text = value.trim();
  if (/^[a-f0-9]{64}$/.test(text)) return text;
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const code = new URLSearchParams(url.hash.slice(1)).get('partner-invite');
    return code && /^[a-f0-9]{64}$/.test(code) ? code : null;
  } catch { return null; }
}

export function initialPartnerInvite(): string {
  return new URLSearchParams(window.location.hash.slice(1)).get('partner-invite') ?? '';
}
