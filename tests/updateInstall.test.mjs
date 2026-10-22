import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, access, mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { downloadUpdate, verifyUpdateBundle, acknowledgeUpdate, quitForUpdate, updateInstallMessage } from '../desktop/electron/update-install.mjs';
import { validateUpdateArchive } from '../desktop/electron/update-archive.mjs';

const temp = () => mkdtemp(path.join(tmpdir(), 'bizencore-update-test-'));
const bytes = Buffer.from('verified update');
const release = { version: '0.1.19', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
  downloadUrl: 'https://github.com/bizen/bizencore-os/releases/download/desktop-v0.1.19/bizencore-terminal-0.1.19-darwin-arm64.zip' };

test('downloads enforce HTTPS redirects, omit credentials and validate exact bytes and digest', async () => {
  const dir = await temp();
  try {
    const progress = []; let calls = 0;
    await downloadUpdate(release, path.join(dir, 'good'), async (url, options) => {
      calls++; assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'manual');
      return calls === 1 ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/file' } }) : new Response(bytes);
    }, value => progress.push(value));
    assert.equal(calls, 2); assert.deepEqual(await readFile(path.join(dir, 'good')), bytes); assert.ok(progress.length);
    for (const [name, body] of [['short', bytes.subarray(1)], ['long', Buffer.concat([bytes, bytes])], ['bad-digest', Buffer.alloc(bytes.length)]]) {
      await assert.rejects(downloadUpdate(release, path.join(dir, name), async () => new Response(body)), /size|checksum/);
    }
    await assert.rejects(downloadUpdate(release, path.join(dir, 'redirect'), async () => new Response(null, { status: 302, headers: { location: 'https://attacker.test/app.zip' } })), /Untrusted/);
    await assert.rejects(downloadUpdate({ ...release, size: 513 * 1024 ** 2 }, path.join(dir, 'huge'), () => assert.fail('must not fetch')), /size/);
    await assert.rejects(downloadUpdate(release, path.join(dir, 'offline'), async () => { throw Error('offline'); }), /offline/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

function zip(entries) {
  const local = [], central = []; let offset = 0;
  for (const { name, data = '', mode = 0o100644 } of entries) {
    const n = Buffer.from(name), b = Buffer.from(data), header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt32LE(b.length, 18); header.writeUInt32LE(b.length, 22); header.writeUInt16LE(n.length, 26);
    local.push(header, n, b);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt32LE(b.length, 20); c.writeUInt32LE(b.length, 24); c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE((mode << 16) >>> 0, 38); c.writeUInt32LE(offset, 42); central.push(c, n); offset += header.length + n.length + b.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
const plist = { name: 'bizencore terminal.app/Contents/Info.plist' };
test('archive preflight rejects traversal, escaping links, duplicate paths and children under links', async () => {
  const dir = await temp(), filename = path.join(dir, 'update.zip');
  const verify = async entries => { await writeFile(filename, zip(entries)); return validateUpdateArchive(filename); };
  try {
    await verify([plist, { name: 'bizencore terminal.app/Contents/Frameworks/Current', mode: 0o120777, data: 'A' }]);
    for (const entries of [
      [plist, { name: '../outside' }], [plist, { name: 'bizencore terminal.app/../outside' }],
      [plist, { name: '/absolute' }], [plist, plist],
      [plist, { name: 'bizencore terminal.app/Contents/link', mode: 0o120777, data: '../../outside' }],
      [plist, { name: 'bizencore terminal.app/Contents/link', mode: 0o120777, data: 'Frameworks' }, { name: 'bizencore terminal.app/Contents/link/file' }],
    ]) await assert.rejects(verify(entries), /Unsafe|traverses/);
    await writeFile(filename, 'not a ZIP'); await assert.rejects(validateUpdateArchive(filename), /ZIP/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('bundle verification checks identity, version, architecture and signature before installation', async () => {
  const calls = [], values = { CFBundleIdentifier: 'com.bizencore.terminal', CFBundleShortVersionString: release.version, CFBundleExecutable: 'bizencore terminal' };
  const run = async (file, args) => { calls.push([file, args]); return { stdout: values[args[1]?.replace('Print :', '')] ?? '' }; };
  await verifyUpdateBundle('/fixture/app', release, 'arm64', run);
  assert.ok(calls.some(([file]) => file === '/usr/bin/codesign'));
  assert.ok(calls.some(([file, args]) => file === '/usr/bin/lipo' && args[1] === '-verify_arch' && args[2] === 'arm64'));
  values.CFBundleIdentifier = 'attacker';
  await assert.rejects(verifyUpdateBundle('/fixture/app', release, 'arm64', run), /identity/);
});

test('startup acknowledgements stay in an owned sibling directory and never follow symlinks', async () => {
  const parent = await temp(), bundle = path.join(parent, 'App.app'); await mkdir(bundle);
  const job = await mkdtemp(path.join(parent, '.bizencore-update-'));
  try {
    await acknowledgeUpdate(bundle, [`--bizencore-update=${path.basename(job)}`]); await access(path.join(job, 'ready'));
    await assert.rejects(acknowledgeUpdate(bundle, ['--bizencore-update=../../escape']), /Invalid/);
    const link = path.join(parent, '.bizencore-update-ABC123'); await symlink(job, link);
    await assert.rejects(acknowledgeUpdate(bundle, [`--bizencore-update=${path.basename(link)}`]), /Invalid/);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('external helper waits for exit, replaces safely, preserves user files and rolls back a failed launch', { skip: process.platform !== 'darwin' }, async () => {
  for (const succeeds of [true, false]) {
    const parent = await temp(), installed = path.join(parent, 'bizencore terminal.app');
    const job = await mkdtemp(path.join(parent, '.bizencore-update-')), temporary = await mkdtemp(path.join(tmpdir(), 'bizencore-update-'));
    const oldPid = spawn('/bin/sleep', ['20']);
    const app = async (folder, script) => { await mkdir(path.join(folder, 'Contents/MacOS'), { recursive: true }); await writeFile(path.join(folder, 'Contents/MacOS/bizencore terminal'), '#!/bin/sh\n' + script, { mode: 0o755 }); };
    try {
      await writeFile(path.join(parent, 'settings'), 'keep settings');
      await app(installed, `echo old > '${parent}/launched-old'\n`);
      await app(path.join(job, 'new.app'), succeeds ? `echo ready > '${job}/ready'\necho new > '${parent}/launched-new'\n` : 'exit 1\n');
      const helper = spawn('/bin/sh', ['desktop/electron/update-helper.sh', job, installed, String(oldPid.pid), temporary]);
      const exited = new Promise(resolve => helper.once('exit', code => resolve(code)));
      const deadline = Date.now() + 5000;
      while (true) { try { await access(path.join(job, 'armed')); break; } catch { if (Date.now() > deadline) assert.fail('helper did not arm'); await new Promise(resolve => setTimeout(resolve, 20)); } }
      assert.ok((await readFile(path.join(installed, 'Contents/MacOS/bizencore terminal'), 'utf8')).includes('old'));
      oldPid.kill();
      assert.equal(await exited, succeeds ? 0 : 5);
      assert.equal(await readFile(path.join(parent, 'settings'), 'utf8'), 'keep settings');
      const launched = path.join(parent, succeeds ? 'launched-new' : 'launched-old');
      const launchDeadline = Date.now() + 5000;
      while (true) { try { await access(launched); break; } catch { if (Date.now() > launchDeadline) assert.fail('replacement did not launch'); await new Promise(resolve => setTimeout(resolve, 20)); } }
      if (!succeeds) {
        await access(path.join(job, 'rolled-back'));
        await assert.rejects(access(path.join(job, 'failed.app')), /ENOENT/);
        await assert.rejects(access(temporary), /ENOENT/);
      }
    } finally { oldPid.kill(); await rm(parent, { recursive: true, force: true }); await rm(temporary, { recursive: true, force: true }); }
  }
});

test('approved update exit recovers a cancelled native quit but never exits with live work', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = []; let approved = true;
  const app = { quit: () => calls.push('quit'), exit: code => calls.push(['exit', code]) };
  assert.throws(() => quitForUpdate(app, () => false), /not approved/);
  assert.deepEqual(calls, []);
  quitForUpdate(app, () => approved, () => calls.push('fallback'));
  t.mock.timers.tick(1499); assert.deepEqual(calls, ['quit']);
  t.mock.timers.tick(1); assert.deepEqual(calls, ['quit', 'fallback', ['exit', 0]]);
  calls.length = 0; quitForUpdate(app, () => approved); approved = false;
  t.mock.timers.tick(1500); assert.deepEqual(calls, ['quit']);
});
test('update errors identify actual failure without blaming capacity for unrelated errors', () => {
  assert.match(updateInstallMessage({code:'ENOSPC'}), /空き容量/);
  assert.match(updateInstallMessage({code:'EPERM'}), /書き込めません/);
  assert.match(updateInstallMessage(Error('Move the app to a writable Applications folder')), /一時隔離/);
  assert.match(updateInstallMessage(Error('Update is not ready')), /準備状態/);
  assert.doesNotMatch(updateInstallMessage(Error('unexpected')), /容量|権限/);
});
