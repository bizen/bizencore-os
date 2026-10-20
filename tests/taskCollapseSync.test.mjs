import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

async function load(entryPoint) {
  const { outputFiles } = await build({ entryPoints: [entryPoint], bundle: true, platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
}
const { restamp, mergeItems } = await load('src/lib/itemMerge.ts');
const { mergeRows } = await load('convex/sync.ts');

test('collapse sync is independent of content, survives older clients and accepts a later expand', () => {
  const base = restamp(undefined, { id: 'parent', type: 'task', locked: true, done: false, text: 'Container', updatedAt: 1 }, 1);
  const folded = restamp(base, { ...base, collapsed: true }, 2);
  const edited = restamp(base, { ...base, note: 'Other device' }, 3);
  for (const [a, b] of [[folded, edited], [edited, folded]]) {
    const remote = mergeItems(a, b);
    assert.equal(remote.collapsed, true);
    assert.equal(remote.note, 'Other device');
    assert.equal(remote.locked, true);
    assert.equal(remote.done, false);
  }
  const legacy = { ...base, text: 'Old client edit', updatedAt: 100, stamps: { text: 100 } };
  assert.equal(mergeItems(folded, legacy).collapsed, true);
  const expanded = restamp(folded, { ...folded, collapsed: undefined }, 4);
  const row = item => ({ updatedAt: item.updatedAt, payload: JSON.stringify(item) });
  assert.equal(JSON.parse(mergeRows(row(folded), row(expanded)).payload).collapsed, undefined);
  assert.equal(mergeItems(expanded, legacy).collapsed, undefined);
});

test('task store saves and restores collapse and expansion, including remote coercion', async () => {
  const saved = new Map();
  globalThis.localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  try {
    const { taskStore, flushPersist } = await load('src/lib/taskStore.ts');
    const id = taskStore.insertAfter(null);
    taskStore.setText(id, 'Container');
    taskStore.setLocked(id, true);
    taskStore.setCollapsed(id, true);
    flushPersist();
    const persisted = JSON.parse(saved.get('chrct.tasks.v2')).find(item => item.id === id);
    assert.equal(persisted.collapsed, true);
    taskStore.mergeRemote([{ itemId: 'second-device', updatedAt: persisted.updatedAt, payload: JSON.stringify({ ...persisted, id: 'second-device' }) }]);
    assert.equal(taskStore.getState().items['second-device'].collapsed, true);
    taskStore.setCollapsed(id, false);
    flushPersist();
    assert.equal(JSON.parse(saved.get('chrct.tasks.v2')).find(item => item.id === id).collapsed, undefined);
    const unlocked = taskStore.insertAfter(null);
    taskStore.setCollapsed(unlocked, true);
    assert.equal(taskStore.getState().items[unlocked].collapsed, undefined);
    flushPersist();
  } finally { delete globalThis.localStorage; }
});
