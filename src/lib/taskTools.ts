import { childrenOf, depthOf, isLive, MAX_DEPTH, newId, type Item, type ItemMap } from './taskModel';
import { attachmentFrom, contextStorageError, liveAttachments, MAX_ATTACHMENTS, updateDocument } from './attachments';

export type WorkAgent = 'codex' | 'claude';
export type WorkStep = { text: string; owner: 'ai' | 'human' | 'joint'; existingTaskId: string; note: string; completionCriteria: string };
export type WorkResult = { status: 'completed' | 'waiting' | 'partial'; summary: string; questions: string[]; steps: WorkStep[] };
export type WorkRequest = { id: string; taskId: string; agent: WorkAgent; cwd: string; mode: 'execute' | 'decompose'; reply: string };
export type WorkReply = { result: WorkResult; taskDone: boolean; sourceTask?: unknown };
export type WorkEntry = { taskId: string; agent: WorkAgent; state: 'queued' | 'running' | 'completed' | 'waiting' | 'partial' | 'error' | 'skipped' | 'interrupted'; result?: WorkResult; updatedAt?: number; reply?: string; error?: string };

export function labelForTask(items: ItemMap, item: Item): string {
  const seen = new Set<string>();
  let parent = item.parentId ? items[item.parentId] : undefined;
  while (isLive(parent) && !seen.has(parent.id)) {
    if (parent.type === 'section') return parent.id;
    seen.add(parent.id);
    parent = parent.parentId ? items[parent.parentId] : undefined;
  }
  return '';
}

export function selectedRoots(items: ItemMap, ids: string[]): string[] {
  const selected = new Set(ids);
  return [...selected].filter(id => {
    const item = items[id];
    if (!isLive(item) || item.type !== 'task' || item.done || item.filed) return false;
    const seen = new Set<string>([id]);
    let parent = item.parentId ? items[item.parentId] : undefined;
    while (isLive(parent)) {
      if (seen.has(parent.id)) return false;
      if (selected.has(parent.id)) return false;
      seen.add(parent.id);
      parent = parent.parentId ? items[parent.parentId] : undefined;
    }
    return true;
  });
}

export function assignWork(ids: string[], available: WorkAgent[], overrides: Record<string, WorkAgent> = {}): WorkEntry[] {
  if (!available.length || available.some(agent => !['codex', 'claude'].includes(agent))) throw Error('利用できるエージェントを選択してください');
  let index = 0;
  return ids.map(taskId => {
    const agent = overrides[taskId] ?? available[index++ % available.length];
    if (!available.includes(agent)) throw Error('指定したエージェントを利用できません');
    return { taskId, agent, state: 'queued' };
  });
}

// A model's success message alone is not a verified task completion.
export function workOutcome(reply: WorkReply, mode: WorkRequest['mode']): WorkEntry['state'] {
  if (mode === 'decompose') return reply.result.status === 'completed' ? 'completed' : 'waiting';
  if (reply.taskDone) return 'completed';
  return reply.result.status === 'waiting' ? 'waiting' : 'partial';
}

export function matchesWorkSource(items: ItemMap, id: string, source: unknown): boolean {
  const item = items[id];
  if (!isLive(item) || !source || typeof source !== 'object') return false;
  const task = source as Record<string, unknown>;
  if (task.id !== id || task.text !== item.text || Boolean(task.done) !== item.done || Boolean(task.locked) !== Boolean(item.locked) ||
      (task.note ?? '') !== (item.note ?? '') || (task.completion_criteria ?? '') !== (item.completionCriteria ?? '') ||
      (task.due_date ?? '') !== (item.dueDate ?? '') || (task.due_time ?? '') !== (item.dueTime ?? '')) return false;
  const sourceAttachments = task.attachments as { id: string; text?: string; title?: string; revision?: number }[] | undefined;
  const attachments = liveAttachments(item.attachments);
  if ((sourceAttachments?.length ?? 0) !== attachments.length || attachments.some(attachment => {
    const remote = sourceAttachments?.find(value => value.id === attachment.id);
    return !remote || (attachment.text ?? '') !== (remote.text ?? '') || (attachment.revision ?? 0) !== (remote.revision ?? 0);
  })) return false;
  const children = childrenOf(items, id).filter(child => child.type === 'task');
  const subtasks = Array.isArray(task.subtasks) ? task.subtasks as { id: string }[] : [];
  return children.length === subtasks.length && children.every(child => matchesWorkSource(items, child.id, subtasks.find(value => value.id === child.id)));
}

