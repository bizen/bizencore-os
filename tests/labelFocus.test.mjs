import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: ['src/lib/taskModel.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
const { flattenAll, rowsForLabel } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`
);

function item(id, parentId, order, type = 'task') {
  return { id, parentId, order, type, text: id, done: false, createdAt: order, updatedAt: order };
}

test('focus view keeps only the selected label and its nested tasks', () => {
  const items = {
    loose: item('loose', null, 0),
    first: item('first', null, 1, 'section'),
    child: item('child', 'first', 0),
    nested: item('nested', 'child', 0),
    second: item('second', null, 2, 'section'),
    other: item('other', 'second', 0),
  };
  const rows = flattenAll(items);

  assert.deepEqual(rowsForLabel(rows, 'first').map(({ item, depth }) => [item.id, depth]), [
    ['first', 0], ['child', 1], ['nested', 2],
  ]);
  assert.deepEqual(rowsForLabel(rows, 'second').map(({ item }) => item.id), ['second', 'other']);
  assert.deepEqual(rowsForLabel(rows, 'missing'), []);
  assert.deepEqual(rowsForLabel(rows, 'loose'), []);
});
