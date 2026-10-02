import { flattenAll, flattenToday, rowsForLabel, type Item, type ItemMap, type Row } from '../src/lib/taskModel';

export type View = 'all' | 'board' | 'today' | `label:${string}`;
export type DueFilter = 'all' | 'overdue' | 'week' | 'dated';

export function pickerHeight(dimensions?: { height?: number; maxHeight?: number }): number {
  const height = dimensions?.height ?? dimensions?.maxHeight;
  return typeof height === 'number' && Number.isFinite(height) && height > 0 ? Math.min(680, height) : 680;
}

export function filterDue(rows: Row[], filter: DueFilter, today: string): Row[] {
  if (filter === 'all') return rows;
  const end = new Date(`${today}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 7);
  const week = end.toISOString().slice(0, 10);
  const matched = new Set<string>();
  const ancestors: Row[] = [];
  for (const row of rows) {
    ancestors.length = row.depth;
    ancestors[row.depth] = row;
    const date = row.item.dueDate;
    if (!date || row.item.type !== 'task' || row.item.done) continue;
    if (filter === 'overdue' && date >= today) continue;
    if (filter === 'week' && (date < today || date > week)) continue;
    for (const ancestor of ancestors) if (ancestor) matched.add(ancestor.item.id);
  }
  return rows.filter((row) => matched.has(row.item.id));
}

export function pickerRows(items: ItemMap, view: View, today: string): { active: Row[]; done: Row[] } {
  const all = flattenAll(items);
  const rows = view === 'today' ? flattenToday(items, today)
    : view.startsWith('label:') ? rowsForLabel(all, view.slice(6)) : all;
  const active: Row[] = [], done: Row[] = [];
  let filedDepth: number | undefined;
  for (const row of rows) {
    if (filedDepth !== undefined && row.depth > filedDepth) {
      done.push({ ...row, depth: row.depth - filedDepth });
      continue;
    }
    filedDepth = undefined;
    if (row.item.type === 'task' && row.item.done && row.item.filed) {
      filedDepth = row.depth;
      done.push({ ...row, depth: 0 });
    } else active.push(row);
  }
  return { active, done };
}

export function taskPath(items: ItemMap, id: string): string {
  const names: string[] = [], visited = new Set<string>([id]);
  let item = items[id]?.parentId ? items[items[id].parentId!] : undefined;
  while (item && !visited.has(item.id)) {
    visited.add(item.id); names.unshift(item.text);
    item = item.parentId ? items[item.parentId] : undefined;
  }
  return names.join(' › ');
}

export function boardGroups(rows: Row[]): { label?: Item; rows: Row[] }[] {
  const groups: { label?: Item; rows: Row[] }[] = [{ rows: [] }];
  let current = groups[0];
  for (const row of rows) {
    if (row.depth === 0 && row.item.type === 'section') {
      current = { label: row.item, rows: [] };
      groups.push(current);
    } else {
      if (row.depth === 0) current = groups[0];
      current.rows.push({ ...row, depth: row.depth - (current.label ? 1 : 0) });
    }
  }
  return groups.filter((group) => group.label || group.rows.length);
}

export function handoffMessage(id: string): string {
  return `bizencore のタスクに着手してください。タスクID: ${id}\nまず bizencore MCP の work_on_task をこの task_id で呼び、最新情報を読んでください。情報が足りなければ相談し、分かったら同じ会話で作業を続け、検証済みの完了または途中経過を記録してください。`;
}
