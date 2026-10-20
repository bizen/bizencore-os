// Real signed Electron bundles; isolated files/profile, no account or network.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { packager } from '@electron/packager';
import { manualSigningOptions } from '../desktop/electron/release-config.mjs';
import { createDesktopInstaller } from '../desktop/electron/update-install.mjs';

assert.equal(process.platform, 'darwin');
const run = promisify(execFile), root = await mkdtemp(path.join(tmpdir(), 'bizencore-updater-native-'));
const waitFor = async check => {
  const deadline = Date.now() + 30_000;
  while (true) { const value = await check(); if (value) return value; if (Date.now() > deadline) throw Error('Timed out waiting for fixture'); await new Promise(resolve => setTimeout(resolve, 100)); }
};
const exists = async file => { try { await access(file); return true; } catch { return false; } };
const boots = async () => { try { return (await readFile(path.join(root, 'boots'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)); } catch { return []; } };
const oldProcesses = [];
try {
  const bundles = [];
  for (const version of ['0.0.1', '0.0.2']) {
    const stage = path.join(root, `stage-${version}`); await mkdir(stage);
    await writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: 'update-fixture', version, main: 'main.cjs' }));
    await writeFile(path.join(stage, 'preload.cjs'), `const { contextBridge, ipcRenderer } = require('electron'); contextBridge.exposeInMainWorld('fixtureReady', () => ipcRenderer.invoke('fixture-ready'));`);
    await build({ stdin: { resolveDir: process.cwd(), contents: `
      import { app, BrowserWindow } from 'electron';
      import { existsSync, appendFileSync } from 'node:fs';
      import path from 'node:path';
      import { acknowledgeUpdate } from './desktop/electron/update-install.mjs';
      const root = ${JSON.stringify(root)}, version = ${JSON.stringify(version)};
      app.setPath('userData', path.join(root, 'profile'));
      app.whenReady().then(async () => {
        if (version === '0.0.2' && existsSync(path.join(root, 'fail-new'))) { app.exit(2); return; }
        const window = new BrowserWindow({ show: false, webPreferences: { preload: path.join(app.getAppPath(), 'preload.cjs'), contextIsolation: true, sandbox: true } });
        await window.loadURL('data:text/html,<main>Update fixture</main>');
        if (await window.webContents.executeJavaScript('document.querySelector("main").textContent') !== 'Update fixture') throw Error('Fixture renderer failed');
        const bundle = path.dirname(path.dirname(path.dirname(app.getAppPath())));
        await acknowledgeUpdate(bundle, process.argv);
        appendFileSync(path.join(root, 'boots'), JSON.stringify({ version, pid: process.pid, rolledBack: process.argv.includes('--bizencore-update-rolled-back') }) + '\\n');
        setTimeout(() => app.quit(), 25000);
      });
    ` }, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: path.join(stage, 'main.cjs') });
    const outputs = await packager({ dir: stage, out: path.join(root, `out-${version}`), name: 'bizencore terminal', appBundleId: 'com.bizencore.terminal',
      platform: 'darwin', arch: process.arch, appVersion: version, electronVersion: '44.7.0', prune: false, asar: true, osxSign: manualSigningOptions() });
    bundles.push(path.join(outputs[0], 'bizencore terminal.app'));
  }
  const archive = path.join(root, 'fixture.zip');
  await run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', bundles[1], archive]);
  const hash = createHash('sha256'); let size = 0;
  for await (const chunk of createReadStream(archive)) { hash.update(chunk); size += chunk.length; }
  const release = { version: '0.0.2', size, sha256: hash.digest('hex'), downloadUrl: 'https://github.com/bizen/bizencore-os/releases/download/desktop-v0.0.2/bizencore-terminal-0.0.2-darwin-arm64.zip' };
  const helperSource = await readFile('desktop/electron/update-helper.sh', 'utf8');
  await mkdir(path.join(root, 'profile')); await writeFile(path.join(root, 'profile/settings'), 'preserved');
  for (const fails of [false, true]) {
    if (fails) await writeFile(path.join(root, 'fail-new'), 'fail');
    const parent = path.join(root, fails ? 'rollback' : 'success'); await mkdir(parent);
    const installed = path.join(parent, 'bizencore terminal.app');
    await run('/usr/bin/ditto', [bundles[0], installed]);
    const childEnv = { ...process.env }; delete childEnv.ELECTRON_RUN_AS_NODE;
    const old = spawn(path.join(installed, 'Contents/MacOS/bizencore terminal'), [], { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv }); oldProcesses.push(old);
    let diagnostics = ''; old.stderr.on('data', value => { diagnostics += value; }); old.stdout.on('data', value => { diagnostics += value; });
    old.on('error', error => { diagnostics += error.message; });
    try { await waitFor(async () => (await boots()).some(boot => boot.pid === old.pid)); } catch (error) { throw Error(error.message + '\n' + diagnostics); }
    let calls = 0;
    const updater = createDesktopInstaller({ bundle: installed, arch: process.arch, getRelease: async () => release, helperSource,
      fetchData: async (_url, options) => { assert.equal(options.credentials, 'omit'); calls++; return new Response(Readable.toWeb(createReadStream(archive))); } });
    const first = updater.download(); assert.equal(updater.download(), first, 'parallel download requests coalesce');
    assert.equal((await first).version, '0.0.2'); assert.equal(calls, 1);
    let quit = false;
    assert.equal(await updater.install({ pid: old.pid, requestQuit: async () => false, quit: () => { quit = true; } }), false);
    assert.equal(quit, false, 'cancellation keeps the running app'); assert.equal(old.exitCode, null);
    assert.equal(await updater.install({ pid: old.pid, requestQuit: async ({ onApproved }) => { await onApproved(); return true; }, quit: () => old.kill('SIGTERM') }), true);
    const boot = await waitFor(async () => (await boots()).find(entry => fails ? entry.rolledBack : entry.version === '0.0.2'));
    assert.equal(boot.version, fails ? '0.0.1' : '0.0.2');
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', installed]);
    assert.equal(await readFile(path.join(root, 'profile/settings'), 'utf8'), 'preserved');
    process.kill(boot.pid, 'SIGTERM');
    console.log(fails ? 'Native signed app: failed startup restored and relaunched the old version; profile preserved.' : 'Native signed app: streamed download, verification, cancelled restart, swap and renderer acknowledgement passed.');
  }
} finally {
  for (const old of oldProcesses) try { old.kill(); } catch { /* Fixture may have exited. */ }
  for (const boot of await boots()) {
    try {
      const { stdout } = await run('/bin/ps', ['-p', String(boot.pid), '-o', 'command=']);
      if (stdout.includes(root)) process.kill(boot.pid, 'SIGTERM');
    } catch { /* Fixture already exited. */ }
  }
  await rm(root, { recursive: true, force: true });
}
