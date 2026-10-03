import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const result = await build({ entryPoints: ['src/lib/taskWorkPrompt.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { TASK_PICKER_PENDING, TASK_START_INSTRUCTIONS, workOnTaskInstructions } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);

test('selection instructions prioritize Apps, native forms, then numbered text lists', () => {
  const prompt = workOnTaskInstructions();
  const apps = prompt.indexOf('1. MCP Apps picker');
  const form = prompt.indexOf('2. Native selection form');
  const numbers = prompt.indexOf('3. Numbered text lists');
  assert.ok(apps >= 0 && form > apps && numbers > form);
  assert.match(prompt, /Do not call the no-ID work_on_task form or show a competing text list/);
  assert.match(prompt, /lack of a task ID yet.*does not mean that MCP Apps failed/);
  assert.match(prompt, /cancelled selection alone is not evidence/);
  assert.match(prompt, /First ask for a label and wait for the user's label choice; only then show tasks belonging to that label/);
  assert.match(prompt, /Wait for the user's number\. Then call list_tasks for that label/);
  assert.match(prompt, /Retain the exact number-to-ID mapping/);
  assert.match(prompt, /next_offset/);
  assert.match(prompt, /unnumbered bullet list is not/);
  assert.match(prompt, /Authentication or data-loading failures are not UI capability failures/);
});
test('picker response is explicitly pending rather than inviting competing selectors', () => {
  assert.equal(TASK_PICKER_PENDING.selection_status, 'awaiting_user');
  assert.equal(TASK_PICKER_PENDING.next_action, 'wait_for_user_selection');
  assert.match(TASK_PICKER_PENDING.message, /選択待ちは表示失敗ではありません/);
  assert.match(TASK_PICKER_PENDING.message, /別の一覧を出したりしない/);
  assert.match(TASK_PICKER_PENDING.message, /フォームも使えない場合に限り/);
  assert.match(TASK_PICKER_PENDING.message, /番号リスト/);
});
test('exact-ID handoff and fresh task results never restart selection', () => {
  const id = workOnTaskInstructions('task-1');
  assert.match(id, /task_id "task-1"/);
  assert.doesNotMatch(id, /open_task_picker|Numbered text lists/);
  const latest = workOnTaskInstructions('task-1', true);
  assert.match(latest, /latest task details are already included/);
  assert.doesNotMatch(latest, /open_task_picker|Numbered text lists/);
  assert.match(latest, /record_task_progress/);
});

test('every work entry point summarizes the task and waits for intent even with sufficient information', () => {
  for (const prompt of [workOnTaskInstructions(), workOnTaskInstructions('task-1'), workOnTaskInstructions('task-1', true)]) {
    assert.ok(prompt.includes(TASK_START_INSTRUCTIONS));
    assert.ok(prompt.indexOf('First give a concise overview') < prompt.indexOf('Then ask one focused question'));
    assert.match(prompt, /goal, current state, verified completed work, remaining work, and important uncertainties/);
    assert.match(prompt, /Wait for the user's answer before implementation or task changes, even when the task information is sufficient/);
    assert.match(prompt, /Accept free-form answers/);
    assert.match(prompt, /Selecting a task, calling work_on_task, or a generic handoff.*is not an answer/);
    assert.doesNotMatch(prompt, /Then do the actual work; do not stop after selecting/);
  }
});

test('consultation does not imply execution and refreshing the task preserves the answered intent', () => {
  assert.match(TASK_START_INSTRUCTIONS, /retain that intent across re-reads and do not ask the same opening question again/);
  assert.match(TASK_START_INSTRUCTIONS, /If they want execution, do the actual work within the agreed scope/);
  assert.match(TASK_START_INSTRUCTIONS, /without implementing; begin implementation only after they ask or agree to start execution/);
  assert.match(TASK_START_INSTRUCTIONS, /Do not treat a settled design or sufficient information alone as permission/);
  assert.match(TASK_START_INSTRUCTIONS, /Do not record progress or add subtasks merely because you are waiting for this initial intent answer/);
});
