import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

async function compile(path) {
  const result = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
}
const { pickerRows, taskPath, boardGroups, filterDue, handoffMessage, pickerHeight } = await compile('mcp-app/model.ts');
const { readTheme } = await compile('src/lib/theme.ts');
const item = (id, parentId, order, extra = {}) => ({ id, parentId, order, type: 'task', text: id, done: false, createdAt: 1, updatedAt: 1, ...extra });
const items = {
  standalone: item('standalone', null, 0),
  standaloneChild: item('standaloneChild', 'standalone', 0),
  label: item('label', null, 1, { type: 'section', color: 'violet' }),
  parent: item('parent', 'label', 0, { assignedDate: '2026-10-03' }),
  child: item('child', 'parent', 0),
  filed: item('filed', 'parent', 1, { done: true, filed: true }),
  filedChild: item('filedChild', 'filed', 0, { done: true }),
};
test('picker shares native tree ordering, focus and completed shelving', () => {
  const { active, done } = pickerRows(items, 'all', '2026-10-03');
  assert.deepEqual(active.map((row) => row.item.id), ['standalone', 'standaloneChild', 'label', 'parent', 'child']);
  assert.deepEqual(done.map((row) => [row.item.id, row.depth]), [['filed', 0], ['filedChild', 1]]);
  assert.deepEqual(pickerRows(items, 'label:label', '').active.map((row) => row.item.id), ['label', 'parent', 'child']);
  assert.deepEqual(pickerRows(items, 'today', '2026-10-03').active.map((row) => [row.item.id, row.depth]), [['parent', 0], ['child', 1]]);
});
test('board preserves unlabelled descendants and label colors', () => {
  const groups = boardGroups(pickerRows(items, 'all', '').active);
  assert.deepEqual(groups[0].rows.map((row) => row.item.id), ['standalone', 'standaloneChild']);
  assert.equal(groups[1].label.color, 'violet');
  assert.deepEqual(groups[1].rows.map((row) => row.depth), [0, 1]);
});
test('handoff uses the exact ID and requires reading latest information before work', () => {
  assert.equal(taskPath(items, 'child'), 'label › parent');
  assert.match(handoffMessage('task-id'), /タスクID: task-id/);
  assert.match(handoffMessage('task-id'), /work_on_task/);
  assert.match(handoffMessage('task-id'), /最新情報/);
  assert.match(handoffMessage('task-id'), /record_task_progress/);
  assert.match(handoffMessage('task-id'), /Then ask one focused question/);
  assert.match(handoffMessage('task-id'), /Wait for the user's answer before implementation or task changes/);
});
test('picker handoff carries the selected consultation or execution intent', () => {
  for (const intent of ['consult', 'execute']) {
    const prompt = handoffMessage('task-id', intent);
    assert.match(prompt, /task_id "task-id"/);
    assert.match(prompt, /already confirmed intent/);
    assert.match(prompt, /retain this intent across work_on_task results/);
    assert.match(prompt, /record_task_progress/);
    assert.doesNotMatch(prompt, /Then ask one focused question/);
    assert.match(prompt, intent === 'consult' ? /without implementing/ : /Do the actual work within the agreed scope/);
  }
});
test('deadline filtering preserves ancestors and uses the account day', () => {
  const tree = { ...items, child: { ...items.child, dueDate: '2026-10-02' }, standalone: { ...items.standalone, dueDate: '2026-10-05' } };
  const rows = pickerRows(tree, 'all', '').active;
  assert.deepEqual(filterDue(rows, 'overdue', '2026-10-03').map((row) => row.item.id), ['label', 'parent', 'child']);
  assert.deepEqual(filterDue(rows, 'week', '2026-10-03').map((row) => row.item.id), ['standalone']);
});
test('embedded height is stable by default and respects host constraints without a vh resize loop', () => {
  assert.equal(pickerHeight(), 680);
  assert.equal(pickerHeight({ maxHeight: 600 }), 600);
  assert.equal(pickerHeight({ height: 300 }), 300);
  assert.equal(pickerHeight({ maxHeight: 1200 }), 680);
  assert.equal(pickerHeight({ height: -10 }), 680);
});
test('black is default while an explicit original or white theme is preserved', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    for (const [saved, expected] of [[null, 'black'], ['bad', 'black'], ['original', 'original'], ['white', 'white'], ['black', 'black']]) {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => saved } });
      assert.equal(readTheme(), expected);
    }
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('blocked'); } });
    assert.equal(readTheme(), 'black');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  }
});
