import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const { outputFiles } = await build({ entryPoints: ['src/components/task/TaskTreeGuides.tsx'], bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', write: false });
const { TaskTreeGuides } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
const render = (depth, hasChildren, continuations = Array(depth).fill(true), firstTaskDepth = 0) => renderToStaticMarkup(createElement(TaskTreeGuides, { depth, hasChildren, continuations, firstTaskDepth }));

test('a root leaf has no hierarchy rails', () => {
  assert.equal(render(0, false), '');
});

test('labels omit their connection while inner task ancestors remain visible', () => {
  const html = render(5, false, Array(5).fill(true), 1);
  assert.equal((html.match(/class="row-tree-guide(?: is-parent(?: is-continuing)?)?"/g) || []).length, 4);
  assert.doesNotMatch(html, /--tree-level:0/);
  for (let level = 1; level < 5; level++) assert.ok(html.includes(`--tree-level:${level}`));
  assert.equal((html.match(/is-parent/g) || []).length, 1);
  assert.doesNotMatch(html, /row-tree-stem/);
});

test('visible descendants extend the parent rail below its checkbox', () => {
  assert.equal(render(0, true, [], 1), '');
  assert.equal(render(1, false, [false], 1), '');
  for (const depth of [0, 1, 2, 3]) {
    const html = render(depth, true);
    assert.match(html, new RegExp(`class="row-tree-guide row-tree-stem" style="--tree-level:${depth};`));
  }
});

test('rails stay decorative and cannot become accessibility controls', () => {
  const html = render(3, true);
  assert.match(html, /aria-hidden="true"/);
  assert.doesNotMatch(html, /tabindex|button|role=/);
});

test('five task levels expose four distinct connections with consistent label and board colors', () => {
  const html = render(4, false);
  const colors = [...html.matchAll(/--tree-color:([^";]+)/g)].map(match => match[1]);
  assert.equal(new Set(colors).size, 4);
  const labeledColors = [...render(5, false, Array(5).fill(true), 1).matchAll(/--tree-color:([^";]+)/g)].map(match => match[1]);
  assert.deepEqual(colors, labeledColors);
  assert.match(render(0, true), /--tree-level:0;--tree-color:59, 130, 203/);
  assert.match(render(1, false), /is-parent.*--tree-level:0;--tree-color:59, 130, 203/);
});

test('the last child bends to its checkbox and does not carry finished ancestors downward', () => {
  const html = render(4, false, [false, false, false, false]);
  assert.match(html, /--tree-level:3/);
  assert.doesNotMatch(html, /--tree-level:[012]|is-continuing/);
  assert.match(html, /row-tree-branch/);
});

const helperBuild = await build({ entryPoints: ['src/lib/taskTreeGuides.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { treeContinuations, firstTaskDepths } = await import(`data:text/javascript;base64,${Buffer.from(helperBuild.outputFiles[0].contents).toString('base64')}`);
test('visible siblings continue rails across descendants but stop at the next parent or section', () => {
  assert.deepEqual(treeContinuations([0, 1, 2, 3, 2, 1, 0].map(depth => ({ depth }))), [
    [], [true], [true, true], [true, true, false], [true, false], [false], [],
  ]);
  assert.deepEqual(treeContinuations([0, 1, 1].map(depth => ({ depth }))), [[], [true], [false]]);
  assert.deepEqual(treeContinuations([]), []);
});

test('task depth follows each visible root, including rebased board, today and filed trees', () => {
  const rows = (types, depths) => types.map((type, index) => ({ item: { type }, depth: depths[index] }));
  assert.deepEqual(firstTaskDepths(rows(['section', 'task', 'task', 'task', 'task', 'task', 'section', 'task'], [0, 1, 2, 0, 1, 2, 0, 1])), [1, 1, 1, 0, 0, 0, 1, 1]);
  assert.deepEqual(firstTaskDepths(rows(['task', 'task', 'task', 'task', 'task'], [0, 1, 2, 3, 4])), [0, 0, 0, 0, 0]);
  assert.deepEqual(firstTaskDepths(rows(['task', 'task'], [1, 2])), [1, 1]);
  assert.deepEqual(firstTaskDepths([]), []);
});
