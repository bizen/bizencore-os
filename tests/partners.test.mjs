import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

async function load(path) {
  const { outputFiles } = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
}
const functions = await load('convex/partners.ts');
const { publicPartnerItems, partnerLabels, partnerDisplayRows, partnerInviteCode } = await load('src/lib/partnerModel.ts');

function row(id, parentId = null, fields = {}) {
  return { itemId: id, payload: JSON.stringify({ id, parentId, type: parentId === null ? 'section' : 'task', order: 0, text: id, done: false, ...fields }) };
}

function server() {
  const rows = { accountDeletions: [], partnerAccounts: [], partnerInvites: [], syncItems: [] };
  let subject = 'alice', next = 0;
  const ctx = {
    auth: { getUserIdentity: async () => subject ? { subject, name: subject.toUpperCase() } : null },
    db: {
      query(table) {
        const filters = [];
        const chain = {
          withIndex(_name, apply) { const q = { eq: (key, value) => { filters.push([key, value]); return q; } }; apply(q); return chain; },
          collect: async () => rows[table].filter(row => filters.every(([key, value]) => row[key] === value)),
          unique: async () => { const found = await chain.collect(); assert.ok(found.length <= 1); return found[0] ?? null; },
        };
        return chain;
      },
      insert: async (table, data) => { const id = `${table}:${++next}`; rows[table].push({ ...data, _id: id }); return id; },
      patch: async (id, data) => {
        const target = Object.values(rows).flat().find(row => row._id === id); assert.ok(target);
        for (const [key, value] of Object.entries(data)) { if (value === undefined) delete target[key]; else target[key] = value; }
      },
      delete: async id => { for (const table of Object.keys(rows)) rows[table] = rows[table].filter(row => row._id !== id); },
    },
  };
  const call = (name, args = {}) => functions[name]._handler(ctx, { accountId: subject, ...args });
  return { rows, call, identify: value => { subject = value; },
    add: (userId, source) => rows.syncItems.push({ ...source, userId }),
    pair: async () => {
      subject = 'alice'; const invite = await call('createInvite');
      subject = 'bob'; await call('acceptInvite', { code: invite.code });
      return invite;
    },
  };
}

test('public DTO whitelists fields and only follows live, explicitly shared root labels', () => {
  const secret = { note: 'secret-note', completionCriteria: 'secret-criteria', attachments: [{ title: 'secret-file', url: 'https://secret.test' }], createdByClient: 'private-agent', assignedDate: '2026-10-07', estimate: 55, stamps: { text: 999 } };
  const rows = [row('public', null, { color: 'green', ...secret }), row('task', 'public', { ...secret, dueDate: '2026-10-08', dueTime: '18:30' }),
    row('child', 'task'), row('private'), row('hidden', 'private'), row('unlabeled', null, { type: 'task' }),
    { ...row('deleted'), deletedAt: 0 }, row('deleted-child', 'deleted'), row('orphan', 'missing'),
    row('dead-task', 'public', { deletedAt: 1 }), row('dead-child', 'dead-task'),
    row('nested-label', 'public', { type: 'section' }), row('nested-task', 'nested-label'),
    { itemId: 'broken', payload: '{' }, { itemId: 'wrong', payload: row('fake', 'public').payload }];
  assert.deepEqual(publicPartnerItems(rows, []), []);
  const publicItems = publicPartnerItems(rows, ['public', 'unlabeled', 'missing', 'deleted']);
  assert.deepEqual(publicItems.map(item => item.id), ['public', 'task', 'child']);
  assert.deepEqual(Object.keys(publicItems[1]).sort(), ['id', 'type', 'parentId', 'order', 'text', 'done', 'dueDate', 'dueTime'].sort());
  assert.ok(!JSON.stringify(publicItems).includes('secret'));
  assert.ok(!JSON.stringify(publicItems).includes('private-agent'));
  assert.deepEqual(partnerLabels(rows).map(label => label.id), ['private', 'public']);
});

