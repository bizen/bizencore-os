import type { PaneAssignment } from '../src/lib/desktopHandoff';

export function addAssignment<T extends { id: string; assignments?: PaneAssignment[] }>(panes: T[], id: string, assignment: PaneAssignment): T[] {
  const target = panes.find(pane => pane.id === id);
  if (!target) throw new Error('対象のペインは閉じられています');
  if (panes.some(pane => pane.id !== id && pane.assignments?.some(value => value.taskId === assignment.taskId))) throw new Error('このタスクは別のペインに割り当て済みです');
  const values = target.assignments ?? [];
  const existing = values.some(value => value.taskId === assignment.taskId);
  if (!existing && values.length >= 3) throw new Error('担当タスクは3件までです。既存の担当を外すか、別ターミナルで開始してください');
  return panes.map(pane => pane.id !== id ? pane : { ...pane, assignments: existing
    ? values.map(value => value.taskId === assignment.taskId ? { ...value, ...assignment } : value)
    : [...values, assignment] });
}
