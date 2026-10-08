import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { getFunctionName } from 'convex/server';

async function load(path) {
  const { outputFiles } = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
}
const functions = await load('convex/accountDeletion.ts');
const sync = await load('convex/sync.ts');
const stocks = await load('convex/countStocks.ts');
const partners = await load('convex/partners.ts');
const mcp = await load('convex/mcpTasks.ts');
const { default: schema } = await load('convex/schema.ts');
const { createLifeWorldStore } = await load('src/lib/lifeWorldStore.ts');

function server() {
  const rows = Object.fromEntries(Object.keys(schema.tables).map(table => [table, []]));
  const schedules = [], deletedFiles = [];
  let subject = 'alice', next = 0;
  const ctx = {
    auth: { getUserIdentity: async () => subject ? { subject, name: subject } : null },
    db: {
      system: { get: async id => deletedFiles.includes(id) ? null : { _id: id } },
      query(table) {
        const filters = [];
        const chain = {
          withIndex(_index, apply) { const q = { eq(key, value) { filters.push([key, value]); return q; } }; apply(q); return chain; },
          collect: async () => rows[table].filter(row => filters.every(([key, value]) => row[key] === value)),
          unique: async () => { const data = await chain.collect(); assert.ok(data.length <= 1); return data[0] ?? null; },
          take: async limit => (await chain.collect()).slice(0, limit),
          first: async () => (await chain.collect())[0] ?? null,
        }; return chain;
      },
      insert: async (table, data) => { const id = `${table}:${++next}`; rows[table].push({ ...data, _id: id }); return id; },
      patch: async (id, data) => {
        const row = Object.values(rows).flat().find(row => row._id === id); assert.ok(row);
        for (const [key, value] of Object.entries(data)) { if (value === undefined) delete row[key]; else row[key] = value; }
      },
      delete: async id => { for (const table of Object.keys(rows)) rows[table] = rows[table].filter(row => row._id !== id); },
      get: async id => Object.values(rows).flat().find(row => row._id === id) ?? null,
    },
    scheduler: { runAfter: async (delay, ref, args) => schedules.push({ delay, ref, args }) },
    storage: { delete: async id => deletedFiles.push(id) },
    runQuery: async (ref, args) => functions[getFunctionName(ref).split(':')[1]]._handler(ctx, args),
    runMutation: async (ref, args) => functions[getFunctionName(ref).split(':')[1]]._handler(ctx, args),
  };
  return { rows, ctx, schedules, deletedFiles, identify: value => { subject = value; },
    call: (name, args = {}) => functions[name]._handler(ctx, args),
    runNext: async () => {
      const index = schedules.findIndex(job => getFunctionName(job.ref) === 'accountDeletion:worker');
      assert.ok(index >= 0); const [next] = schedules.splice(index, 1);
      await functions.worker._handler(ctx, next.args); return next;
    },
    hasWorker: () => schedules.some(job => getFunctionName(job.ref) === 'accountDeletion:worker'),
  };
}

// All network is mocked. Never call Clerk or delete a real account in tests.
async function clerkFixture(run, { key = 'fixture-only-key', fetcher = async () => Response.json({ id: 'alice' }) } = {}) {
  const oldKey = process.env.CLERK_SECRET_KEY, oldFetch = globalThis.fetch;
  if (key) process.env.CLERK_SECRET_KEY = key; else delete process.env.CLERK_SECRET_KEY;
  globalThis.fetch = fetcher;
  try { await run(); }
  finally { globalThis.fetch = oldFetch; if (oldKey === undefined) delete process.env.CLERK_SECRET_KEY; else process.env.CLERK_SECRET_KEY = oldKey; }
}

test('deletion requires the current authenticated account, exact confirmation, configured key and verified Clerk user', async () => {
  await clerkFixture(async () => {
    const s = server();
    const args = { expectedAccountId: 'alice', confirmation: '削除' };
    s.identify(null);
    assert.equal(await s.call('status'), null);
    await assert.rejects(s.call('request', args), /サインイン/);
    s.identify('bob'); await assert.rejects(s.call('request', args), /アカウント/);
    s.identify('alice'); await assert.rejects(s.call('request', { ...args, confirmation: 'delete' }), /確認欄/);
    assert.equal(s.rows.accountDeletions.length, 0);
    assert.equal(s.schedules.length, 0);
  });
  for (const options of [{ key: '' }, { fetcher: async () => new Response('', { status: 401 }) },
    { fetcher: async () => Response.json({ id: 'bob' }) }, { fetcher: async () => { throw new Error('offline'); } }]) {
    await clerkFixture(async () => {
      const s = server(); await s.ctx.db.insert('syncItems', { userId: 'alice', payload: 'untouched' });
      await assert.rejects(s.call('request', { expectedAccountId: 'alice', confirmation: '削除' }), /データは削除していません/);
      assert.equal(s.rows.syncItems[0].payload, 'untouched'); assert.equal(s.rows.accountDeletions.length, 0);
      assert.equal(s.schedules.length, 0);
    }, options);
  }
});

