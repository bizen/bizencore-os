import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Explicit dev-only integration check; uses synthetic accounts, never a person's data.
const exec = promisify(execFile);
const deployment = 'dazzling-setter-393';
const accountId = 'bizencore-life-world-dev-test-20261005';
const id = 'life-world-sync-dev-test-20261005';
async function run(fn, args, subject = accountId) {
  const identity = { subject, issuer: 'https://life-world-test.invalid', tokenIdentifier: `https://life-world-test.invalid|${subject}` };
  const { stdout } = await exec('./node_modules/.bin/convex', ['run', '--deployment', deployment,
    '--identity', JSON.stringify(identity), '--codegen', 'disable', fn, JSON.stringify(args)], { maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout);
}
let inserted = false;
const updatedAt = Date.now();
const entry = { id, text: 'Development sync test', note: '', startDate: '2026-10-05', repeat: 'daily', order: 0, updatedAt,
  stamps: { text: updatedAt, note: updatedAt, schedule: updatedAt, order: updatedAt, deletion: updatedAt } };
try {
  assert.equal((await run('sync:lifeWorldPush', { accountId, entries: [entry], checks: [{ entryId: id, date: '2026-10-05', done: true, updatedAt }] })).ok, true);
  inserted = true;
  const remote = await run('sync:lifeWorldPull', { accountId });
  assert.equal(remote.entries[id].text, entry.text);
  assert.equal(remote.checks[`${id}:2026-10-05`].done, true);
  const other = `${accountId}-other`;
  const isolated = await run('sync:lifeWorldPull', { accountId: other }, other);
  assert.equal(isolated.entries[id], undefined);
  assert.equal(isolated.checks[`${id}:2026-10-05`], undefined);
  console.log('Passed: real development Convex authenticated write/read, daily check persistence and account isolation using synthetic identities.');
} finally {
  if (inserted) {
    const deletedAt = Math.max(Date.now(), updatedAt + 1);
    await run('sync:lifeWorldPush', { accountId, entries: [{ ...entry, updatedAt: deletedAt, deletedAt,
      stamps: { ...entry.stamps, deletion: deletedAt } }], checks: [] });
    console.log('Development test entry soft-deleted; no production deployment or user data changed.');
  }
}
