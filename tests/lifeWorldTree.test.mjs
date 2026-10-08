import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

async function load(path) {
  const { outputFiles } = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
}
const model = await load('src/lib/lifeWorldModel.ts');
const { createLifeWorldStore } = await load('src/lib/lifeWorldStore.ts');
const date = '2026-10-09';
function store() {
  const data = new Map();
  return createLifeWorldStore({ getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) });
}
const ids = value => model.lifeTreeRows(value.getSnapshot().data, date, true).map(row => [row.entry.id, row.depth]);

test('Enter-style sibling insertion keeps subtrees together; children inherit the container repeat', () => {
  const s = store();
  const root = s.add(date); s.setText(root, 'Grocery shopping'); s.setLocked(root, true, date);
  const child = s.add(date, root, true, true); s.setText(child, 'Milk');
  const next = s.add(date, child, true); s.setText(next, 'Eggs');
  const grandchild = s.add(date, child, true, true);
  const second = s.add(date, root, true);
  assert.deepEqual(ids(s), [[root, 0], [child, 1], [grandchild, 2], [next, 1], [second, 0]]);
  assert.equal(s.getSnapshot().data.entries[next].parentId, root);
  s.setRepeat(root, 'daily');
  const habit = s.add(date, root, true, true);
  assert.equal(s.getSnapshot().data.entries[habit].repeat, 'daily');
  assert.equal(s.getSnapshot().data.entries[child].repeat, 'once', 'existing schedules are not silently changed');
  const normalized = model.coerceLifeData(JSON.parse(JSON.stringify(s.getSnapshot().data)));
  assert.deepEqual(model.lifeTreeRows(normalized).map(row => [row.entry.id, row.depth]), ids(s));
});

test('indent, outdent and sibling movement preserve descendants and undo a whole operation', () => {
  const s = store();
  const a = s.add(date), b = s.add(date), c = s.add(date);
  const child = s.add(date, b, true, true);
  assert.equal(s.indent(a), false);
  assert.equal(s.indent(b), true);
  assert.deepEqual(ids(s), [[a, 0], [b, 1], [child, 2], [c, 0]]);
  s.move(a, date, 1, true);
  assert.deepEqual(ids(s), [[c, 0], [a, 0], [b, 1], [child, 2]]);
  s.undo();
  assert.deepEqual(ids(s), [[a, 0], [b, 1], [child, 2], [c, 0]]);
  assert.equal(s.outdent(b), true);
  assert.deepEqual(ids(s), [[a, 0], [b, 0], [child, 1], [c, 0]]);
  s.undo();
  assert.deepEqual(ids(s), [[a, 0], [b, 1], [child, 2], [c, 0]]);
  assert.equal(s.outdent(a), false);
});

test('depth limits apply to both direct child creation and moving an existing subtree', () => {
  const s = store();
  const root = s.add(date);
  let last = root;
  for (let i = 0; i < 4; i++) last = s.add(date, last, true, true);
  assert.equal(s.add(date, last, true, true), undefined);
  const sibling = s.add(date, last, true);
  assert.equal(s.indent(sibling), false);
  assert.equal(ids(s).at(-1)[1], 4);
});

test('completion cascades, but a locked descendant blocks its ancestors, not its own unlocked children', () => {
  const s = store();
  const root = s.add(date), child = s.add(date, root, true, true), leaf = s.add(date, child, true, true);
  s.toggle(root, date, true);
  assert.ok([root, child, leaf].every(id => model.lifeEntryDone(s.getSnapshot().data, s.getSnapshot().data.entries[id], date)));
  s.undo(); assert.deepEqual(s.getSnapshot().data.checks[model.lifeCheckKey(leaf, date)].done, false);
  s.setLocked(child, true, date);
  const before = s.getSnapshot().data;
  s.toggle(root, date, true); assert.deepEqual(s.getSnapshot().data, before);
  s.toggle(leaf, date, true);
  assert.equal(model.lifeEntryDone(s.getSnapshot().data, s.getSnapshot().data.entries[leaf], date), true);
  assert.equal(model.lifeCompletionBlocked(s.getSnapshot().data, root), true);
  s.setLocked(child, false, date); s.toggle(root, date, true);
  assert.ok([root, child, leaf].every(id => model.lifeEntryDone(s.getSnapshot().data, s.getSnapshot().data.entries[id], date)));
});