test('deletion detaches partners, deletes every account table in bounded batches and preserves other accounts', async () => {
  const requests = [];
  await clerkFixture(async () => {
    const s = server();
    for (const table of Object.keys(s.rows).filter(table => table !== 'accountDeletions')) {
      for (const userId of ['alice', 'bob']) {
        const fields = table === 'partnerInvites' ? { ownerId: userId } : { userId };
        if (table === 'fileOwners') fields.storageId = `${userId}-file`;
        if (table === 'partnerAccounts') Object.assign(fields, { partnerId: userId === 'alice' ? 'bob' : 'alice', sharedLabelIds: ['label'], name: userId });
        await s.ctx.db.insert(table, fields);
      }
    }
    for (let n = 0; n < 75; n++) await s.ctx.db.insert('syncItems', { userId: 'alice', itemId: `task-${n}` });
    const args = { expectedAccountId: 'alice', confirmation: '削除' };
    assert.deepEqual(await s.call('request', args), { phase: 'data' });
    assert.deepEqual(await s.call('request', args), { phase: 'data' });
    assert.equal(s.schedules.length, 2, 'duplicate requests do not create a second worker/watchdog');
    const peer = s.rows.partnerAccounts.find(row => row.userId === 'bob');
    assert.equal(peer.partnerId, undefined); assert.deepEqual(peer.sharedLabelIds, []);
    let steps = 0;
    while (s.hasWorker()) {
      const before = Object.values(s.rows).flat().length;
      await s.runNext(); assert.ok(before - Object.values(s.rows).flat().length <= 25, 'batch remains bounded');
      assert.ok(++steps < 50);
    }
    for (const [table, rows] of Object.entries(s.rows)) {
      if (table === 'accountDeletions') continue;
      assert.equal(rows.length, 1, table); assert.equal(rows[0].userId ?? rows[0].ownerId, 'bob', table);
    }
    assert.deepEqual(s.deletedFiles, ['alice-file']);
    assert.equal(s.rows.accountDeletions[0].phase, 'complete');
    assert.deepEqual(Object.keys(s.rows.accountDeletions[0]).sort(), ['_id', 'attempts', 'phase', 'retrying', 'updatedAt', 'userId', 'nextAttemptAt'].sort(), 'no task content or identity profile retained');
    const before = requests.length; await s.call('worker', { userId: 'alice' }); assert.equal(requests.length, before, 'completed worker is idempotent');
    assert.equal(requests.filter(row => row.method === 'DELETE').length, 1);
    assert.match(requests[0].url, /^https:\/\/api.clerk.com\/v1\/users\/alice$/);
  }, { fetcher: async (url, init) => { requests.push({ url, method: init.method }); return Response.json({ id: 'alice' }); } });
});

test('background failures retry without reporting completion; an already deleted Clerk identity is safe', async () => {
  await clerkFixture(async () => {
    const s = server(); await s.call('begin', { userId: 'alice' });
    await s.runNext(); assert.equal(s.rows.accountDeletions[0].phase, 'identity');
    await s.runNext(); assert.equal(s.rows.accountDeletions[0].phase, 'identity');
    assert.equal(s.rows.accountDeletions[0].retrying, true); assert.equal(s.schedules.at(-1).delay, 60000);
    await s.runNext(); assert.equal(s.schedules.at(-1).delay, 120000);
    globalThis.fetch = async () => new Response('', { status: 404 });
    await s.runNext(); assert.equal(s.rows.accountDeletions[0].phase, 'complete');
    assert.equal(s.rows.accountDeletions[0].retrying, false);
  }, { fetcher: async () => new Response('', { status: 503 }) });
  await clerkFixture(async () => {
    const s = server(); await s.ctx.db.insert('fileOwners', { userId: 'alice', storageId: 'owned' });
    await s.call('begin', { userId: 'alice' });
    s.ctx.storage.delete = async () => { throw new Error('storage offline'); };
    await s.runNext(); assert.equal(s.rows.fileOwners.length, 1); assert.equal(s.rows.accountDeletions[0].phase, 'data');
    assert.equal(s.rows.accountDeletions[0].retrying, true);
    s.ctx.storage.delete = async id => s.deletedFiles.push(id);
    while (s.hasWorker()) await s.runNext();
    assert.equal(s.rows.accountDeletions[0].phase, 'complete');
  });
});

