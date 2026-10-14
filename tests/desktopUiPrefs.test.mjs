import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

async function load(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}
const { defaultUiPrefs, normalizeUiPrefs, readUiPrefs, writeUiPrefs, uiPrefsKey } = await load('../desktop/ui-prefs.ts');
const { completedAssignments } = await load('../desktop/task-notifications.ts');

test('terminal preferences bound font sizes and require explicit notification opt-in', () => {
  assert.deepEqual(defaultUiPrefs, { version: 1, terminalFontSize: 13, completionNotifications: false });
  assert.equal(normalizeUiPrefs({ version: 1, terminalFontSize: 100 }).terminalFontSize, 24);
  assert.equal(normalizeUiPrefs({ version: 1, terminalFontSize: -10 }).terminalFontSize, 10);
  assert.equal(normalizeUiPrefs({ version: 1, terminalFontSize: NaN }).terminalFontSize, 13);
  assert.equal(normalizeUiPrefs({ version: 1, terminalFontSize: 14.4 }).terminalFontSize, 14);
  assert.equal(normalizeUiPrefs({ version: 1, completionNotifications: 'true' }).completionNotifications, false);
  assert.deepEqual(normalizeUiPrefs({ version: 2, completionNotifications: true }), defaultUiPrefs);
});

test('preferences are account/environment scoped and handle corrupt or unavailable storage', t => {
  const previous = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  t.after(() => { if (previous === undefined) delete globalThis.localStorage; else globalThis.localStorage = previous; });
  const key = uiPrefsKey('first', 'dev');
  assert.equal(writeUiPrefs(key, { version: 1, terminalFontSize: 17, completionNotifications: true }), true);
  assert.equal(readUiPrefs(key).terminalFontSize, 17);
  assert.equal(readUiPrefs(key).completionNotifications, true);
  assert.deepEqual(readUiPrefs(uiPrefsKey('second', 'dev')), defaultUiPrefs);
  assert.deepEqual(readUiPrefs(uiPrefsKey('first', 'prod')), defaultUiPrefs);
  values.set(key, 'corrupt');
  assert.deepEqual(readUiPrefs(key), defaultUiPrefs);
  values.set(key, ' '.repeat(1025));
  assert.deepEqual(readUiPrefs(key), defaultUiPrefs);
  globalThis.localStorage.setItem = () => { throw Error('quota'); };
  assert.equal(writeUiPrefs(key, defaultUiPrefs), false);
});

test('completion notifications require a done transition for the same assigned task and pane', () => {
  const before = { paneId: 'pane', taskId: 'task', title: 'Task', done: false };
  const done = { ...before, done: true };
  assert.deepEqual(completedAssignments([before], [done]), [done]);
  assert.deepEqual(completedAssignments([], [done]), [], 'no completion on restore or initial sync');
  assert.deepEqual(completedAssignments([done], [done]), [], 'no repeated notification');
  assert.deepEqual(completedAssignments([before], [{ ...done, taskId: 'another' }]), []);
  assert.deepEqual(completedAssignments([before], [{ ...done, paneId: 'another' }]), []);
  assert.deepEqual(completedAssignments([before], [before]), [], 'exit/output changes do not change task completion');
  assert.deepEqual(completedAssignments([before], []), [], 'deletion is not completion');
});