export function applyWorkPlan(items: ItemMap, taskId: string, expectedUpdatedAt: number, result: WorkResult, agent: WorkAgent, now: number): ItemMap {
  const parent = items[taskId];
  if (!isLive(parent) || parent.type !== 'task' || parent.done || parent.filed || parent.updatedAt !== expectedUpdatedAt) throw Error('タスクが更新されました。最新の内容で再提案してください');
  if (result.status !== 'completed' || !result.steps.length || result.steps.length > 12) throw Error('反映できる分担案がありません');
  const children = childrenOf(items, taskId).filter(item => item.type === 'task');
  const steps = result.steps.map(step => {
    if (!step.text.trim() || step.text.length > 500 || !['ai', 'human', 'joint'].includes(step.owner) || step.note.length > 4000 || step.completionCriteria.length > 2000) throw Error('分担案の内容を確認してください');
    if (step.existingTaskId && !children.some(child => child.id === step.existingTaskId)) throw Error('既存サブタスクを確認してください');
    return { ...step, text: step.text.trim() };
  });
  const next = { ...items };
  const owners = { ai: 'AI', human: '人間', joint: '共同' };
  let order = children.length ? Math.max(...children.map(child => child.order)) + 1 : 0;
  const updatedIds = new Set<string>();
  for (const step of steps) {
    const existing = step.existingTaskId ? next[step.existingTaskId] : children.find(child => child.text.trim() === step.text);
    if (existing) {
      if (existing.done || updatedIds.has(existing.id)) throw Error('完了済み・重複したサブタスクの分担案を確認してください');
      updatedIds.add(existing.id);
      next[existing.id] = { ...existing, text: step.text, note: `担当: ${owners[step.owner]}${step.note ? `\n${step.note}` : ''}`, completionCriteria: step.completionCriteria || undefined, updatedAt: now };
      continue;
    }
    if (Object.values(next).some(child => isLive(child) && child.parentId === taskId && child.text.trim() === step.text)) throw Error('分担案のタスク名が重複しています');
    if (depthOf(items, taskId) + 1 > MAX_DEPTH) throw Error('これ以上深いサブタスクは作成できません');
    const id = newId();
    next[id] = { id, type: 'task', parentId: taskId, order: order++, text: step.text,
      note: `担当: ${owners[step.owner]}${step.note ? `\n${step.note}` : ''}`, completionCriteria: step.completionCriteria || undefined,
      done: false, createdBy: 'ai', createdByClient: agent === 'claude' ? 'Claude Code' : 'Codex', createdAt: now, updatedAt: now };
  }
  const text = `${result.summary}\n\n${steps.map(step => `### ${step.text}\n担当: ${owners[step.owner]}${step.existingTaskId ? `\n既存タスク: ${step.existingTaskId}` : ''}\n${step.note}\n完了条件: ${step.completionCriteria || '未設定'}`).join('\n\n')}`;
  const existing = liveAttachments(parent.attachments).find(attachment => attachment.kind === 'text' && attachment.title === 'タスクベース分担');
  let attachments;
  if (existing) {
    const updated = updateDocument(existing, { text, mode: 'replace', expectedRevision: existing.revision ?? 0 }, now);
    attachments = parent.attachments!.map(attachment => attachment.id === existing.id ? updated : attachment);
  } else {
    if (liveAttachments(parent.attachments).length >= MAX_ATTACHMENTS) throw Error('コンテキストの上限に達しています');
    const document = attachmentFrom({ text, title: 'タスクベース分担' }, 'ai', newId(), now);
    if (!document) throw Error('分担案を保存できません');
    attachments = [...(parent.attachments ?? []), document];
  }
  const error = contextStorageError(attachments);
  if (error) throw Error(error);
  next[taskId] = { ...parent, attachments, updatedAt: now };
  return next;
}
