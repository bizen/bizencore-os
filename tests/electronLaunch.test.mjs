import assert from 'node:assert/strict';
import test from 'node:test';
import { agentLaunchArgs, allocateAgentSession } from '../desktop/electron/agent-launch.mjs';

const handoff = { taskId: '370b6a1f-e4be-4e60-8bb8-8295a4f77e04', intent: 'execute', mode: 'mcp', prompt: '日本語\n--dangerously-bypass-approvals-and-sandbox $(touch unwanted)' };

test('legacy task IDs remain handoff data while control, path and oversized IDs are rejected', () => {
  assert.equal(agentLaunchArgs('codex', { ...handoff, taskId: 'm5c12abc-k7x2v8mn' }).at(-1), handoff.prompt);
  for (const taskId of ['x'.repeat(129), '../task', 'task\nid', 'bad\0id']) {
    assert.throws(() => agentLaunchArgs('codex', { ...handoff, taskId }), /Invalid task handoff/);
  }
});

test('Claude new launches allocate a UUID before spawn; Codex has no unsupported session-id flag', () => {
  const session = allocateAgentSession('claude');
  assert.match(session.sessionId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(session.args, ['--session-id', session.sessionId]);
  assert.deepEqual([...session.args, ...agentLaunchArgs('claude', handoff)], ['--session-id', session.sessionId, '--', handoff.prompt]);
  assert.notEqual(session.sessionId, allocateAgentSession('claude').sessionId);
  assert.deepEqual(allocateAgentSession('codex'), { sessionId: null, args: [] });
  assert.throws(() => allocateAgentSession('shell'), /Unsupported agent/);
});
test('Task handoff is a single positional CLI argument, never a shell command or option', () => {
  assert.deepEqual(agentLaunchArgs('claude', handoff), ['--', handoff.prompt]);
  assert.deepEqual(agentLaunchArgs('codex', handoff), ['--no-alt-screen', '--no-daemon', '--', handoff.prompt]);
  assert.deepEqual(agentLaunchArgs('claude'), []);
  assert.deepEqual(agentLaunchArgs('codex'), ['--no-alt-screen', '--no-daemon']);
});
test('Invalid, oversized, empty and NUL-containing handoffs are rejected', () => {
  for (const patch of [{ taskId: '' }, { intent: 'unknown' }, { mode: 'unknown' }, { prompt: '' }, { prompt: 'x\0y' }, { prompt: '日'.repeat(24000) }]) {
    assert.throws(() => agentLaunchArgs('codex', { ...handoff, ...patch }));
  }
  assert.throws(() => agentLaunchArgs('shell', handoff));
  assert.throws(() => agentLaunchArgs('codex', null));
});

test('resume uses native UUID syntax, retains Codex isolation flags and never repeats handoff', () => {
  const sessionId = '01a0eb80-b9ad-7a81-ba31-31e2da8c4ed6';
  assert.deepEqual(agentLaunchArgs('claude', handoff, sessionId), ['--resume', sessionId]);
  assert.deepEqual(agentLaunchArgs('codex', handoff, sessionId), ['--no-alt-screen', '--no-daemon', 'resume', sessionId]);
  assert.deepEqual(agentLaunchArgs('claude', null, sessionId), ['--resume', sessionId]);
  for (const id of ['', null, '--last', '../session', sessionId + '\n', 'x'.repeat(36), '00000000-0000-0000-0000-000000000000']) {
    assert.throws(() => agentLaunchArgs('codex', handoff, id), /Invalid resume session ID/);
  }
});

test('explicit new Claude UUID precedes the handoff delimiter and cannot combine with resume', () => {
  const id = allocateAgentSession('claude').sessionId;
  assert.deepEqual(agentLaunchArgs('claude', handoff, undefined, id), ['--session-id', id, '--', handoff.prompt]);
  assert.deepEqual(agentLaunchArgs('claude', undefined, undefined, id), ['--session-id', id]);
  assert.throws(() => agentLaunchArgs('claude', handoff, id, id), /Cannot resume/);
  assert.throws(() => agentLaunchArgs('codex', undefined, undefined, id), /Invalid new/);
  assert.throws(() => agentLaunchArgs('claude', undefined, undefined, '--last'), /Invalid new/);
});
