import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const load = async entry => {
  const { outputFiles } = await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
};
const { flattenToday, isTodayItem, todayCarryDays } = await load('src/lib/taskModel.ts');
const item = (id, changes = {}) => ({ id, type: 'task', parentId: null, text: id, order: 0, done: false, createdAt: 1, updatedAt: 1, assignedDate: '2026-10-21', ...changes });
const map = (...items) => Object.fromEntries(items.map(item => [item.id, item]));

test('unfinished Today tasks carry without rewriting their original date; future, deleted and unset tasks stay out', () => {
  const carried = item('carried');
  const items = map(carried, item('today', { assignedDate: '2026-10-23' }), item('future', { assignedDate: '2026-10-24' }), item('unset', { assignedDate: undefined }), item('deleted', { deletedAt: 2 }), item('invalid', { assignedDate: '2026-02-30' }));
  assert.deepEqual(flattenToday(items, '2026-10-23').map(row => row.item.id), ['carried', 'today']);
  assert.equal(todayCarryDays(carried, '2026-10-23'), 2);
  assert.equal(todayCarryDays(carried, '2026-10-21'), 0);
  assert.equal(carried.assignedDate, '2026-10-21');
});

test('calendar days handle month, leap year and DST boundaries without fractional day counts', () => {
  for (const [assignedDate, today, days] of [['2026-12-31', '2027-01-02', 2], ['2028-02-28', '2028-03-01', 2], ['2026-10-03', '2026-10-05', 2]]) {
    assert.equal(todayCarryDays(item('a', { assignedDate }), today), days);
  }
  assert.equal(todayCarryDays(item('future', { assignedDate: '2026-10-24' }), '2026-10-23'), 0);
  assert.equal(todayCarryDays(item('bad', { assignedDate: 'invalid' }), '2026-10-23'), 0);
});

test('carried tasks stay visible on completion day in the account timezone, then leave Today without deleting data', () => {
  const done = item('done', { done: true, stamps: { done: Date.parse('2026-10-22T14:00:00Z') } });
  assert.equal(isTodayItem(done, '2026-10-23', 'Australia/Melbourne'), true);
  assert.equal(isTodayItem(done, '2026-10-23', 'UTC'), false);
  assert.equal(isTodayItem(done, '2026-10-24', 'Australia/Melbourne'), false);
  assert.equal(isTodayItem(item('legacy-done', { done: true }), '2026-10-23'), false);
  assert.equal(isTodayItem(item('today-done', { done: true }), '2026-10-21'), true);
  assert.equal(flattenToday(map(done), '2026-10-24', 'Australia/Melbourne').length, 0);
  assert.equal(done.done, true);
  assert.equal(done.assignedDate, '2026-10-21');
});

test('carried parents retain their descendants without duplicate rows', () => {
  const items = map(item('parent'), item('child', { parentId: 'parent', assignedDate: undefined }), item('grandchild', { parentId: 'child', assignedDate: '2026-10-22' }));
  assert.deepEqual(flattenToday(items, '2026-10-23').map(row => [row.item.id, row.depth]), [['parent', 0], ['child', 1], ['grandchild', 2]]);
});

test('Today toggle removes carried tasks and re-adding starts a fresh count; persistence keeps the date', async () => {
  const saved = new Map();
  globalThis.localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  try {
    const { taskStore, flushPersist } = await load('src/lib/taskStore.ts');
    const carried = item('carried');
    taskStore.mergeRemote([{ itemId: carried.id, updatedAt: 1, payload: JSON.stringify(carried) }]);
    taskStore.toggleToday(carried.id, '2026-10-23');
    assert.equal(taskStore.getState().items.carried.assignedDate, undefined);
    taskStore.toggleToday(carried.id, '2026-10-23');
    assert.equal(taskStore.getState().items.carried.assignedDate, '2026-10-23');
    flushPersist();
    assert.equal(JSON.parse(saved.get('chrct.tasks.v2')).find(item => item.id === carried.id).assignedDate, '2026-10-23');
  } finally { delete globalThis.localStorage; }
});
