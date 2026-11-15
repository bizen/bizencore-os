import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const { outputFiles } = await build({ entryPoints: ['src/lib/collapsedRows.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { collapseRows } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
const rows = [
  { id: 'label', depth: 0, type: 'section' },
  { id: 'container', depth: 1, type: 'task', locked: true },
  { id: 'nested', depth: 2, type: 'task', locked: true },
  { id: 'leaf', depth: 3, type: 'task' },
  { id: 'sibling', depth: 2, type: 'task' },
  { id: 'outside', depth: 1, type: 'task' },
  { id: 'next-label', depth: 0, type: 'section' },
];
const folded = ids => collapseRows(rows, row => !!row.locked && ids.includes(row.id), row => row.id, row => row.type === 'task');

test('folding hides the full subtree, counts all hidden tasks and leaves siblings/labels intact', () => {
  const before = JSON.stringify(rows);
  const result = folded(['container']);
  assert.deepEqual(result.rows.map(row => row.id), ['label', 'container', 'outside', 'next-label']);
  assert.equal(result.hiddenCounts.get('container'), 3);
  assert.equal(JSON.stringify(rows), before, 'the task tree is not edited');
});

test('nested collapse is independent and its state can be retained under a folded parent', () => {
  const both = folded(['container', 'nested']);
  assert.equal(both.hiddenCounts.get('container'), 3);
  const inner = folded(['nested']);
  assert.deepEqual(inner.rows.map(row => row.id), ['label', 'container', 'nested', 'sibling', 'outside', 'next-label']);
  assert.equal(inner.hiddenCounts.get('nested'), 1);
  assert.deepEqual(folded([]).rows, rows);
  assert.equal(folded(['leaf']).hiddenCounts.size, 0, 'unlocked tasks cannot be folded');
});

test('search reveal, leaf containers and top-level rows do not hide unrelated tasks', () => {
  assert.deepEqual(collapseRows(rows, () => false, row => row.id).rows, rows);
  const leaf = collapseRows([{ id: 'locked', depth: 0 }, { id: 'next', depth: 0 }], row => row.id === 'locked', row => row.id);
  assert.equal(leaf.hiddenCounts.get('locked'), 0);
  assert.equal(leaf.rows.length, 2);
  assert.deepEqual(collapseRows([], () => true, row => row.id).rows, []);
});
