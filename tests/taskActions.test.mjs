import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

async function load(path) {
  const { outputFiles } = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text + '\n//# sourceURL=' + path).toString('base64')}`);
}
const actions = await load('convex/taskActions.ts');
const tasks = await load('convex/mcpTasks.ts');
const { default: schema } = await load('convex/schema.ts');

function fixture() {
  const rows = Object.fromEntries(Object.keys(schema.tables).map(name => [name, []]));
  let next = 0, subject = 'alice';
  const scheduled = [];
  const ctx = {
    auth: { getUserIdentity: async () => subject ? { subject } : null },
    scheduler: { runAfter: async (...args) => scheduled.push(args) },
    db: {
      query(table) {
        const filters = [];
        const q = { eq(key, value) { filters.push(row => row[key] === value); return q; },
          lt(key, value) { filters.push(row => row[key] < value); return q; } };
        const chain = {
          withIndex(_index, apply) { apply(q); return chain; },
          collect: async () => rows[table].filter(row => filters.every(filter => filter(row))),
          unique: async () => { const found = await chain.collect(); assert.ok(found.length <= 1); return found[0] ?? null; },
          take: async count => (await chain.collect()).slice(0, count),
        };
        return chain;
      },
      insert: async (table, data) => { const id = `${table}-${++next}`; rows[table].push({ _id: id, _creationTime: Date.now(), ...data }); return id; },
      patch: async (id, data) => { const row = Object.values(rows).flat().find(row => row._id === id); assert.ok(row); Object.assign(row, data); },
      delete: async id => { for (const table of Object.keys(rows)) rows[table] = rows[table].filter(row => row._id !== id); },
    },
  };
  const base = { userId: 'alice', clientId: 'cli' };
  return { rows, ctx, scheduled, identify: value => { subject = value; },
    add: args => tasks.add._handler(ctx, { userId: 'alice', ...args }),
    prepare: taskId => actions.prepareDelete._handler(ctx, { ...base, taskId }),
    status: state => actions.statusForClient._handler(ctx, { ...base, taskId: state.task_id, requestId: state.request_id }),
    client: (state, decision = 'approve', override = {}) => actions.decideForClient._handler(ctx, { ...base, taskId: state.task_id, requestId: state.request_id, decision, ...override }),
    web: (state, decision = 'approve', override = {}) => actions.respond._handler(ctx, { expectedAccountId: 'alice', requestId: state.request_id, expectedRevision: state.revision, decision, ...override }),
    get: (state, expectedAccountId = subject) => actions.get._handler(ctx, { expectedAccountId, requestId: state.request_id }),
  };
}

test('pending actions survive re-reads, deduplicate retries and never delete on preparation or viewing', async () => {
  const f = fixture();
  const parent = await f.add({ text: 'Parent' });
  await f.add({ text: 'Child', parentId: parent.id });
  const before = JSON.stringify(f.rows.syncItems);
  const state = await f.prepare(parent.id);
  assert.equal(state.status, 'pending'); assert.equal(state.count, 2);
  assert.deepEqual(await f.prepare(parent.id), state);
  assert.deepEqual(await f.status(state), state);
  assert.deepEqual(await f.get(state), state);
  assert.equal(f.rows.taskActions.length, 1); assert.equal(f.scheduled.length, 2);
  assert.equal(JSON.stringify(f.rows.syncItems), before);
});

test('Web and native form decisions share one atomic, one-use deletion receipt', async () => {
  for (const first of ['web', 'client']) {
    const f = fixture();
    const parent = await f.add({ text: 'Delete me' });
    await f.add({ text: 'Child', parentId: parent.id });
    await f.add({ text: 'Keep me' });
    const state = await f.prepare(parent.id);
    const done = await f[first](state);
    assert.equal(done.status, 'completed'); assert.equal(done.deleted, 2);
    const after = JSON.stringify(f.rows.syncItems);
    assert.equal((await f.web(state)).status, 'completed');
    assert.equal((await f.client(state)).status, 'completed');
    assert.equal((await f.status(state)).status, 'completed');
    assert.equal(JSON.stringify(f.rows.syncItems), after, 'retry never rewrites tombstones or deletes other tasks');
    assert.equal(f.rows.syncItems.filter(row => row.deletedAt).length, 2);
  }
});

test('unapproved, expired, cancelled and changed operations cannot delete', async () => {
  for (const change of ['expired', 'cancelled', 'edit', 'replace-child', 'add-child', 'delete-elsewhere']) {
    const f = fixture();
    const parent = await f.add({ text: 'Parent' });
    const child = await f.add({ text: 'Child', parentId: parent.id });
    const state = await f.prepare(parent.id);
    if (change === 'expired') f.rows.taskActions[0].expiresAt = Date.now() - 1;
    if (change === 'cancelled') await f.web(state, 'cancel');
    if (change === 'edit') await tasks.update._handler(f.ctx, { userId: 'alice', taskId: child.id, note: 'Changed after preview' });
    if (change === 'replace-child') {
      await tasks.remove._handler(f.ctx, { userId: 'alice', taskId: child.id, expectedText: 'Child', expectedCount: 1 });
      await f.add({ text: 'Different child', parentId: parent.id });
    }
    if (change === 'add-child') await f.add({ text: 'New child', parentId: parent.id });
    if (change === 'delete-elsewhere') await tasks.remove._handler(f.ctx, { userId: 'alice', taskId: parent.id, expectedText: 'Parent', expectedCount: 2 });
    const before = JSON.stringify(f.rows.syncItems);
    const expected = change === 'expired' || change === 'cancelled' ? change : 'changed';
    assert.equal((await f.status(state)).status, expected);
    assert.equal((await f.web(state)).status, expected);
    assert.equal((await f.client(state)).status, expected);
    assert.equal(JSON.stringify(f.rows.syncItems), before, change);
    if (expected === 'changed' && change !== 'delete-elsewhere') {
      const fresh = await f.prepare(parent.id);
      assert.notEqual(fresh.request_id, state.request_id); assert.equal(fresh.status, 'pending');
    }
  }
});

test('confirmation binds account, OAuth client, task and reviewed revision', async () => {
  const f = fixture(); const parent = await f.add({ text: 'Private' }); const state = await f.prepare(parent.id);
  const before = JSON.stringify(f.rows.syncItems);
  f.identify(null); await assert.rejects(f.web(state), /アカウント/);
  f.identify('bob'); await assert.rejects(f.web(state), /アカウント/);
  assert.equal(await f.get(state), null);
  await assert.rejects(f.web(state, 'approve', { expectedAccountId: 'bob' }), /見つかりません/);
  await assert.rejects(f.client(state, 'approve', { userId: 'bob' }), /見つかりません/);
  await assert.rejects(f.client(state, 'approve', { clientId: 'another-client' }), /一致/);
  await assert.rejects(f.client(state, 'approve', { taskId: 'another-task' }), /一致/);
  f.identify('alice'); await assert.rejects(f.web(state, 'approve', { expectedRevision: 'forged' }), /一致/);
  await f.ctx.db.insert('accountDeletions', { userId: 'alice' });
  await assert.rejects(f.web(state), /削除中/); await assert.rejects(f.client(state), /削除中/);
  assert.equal(JSON.stringify(f.rows.syncItems), before);
});

test('old action records are purged without touching unexpired requests', async () => {
  const f = fixture(); const parent = await f.add({ text: 'Parent' }); const state = await f.prepare(parent.id);
  const args = { userId: 'alice', requestId: state.request_id };
  await actions.expire._handler(f.ctx, args); assert.equal(f.rows.taskActions[0].status, 'pending');
  f.rows.taskActions[0].expiresAt = Date.now() - 1;
  await actions.expire._handler(f.ctx, args); assert.equal(f.rows.taskActions[0].status, 'expired');
  await actions.cleanup._handler(f.ctx, args); assert.equal(f.rows.taskActions.length, 1);
  f.rows.taskActions[0].createdAt = Date.now() - 86400001;
  await actions.cleanup._handler(f.ctx, args); assert.equal(f.rows.taskActions.length, 0);
  await actions.cleanup._handler(f.ctx, args);
  assert.equal(f.rows.syncItems.filter(row => row.deletedAt).length, 0);
});
