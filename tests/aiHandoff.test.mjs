import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: ['src/lib/aiHandoff.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
const { buildTaskHandoff } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`
);

const task = {
  id: 'task-1', type: 'task', parentId: null, order: 0, text: 'Build the feature',
  note: 'Private working note', done: false, createdAt: 1, updatedAt: 1,
};

test('MCP handoff sends the ID but not a stale private snapshot', () => {
  const prompt = buildTaskHandoff(task, { [task.id]: task }, 'mcp');
  assert.match(prompt, /task_id "task-1"/);
  assert.match(prompt, /record_task_progress/);
  assert.doesNotMatch(prompt, /Private working note/);
  assert.match(prompt, /接続できない場合/);
});

test('text handoff carries a snapshot and discloses that it cannot sync', () => {
  const withFile = { ...task, attachments: [{ id: 'file-1', kind: 'file', title: 'notes.pdf', storageId: 'file-id', by: 'human', createdAt: 1 }] };
  const prompt = buildTaskHandoff(withFile, { [task.id]: withFile }, 'text');
  assert.match(prompt, /Private working note/);
  assert.match(prompt, /自動反映はできません/);
  assert.match(prompt, /ファイルの実体を渡せません/);
  assert.doesNotMatch(prompt, /task_id/);
});
