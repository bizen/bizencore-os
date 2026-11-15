import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { checkWorkRequest, checkWorkScope, createTaskOperationGuard, parseWorkResult, runTaskProcess, taskTreeIds, workLaunchArgs, workPrompt } from '../desktop/electron/task-runner.mjs';

const compiled = await build({ entryPoints: ['src/lib/taskTools.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { selectedRoots, assignWork, workOutcome, applyWorkPlan, matchesWorkSource } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`);
const item = (id, parentId = null, text = id) => ({ id, parentId, text, type: 'task', order: 0, done: false, createdAt: 1, updatedAt: 1 });
const items = { a: item('a'), b: item('b', 'a'), c: item('c'), done: { ...item('done'), done: true }, label: { ...item('label'), type: 'section' } };
const result = () => ({ status: 'completed', summary: '分担方針', questions: [], steps: [{ text: '新しい成果物', owner: 'ai', existingTaskId: '', note: '必要な内容', completionCriteria: '成果物を検証する' }] });

test('cancelled quit preserves started operation checks while pending launches stay cancelled', () => {
  const controller = new AbortController();
  let launchAllowed = true, authorized = true, accessChecks = 0;
  const options = { signal: controller.signal,
    validateAccess: () => { accessChecks++; if (!authorized) throw Error('Access expired'); },
    launchGuard: () => { if (!launchAllowed) throw Error('Launch cancelled'); },
  };
  const running = createTaskOperationGuard(options);
  const pending = createTaskOperationGuard(options);
  running.markStarted();
  launchAllowed = false;
  assert.doesNotThrow(running.check);
  assert.throws(pending.check, /Launch cancelled/);
  assert.throws(pending.markStarted, /Launch cancelled/);
  assert.throws(pending.check, /Launch cancelled/);
  authorized = false;
  assert.throws(running.check, /Access expired/);
  authorized = true;
  controller.abort();
  assert.throws(running.check, /実行を停止/);
  assert.throws(running.markStarted, /実行を停止/);
  assert.ok(accessChecks >= 8);
});

test('cross-label scope deduplicates overlapping parent and child selections without selecting labels or completed tasks', () => {
  assert.deepEqual(selectedRoots(items, ['b', 'c', 'a', 'c', 'label', 'done', 'missing']), ['c', 'a']);
  assert.deepEqual(selectedRoots(items, ['c', 'b']), ['c', 'b']);
  assert.deepEqual(selectedRoots({ a: item('a', 'b'), b: item('b', 'a') }, ['a']), []);
});
test('assignment supports both providers, alternates unassigned work and respects explicit choices', () => {
  assert.deepEqual(assignWork(['a', 'b', 'c'], ['codex', 'claude']).map(entry => entry.agent), ['codex', 'claude', 'codex']);
  assert.deepEqual(assignWork(['a', 'b', 'c'], ['codex', 'claude'], { a: 'claude' }).map(entry => entry.agent), ['claude', 'codex', 'claude']);
  assert.throws(() => assignWork(['a'], [], {}));
  assert.throws(() => assignWork(['a'], ['codex'], { a: 'claude' }));
});
test('process success does not mark an unverified task complete, while decomposition never checks the task', () => {
  assert.equal(workOutcome({ result: result(), taskDone: false }, 'execute'), 'partial');
  assert.equal(workOutcome({ result: result(), taskDone: true }, 'execute'), 'completed');
  assert.equal(workOutcome({ result: { ...result(), status: 'waiting' }, taskDone: false }, 'execute'), 'waiting');
  assert.equal(workOutcome({ result: result(), taskDone: false }, 'decompose'), 'completed');
});
test('approved decomposition is atomic, preserves locks and reuses existing children and one document', () => {
  const original = { ...items, a: { ...items.a, locked: true } };
  const plan = { ...result(), steps: [...result().steps, { text: 'Existing improved', existingTaskId: 'b', owner: 'human', note: '本人が選ぶ', completionCriteria: '本人が決定した' }] };
  const next = applyWorkPlan(original, 'a', 1, plan, 'codex', 2);
  assert.equal(original.a.attachments, undefined);
  assert.equal(next.a.locked, true); assert.equal(next.a.done, false);
  assert.equal(next.b.text, 'Existing improved'); assert.match(next.b.note, /担当: 人間/);
  const created = Object.values(next).find(value => value.text === '新しい成果物');
  assert.equal(created.createdBy, 'ai'); assert.equal(created.createdByClient, 'Codex');
  const document = next.a.attachments[0];
  const again = applyWorkPlan(next, 'a', 2, plan, 'claude', 3);
  assert.equal(Object.keys(next).length, Object.keys(again).length);
  assert.equal(again.a.attachments.length, 1); assert.equal(again.a.attachments[0].id, document.id);
  assert.equal(again.a.attachments[0].revision, 1);
  assert.throws(() => applyWorkPlan(next, 'a', 1, plan, 'codex', 4), /更新/);
  assert.throws(() => applyWorkPlan(original, 'a', 1, { ...plan, steps: [{ ...plan.steps[0], existingTaskId: 'c' }] }, 'codex', 3), /既存/);
});
test('source comparison notices changed descendants, context, deadlines and completion conditions', () => {
  const source = { id: 'a', text: 'a', done: false, subtasks: [{ id: 'b', text: 'b', done: false }] };
  assert.equal(matchesWorkSource(items, 'a', source), true);
  for (const change of [{ note: 'changed' }, { dueDate: '2026-10-13' }, { completionCriteria: 'changed' }, { text: 'changed' }]) {
    assert.equal(matchesWorkSource({ ...items, b: { ...items.b, ...change } }, 'a', source), false);
  }
  assert.equal(matchesWorkSource({ ...items, b: { ...items.b, attachments: [{ id: 'doc', kind: 'text', by: 'ai', text: 'x' }] } }, 'a', source), false);
});
test('native capability denies all planning writes and all unrelated or scope-expanding execution writes', () => {
  const read = { taskIds: ['a', 'b'], readOnly: true };
  checkWorkScope(read, 'get', { taskId: 'a' });
  for (const operation of ['complete', 'attach', 'record-progress', 'delete', 'add', 'move', 'list']) assert.throws(() => checkWorkScope(read, operation, { taskId: 'a' }));
  const write = { ...read, readOnly: false };
  checkWorkScope(write, 'record-progress', { taskId: 'a', completedSubtaskIds: ['b'], remainingSubtasks: [] });
  assert.throws(() => checkWorkScope(write, 'complete', { taskId: 'c' }), /範囲外/);
  assert.throws(() => checkWorkScope(write, 'record-progress', { taskId: 'a', completedSubtaskIds: ['c'] }));
  assert.throws(() => checkWorkScope(write, 'record-progress', { taskId: 'a', remainingSubtasks: [{ text: 'new' }] }));
  for (const operation of ['add', 'delete', 'move', 'update']) assert.throws(() => checkWorkScope(write, operation, { taskId: 'a' }));
  assert.deepEqual(taskTreeIds({ id: 'a', subtasks: [{ id: 'b' }] }), ['a', 'b']);
});
test('native requests and model results are bounded and never opt into bypassing permissions', () => {
  assert.throws(() => checkWorkRequest({ id: 'valid', taskId: 'a', cwd: '/tmp', agent: 'other', mode: 'execute', reply: '' }));
  assert.throws(() => parseWorkResult({ ...result(), status: 'done' }));
  assert.throws(() => parseWorkResult({ ...result(), extra: 'untrusted' }));
  assert.throws(() => parseWorkResult({ ...result(), steps: Array(13).fill(result().steps[0]) }));
  assert.match(workPrompt('a', 'decompose'), /NOT execution permission/);
  assert.match(workPrompt('a', 'execute'), /Do not perform task-based decomposition as a prerequisite/);
  for (const agent of ['claude', 'codex']) for (const mode of ['execute', 'decompose']) {
    const args = workLaunchArgs(agent, mode, '/tmp/schema');
    assert.doesNotMatch(args.join(' '), /bypassPermissions|danger-full-access|dangerously-/);
  }
  assert.ok(workLaunchArgs('codex', 'decompose', '/tmp/schema').includes('read-only'));
  assert.ok(workLaunchArgs('codex', 'execute', '/tmp/schema').includes('--skip-git-repo-check'));
  assert.ok(workLaunchArgs('claude', 'execute', '/tmp/schema').includes('--restricted'));
  const claudeArgs = workLaunchArgs('claude', 'execute', '/tmp/schema');
  const schema = JSON.parse(claudeArgs[claudeArgs.indexOf('--json-schema') + 1]);
  assert.equal(schema.$schema, 'http://json-schema.org/draft-07/schema#');
  assert.equal(schema.additionalProperties, false);
  const allowed = claudeArgs[claudeArgs.indexOf('--allowedTools') + 1].split(',');
  assert.ok(allowed.includes('mcp__bizencore__complete_task'));
  assert.ok(!allowed.includes('Bash'));
  const planArgs = workLaunchArgs('claude', 'decompose', '/tmp/schema');
  assert.equal(planArgs[planArgs.indexOf('--allowedTools') + 1], 'mcp__bizencore__work_on_task,mcp__bizencore__get_task');
});

test('real shell-free process transport validates Claude structured results and cleans up on cancellation', async () => {
  const controller = new AbortController();
  const children = new Map();
  const stopProcess = async pid => { const child = children.get(pid); if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); };
  const spawnProcess = (_file, args, options) => {
    assert.equal(options.shell, false);
    const child = spawn(process.execPath, ['-e', `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(${JSON.stringify(JSON.stringify({ structured_output: result() }))})})`], options);
    children.set(child.pid, child); return child;
  };
  const reply = await runTaskProcess({ executable: '/fixture/claude', args: [], agent: 'claude', mode: 'decompose', taskId: 'a', reply: '', cwd: process.cwd(), env: process.env, signal: controller.signal, stopProcess, spawnProcess });
  assert.deepEqual(reply, result());
  const pending = new AbortController();
  await assert.rejects(runTaskProcess({ executable: '/fixture/claude', args: [], agent: 'claude', mode: 'execute', taskId: 'a', reply: '', cwd: process.cwd(), env: process.env, signal: pending.signal, stopProcess,
    spawnProcess: (_file, _args, options) => { const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], options); children.set(child.pid, child); return child; },
    onSpawn: async () => pending.abort(),
  }), /停止/);
});

test('Codex output-file transport uses a fresh result, not stdout prose', async () => {
  let child;
  const stopProcess = async () => { if (child?.exitCode === null && child?.signalCode === null) child.kill('SIGTERM'); };
  const reply = await runTaskProcess({ executable: '/fixture/codex', args: ['-c', 'features.apps=false', '-c', 'mcp_servers.bizencore={enabled=true}'], agent: 'codex', mode: 'execute', taskId: 'a', reply: '', cwd: process.cwd(), env: process.env, signal: new AbortController().signal, stopProcess,
    spawnProcess: (_file, args, options) => {
      assert.deepEqual(args.slice(0, 6), ['--no-daemon', 'exec', '-c', 'features.apps=false', '-c', 'mcp_servers.bizencore={enabled=true}']);
      const output = args[args.indexOf('--output-last-message') + 1];
      child = spawn(process.execPath, ['-e', `process.stdin.resume();process.stdin.on('end',()=>{require('node:fs').writeFileSync(${JSON.stringify(output)},${JSON.stringify(JSON.stringify({ ...result(), steps: [] }))});console.log('not the result')})`], options); return child;
    },
  });
  assert.equal(reply.status, 'completed'); assert.deepEqual(reply.steps, []);
});
