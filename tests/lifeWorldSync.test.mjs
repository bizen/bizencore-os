import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

async function load(path) {
  const { outputFiles } = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
}
const { lifeWorldPull, lifeWorldPush } = await load('convex/sync.ts');
const { createLifeWorldStore } = await load('src/lib/lifeWorldStore.ts');
const { emptyLifeData, lifePendingChanges, lifeTreeRows, lifeWeek, lifeCheckKey } = await load('src/lib/lifeWorldModel.ts');
function storage() {
  const map = new Map();
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) };
}
function server() {
  const rows = { accountDeletions: [], lifeEntries: [], lifeChecks: [], lifePreferences: [] };
  let identity = 'user-a';
  let id = 0;
  return {
    rows, identify: value => { identity = value; },
    ctx: {
      auth: { getUserIdentity: async () => identity ? { subject: identity } : null },
      db: {
        query(table) {
          const filters = [];
          const chain = {
            withIndex(_name, apply) { const q = { eq: (key, value) => { filters.push([key, value]); return q; } }; apply(q); return chain; },
            collect: async () => rows[table].filter(row => filters.every(([key, value]) => row[key] === value)),
            unique: async () => (await chain.collect())[0] ?? null,
          };
          return chain;
        },
        insert: async (table, data) => { const key = `${table}:${++id}`; rows[table].push({ ...data, _id: key, _creationTime: id }); return key; },
        patch: async (key, patch) => {
          assert.ok(!Object.keys(patch).some(key => key.startsWith('_')), 'never patch Convex system fields');
          const row = Object.values(rows).flat().find(row => row._id === key);
          assert.ok(row);
          for (const [field, value] of Object.entries(patch)) {
            if (value === undefined) delete row[field]; else row[field] = value;
          }
        },
      },
    },
  };
}

test('two devices round-trip habits and independent date checks through the authenticated sync handlers', async () => {
  const s = server();
  const a = createLifeWorldStore(storage());
  const b = createLifeWorldStore(storage());
  a.setAccount('user-a'); b.setAccount('user-a');
  const habit = a.add('2026-09-29');
  a.setText(habit, 'ストレッチ'); a.setRepeat(habit, 'daily');
  a.toggle(habit, '2026-10-01');
  const send = async (device, remote) => lifeWorldPush._handler(s.ctx, { accountId: 'user-a', ...lifePendingChanges(device.getSnapshot().data, remote) });
  await send(a, emptyLifeData());
  const first = await lifeWorldPull._handler(s.ctx, { accountId: 'user-a' });
  assert.equal(first.entries[habit].text, 'ストレッチ');
  assert.ok(!JSON.stringify(first).includes('userId'));
  assert.ok(!JSON.stringify(first).includes('_creationTime'));
  a.mergeRemote(first, 'user-a'); b.mergeRemote(first, 'user-a');
  a.setText(habit, 'ゆっくりストレッチ');
  b.setNote(habit, '肩と背中');
  a.toggle(habit, '2026-10-03'); b.toggle(habit, '2026-10-05');
  await send(a, first); await send(b, first);
  const latest = await lifeWorldPull._handler(s.ctx, { accountId: 'user-a' });
  a.mergeRemote(latest, 'user-a'); b.mergeRemote(latest, 'user-a');
  assert.equal(latest.entries[habit].text, 'ゆっくりストレッチ');
  assert.equal(latest.entries[habit].note, '肩と背中');
  assert.equal(Object.values(latest.checks).filter(c => c.done).length, 3);
  assert.deepEqual(lifePendingChanges(a.getSnapshot().data, latest), { entries: [], checks: [] });
  assert.deepEqual(lifePendingChanges(b.getSnapshot().data, latest), { entries: [], checks: [] });
  assert.deepEqual(lifeWeek(latest, latest.entries[habit], '2026-10-05').map(d => d.done), [false, false, true, false, true, false, true]);
});

test('sync handlers isolate accounts and reject unauthorized, stale-account and foreign-entry requests', async () => {
  const s = server();
  const a = createLifeWorldStore(storage()); a.setAccount('user-a');
  const id = a.add('2026-10-05');
  await lifeWorldPush._handler(s.ctx, { accountId: 'user-a', ...lifePendingChanges(a.getSnapshot().data, emptyLifeData()) });
  s.identify('user-b');
  assert.deepEqual(await lifeWorldPull._handler(s.ctx, { accountId: 'user-b' }), emptyLifeData());
  assert.equal(await lifeWorldPull._handler(s.ctx, { accountId: 'user-a' }), null);
  await assert.rejects(lifeWorldPush._handler(s.ctx, { accountId: 'user-a', entries: [], checks: [] }), /Unauthorized/);
  await assert.rejects(lifeWorldPush._handler(s.ctx, { accountId: 'user-b', entries: [], checks: [{ entryId: id, date: '2026-10-05', done: true, updatedAt: 100 }] }), /not found/);
  assert.equal(s.rows.lifeChecks.length, 0);
  s.identify(null);
  assert.equal(await lifeWorldPull._handler(s.ctx, { accountId: 'user-a' }), null);
  await assert.rejects(lifeWorldPush._handler(s.ctx, { accountId: 'user-a', entries: [], checks: [] }), /Unauthorized/);
});

