import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const { outputFiles } = await build({ entryPoints: ['src/components/task/TaskTreeGuides.tsx'], bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', write: false });
const { TaskTreeGuides } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
const render = (depth, hasChildren) => renderToStaticMarkup(createElement(TaskTreeGuides, { depth, hasChildren }));

test('a root leaf has no hierarchy rails', () => {
  assert.equal(render(0, false), '');
});

test('inner ancestors remain visible while the outermost rail is omitted', () => {
  const html = render(5, false);
  assert.equal((html.match(/class="row-tree-guide(?: is-parent)?"/g) || []).length, 4);
  assert.doesNotMatch(html, /--tree-level:0/);
  for (let level = 1; level < 5; level++) assert.ok(html.includes(`--tree-level:${level}`));
  assert.equal((html.match(/is-parent/g) || []).length, 1);
  assert.doesNotMatch(html, /row-tree-stem/);
});

test('visible descendants extend the parent rail below its checkbox', () => {
  assert.equal(render(0, true), '');
  assert.equal(render(1, false), '');
  for (const depth of [1, 2, 4]) {
    const html = render(depth, true);
    assert.match(html, new RegExp(`class="row-tree-guide row-tree-stem" style="--tree-level:${depth};`));
  }
});

test('rails stay decorative and cannot become accessibility controls', () => {
  const html = render(3, true);
  assert.match(html, /aria-hidden="true"/);
  assert.doesNotMatch(html, /tabindex|button|role=/);
});

test('four inner levels have stable distinct colors', () => {
  const html = render(4, true);
  const colors = [...html.matchAll(/--tree-color:([^";]+)/g)].map(match => match[1]);
  assert.equal(new Set(colors).size, 4);
  assert.equal(colors[0], [...render(2, false).matchAll(/--tree-color:([^";]+)/g)][0][1]);
});
