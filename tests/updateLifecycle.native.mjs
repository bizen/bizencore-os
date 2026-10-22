// Real signed Electron bundles; isolated files/profile, no account or network.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { packager } from '@electron/packager';
import { manualSigningOptions } from '../desktop/electron/release-config.mjs';

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
      import { acknowledgeUpdate, createDesktopInstaller, quitForUpdate } from './desktop/electron/update-install.mjs';
      import { attachDesktopLifecycle } from './desktop/electron/lifecycle.mjs';
      import { ipcMain } from 'electron';
      import { readFileSync, createReadStream } from 'node:fs';
      import { Readable } from 'node:stream';
      const root = ${JSON.stringify(root)}, version = ${JSON.stringify(version)};
      app.setPath('userData', path.join(root, 'profile'));
      app.whenReady().then(async () => {
        if (version === '0.0.2' && existsSync(path.join(root, 'fail-new'))) { app.exit(2); return; }
        const window = new BrowserWindow({ show: false, webPreferences: { preload: path.join(app.getAppPath(), 'preload.cjs'), contextIsolation: true, sandbox: true } });
        const installed = path.dirname(path.dirname(path.dirname(app.getAppPath())));
        const lifecycle = attachDesktopLifecycle({ app, getWindow: () => window, runningCount: () => 0, pendingCount: () => 0,
          showMessageBox: async () => ({response: 1}), stopAgents: async () => {}, onError: e => appendFileSync(path.join(root, 'integration-errors'), e.stack + '\\n') });
        ipcMain.handle('fixture-ready', async () => {
          const release = JSON.parse(readFileSync(path.join(root, 'release.json'), 'utf8'));
          const updater = createDesktopInstaller({bundle: installed, arch: process.arch, getRelease: async () => release,
            helperSource: readFileSync(path.join(root, 'helper.sh'), 'utf8'),
            fetchData: async () => new Response(Readable.toWeb(createReadStream(path.join(root, 'fixture.zip')))) });
          await updater.download();
          return updater.install({ requestQuit: options => lifecycle.requestQuit(options), quit: () => quitForUpdate(app, () => lifecycle.canExit(), () => appendFileSync(path.join(root, 'exit-fallback'), 'used\\n')) });
        });
        await window.loadURL('data:text/html,<main>Update fixture</main>');
        if (await window.webContents.executeJavaScript('document.querySelector("main").textContent') !== 'Update fixture') throw Error('Fixture renderer failed');
        const bundle = path.dirname(path.dirname(path.dirname(app.getAppPath())));
        await acknowledgeUpdate(bundle, process.argv);
        appendFileSync(path.join(root, 'boots'), JSON.stringify({ version, pid: process.pid, rolledBack: process.argv.includes('--bizencore-update-rolled-back') }) + '\\n');
        if (version === '0.0.1' && !process.argv.includes('--bizencore-update-rolled-back')) {
          await window.webContents.executeJavaScript('window.onbeforeunload = () => false; true');
          void window.webContents.executeJavaScript('window.fixtureReady()').catch(e => appendFileSync(path.join(root, 'integration-errors'), e.stack + '\\n'));
        }
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
  await writeFile(path.join(root, 'release.json'), JSON.stringify(release)); await writeFile(path.join(root, 'helper.sh'), helperSource);
  await mkdir(path.join(root, 'profile')); await writeFile(path.join(root, 'profile/settings'), 'preserved');
  for (const fails of [false, true]) {
    await rm(path.join(root, 'exit-fallback'), { force: true });
    if (fails) await writeFile(path.join(root, 'fail-new'), 'fail');
    const parent = path.join(root, fails ? 'rollback' : 'success'); await mkdir(parent);
    const installed = path.join(parent, 'bizencore terminal.app');
    await run('/usr/bin/ditto', [bundles[0], installed]);
    const childEnv = { ...process.env }; delete childEnv.ELECTRON_RUN_AS_NODE;
    const old = spawn(path.join(installed, 'Contents/MacOS/bizencore terminal'), [], { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv }); oldProcesses.push(old);
    let diagnostics = ''; old.stderr.on('data', value => { diagnostics += value; }); old.stdout.on('data', value => { diagnostics += value; });
    old.on('error', error => { diagnostics += error.message; });
    try { await waitFor(async () => (await boots()).some(boot => boot.pid === old.pid)); } catch (error) { throw Error(error.message + '\n' + diagnostics); }
    const boot = await waitFor(async () => (await boots()).find(entry => fails ? entry.rolledBack : entry.version === '0.0.2'));
    assert.equal(boot.version, fails ? '0.0.1' : '0.0.2');
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', installed]);
    assert.ok(await exists(path.join(root, 'exit-fallback')), 'a cancelled renderer quit must use the approved-exit fallback');
    assert.equal(await readFile(path.join(root, 'profile/settings'), 'utf8'), 'preserved');
    assert.equal(await exists(path.join(root, 'integration-errors')), false, 'native IPC lifecycle must not report errors');
    process.kill(boot.pid, 'SIGTERM');
    console.log(fails ? 'Native signed app: failed startup restored and relaunched the old version; profile preserved.' : 'Native signed app: real IPC, approved exit fallback, verified swap and renderer acknowledgement passed.');
  }
} finally {
  for (const old of oldProcesses) try { old.kill(); } catch { /* Fixture may have exited. */ }
  for (const boot of await boots()) {
    try {
      const { stdout } = await run('/bin/ps', ['-p', String(boot.pid), '-o', 'command=']);
      if (stdout.includes(root)) process.kill(boot.pid, 'SIGTERM');
    } catch { /* Fixture already exited. */ }
  }
  console.log('Integration diagnostics:', await readFile(path.join(root, 'integration-errors'), 'utf8').catch(() => 'none'));
  await rm(root, { recursive: true, force: true });
}