test('stale offline edits cannot resurrect a deleted habit or revert a newer daily check', async () => {
  const s = server();
  const a = createLifeWorldStore(storage()); a.setAccount('user-a');
  const id = a.add('2026-10-01'); a.setRepeat(id, 'daily');
  const original = a.getSnapshot().data.entries[id];
  await lifeWorldPush._handler(s.ctx, { accountId: 'user-a', entries: [original], checks: [] });
  const check = { entryId: id, date: '2026-10-05', done: true, updatedAt: 300 };
  await lifeWorldPush._handler(s.ctx, { accountId: 'user-a', entries: [], checks: [check] });
  await lifeWorldPush._handler(s.ctx, { accountId: 'user-a', entries: [], checks: [{ ...check, done: false, updatedAt: 299 }] });
  a.remove(id);
  await lifeWorldPush._handler(s.ctx, { accountId: 'user-a', entries: [a.getSnapshot().data.entries[id]], checks: [] });
  await lifeWorldPush._handler(s.ctx, { accountId: 'user-a', entries: [original], checks: [] });
  const remote = await lifeWorldPull._handler(s.ctx, { accountId: 'user-a' });
  assert.ok(remote.entries[id].deletedAt);
  assert.equal(remote.checks[lifeCheckKey(id, check.date)].done, true);
  await lifeWorldPush._handler(s.ctx, { accountId: 'user-a', entries: [], checks: [{ ...check, done: false, updatedAt: 301 }] });
  assert.equal((await lifeWorldPull._handler(s.ctx, { accountId: 'user-a' })).checks[lifeCheckKey(id, check.date)].done, false);
});

test('invalid batches are rejected before writing any life entries', async () => {
  const s = server();
  const a = createLifeWorldStore(storage());
  const id = a.add('2026-10-01');
  const entry = a.getSnapshot().data.entries[id];
  for (const invalid of [
    { entries: [entry, { ...entry, id: 'bad', startDate: '2026-02-30' }], checks: [] },
    { entries: [{ ...entry, note: 'x'.repeat(40001) }], checks: [] },
    { entries: [entry], checks: [{ entryId: id, date: '2026-02-30', done: true, updatedAt: 1 }] },
    { entries: Array.from({ length: 101 }, (_, i) => ({ ...entry, id: String(i) })), checks: [] },
    { entries: [entry], checks: [{ entryId: 'missing', date: '2026-10-01', done: true, updatedAt: 1 }] },
  ]) await assert.rejects(lifeWorldPush._handler(s.ctx, { accountId: 'user-a', ...invalid }));
  assert.equal(s.rows.lifeEntries.length, 0);
});

test('All visibility and label placement sync independently, round-trip and remain private to an account', async () => {
  const s = server();
  const a = createLifeWorldStore(storage()); a.setAccount('user-a');
  a.setShowInAll(true); a.moveSection(['a', 'b'], -1);
  const initial = a.getSnapshot().data.preferences;
  await lifeWorldPush._handler(s.ctx, { accountId: 'user-a', entries: [], checks: [], preferences: initial });
  const first = await lifeWorldPull._handler(s.ctx, { accountId: 'user-a' });
  assert.deepEqual(first.preferences, initial);
  assert.ok(!JSON.stringify(first.preferences).includes('userId'));
  await lifeWorldPush._handler(s.ctx, { accountId: 'user-a', entries: [], checks: [], preferences: {
    ...initial, beforeId: 'a', placementStamp: initial.updatedAt + 20, updatedAt: initial.updatedAt + 20 } });
  await lifeWorldPush._handler(s.ctx, { accountId: 'user-a', entries: [], checks: [], preferences: {
    ...initial, showInAll: false, visibilityStamp: initial.updatedAt + 10, updatedAt: initial.updatedAt + 10 } });
  const latest = await lifeWorldPull._handler(s.ctx, { accountId: 'user-a' });
  assert.equal(latest.preferences.beforeId, 'a'); assert.equal(latest.preferences.showInAll, false);
  const b = createLifeWorldStore(storage()); b.setAccount('user-a'); b.mergeRemote(latest, 'user-a');
  assert.deepEqual(lifePendingChanges(b.getSnapshot().data, latest), { entries: [], checks: [] });
  s.identify('user-b');
  assert.equal((await lifeWorldPull._handler(s.ctx, { accountId: 'user-b' })).preferences, undefined);
});

