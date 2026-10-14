import assert from 'node:assert/strict';
import test from 'node:test';
import { parseProcessIdentities, retainProcessTree, stopProcessTree } from '../desktop/electron/process-tree.mjs';

const row = (pid, ppid, started = 'Sun Oct 11 10:00:00 2026') => ({ pid, ppid, started, executable: '/fixture/node' });
test('process identity parsing retains creation time without collecting arguments or environment', () => {
  assert.deepEqual(parseProcessIdentities('  20 1 Sun Oct 11 10:00:00 2026 /fixture/node\ninvalid'), [row(20, 1)]);
});
test('tracking retains detached descendants after their parent exits, but rejects reused PIDs', () => {
  let known = new Map([[20, row(20, 1)]]);
  known = retainProcessTree([row(20, 1), row(21, 20), row(22, 21), row(99, 1)], known);
  assert.deepEqual([...known.keys()], [20, 21, 22]);
  assert.deepEqual([...retainProcessTree([row(21, 1), row(22, 21), row(23, 22)], known).keys()], [21, 22, 23]);
  assert.equal(retainProcessTree([row(20, 1, 'Sun Oct 11 10:01:00 2026'), row(24, 20)], new Map([[20, row(20, 1)]])).size, 0);
});
test('stop freezes known parents, rescans new descendants, then kills only verified identities', () => {
  const known = new Map([[20, row(20, 1)]]);
  let scans = 0;
  const signals = [];
  stopProcessTree(known, () => {
    scans++;
    return [row(20, 1), row(21, 20), ...(scans > 1 ? [row(22, 21)] : []), row(99, 1)];
  }, (pid, signal) => signals.push([pid, signal]));
  assert.deepEqual(signals, [[20, 'SIGSTOP'], [21, 'SIGSTOP'], [22, 'SIGSTOP'], [22, 'SIGKILL'], [21, 'SIGKILL'], [20, 'SIGKILL']]);
});
test('a PID replaced before final cleanup is never killed', () => {
  let scans = 0;
  const signals = [];
  stopProcessTree(new Map([[20, row(20, 1)]]), () => {
    scans++;
    return [row(20, 1, scans > 2 ? 'Sun Oct 11 10:01:00 2026' : undefined)];
  }, (pid, signal) => signals.push([pid, signal]));
  assert.deepEqual(signals, [[20, 'SIGSTOP']]);
});
test('an already exited owned process is harmless and unrelated processes remain untouched', () => {
  const signals = [];
  stopProcessTree(new Map([[20, row(20, 1)]]), () => [row(99, 1)], (pid, signal) => signals.push([pid, signal]));
  assert.deepEqual(signals, []);
});
