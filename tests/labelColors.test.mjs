import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

async function load(entryPoint) {
  const compiled = await build({ entryPoints: [entryPoint], bundle: true, platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`);
}
const { LABEL_COLORS, LABEL_COLOR_KEYS, LABEL_COLOR_NAMES, isLabelColor, nextLabelColor } = await load('src/lib/taskModel.ts');

test('the twelve-color palette preserves existing colors and rejects non-palette values', () => {
  const legacy = { blue: '#5b9dff', violet: '#a78bfa', pink: '#f472b6', amber: '#f0b429', green: '#4ade80' };
  for (const [key, hex] of Object.entries(legacy)) assert.equal(LABEL_COLORS[key], hex);
  assert.equal(LABEL_COLOR_KEYS.length, 12);
  assert.equal(new Set(Object.values(LABEL_COLORS)).size, 12);
  for (const key of LABEL_COLOR_KEYS) {
    assert.equal(isLabelColor(key), true);
    assert.match(LABEL_COLORS[key], /^#[0-9a-f]{6}$/);
    assert.ok(LABEL_COLOR_NAMES[key]);
  }
  for (const invalid of [undefined, null, 1, '#ffffff', 'constructor', '__proto__', 'toString']) assert.equal(isLabelColor(invalid), false);
});

test('keyboard color cycling visits every preset then returns to no color', () => {
  let color;
  for (const key of LABEL_COLOR_KEYS) {
    color = nextLabelColor(color);
    assert.equal(color, key);
  }
  assert.equal(nextLabelColor(color), undefined);
});

test('new label colors survive remote loading, local persistence and sync merge', async () => {
  const { taskStore, flushPersist } = await load('src/lib/taskStore.ts');
  const { mergeRows } = await load('convex/sync.ts');
  const original = globalThis.localStorage;
  let stored;
  try {
    globalThis.localStorage = { setItem: (_key, value) => { stored = value; } };
    for (const [index, color] of LABEL_COLOR_KEYS.entries()) {
      const id = `color-${color}`;
      const item = { id, type: 'section', text: color, parentId: null, color, done: false, order: index, createdAt: 1, updatedAt: 100 + index };
      taskStore.mergeRemote([{ itemId: id, updatedAt: item.updatedAt, payload: JSON.stringify(item) }]);
      assert.equal(taskStore.getState().items[id].color, color);
      const old = { ...item, color: 'blue', updatedAt: 1 };
      const merged = mergeRows({ updatedAt: 1, payload: JSON.stringify(old) }, { updatedAt: item.updatedAt, payload: JSON.stringify(item) });
      assert.equal(JSON.parse(merged.payload).color, color);
    }
    flushPersist();
    for (const color of LABEL_COLOR_KEYS) assert.equal(JSON.parse(stored).find(item => item.id === `color-${color}`).color, color);
  } finally { flushPersist(); globalThis.localStorage = original; }
});
