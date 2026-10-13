export function collapseRows<T extends { depth: number }>(
  rows: T[],
  isCollapsed: (row: T) => boolean,
  getId: (row: T) => string,
  isTask: (row: T) => boolean = () => true
) {
  const visible: T[] = [];
  const hiddenCounts = new Map<string, number>();
  let parent: { id: string; depth: number } | null = null;
  for (const row of rows) {
    if (parent && row.depth > parent.depth) {
      if (isTask(row)) hiddenCounts.set(parent.id, (hiddenCounts.get(parent.id) ?? 0) + 1);
      continue;
    }
    parent = null;
    visible.push(row);
    if (isCollapsed(row)) {
      parent = { id: getId(row), depth: row.depth };
      hiddenCounts.set(parent.id, 0);
    }
  }
  return { rows: visible, hiddenCounts };
}
