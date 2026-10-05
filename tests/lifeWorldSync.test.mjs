import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

async function load(path) {
  const { outputFiles } = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
}
const { lifeWorldPull, lifeWorldPush } = await load('convex/sync.ts');
const { createLifeWorldStore } = await load('src/lib/lifeWorldStore.ts');
const { emptyLifeData, lifePendingChanges, lifeWeek, lifeCheckKey } = await load('src/lib/lifeWorldModel.ts');
function storage() {
  const map = new Map();
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) };
}
function server() {
  const rows = { lifeEntries: [], lifeChecks: [] };
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
