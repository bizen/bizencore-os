import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

async function load(entryPoint) {
  const compiled = await build({ entryPoints: [entryPoint], bundle: true, platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`);
}

test('completion source stays with done during concurrent note edits', async () => {
  const { mergeItems, restamp } = await load('src/lib/itemMerge.ts');
  const base = { id: 'one', done: false, text: 'Ship', note: undefined, updatedAt: 100 };
  const ai = restamp(base, { ...base, done: true, completedBy: 'ai' }, 200);
  const humanNote = restamp(base, { ...base, note: 'Check docs' }, 150);
  const merged = mergeItems(humanNote, ai);
  assert.equal(merged.done, true);
  assert.equal(merged.completedBy, 'ai');
  assert.equal(merged.note, 'Check docs');
});

test('human re-completion returns the check to its usual color', async () => {
  const { taskStore, flushPersist } = await load('src/lib/taskStore.ts');
  const id = taskStore.insertAfter(null);
  taskStore.update(id, { done: true, completedBy: 'ai' });
  taskStore.toggleDone(id);
  assert.equal(taskStore.getState().items[id].done, false);
  assert.equal(taskStore.getState().items[id].completedBy, undefined);
  taskStore.toggleDone(id);
  assert.equal(taskStore.getState().items[id].done, true);
  assert.equal(taskStore.getState().items[id].completedBy, undefined);
  flushPersist();
});
