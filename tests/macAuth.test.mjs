import assert from 'node:assert/strict';
import test from 'node:test';
import { checkedAuthUrl, checkedAuthCallback, installMacAuthentication } from '../desktop/electron/mac-auth.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

test('Native authentication starts only at the configured Clerk host or Google over HTTPS', () => {
  const host = 'grown-gorilla-52.accounts.dev';
  assert.equal(checkedAuthUrl(`https://${host}/v1/start?nonce=example`, host), `https://${host}/v1/start?nonce=example`);
  assert.equal(checkedAuthUrl('https://accounts.google.com/start', host), 'https://accounts.google.com/start');
  for (const url of ['http://accounts.google.com/', 'https://accounts.google.com.evil/', 'https://user@accounts.google.com/', 'https://accounts.google.com:444/', 'file:///tmp/test', 'https://other.accounts.dev/']) assert.throws(() => checkedAuthUrl(url, host));
  assert.throws(() => checkedAuthUrl('x'.repeat(16385), host));
});

function fixture(options = {}) {
  let handler;
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stdin = new PassThrough();
  let killed = false; let focused = false;
  child.kill = () => { killed = true; };
  const auth = installMacAuthentication({
    ipcMain: { removeHandler() {}, handle(_name, callback) { handler = callback; } },
    executable: '/mock/native-auth', clerkHost: 'test.accounts.dev',
    checkSender(event) { if (event !== 'local') throw new Error('Invalid sender'); },
    focusWindow() { focused = true; }, spawnProcess: () => child,
    ...options,
  });
  return { auth, child, open: event => handler(event, 'https://accounts.google.com/start'), killed: () => killed, focused: () => focused };
}
test('System session returns the callback to Clerk, focuses the app and cleans up the helper', async () => {
  const f = fixture();
  const pending = f.open('local');
  await assert.rejects(f.open('local'), /進行中/);
  f.child.stdout.write(JSON.stringify({ callbackUrl: 'bizencore-electron-preview://renderer/?nonce=example' }));
  f.child.emit('close');
  assert.deepEqual(await pending, { callbackUrl: 'bizencore-electron-preview://renderer/?nonce=example' });
  assert.ok(f.killed()); assert.ok(f.focused());
});

test('production OAuth accepts only its pinned host and production callback; preview callbacks cannot complete it', async () => {
  const host = 'clerk.bizencore.com';
  assert.equal(checkedAuthUrl(`https://${host}/start`, host), `https://${host}/start`);
  assert.throws(() => checkedAuthUrl('https://grown-gorilla-52.clerk.accounts.dev/start', host));
  const options = { clerkHost: host, callbackScheme: 'bizencore-terminal' };
  const f = fixture(options);
  let request = '';
  f.child.stdin.on('data', chunk => { request += chunk; });
  const pending = f.open('local');
  f.child.stdout.end(JSON.stringify({ callbackUrl: 'bizencore-terminal://renderer/?nonce=fixture' }));
  f.child.emit('close');
  assert.deepEqual(await pending, { callbackUrl: 'bizencore-terminal://renderer/?nonce=fixture' });
  assert.equal(JSON.parse(request).callbackScheme, 'bizencore-terminal');
  assert.equal(JSON.parse(request).clerkHost, host);
  const wrong = fixture(options);
  const rejected = wrong.open('local');
  wrong.child.stdout.end(JSON.stringify({ callbackUrl: 'bizencore-electron-preview://renderer/?nonce=fixture' }));
  wrong.child.emit('close');
  await assert.rejects(rejected);
  assert.equal(wrong.focused(), false);
  assert.throws(() => fixture({ clerkHost: host }));
  assert.throws(() => fixture({ callbackScheme: 'bizencore-terminal' }));
  assert.throws(() => checkedAuthCallback('bizencore-terminal://renderer/?nonce=fixture'));
});
test('Unauthorized senders, cancellation, helper errors and wrong callbacks never complete sign-in', async () => {
  const unauthorized = fixture();
  await assert.rejects(unauthorized.open('remote'), /Invalid sender/);
  for (const mode of ['cancel', 'error', 'wrong', 'oversize']) {
    const f = fixture();
    const pending = f.open('local');
    if (mode === 'cancel') f.auth.cancel();
    if (mode === 'error') f.child.emit('error', new Error('Private system error'));
    if (mode === 'oversize') f.child.stdout.write('x'.repeat(32769));
    if (mode === 'wrong') { f.child.stdout.write(JSON.stringify({ callbackUrl: 'https://attacker.invalid/' })); f.child.emit('close'); }
    await assert.rejects(pending);
    assert.ok(f.killed()); assert.equal(f.focused(), false);
  }
});
test('Native callbacks match the existing renderer origin and path; callback secrets are not logged', () => {
  const url = 'bizencore-electron-preview://renderer/?rotating_token_nonce=example';
  assert.deepEqual(checkedAuthCallback(url), { callbackUrl: url });
  for (const value of [null, 'https://renderer/', 'bizencore-electron-preview://renderer.evil/', 'bizencore-electron-preview://renderer/other', 'bizencore-electron-preview://user@renderer/']) assert.throws(() => checkedAuthCallback(value));
});

test('Native authentication failures expose only the OS error code', async () => {
  const f = fixture();
  const pending = f.open('local');
  f.child.stdout.write(JSON.stringify({ errorCode: 2 }));
  f.child.emit('close');
  await assert.rejects(pending, /コード 2/);
  assert.equal(f.focused(), false);
});

test('Swift helper consumes input and exits without opening auth for invalid requests', { skip: process.platform !== 'darwin', timeout: 60000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bizencore-native-auth-test-'));
  const executable = join(dir, 'auth-session');
  try {
    for (const production of [false, true]) {
    await promisify(execFile)('/usr/bin/xcrun', ['swiftc', ...(production ? ['-D', 'DESKTOP_PRODUCTION'] : []), '-module-cache-path', join(dir, 'cache'), fileURLToPath(new URL('../desktop/electron/auth-session.swift', import.meta.url)), '-o', executable, '-framework', 'AppKit', '-framework', 'AuthenticationServices'], { timeout: 30000 });
    const clerkHost = production ? 'clerk.bizencore.com' : 'grown-gorilla-52.clerk.accounts.dev';
    const callbackScheme = production ? 'bizencore-terminal' : 'bizencore-electron-preview';
    for (const input of ['{}',
      JSON.stringify({ url: 'http://example.invalid/', callbackScheme, clerkHost }),
      JSON.stringify({ url: `https://${clerkHost}/`, callbackScheme: 'wrong-scheme', clerkHost }),
      JSON.stringify({ url: `https://${clerkHost}/`, callbackScheme: production ? 'bizencore-electron-preview' : 'bizencore-terminal', clerkHost }),
      JSON.stringify({ url: 'https://attacker.invalid/', callbackScheme, clerkHost }),
      JSON.stringify({ url: `https://user@${clerkHost}/`, callbackScheme, clerkHost })]) {
      await new Promise((resolve, reject) => {
        const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'ignore'] });
        let output = '';
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Native helper did not process input')); }, 5000);
        child.stdout.on('data', chunk => { output += chunk; });
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          if (code !== 0 || signal || output !== '') reject(new Error('Invalid request did not exit cleanly'));
          else resolve();
        });
        child.stdin.on('error', reject);
        child.stdin.end(input);
      });
    }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
