import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createTaskStartRequests } from '../desktop/electron/task-start-requests.mjs';
const { outputFiles } = await build({ entryPoints: ['desktop/task-assignments.ts'], bundle: true, write: false, format: 'esm' });
const { addAssignment } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
const assignment = taskId => ({ taskId, intent: 'consult', mode: 'mcp' });

test('a pane can acquire up to three tasks, update intent at capacity and release one independently', () => {
  let panes = [{ id: 'pane', busy: true }, { id: 'other', assignments: [assignment('elsewhere')] }];
  for (const id of ['a', 'b', 'c']) panes = addAssignment(panes, 'pane', assignment(id));
  assert.deepEqual(panes[0].assignments.map(value => value.taskId), ['a', 'b', 'c']);
  const original = structuredClone(panes);
  assert.throws(() => addAssignment(panes, 'pane', assignment('d')), /3件/);
  assert.throws(() => addAssignment(panes, 'pane', assignment('elsewhere')), /別のペイン/);
  assert.throws(() => addAssignment(panes, 'closed', assignment('d')), /閉じられ/);
  assert.deepEqual(panes, original, 'failed additions never replace existing tasks');
  panes = addAssignment(panes, 'pane', { ...assignment('b'), intent: 'execute' });
  assert.equal(panes[0].assignments.length, 3);
  assert.equal(panes[0].assignments[1].intent, 'execute');
  panes[0].assignments = panes[0].assignments.filter(value => value.taskId !== 'a');
  assert.deepEqual(addAssignment(panes, 'pane', assignment('d'))[0].assignments.map(value => value.taskId), ['b', 'c', 'd']);
});

test('start requests require acknowledgement and reject renderer errors, timeout and ended connections', async () => {
  const requests = [];
  const broker = createTaskStartRequests(request => requests.push(request), 30);
  const controller = new AbortController();
  const first = broker.request('pane', assignment('a'), controller.signal);
  assert.equal(requests[0].paneId, 'pane');
  broker.reply(requests[0].requestId, null);
  assert.deepEqual(await first, { assigned: true, task_id: 'a' });
  const second = broker.request('pane', assignment('b'), controller.signal);
  broker.reply(requests[1].requestId, '担当タスクは3件までです');
  await assert.rejects(second, /3件/);
  await assert.rejects(broker.request('pane', assignment('c'), controller.signal), /反映を確認/);
  const fourth = broker.request('pane', assignment('d'), controller.signal);
  controller.abort();
  await assert.rejects(fourth, /接続は終了/);
  broker.reply(requests[3].requestId, null);
  await assert.rejects(broker.request('pane', assignment('d'), controller.signal), /接続は終了/);
});
