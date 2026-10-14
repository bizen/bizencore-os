import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../desktop/workspace-state.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { normalizeWorkspace, workspaceKey, readWorkspace, writeWorkspace } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const paneId = '11111111-1111-4111-8111-111111111111';
const taskId = '22222222-2222-4222-8222-222222222222';
const state = () => ({ version: 1, panes: [{ id: paneId, agent: 'codex', cwd: '/test/project', assignment: { taskId, intent: 'execute', mode: 'mcp' }, busy: true, sentAt: 123, token: 'do-not-save' }], width: 50, inspectorWidth: 330, expanded: false });

test('workspace preserves assignments and layout but never executable state, terminal content or credentials', () => {
  const saved = normalizeWorkspace(state());
  assert.deepEqual(saved.panes[0], { id: paneId, agent: 'codex', cwd: '/test/project', assignment: { taskId, intent: 'execute', mode: 'mcp' } });
  assert.equal(saved.width, 50);
  assert.equal(saved.inspectorWidth, 330);
  assert.ok(!JSON.stringify(saved).includes('do-not-save'));
  assert.equal(saved.panes[0].busy, undefined);
  assert.equal(saved.panes[0].sentAt, undefined);
  assert.equal(normalizeWorkspace({ ...state(), panes: [{ ...state().panes[0], launchRequested: true }] }).panes[0].launchRequested, undefined);
});

test('layout is backward compatible and an empty workspace never restores agent expansion', () => {
  assert.equal(normalizeWorkspace(state()).layout, 'grid');
  assert.equal(normalizeWorkspace({ ...state(), layout: 'tabs' }).layout, 'tabs');
  assert.equal(normalizeWorkspace({ ...state(), layout: 'invalid' }).layout, 'grid');
  assert.equal(normalizeWorkspace({ ...state(), panes: [], expanded: true }).expanded, false);
});

test('a specific resume session and label survive storage without requesting a launch', () => {
  const saved = normalizeWorkspace({ ...state(), panes: [{ ...state().panes[0], labelId: 'label-one', resumeSessionId: taskId, launchRequested: true }] });
  assert.equal(saved.panes[0].resumeSessionId, taskId);
  assert.equal(saved.panes[0].labelId, 'label-one');
  assert.equal(saved.panes[0].launchRequested, undefined);
  for (const resumeSessionId of ['latest', '', '../session', 'bad\0id', 42]) {
    assert.equal(normalizeWorkspace({ ...state(), panes: [{ ...state().panes[0], resumeSessionId }] }).panes[0].resumeSessionId, undefined);
  }
  assert.equal(normalizeWorkspace({ ...state(), panes: [{ ...state().panes[0], cwd: '', resumeSessionId: taskId }] }).panes[0].resumeSessionId, undefined);
});

test('last used folder survives closing all panes and rejects invalid paths', () => {
  assert.equal(normalizeWorkspace(state()).lastCwd, '/test/project', 'legacy saved panes supply an initial folder');
  assert.equal(normalizeWorkspace({ ...state(), lastCwd: '' }).lastCwd, '', 'new workspaces without a successful launch do not reuse failed pane paths');
  for (const lastCwd of ['/test/recent-project', 'C:\\Projects\\recent']) {
    assert.equal(normalizeWorkspace({ ...state(), panes: [], lastCwd }).lastCwd, lastCwd);
  }
  for (const lastCwd of ['relative', '/bad\0path', '/'.repeat(4097), null, 42]) {
    assert.equal(normalizeWorkspace({ ...state(), lastCwd }).lastCwd, '');
  }
});

test('workspace rejects corrupt versions, clamps layout and discards invalid or duplicated pane and assignment IDs', () => {
  assert.equal(normalizeWorkspace({ ...state(), version: 2 }), null);
  assert.equal(normalizeWorkspace({ ...state(), panes: [{ id: 'evil' }] }), null);
  const candidate = state();
  candidate.width = 10000; candidate.inspectorWidth = NaN;
  candidate.panes.push({ ...candidate.panes[0] });
  candidate.panes.push({ ...candidate.panes[0], id: '33333333-3333-4333-8333-333333333333', cwd: 'relative' });
  const saved = normalizeWorkspace(candidate);
  assert.equal(saved.width, 65);
  assert.equal(saved.inspectorWidth, 340);
  assert.equal(saved.panes.length, 2);
  assert.equal(saved.panes[1].cwd, '');
  assert.equal(saved.panes[1].assignment, undefined);
  assert.deepEqual(normalizeWorkspace({ ...state(), panes: [] }).panes, []);
});

test('workspace limits restore to eight panes and requires explicit recognized handoff values', () => {
  const candidate = state();
  candidate.panes = Array.from({ length: 20 }, (_, index) => ({ ...candidate.panes[0], id: `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`, assignment: { taskId, intent: 'automatic', mode: 'mcp' } }));
  const saved = normalizeWorkspace(candidate);
  assert.equal(saved.panes.length, 8);
  assert.ok(saved.panes.every(pane => !pane.assignment));
});

test('workspace restores legacy task IDs without weakening native pane IDs', () => {
  const candidate = state();
  candidate.panes[0].assignment.taskId = 'm5c12abc-k7x2v8mn';
  assert.equal(normalizeWorkspace(candidate).panes[0].assignment.taskId, 'm5c12abc-k7x2v8mn');
  for (const taskId of ['', 'x'.repeat(129), 'bad\0id', '../task', 'task\nid']) {
    candidate.panes[0].assignment.taskId = taskId;
    assert.equal(normalizeWorkspace(candidate).panes[0].assignment, undefined);
  }
  candidate.panes[0].id = 'm5c12abc-k7x2v8mn';
  assert.equal(normalizeWorkspace(candidate), null);
});

test('workspace storage is scoped by account and environment and survives unavailable or corrupt storage', t => {
  const values = new Map();
  const previous = globalThis.localStorage;
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  t.after(() => { if (previous === undefined) delete globalThis.localStorage; else globalThis.localStorage = previous; });
  const key = workspaceKey('first', 'dev');
  assert.equal(writeWorkspace(key, { ...state(), lastCwd: '/test/recent-project' }), true);
  assert.equal(readWorkspace(key).panes[0].cwd, '/test/project');
  assert.equal(readWorkspace(key).lastCwd, '/test/recent-project');
  assert.equal(readWorkspace(workspaceKey('second', 'dev')), null);
  assert.equal(readWorkspace(workspaceKey('first', 'other')), null);
  values.set(key, 'corrupted');
  assert.equal(readWorkspace(key), null);
  values.set(key, ' '.repeat(70000));
  assert.equal(readWorkspace(key), null);
  globalThis.localStorage.setItem = () => { throw Error('quota'); };
  assert.equal(writeWorkspace(key, state()), false);
});
