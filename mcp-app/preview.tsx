import { createRoot } from 'react-dom/client';
import { Picker, type PickerClient } from './Picker';
import type { Item } from '../src/lib/taskModel';
import '../src/index.css';
import './style.css';

// Development-only fixture, never an entry point in the single-file production build.
if (!import.meta.env.DEV) throw new Error('Preview is development-only');
const today = '2026-10-03';
const seed = { done: false, createdAt: 1, updatedAt: 1 };
const items: Item[] = [
  { ...seed, id: 'build', type: 'section', parentId: null, order: 0, text: 'bizencoreビルド', color: 'blue', note: '人間とAIが同じタスクリストで作業を進める。' },
  { ...seed, id: 'os', type: 'task', parentId: 'build', order: 0, text: 'bizencore OS', note: '毎日の作業とプロジェクトをまとめる。' },
  { ...seed, id: 'picker', type: 'task', parentId: 'os', order: 0, text: 'work_on_task：タスクを選んでAIに実行させる', assignedDate: today, dueDate: '2026-10-05', completionCriteria: '選択から作業と途中経過の記録まで一貫して使える。' },
  { ...seed, id: 'design', type: 'task', parentId: 'picker', order: 0, text: 'MCP Apps のデザインを本体と揃える', note: 'ラベル、階層、メモをそのまま表示する。' },
  { ...seed, id: 'cli', type: 'task', parentId: 'picker', order: 1, text: 'CLI のタスク選択を検証する', done: true, completedBy: 'ai' },
  { ...seed, id: 'mobile', type: 'task', parentId: 'os', order: 1, text: 'モバイルで詳細パネルを確認する', assignedDate: today },
  { ...seed, id: 'creative', type: 'section', parentId: null, order: 1, text: 'デザイン', color: 'violet', note: '公開するプロジェクトの世界観を整える。' },
  { ...seed, id: 'lp', type: 'task', parentId: 'creative', order: 0, text: 'LP のスクロールとカメラの動きを確認する', dueDate: '2026-10-02' },
  { ...seed, id: 'research', type: 'section', parentId: null, order: 2, text: 'リサーチ', color: 'green' },
  ...Array.from({ length: 12 }, (_, i): Item => ({ ...seed, id: `research-${i}`, type: 'task', parentId: 'research', order: i, text: `OSS アイデアの検討 ${i + 1}` })),
  { ...seed, id: 'filed', type: 'task', parentId: 'build', order: 3, text: '完了済みのタスク', done: true, filed: true },
];
const client: PickerClient = {
  connect: async () => {},
  page: async () => ({ items, today_date: today }),
  detail: async (id) => {
    const item = items.find((task) => task.id === id)!;
    return { id, text: item.text, note: item.note, done: item.done, due_date: item.dueDate, completion_criteria: item.completionCriteria,
      subtasks: items.filter((task) => task.parentId === id).map((task) => ({ id: task.id, text: task.text, done: task.done })),
      attachments: id === 'picker' ? [{ id: 'context', title: '設計メモ', kind: 'text', text: '最新の情報を読んで、十分なら作業。不十分なら相談してから着手する。' }] : [] };
  },
  send: async () => {},
  open: async () => {},
};
createRoot(document.getElementById('root')!).render(<Picker client={client} />);
