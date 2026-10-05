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
  assert.match(prompt, /Wait for the user's answer before implementation or task changes/);
});

test('text handoff carries a snapshot and discloses that it cannot sync', () => {
  const withFile = { ...task, attachments: [{ id: 'file-1', kind: 'file', title: 'notes.pdf', storageId: 'file-id', by: 'human', createdAt: 1 }] };
  const prompt = buildTaskHandoff(withFile, { [task.id]: withFile }, 'text');
  assert.match(prompt, /Private working note/);
  assert.match(prompt, /自動反映はできません/);
  assert.match(prompt, /ファイルの実体を渡せません/);
  assert.doesNotMatch(prompt, /task_id/);
  assert.match(prompt, /Then ask one focused question/);
  assert.match(prompt, /Wait for the user's answer before implementation or task changes/);
});

test('text handoff discloses a locked persistent container rather than inviting its completion', () => {
  const locked = { ...task, locked: true };
  const prompt = buildTaskHandoff(locked, { [locked.id]: locked }, 'text');
  assert.match(prompt, /ロック: 完了不可/);
});

for (const mode of ['mcp', 'text']) {
  test(`${mode} consultation handoff carries confirmed intent without authorizing implementation`, () => {
    const prompt = buildTaskHandoff(task, { [task.id]: task }, mode, 'consult');
    assert.match(prompt, /検討・相談/);
    assert.match(prompt, /explicitly selected "検討する"/);
    assert.match(prompt, /without implementing/);
    assert.match(prompt, /only after the user later explicitly agrees/);
    assert.match(prompt, /Do not ask whether they want consultation or execution again/);
    assert.doesNotMatch(prompt, /Then ask one focused question|今回どう進めたいか確認/);
    if (mode === 'mcp') {
      assert.match(prompt, /task_id "task-1"/);
      assert.match(prompt, /attach_context|record_task_progress/);
      assert.doesNotMatch(prompt, /Private working note/);
    } else {
      assert.match(prompt, /Private working note/);
      assert.match(prompt, /自動反映はできません/);
      assert.doesNotMatch(prompt, /work_on_task tool with task_id/);
    }
  });

  test(`${mode} execution handoff proceeds while retaining clarification, verification and locks`, () => {
    const locked = { ...task, locked: true };
    const prompt = buildTaskHandoff(locked, { [task.id]: locked }, mode, 'execute');
    assert.match(prompt, /explicitly selected "実行する"/);
    assert.match(prompt, /Do the actual work within the agreed scope/);
    assert.match(prompt, /only when essential information is missing/);
    assert.match(prompt, /Verify the outcome against the completion criteria/);
    assert.doesNotMatch(prompt, /Then ask one focused question|今回どう進めたいか確認/);
    assert.match(prompt, mode === 'mcp' ? /do not complete them or try to unlock them/ : /ロック: 完了不可/);
  });
}
