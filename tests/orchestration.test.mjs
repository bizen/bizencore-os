import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { checkOrchestration, orchestrationPrompt, reviewOrchestration } from '../desktop/electron/orchestration.mjs';
import { agentLaunchArgs } from '../desktop/electron/agent-launch.mjs';

test('interactive orchestration accepts only a selected task and bounded clarification', () => {
  assert.deepEqual(checkOrchestration({ taskId: 'task-1' }), { taskId: 'task-1', reply: '' });
  for (const value of [{ taskId: '--bad;sh' }, { taskId: 'task', reply: 'x'.repeat(8001) }, { taskId: 'task', reply: '\0' }, { taskId: 'task', policy: { all: true } }]) assert.throws(() => checkOrchestration(value));
});
test('normal CLI launch is interactive, not exec/print/json transport', () => {
  const prompt = orchestrationPrompt('task-1', 'Please check the earlier change.');
  for (const agent of ['codex', 'claude']) {
    const args = agentLaunchArgs(agent, { taskId: 'task-1', prompt, mode: 'mcp', intent: 'execute' });
    assert.equal(args.at(-1), prompt);
    assert.ok(!args.some(value => ['exec', '-p', '--json', '--dangerously-skip-permissions', '--yolo'].includes(value)));
  }
  assert.match(prompt, /wait for the user's reply/);
  assert.match(prompt, /Never unlock|never unlock/);
  assert.match(prompt, /Do not choose or start the next/);
  assert.match(prompt, /Read its latest data/);
});
test('only latest MCP completion of the entire unlocked subtree allows auto progression', () => {
  const task = { id: 'a', done: true, subtasks: [{ id: 'b', done: true }] };
  assert.equal(reviewOrchestration(task, ['a', 'b']).taskDone, true);
  for (const patch of [{ done: false }, { locked: true }, { subtasks: [{ id: 'b', done: false }] }, { subtasks: [{ id: 'b', done: true, locked: true }] }]) {
    const reply = reviewOrchestration({ ...task, ...patch }, ['a', 'b']);
    assert.equal(reply.taskDone, false); assert.equal(reply.result.status, 'partial');
  }
  assert.throws(() => reviewOrchestration(task, ['a']), /実行範囲/);
});
test('native orchestration is bound to account generation, actual task scope and owned PTY', async () => {
  const main = await readFile(new URL('../desktop/electron/main.mjs', import.meta.url), 'utf8');
  assert.match(main, /desktopMcp\.issue\(id, agent, work \? \{ taskIds: workIds, readOnly: false \}/);
  const review = main.slice(main.indexOf("command('task-review'"), main.indexOf("command('start'"));
  assert.match(review, /sameAccess\(event, binding.generation\)/);
  assert.match(review, /orchestrations.get\(id\) !== binding/);
  assert.match(review, /latest.task.id !== binding.taskId/);
  assert.match(review, /binding.controller.signal/);
  assert.match(main, /orchestrations.clear\(\)/);
  assert.match(main, /return stopSession\(id\)/);
});