test('pending and completed deletion block stale sync, imports, MCP, partner writes and saved texts', async () => {
  const s = server(); await s.call('begin', { userId: 'alice' });
  for (const phase of ['data', 'identity', 'complete']) {
    s.rows.accountDeletions[0].phase = phase;
    for (const [fn, args] of [[sync.push, { items: [] }], [sync.importLegacy, {}],
      [sync.setTimeZone, { timeZone: 'UTC', automatic: true }], [sync.lifeWorldPush, { accountId: 'alice', entries: [], checks: [] }],
      [sync.touchMcpConnection, { userId: 'alice', clientId: 'codex' }],
      [stocks.add, { text: 'stale' }], [stocks.mergeLocalStocks, { entries: [] }], [stocks.remove, { id: 'foreign' }],
      [partners.createInvite, { accountId: 'alice' }], [partners.setLabelSharing, { accountId: 'alice', labelId: 'label', shared: true }],
      [mcp.add, { userId: 'alice', text: 'stale', idempotencyKey: 'old' }], [mcp.list, { userId: 'alice' }],
      [mcp.attachFile, { userId: 'alice', taskId: 'old', attachmentId: 'file', storageId: 'new', title: 'new', size: 5, mimeType: 'text/plain' }]]) {
      await assert.rejects(fn._handler(s.ctx, args), /削除中、または削除済み/);
    }
    assert.equal(await sync.pull._handler(s.ctx, {}), null);
    assert.equal(await sync.lifeWorldPull._handler(s.ctx, { accountId: 'alice' }), null);
    assert.equal(await sync.listMcpConnections._handler(s.ctx, {}), null);
    assert.deepEqual(await stocks.list._handler(s.ctx, {}), []);
    assert.equal(await partners.state._handler(s.ctx, { accountId: 'alice' }), null);
    assert.equal(s.rows.syncItems.length, 0);
  }
  s.identify('bob'); await stocks.add._handler(s.ctx, { text: 'untouched account' });
  assert.equal(s.rows.countStocks[0].userId, 'bob');
});

test('account-specific life cache clears its undo history without deleting guest or another account', () => {
  const map = new Map();
  const store = createLifeWorldStore({ getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) });
  const guest = store.add('2026-10-09'); store.setText(guest, 'Guest');
  store.setAccount('alice'); const alice = store.add('2026-10-09'); store.setText(alice, 'Private');
  store.setAccount('bob'); const bob = store.add('2026-10-09'); store.setText(bob, 'Other');
  const bobBefore = map.get('bizencore.life-world.account.bob.v1');
  const guestBefore = map.get('bizencore.life-world.local.v1');
  store.setAccount('alice'); store.clearAccount('alice'); store.undo();
  assert.deepEqual(store.getSnapshot().data.entries, {}); assert.equal(store.getSnapshot().canUndo, false);
  assert.equal(map.get('bizencore.life-world.account.bob.v1'), bobBefore);
  assert.equal(map.get('bizencore.life-world.local.v1'), guestBefore);
});

test('watchdog recovers a crashed action without bypassing retry backoff and stops after completion', async () => {
  const s = server(); await s.call('begin', { userId: 'alice' });
  s.schedules.length = 0;
  s.rows.accountDeletions[0].nextAttemptAt = Date.now() - 120001;
  await s.call('watchdog', { userId: 'alice' });
  assert.equal(s.hasWorker(), true); assert.equal(s.rows.accountDeletions[0].retrying, true);
  s.schedules.length = 0; s.rows.accountDeletions[0].nextAttemptAt = Date.now() + 3600000;
  await s.call('watchdog', { userId: 'alice' });
  assert.equal(s.hasWorker(), false); assert.equal(s.schedules.length, 1); assert.ok(s.schedules[0].delay >= 3600000);
  s.schedules.length = 0; s.rows.accountDeletions[0].phase = 'complete';
  await s.call('watchdog', { userId: 'alice' }); assert.equal(s.schedules.length, 0);
});
