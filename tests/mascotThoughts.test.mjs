import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
const { outputFiles } = await build({ entryPoints: ['src/lib/mascotThoughts.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { mascotThoughts, pickMascotThought } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
const now = Date.parse('2026-10-23T00:00:00Z');
const task = (id, extra = {}) => ({ id, type: 'task', parentId: null, order: 0, text: id, done: false, createdAt: 1, updatedAt: 1, ...extra });
const map = (...tasks) => Object.fromEntries(tasks.map(item => [item.id, item]));
test('six categories use current tasks, Today tree order, recent actual completions and the account date', () => {
  const items = map(task('second', { order: 2, assignedDate: '2026-10-23' }), task('first', { assignedDate: '2026-10-22', dueDate: '2026-10-24' }), task('done', { done: true, stamps: { done: now - 1 } }));
  const thoughts = mascotThoughts(items, now, now - 100, 'Australia/Melbourne');
  assert.deepEqual([...new Set(thoughts.map(t => t.kind))].sort(), ['carry', 'curious', 'deadline', 'joy', 'rest', 'today']);
  assert.deepEqual([...new Set(thoughts.filter(t => t.kind === 'today').map(t => t.taskId))], ['first']);
  assert.ok(thoughts.some(t => t.ending === '、いつやるのかな……'));
  assert.ok(!mascotThoughts(items, now, now, 'UTC').some(t => t.kind === 'joy'), 'existing completion history is silent');
  assert.ok(!mascotThoughts(items, now + 300_000, 0, 'UTC').some(t => t.kind === 'joy'), 'old completions expire');
  assert.ok(!mascotThoughts(map(task('tz', { dueDate: '2026-10-22' })), now, now, 'UTC').some(t => t.kind === 'deadline'), 'overdue tasks do not falsely have an upcoming deadline');
});
test('deleted, filed, locked, empty and label rows are not mentioned; no task data leaves the device', () => {
  const items = map(task('deleted', { deletedAt: 1 }), task('filed', { filed: true }), task('locked', { locked: true }), task('blank', { text: ' ' }), task('label', { type: 'section' }));
  assert.ok(mascotThoughts(items, now, 0, 'UTC').every(t => t.kind === 'rest'));
  assert.equal(mascotThoughts(map(task('name', { text: 'a\nb' })), now, now, 'UTC')[0].title, 'a b');
});
test('selection avoids recent task/category pairs and consecutive pressure, while balancing categories', () => {
  const thoughts = mascotThoughts(map(task('a', { assignedDate: '2026-10-22', dueDate: '2026-10-23' })), now, now, 'UTC');
  const deadline = thoughts.find(t => t.kind === 'deadline');
  const chosen = pickMascotThought(thoughts, [deadline], () => 0.99);
  assert.ok(!['carry', 'deadline'].includes(chosen.kind));
  assert.notEqual(chosen.key, deadline.key);
  assert.equal(pickMascotThought([], [], () => 0), undefined);
  const curious = thoughts.find(t => t.kind === 'curious');
  assert.ok(!pickMascotThought(thoughts.filter(t => t.kind === 'curious'), [curious], () => 0));
});

test('past timed deadlines stay silent and rest thoughts resume after cycling all phrases', () => {
  const later = now + 10 * 60 * 60_000;
  const thoughts = mascotThoughts(map(task('past', { dueDate: '2026-10-23', dueTime: '09:00' }), task('future', { dueDate: '2026-10-23', dueTime: '11:00' })), later, later, 'UTC');
  assert.deepEqual([...new Set(thoughts.filter(t => t.kind === 'deadline').map(t => t.taskId))], ['future']);
  const rest = mascotThoughts({}, now, now, 'UTC');
  const next = pickMascotThought(rest, rest, () => 0);
  assert.ok(next && next.key !== rest.at(-1).key);
});