test('malformed deadline/color payloads never become public fields and deep trees stay iterative', () => {
  const rows = [row('label', null, { color: 'url(secret)' }), row('bad', 'label', { dueDate: '2026-02-30', dueTime: '25:99' })];
  for (let i = 0; i < 2000; i++) rows.push(row(`deep-${i}`, i ? `deep-${i - 1}` : 'bad'));
  const items = publicPartnerItems(rows, ['label']);
  assert.equal(items.length, 2002);
  assert.equal(items[0].color, undefined); assert.equal(items[1].dueDate, undefined);
  assert.equal(partnerDisplayRows(items).active.at(-1).depth, 2001);
});

test('completed tasks remain in place and only filed completed subtrees enter the shelf', () => {
  const items = publicPartnerItems([row('label'), row('done', 'label', { done: true, order: 1 }),
    row('filed', 'label', { done: true, filed: true, order: 2 }), row('filed-child', 'filed', { done: true }),
    row('next', 'label', { order: 3 }), row('unfinished', 'label', { filed: true, order: 4 })], ['label']);
  const { active, done } = partnerDisplayRows(items);
  assert.deepEqual(active.map(row => row.item.id), ['label', 'done', 'next', 'unfinished']);
  assert.deepEqual(done.map(row => [row.item.id, row.depth]), [['filed', 0], ['filed-child', 1]]);
});

test('locked containers are never displayed as complete or filed, even with inconsistent old payloads', () => {
  const items = publicPartnerItems([row('label'), row('locked', 'label', { locked: true, done: true, filed: true })], ['label']);
  assert.equal(items[1].locked, true); assert.equal(items[1].done, false); assert.equal(items[1].filed, undefined);
  assert.deepEqual(partnerDisplayRows(items).done, []);
});

test('invite parsing does not navigate and rejects executable or malformed links', () => {
  const code = 'a'.repeat(64);
  assert.equal(partnerInviteCode(code), code);
  assert.equal(partnerInviteCode(`https://app.bizencore.com/#partner-invite=${code}`), code);
  for (const value of ['javascript:alert(1)', 'data:text/html,evil', 'file:///tmp/#partner-invite=' + code, 'a'.repeat(63), 'https://example.test/?partner-invite=' + code]) assert.equal(partnerInviteCode(value), null);
});

test('authenticated mutual acceptance starts private and consumes invitations from both parties', async () => {
  const s = server();
  s.add('alice', row('alice-label')); s.add('bob', row('bob-label'));
  const invite = await s.call('createInvite');
  assert.match(invite.code, /^[a-f0-9]{64}$/);
  assert.ok(invite.expiresAt > Date.now());
  assert.equal(await s.call('previewInvite', { code: invite.code }), null, 'self cannot preview acceptance');
  s.identify('bob'); await s.call('createInvite');
  assert.deepEqual(await s.call('previewInvite', { code: invite.code }), { name: 'ALICE', expiresAt: invite.expiresAt });
  await s.call('acceptInvite', { code: invite.code });
  assert.equal(s.rows.partnerInvites.length, 0);
  assert.equal((await s.call('state')).partner.name, 'ALICE');
  assert.deepEqual((await s.call('list')).items, []);
  for (const profile of s.rows.partnerAccounts) assert.deepEqual(profile.sharedLabelIds, []);
  await assert.rejects(s.call('acceptInvite', { code: invite.code }));
});

test('unauthenticated, stale-account and third-party reads cannot access either partner', async () => {
  const s = server(); await s.pair();
  s.add('alice', row('label')); s.add('alice', row('task', 'label', { note: 'private' }));
  s.identify('alice'); await s.call('setLabelSharing', { labelId: 'label', shared: true });
  s.identify('bob'); assert.equal((await s.call('list')).items.length, 2);
  for (const identity of ['eve', null]) {
    s.identify(identity);
    for (const name of ['list', 'state']) {
      assert.equal(await s.call(name, { accountId: 'bob' }), null);
    }
    assert.equal(await s.call('list', { accountId: identity ?? 'anonymous' }), null);
    const ownState = await s.call('state', { accountId: identity ?? 'anonymous' });
    if (identity) { assert.deepEqual(ownState.labels, []); assert.equal(ownState.partner, null); }
    else assert.equal(ownState, null);
    assert.equal(await s.call('previewInvite', { accountId: 'bob', code: 'a'.repeat(64) }), null);
    for (const [name, args] of [['createInvite', {}], ['cancelInvite', {}], ['acceptInvite', { code: 'a'.repeat(64) }], ['disconnect', {}], ['setLabelSharing', { labelId: 'label', shared: true }]]) await assert.rejects(s.call(name, { ...args, accountId: 'bob' }));
  }
});

