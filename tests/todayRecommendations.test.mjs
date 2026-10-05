import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['src/lib/todayRecommendations.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { todayRecommendations } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`);
const item = (id, changes = {}) => ({ id, text: id, type: 'task', parentId: null, order: 0, done: false, createdAt: 1, updatedAt: 1, dueDate: '2026-10-05', ...changes });
const map = (...items) => Object.fromEntries(items.map(item => [item.id, item]));
const recommend = items => todayRecommendations(items, '2026-10-05', '12:00');

test('recommendations rank deadlines, cap at three and replenish after Today assignment', () => {
  const items = map(item('near', { dueDate: '2026-10-07' }), item('today'), item('overdue', { dueDate: '2026-10-03' }), item('tomorrow', { dueDate: '2026-10-06' }));
  assert.deepEqual(recommend(items).map(c => [c.item.id, c.reason]), [['overdue', '期限超過'], ['today', '今日締切'], ['tomorrow', '明日締切']]);
  items.overdue.assignedDate = '2026-10-05';
  assert.deepEqual(recommend(items).map(c => c.item.id), ['today', 'tomorrow', 'near']);
  assert.equal(items.today.assignedDate, undefined, 'recommendation does not mutate tasks');
});

test('completed, filed, deleted, locked, unnamed, invalid and distant tasks are excluded', () => {
  const items = map(item('done', { done: true }), item('filed', { filed: true }), item('deleted', { deletedAt: 2 }), item('locked', { locked: true }), item('blank', { text: '  ' }), item('invalid', { dueDate: '2026-02-30' }), item('no-deadline', { dueDate: undefined }), item('distant', { dueDate: '2026-10-09' }), item('section', { type: 'section' }));
  assert.deepEqual(recommend(items), []);
  assert.deepEqual(todayRecommendations(items, 'invalid', '12:00'), []);
});

test('Today descendants are excluded even without their own assignment date', () => {
  const items = map(item('parent', { assignedDate: '2026-10-05' }), item('child', { parentId: 'parent' }), item('grandchild', { parentId: 'child' }), item('previous', { assignedDate: '2026-10-04' }));
  assert.deepEqual(recommend(items).map(c => c.item.id), ['previous']);
});

test('actionable children replace containers and preserve label and parent context', () => {
  const items = map(item('label', { type: 'section', text: 'ビルド' }), item('container', { parentId: 'label', locked: true, text: 'OS' }), item('parent', { parentId: 'container' }), item('child', { parentId: 'parent', text: '詳細の確認' }));
  assert.deepEqual(recommend(items).map(c => [c.item.id, c.context]), [['child', 'ビルド › OS › parent']]);
});

test('a parent deadline remains visible when its children have no matching deadline', () => {
  const items = map(item('parent'), item('child', { parentId: 'parent', dueDate: undefined }));
  assert.deepEqual(recommend(items).map(c => c.item.id), ['parent']);
});

test('unfinished descendants of completed or filed parents cannot be recommended', () => {
  const items = map(item('done', { done: true }), item('hidden', { parentId: 'done' }), item('filed', { filed: true }), item('hidden-too', { parentId: 'filed' }));
  assert.deepEqual(recommend(items), []);
});

test('deadline times are interpreted against the supplied account day and time', () => {
  const items = map(item('date-only'), item('future', { dueTime: '13:00' }), item('past', { dueTime: '11:00' }));
  assert.deepEqual(recommend(items).map(c => [c.item.id, c.reason]), [['past', '期限超過'], ['future', '今日締切'], ['date-only', '今日締切']]);
  assert.equal(todayRecommendations(items, '2026-10-05', '10:00')[0].reason, '今日締切');
  assert.equal(todayRecommendations(items, '2026-10-06', '00:00')[0].reason, '期限超過');
});

test('three-calendar-day window handles month, leap year and DST boundaries with stable ties', () => {
  const items = map(item('first', { dueDate: '2028-03-01', order: 1 }), item('second', { dueDate: '2028-03-01', order: 2 }), item('outside', { dueDate: '2028-03-02' }));
  assert.deepEqual(todayRecommendations(items, '2028-02-27', '12:00').map(c => [c.item.id, c.reason]), [['first', '3日後締切'], ['second', '3日後締切']]);
  assert.equal(todayRecommendations(map(item('dst', { dueDate: '2026-10-06' })), '2026-10-03', '23:00')[0].reason, '3日後締切');
});
