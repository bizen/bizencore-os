import { useMemo } from 'react';
import { PanelRight, X } from 'lucide-react';
import { completionBlockedIds, isLive, type ItemMap } from '../src/lib/taskModel';
import { taskStore } from '../src/lib/taskStore';
import { TaskCheckBox } from '../src/components/task/TaskCheckBox';
import { TaskLockMark } from '../src/components/task/TaskLockMark';

export function AgentTaskAssignment({ taskId, items, summary, onOpenTask, onRemove, removeDisabled = false }: {
  taskId: string;
  items: ItemMap;
  summary?: string;
  onOpenTask?: (id: string) => void;
  onRemove?: () => void;
  removeDisabled?: boolean;
}) {
  const assigned = items[taskId];
  const task = isLive(assigned) && assigned.type === 'task' ? assigned : undefined;
  const blocked = useMemo(() => completionBlockedIds(items), [items]);
  const openDetails = () => { if (task) onOpenTask?.(task.id); };
  return <div className={`agent-assignment${task?.done ? ' is-done' : ''}`}>
    <div>
      {task ? task.locked ? <TaskLockMark text={task.text} hasChildren={false} /> : <TaskCheckBox
        done={task.done} completedByAi={task.done && task.completedBy === 'ai'} blocked={blocked.has(task.id)}
        tabIndex={0} title={task.done ? '未完了に戻す' : '完了にする'} onToggle={() => taskStore.toggleDone(task.id)}
      /> : null}
      <button type="button" className="agent-assignment-title" disabled={!task || !onOpenTask} title="担当タスクの詳細を開く" onClick={openDetails}>{task ? task.text || '（無題）' : 'タスクが見つかりません'}</button>
      <button type="button" className="icon-btn" disabled={!task || !onOpenTask} title="担当タスクの詳細を開く" aria-label="担当タスクの詳細を開く" onClick={openDetails}><PanelRight size={15} /></button>
      {onRemove ? <button type="button" className="icon-btn" disabled={removeDisabled} title="担当タスクを外す" aria-label="担当タスクを外す" onClick={onRemove}><X size={13} /></button> : null}
    </div>
    {summary ? <small>{summary}</small> : null}
  </div>;
}