test('sharing validates ownership/root status and revocation, reparenting, deletion are reflected at read time', async () => {
  const s = server(); await s.pair();
  s.add('alice', row('public')); s.add('alice', row('private')); s.add('alice', row('task', 'public'));
  s.add('alice', row('child', 'task')); s.add('bob', row('foreign'));
  s.identify('alice');
  for (const labelId of ['task', 'foreign', 'missing']) await assert.rejects(s.call('setLabelSharing', { labelId, shared: true }));
  await s.call('setLabelSharing', { labelId: 'public', shared: true });
  await s.call('setLabelSharing', { labelId: 'public', shared: true });
  assert.deepEqual((await s.call('state')).sharedLabelIds, ['public']);
  s.identify('bob'); assert.deepEqual((await s.call('list')).items.map(item => item.id), ['public', 'task', 'child']);
  const taskRow = s.rows.syncItems.find(row => row.itemId === 'task');
  taskRow.payload = row('task', 'private').payload;
  assert.deepEqual((await s.call('list')).items.map(item => item.id), ['public']);
  taskRow.payload = row('task', 'public').payload;
  s.rows.syncItems.find(row => row.itemId === 'public').deletedAt = 1;
  assert.deepEqual((await s.call('list')).items, []);
  delete s.rows.syncItems.find(row => row.itemId === 'public').deletedAt;
  s.add('alice', row('new-label')); s.add('alice', row('new-secret', 'new-label'));
  assert.ok(!(await s.call('list')).items.some(item => item.id === 'new-label'));
  s.identify('alice'); await s.call('setLabelSharing', { labelId: 'public', shared: false });
  s.identify('bob'); assert.deepEqual((await s.call('list')).items, []);
});

test('expired, rotated, cancelled and already-paired invites reject without changing partnerships', async () => {
  const s = server(); const first = await s.call('createInvite'); const second = await s.call('createInvite');
  s.identify('bob'); assert.equal(await s.call('previewInvite', { code: first.code }), null);
  await assert.rejects(s.call('acceptInvite', { code: first.code }));
  s.rows.partnerInvites[0].expiresAt = Date.now() - 1;
  assert.equal(await s.call('previewInvite', { code: second.code }), null);
  await assert.rejects(s.call('acceptInvite', { code: second.code }));
  assert.ok(s.rows.partnerAccounts.every(profile => !profile.partnerId));
  s.identify('alice'); const cancelled = await s.call('createInvite'); await s.call('cancelInvite');
  s.identify('bob'); await assert.rejects(s.call('acceptInvite', { code: cancelled.code }));
  await s.pair();
  s.identify('eve'); const eveInvite = await s.call('createInvite');
  s.identify('bob'); await assert.rejects(s.call('acceptInvite', { code: eveInvite.code }));
  await assert.rejects(s.call('createInvite'));
  assert.equal((await s.call('state')).partner.name, 'ALICE');
  s.identify('eve'); assert.equal(await s.call('list'), null);
});

test('disconnect revokes both directions and reconnect never restores previous label sharing', async () => {
  const s = server(); await s.pair();
  for (const userId of ['alice', 'bob']) { s.identify(userId); s.add(userId, row(userId + '-label')); await s.call('setLabelSharing', { labelId: userId + '-label', shared: true }); }
  const tasksBefore = structuredClone(s.rows.syncItems);
  s.identify('alice'); await s.call('disconnect');
  for (const userId of ['alice', 'bob']) { s.identify(userId); assert.equal(await s.call('list'), null); assert.deepEqual((await s.call('state')).sharedLabelIds, []); }
  assert.deepEqual(s.rows.syncItems, tasksBefore, 'disconnect never writes task data');
  await s.pair(); assert.deepEqual((await s.call('list')).items, []);
});

test('one-sided corrupted connections fail closed', async () => {
  const s = server(); await s.pair();
  s.rows.partnerAccounts.find(profile => profile.userId === 'alice').partnerId = 'eve';
  assert.equal(await s.call('list'), null);
  assert.equal((await s.call('state')).partner, null);
  await assert.rejects(s.call('setLabelSharing', { labelId: 'anything', shared: false }));
});
