import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

// Dev-only, isolated identities and reusable fixture IDs. Never target production.
const exec = promisify(execFile);
const deployment = 'dazzling-setter-393';
const alice = 'bizencore-partner-dev-test-alice';
const bob = 'bizencore-partner-dev-test-bob';
const eve = 'bizencore-partner-dev-test-eve';
const users = [alice, bob, eve];
const identity = subject => ({ subject, name: subject, issuer: 'https://partner-test.invalid', tokenIdentifier: `https://partner-test.invalid|${subject}` });
const cliArgs = (subject, fn, args) => ['run', '--deployment', deployment, '--identity', JSON.stringify(identity(subject)), '--codegen', 'disable', fn, JSON.stringify(args)];
async function run(subject, fn, args) {
  const { stdout } = await exec('./node_modules/.bin/convex', cliArgs(subject, fn, args), { maxBuffer: 1024 * 1024 });
  return stdout.trim() ? JSON.parse(stdout) : null;
}
const call = (subject, name, args = {}) => run(subject, `partners:${name}`, { accountId: subject, ...args });
const items = new Map(users.map(user => [user, new Map()]));
let clock = Date.now(), watcher;
function stamp() { clock = Math.max(Date.now(), clock + 1); return clock; }
async function put(subject, data) {
  const item = { type: 'task', parentId: null, done: false, order: 0, createdAt: 1, ...data, updatedAt: stamp() };
  items.get(subject).set(item.id, item);
  await run(subject, 'sync:push', { items: [{ itemId: item.id, updatedAt: item.updatedAt, payload: JSON.stringify(item) }] });
}
async function waitUntil(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Timed out waiting for the real Convex subscription');
}
try {
  for (const user of users) { await call(user, 'disconnect'); await call(user, 'cancelInvite'); }
  const race = await call(alice, 'createInvite');
  const outcomes = await Promise.allSettled([call(bob, 'acceptInvite', { code: race.code }), call(eve, 'acceptInvite', { code: race.code })]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1, 'exactly one recipient wins simultaneous acceptance');
  const winningUser = outcomes[0].status === 'fulfilled' ? bob : eve;
  const losingUser = winningUser === bob ? eve : bob;
  assert.deepEqual((await call(winningUser, 'list')).items, []);
  assert.equal(await call(losingUser, 'list'), null);
  await call(alice, 'disconnect');
  const invite = await call(alice, 'createInvite');
  assert.equal((await call(bob, 'previewInvite', { code: invite.code })).name, alice);
  await call(bob, 'acceptInvite', { code: invite.code });
  await put(alice, { id: 'partner-test-public-label', type: 'section', text: 'Public development label', color: 'green' });
  await put(alice, { id: 'partner-test-private-label', type: 'section', text: 'Private development label' });
  await put(alice, { id: 'partner-test-task', parentId: 'partner-test-public-label', text: 'Shared development task', note: 'PRIVATE DEVELOPMENT NOTE', completionCriteria: 'PRIVATE CRITERIA', attachments: [{ id: 'synthetic-link', kind: 'link', url: 'https://private.invalid', createdAt: 1 }], dueDate: '2026-10-10' });
  assert.deepEqual((await call(bob, 'list')).items, [], 'pairing does not publish anything');
  await call(alice, 'setLabelSharing', { labelId: 'partner-test-public-label', shared: true });
  const shared = await call(bob, 'list');
  assert.deepEqual(shared.items.map(item => item.id), ['partner-test-public-label', 'partner-test-task']);
  assert.ok(!JSON.stringify(shared).includes('PRIVATE'));
  assert.ok(!JSON.stringify(shared).includes('private.invalid'));
  assert.equal(await call(eve, 'list'), null);
  await assert.rejects(call(bob, 'setLabelSharing', { labelId: 'partner-test-public-label', shared: true }));
  assert.equal(await call(eve, 'list', { accountId: bob }), null);

  let output = '', watchError = '';
  watcher = spawn('./node_modules/.bin/convex', ['run', '--watch', ...cliArgs(bob, 'partners:list', { accountId: bob }).slice(1)], { stdio: ['ignore', 'pipe', 'pipe'] });
  watcher.stdout.on('data', chunk => { output += chunk; });
  watcher.stderr.on('data', chunk => { watchError += chunk; });
  await waitUntil(() => output.includes('Shared development task'));
  const before = output.length;
  await call(alice, 'setLabelSharing', { labelId: 'partner-test-public-label', shared: false });
  await waitUntil(() => /"items":\s*\[\s*\]/.test(output.slice(before)));
  assert.ok(!watchError.includes('Error'), 'live subscription remains connected');
  await call(alice, 'setLabelSharing', { labelId: 'partner-test-public-label', shared: true });
  const original = items.get(alice).get('partner-test-task');
  await put(alice, { ...original, parentId: 'partner-test-private-label' });
  assert.deepEqual((await call(bob, 'list')).items.map(item => item.id), ['partner-test-public-label']);
  await put(alice, original);
  await put(bob, { ...original, text: 'Attempted peer edit' });
  assert.equal((await call(bob, 'list')).items.find(item => item.id === original.id).text, original.text, 'sync writes remain in the caller namespace');
  await call(bob, 'disconnect');
  assert.equal(await call(alice, 'list'), null);
  assert.equal(await call(bob, 'list'), null);
  assert.deepEqual((await call(alice, 'state')).sharedLabelIds, []);
  console.log('Passed on real development Convex: mutual consent/default privacy, concurrent invite acceptance, field whitelist, third-party isolation, foreign-label refusal, live unshare notification, private reparenting, sync-write isolation and mutual disconnect.');
} finally {
  if (watcher && watcher.exitCode === null && watcher.signalCode === null) {
    const exited = new Promise(resolve => watcher.once('close', resolve)); watcher.kill('SIGTERM'); await exited;
  }
  for (const user of users) {
    await call(user, 'disconnect'); await call(user, 'cancelInvite');
    const deleted = [...items.get(user).values()].map(item => { const updatedAt = stamp(); return { ...item, updatedAt, deletedAt: updatedAt }; });
    if (deleted.length) await run(user, 'sync:push', { items: deleted.map(item => ({ itemId: item.id, updatedAt: item.updatedAt, deletedAt: item.deletedAt, payload: JSON.stringify(item) })) });
  }
  console.log('Fixture tasks soft-deleted, invitations cancelled, empty test profiles disconnected. No real account or production data changed.');
}
