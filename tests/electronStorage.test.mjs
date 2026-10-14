import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { build } from 'esbuild';

const host = 'grown-gorilla-52.accounts.dev';
const bundle = await build({
  entryPoints: [new URL('../desktop/electron/auth-storage.mjs', import.meta.url).pathname],
  bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'mock-electron', setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'mock' }));
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
      contents: 'module.exports = electronMock;', loader: 'js',
    }));
  } }],
});

async function fixture(t, available = true, encryptionHook) {
  const directory = await mkdtemp(path.join(tmpdir(), 'bizencore-storage-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = randomBytes(32);
  const encrypt = value => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  };
  const decrypt = value => {
    const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12), { authTagLength: 16 });
    cipher.setAuthTag(value.subarray(-16));
    return Buffer.concat([cipher.update(value.subarray(12, -16)), cipher.final()]).toString('utf8');
  };
  const mock = {
    app: { getPath: () => directory, getVersion: () => '0.1.0' },
    ipcMain: { on() {} }, shell: {},
    safeStorage: {
      isAsyncEncryptionAvailable: async () => available,
      isEncryptionAvailable: () => available,
      encryptStringAsync: encryptionHook ? value => encryptionHook(value, encrypt) : async value => encrypt(value),
      decryptStringAsync: async value => ({ result: decrypt(value), shouldReEncrypt: false }),
    },
  };
  const module = { exports: {} };
  new Function('require', 'electronMock', 'console', 'module', 'exports', bundle.outputFiles[0].text)(
    createRequire(import.meta.url), mock, { warn() {} }, module, module.exports,
  );
  return {
    create: (target = host) => module.exports.createAuthStorage(directory, target),
    factory: module.exports.createAuthStorage,
    directory,
    file: path.join(directory, 'auth', host, 'clerk-tokens.json'),
  };
}

test('Clerk storage restores encrypted tokens across fresh adapters and removes them on logout', async t => {
  const f = await fixture(t);
  await f.create().setItem('token', 'dummy-session');
  const serialized = await readFile(f.file, 'utf8');
  assert.ok(JSON.parse(serialized).token.startsWith('enc:'));
  assert.ok(!serialized.includes('dummy-session'));
  assert.equal((await stat(f.file)).mode & 0o777, 0o600);
  const restored = f.create();
  assert.equal(await restored.getItem('token'), 'dummy-session');
  restored.removeItem('token');
  assert.equal(await f.create().getItem('token'), null);
  assert.throws(() => f.factory('relative', host));
  assert.throws(() => f.create('../accounts.dev'));
  assert.throws(() => f.create('production.example.com'));
  assert.equal(await f.create('other.accounts.dev').getItem('token'), null);
});

test('production tokens restore only inside their own Clerk host directory', async t => {
  const f = await fixture(t);
  const preview = f.create();
  const production = f.create('clerk.bizencore.com');
  await preview.setItem('token', 'preview-session');
  await production.setItem('token', 'production-session');
  assert.equal(await f.create().getItem('token'), 'preview-session');
  assert.equal(await f.create('clerk.bizencore.com').getItem('token'), 'production-session');
  const file = path.join(f.directory, 'auth', 'clerk.bizencore.com', 'clerk-tokens.json');
  assert.ok(!(await readFile(file, 'utf8')).includes('production-session'));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  production.removeItem('token');
  assert.equal(await f.create('clerk.bizencore.com').getItem('token'), null);
  assert.equal(await f.create().getItem('token'), 'preview-session');
});

test('Unavailable OS encryption never persists plaintext', async t => {
  const f = await fixture(t, false);
  const first = f.create();
  await first.setItem('token', 'dummy-session');
  assert.equal(await first.getItem('token'), 'dummy-session');
  assert.equal(await f.create().getItem('token'), null);
  assert.ok(!(await readFile(f.file, 'utf8').catch(() => '')).includes('dummy-session'));
  first.removeItem('token');
  assert.equal(await first.getItem('token'), null);
});

test('Undecryptable token requires sign-in again', async t => {
  const f = await fixture(t);
  await f.create().setItem('token', 'dummy-session');
  await writeFile(f.file, JSON.stringify({ token: 'enc:broken' }));
  assert.equal(await f.create().getItem('token'), null);
});

test('Keychain encryption errors stay memory-only without a plaintext fallback', async t => {
  const f = await fixture(t, true, async () => { throw new Error('Keychain unavailable'); });
  const store = f.create();
  await store.setItem('token', 'dummy-session');
  assert.equal(await store.getItem('token'), 'dummy-session');
  assert.equal(await f.create().getItem('token'), null);
  assert.ok(!(await readFile(f.file, 'utf8').catch(() => '')).includes('dummy-session'));
});

test('Logout cannot be undone by a late encrypted write', async t => {
  let finish;
  const f = await fixture(t, true, (value, encrypt) => new Promise(resolve => {
    finish = () => resolve(encrypt(value));
  }));
  const store = f.create();
  const pending = store.setItem('token', 'dummy-session');
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  store.removeItem('token');
  finish();
  await pending;
  assert.equal(await store.getItem('token'), null);
  assert.equal(await f.create().getItem('token'), null);
});

test('An older encrypted write cannot overwrite a newer session', async t => {
  const finishes = [];
  const f = await fixture(t, true, (value, encrypt) => new Promise(resolve => {
    finishes.push(() => resolve(encrypt(value)));
  }));
  const store = f.create();
  const first = store.setItem('token', 'old');
  while (finishes.length < 1) await new Promise(resolve => setImmediate(resolve));
  const second = store.setItem('token', 'new');
  while (finishes.length < 2) await new Promise(resolve => setImmediate(resolve));
  finishes[1]();
  await second;
  finishes[0]();
  await first;
  assert.equal(await f.create().getItem('token'), 'new');
});
