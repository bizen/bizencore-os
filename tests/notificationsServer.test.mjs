import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { getFunctionName } from 'convex/server';
const { outputFiles } = await build({ entryPoints: ['convex/notifications.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const functions = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
const id = '662a5ff1-a990-4c90-a9bd-2a773844da3c';
const prefs = { deadline: true, morning: false, completion: true, morningTime: '09:00' };
function server(now = Date.parse('2026-10-23T09:00:00Z')) {
  const rows = { notificationDevices: [], notificationDeliveries: [], syncItems: [], userPreferences: [{ _id: 'prefs', userId: 'alice', timeZone: 'UTC' }], accountDeletions: [] };
  let account = 'alice', sequence = 0; const jobs = [];
  const ctx = { auth: { getUserIdentity: async () => account ? { subject: account } : null },
    db: { get: async id => Object.values(rows).flat().find(r => r._id === id) ?? null,
      insert: async (table, value) => { const _id = `id${++sequence}`; rows[table].push({ _id, ...value }); return _id; },
      patch: async (id, value) => Object.assign(await ctx.db.get(id), value),
      delete: async id => { for (const table in rows) rows[table] = rows[table].filter(r => r._id !== id); },
      query: table => {
        const checks = []; const chain = { withIndex(_name, apply) {
          const q = Object.fromEntries(['eq','lt','gt','lte'].map(op => [op, (key, value) => { checks.push(row => {
            const a = key.split('.').reduce((r, k) => r?.[k], row);
            return op === 'eq' ? a === value : op === 'lt' ? a < value : op === 'gt' ? a > value : a <= value;
          }); return q; }])); apply(q); return chain;
        }, collect: async () => rows[table].filter(row => checks.every(check => check(row))),
          take: async n => (await chain.collect()).slice(0,n), unique: async () => { const r = await chain.collect(); assert.ok(r.length <= 1); return r[0] ?? null; } }; return chain;
      } }, scheduler: { runAfter: async (delay, ref, args) => jobs.push({ delay, name: getFunctionName(ref), args }) } };
  return { rows, jobs, now, ctx, identify: value => { account = value; }, call: (name, args = {}) => functions[name]._handler(ctx, args),
    seed: value => rows.syncItems.push({ _id: `task${++sequence}`, userId: 'alice', itemId: value.id, updatedAt: value.updatedAt ?? now, payload: JSON.stringify({ type: 'task', parentId: null, order: 0, text: value.id, done: false, createdAt: 1, ...value }) }) };
}

test('registration is opt-in, account-scoped, validates settings and refuses unsafe subscriptions', async t => {
  const s = server();t.mock.method(Date, 'now', () => s.now);
  await s.call('save', { deviceId: id, platform: 'desktop', preferences: prefs });
  assert.equal(s.rows.notificationDevices.length, 1);
  s.identify('bob');assert.equal((await s.call('state', { deviceId: id })).registered, false);
  s.identify(null);await assert.rejects(s.call('save', { deviceId: id, platform: 'desktop', preferences: prefs }));
  s.identify('alice');await assert.rejects(s.call('save', { deviceId: '../bad', platform: 'desktop', preferences: prefs }));
  await assert.rejects(s.call('save', { deviceId: id, platform: 'desktop', preferences: { ...prefs, morningTime: '25:00' } }));
  await assert.rejects(s.call('save', { deviceId: id, platform: 'web', preferences: prefs, subscription: { endpoint: 'https://127.0.0.1/private', keys: { p256dh: 'a', auth: 'b' } } }));
});
test('scheduled collection deduplicates, revalidates deadline edits/undo before display, and honors disable/delete', async t => {
  const s = server();t.mock.method(Date, 'now', () => s.now);
  await s.call('save', { deviceId: id, platform: 'desktop', preferences: prefs });
  s.seed({ id: 'deadline', dueDate: '2026-10-23', dueTime: '09:30' });
  s.seed({ id: 'ai', done: true, completedBy: 'ai', stamps: { done: s.now } });
  await s.call('collect');assert.equal(s.rows.notificationDeliveries.length, 2);
  s.rows.notificationDevices[0].nextCheckAt = s.now;await s.call('collect');assert.equal(s.rows.notificationDeliveries.length, 2);
  assert.equal((await s.call('pending', { deviceId: id })).length, 2);
  s.rows.syncItems[0].payload = JSON.stringify({ ...JSON.parse(s.rows.syncItems[0].payload), done: true });
  s.rows.syncItems[1].payload = JSON.stringify({ ...JSON.parse(s.rows.syncItems[1].payload), done: false });
  assert.equal((await s.call('pending', { deviceId: id })).length, 0);
  s.identify('bob');await assert.rejects(s.call('acknowledge', { id: s.rows.notificationDeliveries[0]._id }));
  s.identify('alice');await s.call('save', { deviceId: id, platform: 'desktop', preferences: { ...prefs, deadline: false, completion: false } });
  assert.equal(s.rows.notificationDevices[0].nextCheckAt, undefined);
  s.rows.accountDeletions.push({ userId: 'alice' });assert.equal(await s.call('state', { deviceId: id }), null);
});
test('web deliveries retry with bounds, discard invalid data and remove expired endpoints without disabling a rotated subscription', async t => {
  const s = server();t.mock.method(Date, 'now', () => s.now);
  await s.call('save', { deviceId: id, platform: 'desktop', preferences: prefs });
  const device = s.rows.notificationDevices[0];device.platform = 'web';device.subscription = { endpoint: 'https://web.push.apple.com/new', keys: { p256dh: 'a', auth: 'b' } };
  s.seed({ id: 'deadline', dueDate: '2026-10-23', dueTime: '09:30' });
  await s.call('collect');const delivery = s.rows.notificationDeliveries[0];assert.equal(s.jobs[0].name, 'pushNotifications:deliver');
  assert.equal((await s.call('delivery', { id: delivery._id })).subscription.endpoint, device.subscription.endpoint);
  await s.call('result', { id: delivery._id, result: 'retry' });assert.equal(delivery.attempts, 1);assert.equal(s.jobs.at(-1).delay, 60000);
  await s.call('result', { id: delivery._id, result: 'retry' });await s.call('result', { id: delivery._id, result: 'retry' });assert.equal(delivery.status, 'failed');
  delivery.status = 'pending';await s.call('result', { id: delivery._id, result: 'expired', endpoint: 'https://web.push.apple.com/old' });assert.equal(device.preferences.deadline, true);
  delivery.status = 'pending';await s.call('result', { id: delivery._id, result: 'expired', endpoint: device.subscription.endpoint });assert.equal(device.subscription, undefined);assert.equal(device.nextCheckAt, undefined);
});
