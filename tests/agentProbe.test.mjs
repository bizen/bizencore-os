import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { runAgentProbe } from '../desktop/electron/agent-probe.mjs';

test('probe abort waits for close, not the early execFile error callback', async () => {
  const child = new EventEmitter();
  let callback;
  const operation = runAgentProbe('/mock/cli', ['--help'], {}, (_file, _args, options, done) => {
    assert.equal(options.killSignal, 'SIGKILL'); callback = done; return child;
  });
  let settled = false;
  void operation.catch(() => { settled = true; });
  callback(Error('aborted'), '', '');
  await Promise.resolve(); assert.equal(settled, false);
  child.emit('close', null); await assert.rejects(operation, /aborted/);
  assert.equal(settled, true);
});
test('successful probe waits for both callback data and process close', async () => {
  const child = new EventEmitter(); let callback;
  const operation = runAgentProbe('/mock/cli', [], {}, (_file, _args, _options, done) => { callback = done; return child; });
  child.emit('close', 0); callback(null, 'version', '');
  assert.deepEqual(await operation, { stdout: 'version', stderr: '' });
});
test('real aborted probe has exited before startup reservation can be released', async () => {
  const controller = new AbortController(); let child;
  const operation = runAgentProbe(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: controller.signal, timeout: 2000 }, (...args) => {
    child = execFile(...args); return child;
  });
  controller.abort();
  await assert.rejects(operation, error => error.name === 'AbortError');
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  assert.throws(() => process.kill(child.pid, 0), error => error.code === 'ESRCH');
});

test('abort kills a probe with an installed SIGTERM handler and awaits its actual exit', { timeout: 3000 }, async t => {
  const controller = new AbortController(); let child; let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const operation = runAgentProbe(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)'], { signal: controller.signal, timeout: 2000 }, (...args) => {
    child = execFile(...args); child.stdout.once('data', ready); return child;
  });
  t.after(() => child.kill('SIGKILL'));
  await started; controller.abort();
  await assert.rejects(operation, error => error.name === 'AbortError');
  assert.equal(child.signalCode, 'SIGKILL');
  assert.throws(() => process.kill(child.pid, 0), error => error.code === 'ESRCH');
});
