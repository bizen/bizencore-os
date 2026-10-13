import { LockKeyhole } from 'lucide-react';

export function TaskLockMark({ text, hasChildren, hiddenCount = 0, collapsed = false, onToggle }: {
  text: string;
  hasChildren: boolean;
  hiddenCount?: number;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const mark = <span className="row-lock-mark" role="img" aria-label="ロック中・完了不可">
    <LockKeyhole size={14} aria-hidden />
  </span>;
  if (!onToggle || (!hasChildren && hiddenCount === 0)) return <span title="ロック中・詳細から解除できます">{mark}</span>;
  const label = `${text.trim() || 'タスク'}のサブタスクを${collapsed ? '展開' : '収納'}`;
  return <button type="button" className={`row-lock-toggle${collapsed ? ' is-collapsed' : ''}`}
    aria-label={label} aria-expanded={!collapsed} title={collapsed ? `${label}（${hiddenCount}件）` : label} onClick={onToggle}>
    {mark}
    {collapsed && hiddenCount > 0 ? <span className="row-lock-count" aria-label={`${hiddenCount}件収納中`}>{hiddenCount}</span> : null}
  </button>;
}
