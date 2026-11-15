import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createShutdownBarrier } from '../desktop/electron/session-shutdown.mjs';

test('natural exit, explicit stop and repeated stop await the same cleanup barrier', async () => {
  const barrier = createShutdownBarrier();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const first = barrier.run('pane', () => { calls++; return pending; });
  const second = barrier.run('pane', () => { throw Error('must not run twice'); });
  assert.equal(first, second); assert.equal(barrier.get('pane'), first);
  let settled = false;
  void second.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(calls, 1); assert.equal(settled, false); assert.equal(barrier.size, 1);
  assert.equal(barrier.hasOther('another-pane'), true); assert.equal(barrier.hasOther('pane'), false);
  release(); await barrier.wait();
  assert.equal(settled, true); assert.equal(barrier.size, 0);
});
test('cleanup failure blocks progression instead of reporting a successful stop', async () => {
  const barrier = createShutdownBarrier();
  const failure = Error('process tree still running');
  await assert.rejects(barrier.run('pane', () => { throw failure; }), /still running/);
  assert.equal(barrier.size, 1);
  await assert.rejects(barrier.run('pane', () => Promise.resolve()), /still running/);
  await assert.rejects(barrier.wait(), /still running/);
});
test('native pending startup retains its reservation until aborted preparation actually finishes', async () => {
  const main = await readFile(new URL('../desktop/electron/main.mjs', import.meta.url), 'utf8');
  const stop = main.slice(main.indexOf('function stopSession'), main.indexOf('function lock'));
  assert.match(stop, /pending.controller.abort\(\)/);
  assert.doesNotMatch(stop, /pendingStarts.delete/);
  assert.match(stop, /pending\?\.finished, shutdowns.get\(id\)/);
  assert.match(main, /pending.controller.signal.aborted/);
  assert.match(main, /if \(shutdowns.hasOther\(id\)\)/);
  assert.match(main, /if \(retainProcessTree\(processSnapshot\(\), owned\).size\)/);
  assert.match(main, /isolatedMcpLaunch\(agent, executable, folder, childEnv, capability, undefined, pending.controller.signal\)/);
  assert.match(main, /finishLaunch\(\)/);
  const terminal = await readFile(new URL('../desktop/OrchestrationTerminal.tsx', import.meta.url), 'utf8');
  assert.ok(terminal.indexOf('if (run.controller.signal.aborted) { abort(); return cleanup; }') < terminal.indexOf('await bridge.start('));
});