test('habit subtask checks reset daily without discarding history; one-off children carry forward', () => {
  const s = store();
  const root = s.add(date); s.setRepeat(root, 'daily');
  const child = s.add(date, root, true, true);
  s.toggle(root, date, true);
  assert.equal(model.lifeEntryDone(s.getSnapshot().data, s.getSnapshot().data.entries[child], '2026-10-10'), false);
  assert.equal(model.lifeWeek(s.getSnapshot().data, s.getSnapshot().data.entries[child], date).at(-1).done, true);
  s.setRepeat(child, 'once');
  assert.equal(model.lifeEntryDone(s.getSnapshot().data, s.getSnapshot().data.entries[child], '2026-10-10'), true);
});

test('subtree deletion includes future children, preserves check history and can be undone', () => {
  const s = store();
  const root = s.add(date), child = s.add(date, root, true, true), other = s.add(date);
  const future = s.add('2026-10-10', child, true, true);
  s.toggle(child, date, true);
  s.remove(root);
  assert.deepEqual(ids(s), [[other, 0]]);
  assert.ok(s.getSnapshot().data.entries[future].deletedAt);
  s.undo();
  assert.deepEqual(ids(s), [[root, 0], [child, 1], [other, 0]]);
  assert.equal(model.lifeEntryDone(s.getSnapshot().data, s.getSnapshot().data.entries[child], date), true);
  assert.equal(s.getSnapshot().data.entries[future].deletedAt, undefined);
});

test('hierarchy merges independently of notes and legacy root-only clients cannot erase it', () => {
  const s = store();
  const a = s.add(date), b = s.add(date);
  const original = s.getSnapshot().data.entries[b];
  s.indent(b);
  const indented = s.getSnapshot().data.entries[b];
  const note = model.restampLifeEntry(original, { ...original, note: 'Check the list' }, indented.updatedAt + 10);
  assert.equal(model.mergeLifeEntry(indented, note).parentId, a);
  assert.equal(model.mergeLifeEntry(note, indented).note, 'Check the list');
  const legacy = { ...note, updatedAt: indented.updatedAt + 20, stamps: { ...note.stamps } };
  delete legacy.parentId; delete legacy.stamps.hierarchy;
  assert.equal(model.mergeLifeEntry(indented, legacy).parentId, a);
  const pending = model.lifePendingChanges(s.getSnapshot().data, { version: 1, entries: { [b]: original }, checks: {} });
  assert.ok(pending.entries.some(entry => entry.id === b && entry.parentId === a));
});

test('date and search filters retain ancestor context, and cycles/orphans never lose rows or loop', () => {
  const s = store();
  const root = s.add(date); s.setRepeat(root, 'weekdays');
  const child = s.add(date, root, true, true); s.setRepeat(child, 'once'); s.setText(child, 'Milk');
  assert.deepEqual(model.lifeTreeRows(s.getSnapshot().data, '2026-10-10').map(row => row.entry.id), [root, child]);
  assert.deepEqual(model.lifeTreeRows(s.getSnapshot().data, date, true, 'Milk').map(row => row.entry.id), [root, child]);
  const base = s.getSnapshot().data.entries[root];
  const entries = {
    a: { ...base, id: 'a', parentId: 'b', order: 0 },
    b: { ...base, id: 'b', parentId: 'a', order: 0 },
    orphan: { ...base, id: 'orphan', parentId: 'not-synced-yet', order: 1 },
  };
  const data = { version: 1, entries, checks: {} };
  assert.deepEqual(model.lifeTreeRows(data).map(row => [row.entry.id, row.depth]), [['a', 0], ['b', 1], ['orphan', 0]]);
  assert.deepEqual(model.lifeTreeRows({ ...data, entries: Object.fromEntries(Object.entries(entries).reverse()) }), model.lifeTreeRows(data));
  entries.a.deletedAt = 2;
  assert.deepEqual(model.lifeTreeRows(data).map(row => row.entry.id), ['orphan']);
});
