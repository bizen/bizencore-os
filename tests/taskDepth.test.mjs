import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

async function load(path) {
  const { outputFiles } = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
}
const { MAX_DEPTH, depthOf, flattenAll } = await load('src/lib/taskModel.ts');
const { taskStore } = await load('src/lib/taskStore.ts');

test('four task levels are available with or without a label; structural depth still preserves label ownership', () => {
  assert.equal(MAX_DEPTH, 3);
  for (const labeled of [false, true]) {
    taskStore.replaceAll([]);
    const label = labeled ? taskStore.addSection() : null;
    const root = taskStore.insertAfter(label, { asChild: true });
    let last = root;
    for (let level = 1; level <= MAX_DEPTH; level++) {
      last = taskStore.insertAfter(last, { asChild: true });
      assert.equal(depthOf(taskStore.getState().items, last), level);
    }
    const overflow = taskStore.insertAfter(last, { asChild: true });
    assert.equal(taskStore.getState().items[overflow].parentId, taskStore.getState().items[last].parentId);
    assert.equal(taskStore.indent(overflow), false);
    assert.equal(flattenAll(taskStore.getState().items).find(row => row.item.id === last).depth, labeled ? 4 : 3);
    if (label) {
      assert.equal(depthOf(taskStore.getState().items, label), -1);
      assert.equal(taskStore.outdent(root), true);
      assert.equal(depthOf(taskStore.getState().items, last), 3, 'outdenting a label does not change task depth');
      assert.equal(taskStore.indent(root), true, 'a full four-level subtree can return beneath its label');
    }
  }
});

test('legacy deeper tasks survive hydration and edits, and new entries return to the allowed depth', () => {
  const items = Array.from({ length: 6 }, (_, depth) => ({ id: String(depth), parentId: depth ? String(depth - 1) : null,
    type: 'task', text: String(depth), order: 0, done: false, createdAt: 1, updatedAt: 1 }));
  taskStore.replaceAll(items);
  taskStore.setText('5', 'Keep me');
  assert.equal(taskStore.getState().items['5'].parentId, '4');
  assert.equal(flattenAll(taskStore.getState().items).length, 6);
  const id = taskStore.insertAfter('5', { asChild: true });
  assert.equal(depthOf(taskStore.getState().items, id), 3);
  assert.equal(taskStore.getState().items['5'].text, 'Keep me');
});
