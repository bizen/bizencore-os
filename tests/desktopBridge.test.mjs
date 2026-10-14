import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../desktop/bridge.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const calls = [];
const listeners = new Set();
globalThis.window = { bizencoreDesktop: {
  agents: async () => [{ id: 'codex', name: 'Codex', path: '/mock/codex' }],
  start: async args => { calls.push(args); return 123; },
  onEvent: callback => { listeners.add(callback); return () => listeners.delete(callback); },
  openExternal: async url => { calls.push(url); },
} };
const bridge = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

test('resume uses a specific UUID and never passes the old handoff', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const session = '22222222-2222-4222-8222-222222222222';
  await bridge.start(id, 'codex', '/project', 80, 24, () => {}, { taskId: 'task', prompt: 'old', intent: 'execute', mode: 'text' }, session);
  assert.equal(calls.at(-1).resumeSessionId, session);
  assert.equal(Object.hasOwn(calls.at(-1), 'handoff'), false);
  for (const callback of listeners) callback(id, { kind: 'exit', code: 0 });
  assert.equal(listeners.size, 0);
  await assert.rejects(bridge.start(id, 'codex', '/project', 80, 24, () => {}, undefined, 'latest'), /会話ID/);
  await bridge.start(id, 'codex', '/project', 80, 24, () => {});
  assert.equal(Object.hasOwn(calls.at(-1), 'resumeSessionId'), false, 'new is the default');
});

test('optional APIs degrade cleanly and external links require web schemes', async () => {
  await assert.rejects(bridge.taskReview('pane'), /オーケストレーション/);
  assert.deepEqual(await bridge.agentDiagnostics(), [{ id: 'codex', name: 'Codex', path: '/mock/codex', version: null }]);
  assert.doesNotThrow(() => bridge.onFocusPane(() => {})());
  assert.doesNotThrow(() => bridge.onResume(() => {})());
  await assert.rejects(bridge.conversations('codex', '/project'), /会話履歴/);
  await assert.rejects(bridge.openExternal('file:///secret'), /Webリンク/);
  await assert.rejects(bridge.openExternal('https://name:password@example.com'), /Webリンク/);
  await assert.rejects(bridge.openExternal('javascript:alert(1)'), /Webリンク/);
  await bridge.openExternal('https://example.com');
  assert.equal(calls.at(-1), 'https://example.com');
});

test('interactive orchestration passes an ID, never a copied prompt or resume session', async () => {
  const id = '33333333-3333-4333-8333-333333333333';
  await bridge.start(id, 'claude', '/project', 80, 24, () => {}, undefined, undefined, { taskId: 'task-1', reply: '' });
  assert.deepEqual(calls.at(-1).orchestration, { taskId: 'task-1', reply: '' });
  assert.equal(Object.hasOwn(calls.at(-1), 'handoff'), false);
  assert.equal(Object.hasOwn(calls.at(-1), 'resumeSessionId'), false);
  await assert.rejects(bridge.start(id, 'claude', '/project', 80, 24, () => {}, { taskId: 'task', mode: 'text', intent: 'execute', prompt: 'snapshot' }, undefined, { taskId: 'task-1', reply: '' }), /専用セッション/);
});

test('notification payloads respect native title and body bounds', async () => {
  window.bizencoreDesktop.notify = async value => { calls.push(value); };
  await bridge.notify({ paneId: 'pane', title: 't'.repeat(161), body: 'b'.repeat(501) });
  assert.equal(calls.at(-1).title.length, 160);
  assert.equal(calls.at(-1).body.length, 500);
});
