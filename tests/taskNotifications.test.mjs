import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import webpush from 'web-push';
const load = async entry => {
  const { outputFiles } = await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
};
const { taskNotices, deadlineInstant, validatePushSubscription, notificationPath } = await load('src/lib/taskNotifications.ts');
const all = { deadline: true, morning: true, completion: true, morningTime: '09:00' };
const now = Date.parse('2026-10-23T09:00:00Z');
const task = (id, changes = {}) => ({ id, type: 'task', parentId: null, text: id, done: false, order: 0, createdAt: 1, updatedAt: 1, ...changes });
const map = (...tasks) => Object.fromEntries(tasks.map(task => [task.id, task]));

test('deadlines notify once within 30 minutes, ignore date-only/past/done/locked/deleted tasks and change identity on reschedule', () => {
  const items = map(task('soon', { dueDate: '2026-10-23', dueTime: '09:30' }), task('later', { dueDate: '2026-10-23', dueTime: '09:31' }), task('past', { dueDate: '2026-10-23', dueTime: '09:00' }), task('date', { dueDate: '2026-10-23' }));
  const notices = taskNotices(items, { ...all, morning: false }, 'UTC', now, now);
  assert.deepEqual(notices.map(n => n.taskId), ['soon']);
  assert.match(notices[0].body, /あと30分/);
  for (const patch of [{ done: true }, { locked: true }, { deletedAt: 2 }, { filed: true }]) {
    assert.equal(taskNotices(map({ ...items.soon, ...patch }), { ...all, morning: false }, 'UTC', now, now).length, 0);
  }
  items.soon.dueTime = '09:29';
  assert.notEqual(taskNotices(items, { ...all, morning: false }, 'UTC', now, now)[0].key, notices[0].key);
});
test('morning summary includes Today order, carryover count, first actionable task and has a bounded catchup window', () => {
  const items = map(task('container', { locked: true, assignedDate: '2026-10-21' }), task('first', { parentId: 'container' }), task('second', { order: 2, assignedDate: '2026-10-22' }), task('done', { done: true, assignedDate: '2026-10-23' }));
  const [notice] = taskNotices(items, all, 'UTC', now, now);
  assert.equal(notice.kind, 'morning');assert.equal(notice.body, '2件、持ち越し1件。最初は「first」');
  assert.equal(notice.taskId, undefined);
  assert.equal(notificationPath(), '/?view=today');
  assert.equal(taskNotices(items, all, 'UTC', now + 30 * 60_000, now).length, 0);
  assert.equal(taskNotices({}, all, 'UTC', now, now)[0].body, 'Todayのタスクはありません。');
});
test('only AI completions since opt-in notify; manual checks, old history, undone and future stamps do not', () => {
  const items = map(task('ai', { done: true, completedBy: 'ai', stamps: { done: now - 1 } }), task('human', { done: true, completedBy: 'user', stamps: { done: now - 1 } }), task('legacy', { done: true, stamps: { done: now - 1 } }), task('old', { done: true, completedBy: 'ai', stamps: { done: now - 100 } }), task('undone', { completedBy: 'ai', stamps: { done: now - 1 } }));
  assert.deepEqual(taskNotices(items, { ...all, morning: false }, 'UTC', now, now - 10).map(n => n.taskId), ['ai']);
  assert.equal(taskNotices(items, { ...all, morning: false }, 'UTC', now - 2, now - 10).length, 0);
});
test('account timezone, date boundaries and DST gaps are respected', () => {
  assert.equal(deadlineInstant('2026-10-23', '09:00', 'Australia/Melbourne'), Date.parse('2026-10-22T22:00:00Z'));
  assert.equal(deadlineInstant('2026-10-04', '02:30', 'Australia/Melbourne'), null);
  assert.equal(deadlineInstant('2026-02-30', '09:00', 'UTC'), null);
  assert.equal(deadlineInstant('2026-10-23', '25:00', 'UTC'), null);
  assert.equal(taskNotices({}, all, 'Australia/Melbourne', Date.parse('2026-10-22T22:00:00Z'), 0)[0].key, 'morning:2026-10-23');
});
test('push destinations are restricted to browser vendors, reject SSRF/credentials and payloads are encrypted and signed', () => {
  const vapid = webpush.generateVAPIDKeys();
  const sub = { endpoint: 'https://web.push.apple.com/opaque', keys: { p256dh: vapid.publicKey, auth: Buffer.alloc(16, 1).toString('base64url') } };
  validatePushSubscription(sub);
  for (const endpoint of ['http://web.push.apple.com/x','https://web.push.apple.com.evil.test/x','https://127.0.0.1/x','https://user:pass@web.push.apple.com/x','https://web.push.apple.com:8443/x']) assert.throws(() => validatePushSubscription({ ...sub, endpoint }));
  const payload = JSON.stringify({ title: 'private task' });
  const request = webpush.generateRequestDetails(sub, payload, { vapidDetails: { subject: 'https://app.bizencore.com', ...vapid }, TTL: 60 });
  assert.equal(request.headers['Content-Encoding'], 'aes128gcm');
  assert.ok(request.headers.Authorization.includes('vapid'));
  assert.ok(!request.body.includes(Buffer.from('private task')));
  assert.equal(notificationPath('a&view=all'), '/?task=a%26view%3Dall');
});

test('push key setup keeps secrets private and refuses to rotate an existing key pair', async () => {
  const { mkdtemp, readFile, stat, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');const path = await import('node:path');
  const { execFile } = await import('node:child_process');const { promisify } = await import('node:util');
  const run = promisify(execFile), directory = await mkdtemp(path.join(tmpdir(), 'notification-keys-'));
  try {
    const script = path.resolve('scripts/create-push-keys.mjs');
    await run(process.execPath, [script], { cwd: directory });
    const file = path.join(directory, '.env.web-push.local'), original = await readFile(file, 'utf8');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.ok(original.includes('WEB_PUSH_PUBLIC_KEY=') && original.includes('WEB_PUSH_PRIVATE_KEY='));
    await assert.rejects(run(process.execPath, [script], { cwd: directory }));
    assert.ok(original === await readFile(file, 'utf8'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
