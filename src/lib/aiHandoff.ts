import { attachmentLabel, liveAttachments } from './attachments';
import { childrenOf, isLive, type Item, type ItemMap } from './taskModel';

/**
 * タスクを AI に渡すための指示文。本文・ラベル・親タスク・メモ・サブタスクを
 * ひとまとめにする。Web の AI には URL で、CLI の AI にはコマンドで渡す。
 */
export function buildTaskPrompt(item: Item, items: ItemMap): string {
  const lines = ['次のタスクを進めるのを手伝ってください。', '', `タスク: ${item.text.trim() || '（無題）'}`];

  const parents: string[] = [];
  let label: string | undefined;
  let parent = item.parentId ? items[item.parentId] : undefined;
  while (isLive(parent)) {
    if (parent.type === 'section') {
      label = parent.text.trim() || undefined;
      break;
    }
    parents.unshift(parent.text.trim() || '（無題）');
    parent = parent.parentId ? items[parent.parentId] : undefined;
  }
  if (label) lines.push(`ラベル: ${label}`);
  if (parents.length > 0) lines.push(`親タスク: ${parents.join(' › ')}`);

  if (item.note?.trim()) lines.push('', 'メモ:', item.note.trim());
  if (item.dueDate) lines.push(`期限: ${item.dueDate}${item.dueTime ? ` ${item.dueTime}` : ''}`);
  if (item.completionCriteria?.trim()) lines.push('', '完了条件:', item.completionCriteria.trim());

  const subtasks = childrenOf(items, item.id).filter((child) => child.type === 'task');
  if (subtasks.length > 0) {
    lines.push('', 'サブタスク:');
    for (const sub of subtasks) lines.push(`- [${sub.done ? 'x' : ' '}] ${sub.text.trim() || '（無題）'}`);
  }

  const attachments = liveAttachments(item.attachments);
  if (attachments.length > 0) {
    lines.push('', 'コンテキスト:');
    for (const att of attachments) {
      if (att.kind === 'link') {
        lines.push(`- ${attachmentLabel(att)}: ${att.url}`);
      } else if (att.kind === 'file') {
        lines.push(`- ファイル: ${attachmentLabel(att)}（MCP の list_tasks から参照）`);
      } else if (att.title) {
        lines.push(`- ${att.title}`, ...(att.text ?? '').split('\n').map((line) => `  > ${line}`));
      } else {
        // タイトルがなければ名前は1行目と同じなので、本文だけを載せる
        const [first, ...rest] = (att.text ?? '').split('\n');
        lines.push(`- ${first}`, ...rest.map((line) => `  ${line}`));
      }
    }
  }

  return lines.join('\n');
}

/** シェルにそのまま貼れるよう、単一引用符で囲む */
function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export type AiTarget =
  | { id: string; name: string; kind: 'open'; url: (prompt: string) => string }
  | { id: string; name: string; kind: 'copy'; command: (prompt: string) => string };

/** Web の AI は指示文を入れた新しい会話を開き、CLI の AI は起動コマンドをコピーする */
export const AI_TARGETS: AiTarget[] = [
  { id: 'claude', name: 'Claude', kind: 'open', url: (p) => `https://claude.ai/new?q=${encodeURIComponent(p)}` },
  { id: 'chatgpt', name: 'ChatGPT', kind: 'open', url: (p) => `https://chatgpt.com/?q=${encodeURIComponent(p)}` },
  { id: 'claude-code', name: 'Claude Code', kind: 'copy', command: (p) => `claude ${shellQuote(p)}` },
  { id: 'codex', name: 'Codex', kind: 'copy', command: (p) => `codex ${shellQuote(p)}` },
];
