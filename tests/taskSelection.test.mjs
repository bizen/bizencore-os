import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const result = await build({ entryPoints: ['src/lib/taskWorkPrompt.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { TASK_PICKER_PENDING, workOnTaskInstructions } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);

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
