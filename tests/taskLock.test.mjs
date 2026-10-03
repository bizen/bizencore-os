import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

async function load(entryPoint) {
  const compiled = await build({ entryPoints: [entryPoint], bundle: true, platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`);
}
const { taskStore, flushPersist } = await load('src/lib/taskStore.ts');
const { mergeItems, restamp } = await load('src/lib/itemMerge.ts');
const { completionBlockedIds } = await load('src/lib/taskModel.ts');

test('a locked container cannot be completed, but its children can; unlocking restores completion', () => {
  const parent = taskStore.insertAfter(null);
  const container = taskStore.insertAfter(parent, { asChild: true });
  const child = taskStore.insertAfter(container, { asChild: true });
  taskStore.setLocked(container, true);
  assert.equal(taskStore.getState().items[container].locked, true);
  assert.equal(taskStore.toggleDone(container), false);
  assert.equal(taskStore.toggleDone(parent), false);
  assert.equal(taskStore.getState().items[child].done, false);
  assert.deepEqual([...completionBlockedIds(taskStore.getState().items)].sort(), [parent, container].sort());
  assert.equal(taskStore.toggleDone(child), true);
  assert.equal(taskStore.getState().items[container].done, false);
  taskStore.setNote(container, 'Still editable');
  assert.equal(taskStore.getState().items[container].note, 'Still editable');
  taskStore.update(container, { done: true, filed: true, completedBy: 'ai' });
  assert.equal(taskStore.getState().items[container].done, false);
  assert.equal(taskStore.getState().items[container].filed, undefined);
  taskStore.setLocked(container, false);
  assert.equal(taskStore.toggleDone(parent), true);
  assert.equal(taskStore.getState().items[container].done, true);
  flushPersist();
});

test('completed tasks must be reopened before locking, and labels cannot be locked', () => {
  const task = taskStore.insertAfter(null);
  taskStore.toggleDone(task);
  taskStore.setLocked(task, true);
  assert.equal(taskStore.getState().items[task].locked, undefined);
  taskStore.toggleDone(task);
  taskStore.setLocked(task, true);
  assert.equal(taskStore.getState().items[task].locked, true);
  const label = taskStore.addSection();
  taskStore.setLocked(label, true);
  assert.equal(taskStore.getState().items[label].locked, undefined);
  flushPersist();
});

test('lock and completion remain safe under concurrent edits and older clients omitting the new field', () => {
  const base = restamp(undefined, { id: 'one', type: 'task', done: false, updatedAt: 100 }, 100);
  const locked = restamp(base, { ...base, locked: true }, 200);
  const ai = restamp(base, { ...base, done: true, filed: true, completedBy: 'ai' }, 300);
  for (const [a, b] of [[locked, ai], [ai, locked]]) {
    const result = mergeItems(a, b);
    assert.equal(result.locked, true);
    assert.equal(result.done, false);
    assert.equal(result.filed, undefined);
    assert.equal(result.completedBy, undefined);
  }
  const legacy = { ...base, done: true, note: 'Old client edit', updatedAt: 400, stamps: { done: 400, note: 400 } };
  const merged = mergeItems(locked, legacy);
  assert.equal(merged.locked, true);
  assert.equal(merged.done, false);
  assert.equal(merged.note, 'Old client edit');
  const unlocked = restamp(merged, { ...merged, locked: undefined }, 500);
  const completed = restamp(unlocked, { ...unlocked, done: true }, 600);
  const final = mergeItems(locked, completed);
  assert.equal(final.locked, undefined);
  assert.equal(final.done, true);
});

test('sync merge repairs invalid locked completions and remote coercion preserves the lock', async () => {
  const { mergeRows } = await load('convex/sync.ts');
  const payload = { id: 'remote-lock', type: 'task', text: 'Reading list', done: false, locked: true, updatedAt: 100 };
  const a = { updatedAt: 100, payload: JSON.stringify(payload) };
  const b = { updatedAt: 200, payload: JSON.stringify({ ...payload, done: true, filed: true, completedBy: 'ai' }) };
  const result = JSON.parse(mergeRows(a, b).payload);
  assert.equal(result.locked, true);
  assert.equal(result.done, false);
  assert.equal(result.filed, undefined);
  assert.equal(result.completedBy, undefined);
  taskStore.mergeRemote([{ itemId: payload.id, ...b }]);
  assert.equal(taskStore.getState().items[payload.id].locked, true);
  assert.equal(taskStore.getState().items[payload.id].done, false);
  assert.equal(taskStore.getState().items[payload.id].filed, undefined);
  flushPersist();
});