test('server refuses completion of a locked life task, including a same-batch lock, but accepts older historical checks', async () => {
  const s = server();
  const entry = { id: 'locked', text: '買い物', note: '', startDate: '2026-10-05', repeat: 'once', order: 0,
    updatedAt: 200, locked: true, stamps: { lock: 200 } };
  const check = { entryId: entry.id, date: '2026-10-05', done: true, updatedAt: 201 };
  await assert.rejects(lifeWorldPush._handler(s.ctx, { accountId: 'user-a', entries: [entry], checks: [check] }), /locked/);
  assert.equal(s.rows.lifeEntries.length, 0);
  await lifeWorldPush._handler(s.ctx, { accountId: 'user-a', entries: [entry], checks: [{ ...check, updatedAt: 100 }] });
  await assert.rejects(lifeWorldPush._handler(s.ctx, { accountId: 'user-a', entries: [], checks: [check] }), /locked/);
  assert.equal((await lifeWorldPull._handler(s.ctx, { accountId: 'user-a' })).entries[entry.id].locked, true);
  await lifeWorldPush._handler(s.ctx, { accountId: 'user-a', entries: [{ ...entry, locked: undefined, updatedAt: 300, stamps: { lock: 300 } }], checks: [{ ...check, updatedAt: 301 }] });
  assert.equal((await lifeWorldPull._handler(s.ctx, { accountId: 'user-a' })).checks[lifeCheckKey(entry.id, check.date)].done, true);
});

test('nested life tasks synchronize between devices, including child-before-parent batches and legacy edits', async () => {
  const s = server();
  const a = createLifeWorldStore(storage()); a.setAccount('user-a');
  const parent = a.add('2026-10-05'); a.setText(parent, 'Grocery shopping');
  const child = a.add('2026-10-05', parent, true, true); a.setText(child, 'Milk');
  const initial = a.getSnapshot().data;
  await lifeWorldPush._handler(s.ctx, { accountId: 'user-a', entries: [initial.entries[child]], checks: [] });
  let remote = await lifeWorldPull._handler(s.ctx, { accountId: 'user-a' });
  assert.equal(remote.entries[child].parentId, parent, 'retain link until parent batch arrives');
  assert.equal(lifeTreeRows(remote)[0].depth, 0, 'temporary orphan stays accessible');
  await lifeWorldPush._handler(s.ctx, { accountId: 'user-a', entries: [initial.entries[parent]], checks: [] });
  remote = await lifeWorldPull._handler(s.ctx, { accountId: 'user-a' });
  const b = createLifeWorldStore(storage()); b.setAccount('user-a'); b.mergeRemote(remote, 'user-a');
  assert.deepEqual(lifeTreeRows(b.getSnapshot().data).map(row => [row.entry.id, row.depth]), [[parent, 0], [child, 1]]);
  const legacy = { ...remote.entries[child], note: 'Organic', updatedAt: initial.entries[child].updatedAt + 100,
    stamps: { ...remote.entries[child].stamps, note: initial.entries[child].updatedAt + 100 } };
  delete legacy.parentId; delete legacy.stamps.hierarchy;
  await lifeWorldPush._handler(s.ctx, { accountId: 'user-a', entries: [legacy], checks: [] });
  remote = await lifeWorldPull._handler(s.ctx, { accountId: 'user-a' });
  assert.equal(remote.entries[child].parentId, parent); assert.equal(remote.entries[child].note, 'Organic');
  b.remove(parent);
  await lifeWorldPush._handler(s.ctx, { accountId: 'user-a', ...lifePendingChanges(b.getSnapshot().data, remote) });
  assert.deepEqual(lifeTreeRows(await lifeWorldPull._handler(s.ctx, { accountId: 'user-a' })), []);
});

test('a locked descendant blocks parent completion on the server, but not independent child completion', async () => {
  const s = server();
  const parent = { id: 'parent', text: 'List', note: '', startDate: '2026-10-05', repeat: 'once', order: 0, updatedAt: 100 };
  const locked = { ...parent, id: 'locked-child', parentId: parent.id, locked: true, updatedAt: 200, stamps: { lock: 200 } };
  const leaf = { ...parent, id: 'leaf', parentId: locked.id };
  const check = { entryId: parent.id, date: '2026-10-05', done: true, updatedAt: 201 };
  await assert.rejects(lifeWorldPush._handler(s.ctx, { accountId: 'user-a', entries: [parent, locked, leaf], checks: [check] }), /locked/);
  assert.equal(s.rows.lifeEntries.length, 0);
  await lifeWorldPush._handler(s.ctx, { accountId: 'user-a', entries: [parent, locked, leaf], checks: [] });
  await assert.rejects(lifeWorldPush._handler(s.ctx, { accountId: 'user-a', entries: [], checks: [check] }), /locked/);
  await lifeWorldPush._handler(s.ctx, { accountId: 'user-a', entries: [], checks: [{ ...check, entryId: leaf.id }] });
  assert.equal((await lifeWorldPull._handler(s.ctx, { accountId: 'user-a' })).checks[lifeCheckKey(leaf.id, check.date)].done, true);
  for (const entry of [{ ...parent, parentId: parent.id }, { ...parent, parentId: 'x'.repeat(257) }]) {
    await assert.rejects(lifeWorldPush._handler(s.ctx, { accountId: 'user-a', entries: [entry], checks: [] }), /Invalid life entry/);
  }
});
