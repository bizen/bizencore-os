import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { setImmediate as tick } from 'node:timers/promises';
import { createAuthStorageChannel, serveAuthStorage, validStorageRequest } from '../desktop/electron/auth-storage-channel.mjs';
import { claimDesktopInstance } from '../desktop/electron/single-instance.mjs';

function helper() {
  const child = new EventEmitter();
  child.exitCode = null; child.signalCode = null; child.connected = true;
  child.calls = [];
  child.send = (value, callback) => { child.calls.push(value); callback?.(); };
  child.kill = signal => { child.signalCode = signal; child.connected = false; queueMicrotask(() => child.emit('exit', null, signal)); return true; };
  return child;
}

test('auth requests wait for both guard registration and helper readiness without blocking main', async t => {
  const child = helper(); let registered;
  const storage = createAuthStorageChannel({ start: () => child, register: () => new Promise(resolve => { registered = resolve; }) });
  t.after(() => storage.close());
  const pending = storage.getItem('__clerk_client_jwt');
  await tick(); child.emit('message', { ready: true });
  assert.equal(child.calls.length, 0);
  registered(); await tick();
  assert.equal(child.calls.length, 1);
  let settled = false; void pending.then(() => { settled = true; });
  await tick(); assert.equal(settled, false, 'the parent event loop still runs while Keychain waits');
  child.emit('message', { id: child.calls[0].id, ok: true, value: 'fixture-only-token' });
  assert.equal(await pending, 'fixture-only-token');
});

test('logout and writes retain FIFO order; helper failures never disclose values', async () => {
  const transport = new EventEmitter(); transport.connected = true;
  const replies = []; transport.send = value => replies.push(value);
  let release; const calls = []; let value = null;
  const storage = {
    async setItem(key, next) { calls.push('write'); await new Promise(resolve => { release = resolve; }); value = next; },
    removeItem() { calls.push('remove'); value = null; }, getItem() { return value; },
  };
  serveAuthStorage(transport, storage, () => assert.fail('valid requests must be accepted'));
  transport.emit('message', { id: 1, method: 'setItem', key: '__clerk_client_jwt', value: 'fixture' });
  transport.emit('message', { id: 2, method: 'removeItem', key: '__clerk_client_jwt' });
  await tick(); assert.deepEqual(calls, ['write']);
  release(); await tick();
  assert.deepEqual(calls, ['write', 'remove']); assert.equal(value, null);
  assert.deepEqual(replies, [{ id: 1, ok: true }, { id: 2, ok: true }]);
  storage.getItem = () => { throw Error('secret-token-and-private-path'); };
  transport.emit('message', { id: 3, method: 'getItem', key: '__clerk_client_jwt' });
  await tick(); assert.deepEqual(replies.at(-1), { id: 3, ok: false });
});

test('invalid/replayed requests and oversized values are rejected before storage access', async () => {
  const transport = new EventEmitter(); transport.connected = true; transport.send = () => {};
  let rejected = 0, calls = 0;
  serveAuthStorage(transport, { getItem() { calls++; return null; } }, () => { rejected++; });
  for (const input of [null, {}, { id: 1, method: 'getItem', key: '../token' }, { id: 1, method: 'getItem', key: '__proto__' }, { id: 1, method: 'clear', key: 'token' }, { id: 1, method: 'setItem', key: 'token', value: 'x'.repeat(131073) }]) {
    assert.ok(!validStorageRequest(input)); transport.emit('message', input);
  }
  transport.emit('message', { id: 2, method: 'getItem', key: '__clerk_client_jwt' });
  transport.emit('message', { id: 2, method: 'getItem', key: '__clerk_client_jwt' });
  await tick(); assert.equal(calls, 1); assert.equal(rejected, 7);
});

test('a timed-out helper is killed and the stored token is never removed or rewritten', async t => {
  const children = [];
  const storage = createAuthStorageChannel({ start: () => { const child = helper(); children.push(child); queueMicrotask(() => child.emit('message', { ready: true })); return child; }, timeoutMs: 15 });
  t.after(() => storage.close());
  await assert.rejects(storage.getItem('__clerk_client_jwt'), /保存済みログイン/);
  assert.equal(children[0].signalCode, 'SIGKILL');
  assert.deepEqual(children[0].calls.map(call => call.method), ['getItem']);
  const retry = storage.getItem('__clerk_client_jwt');
  await tick(); await tick();
  children[1].emit('message', { id: children[1].calls[0].id, ok: true, value: 'restored' });
  assert.equal(await retry, 'restored');
});

test('shutdown rejects pending work, kills only its helper and ignores late replies', async () => {
  const child = helper(); const storage = createAuthStorageChannel({ start: () => child });
  const pending = storage.getItem('__clerk_client_jwt');
  const rejected = assert.rejects(pending, /保存済みログイン/);
  await tick(); child.emit('message', { ready: true });
  await storage.close(); await rejected;
  child.emit('message', { id: 1, ok: true, value: 'late' });
  assert.equal(child.signalCode, 'SIGKILL');
  await assert.rejects(storage.setItem('__clerk_client_jwt', 'late-write'));
});

test('unregistered, crashed and disconnected helpers fail closed with a redacted error', async () => {
  for (const mode of ['register', 'crash', 'send', 'malformed']) {
    const child = helper();
    const storage = createAuthStorageChannel({ start: () => child, register: async () => { if (mode === 'register') throw Error('private'); } });
    const pending = storage.getItem('__clerk_client_jwt');
    const rejected = assert.rejects(pending, error => !error.message.includes('private'));
    await tick();
    if (mode === 'send') child.send = () => { throw Error('private'); };
    if (mode === 'crash') { child.exitCode = 2; child.emit('exit', 2); }
    else if (mode !== 'register') {
      child.emit('message', { ready: true });
      if (mode === 'malformed') child.emit('message', { id: child.calls[0].id, ok: true, value: { secret: 'private' } });
    }
    await rejected; await storage.close();
  }
});

test('primary instance lock is required on macOS too and activates the existing window', async () => {
  const app = new EventEmitter(); let requested = 0; app.requestSingleInstanceLock = () => { requested++; return true; };
  let window = null; const actions = [];
  assert.equal(claimDesktopInstance(app, () => window), true);
  app.emit('second-instance');
  window = { isDestroyed: () => false, isMinimized: () => true, restore: () => actions.push('restore'), show: () => actions.push('show'), focus: () => actions.push('focus') };
  app.emit('browser-window-created'); await tick();
  assert.deepEqual(actions, ['restore', 'show', 'focus']); assert.equal(requested, 1);
  app.requestSingleInstanceLock = () => false;
  assert.equal(claimDesktopInstance(app, () => assert.fail('secondary must not initialize storage or a window')), false);
});

test('a genuinely blocked native-style helper cannot freeze main or prevent shutdown', { timeout: 10000 }, async () => {
  let child;
  const storage = createAuthStorageChannel({ start: () => {
    child = spawn(process.execPath, ['-e', `process.on('message', () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)); process.send({ready:true});`], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    return child;
  }, timeoutMs: 1000, startupMs: 2000 });
  let ticks = 0; const timer = setInterval(() => { ticks++; }, 10);
  try {
    await assert.rejects(storage.getItem('__clerk_client_jwt'), /保存済みログイン/);
    assert.ok(ticks >= 5, 'the main event loop remains responsive during a synchronous child wait');
    await storage.close(); assert.ok(child.signalCode || child.exitCode !== null);
  } finally { clearInterval(timer); await storage.close(); }
});
