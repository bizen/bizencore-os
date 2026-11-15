import { access, chmod, lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateUpdateArchive } from './update-archive.mjs';

const execute = promisify(execFile);
const ASSET_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const MAX_DOWNLOAD = 512 * 1024 ** 2;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function downloadUpdate(release, filename, fetchData, onProgress = () => {}) {
  if (!Number.isSafeInteger(release.size) || release.size <= 0 || release.size > MAX_DOWNLOAD || !/^[a-f0-9]{64}$/.test(release.sha256)) throw Error('Invalid update size or digest');
  let url = release.downloadUrl;
  let response;
  const signal = AbortSignal.timeout(10 * 60_000);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || !ASSET_HOSTS.has(target.hostname) || target.username || target.password || target.port) throw Error('Untrusted update URL');
    response = await fetchData(target.href, { credentials: 'omit', redirect: 'manual', signal, headers: { Accept: 'application/octet-stream' } });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    await response.body?.cancel();
    url = new URL(response.headers.get('location'), target).href;
    response = undefined;
  }
  if (!response?.ok || !response.body) throw Error('Update download failed');
  const reader = response.body.getReader(), hash = createHash('sha256');
  let file, size = 0;
  try {
    file = await open(filename, 'wx', 0o600);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > release.size) throw Error('Update exceeds published size');
      hash.update(value); await file.writeFile(value);
      onProgress(Math.min(99, Math.floor(size / release.size * 100)));
    }
    if (size !== release.size || hash.digest('hex') !== release.sha256) throw Error('Update checksum mismatch');
  } finally { await file?.close(); await reader.cancel(); }
}

export async function verifyUpdateBundle(bundle, release, arch, run = execute) {
  const plist = path.join(bundle, 'Contents/Info.plist');
  for (const [key, expected] of [['CFBundleIdentifier', 'com.bizencore.terminal'], ['CFBundleShortVersionString', release.version], ['CFBundleExecutable', 'bizencore terminal']]) {
    const { stdout } = await run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist]);
    if (stdout.trim() !== expected) throw Error('Update app identity mismatch');
  }
  await run('/usr/bin/lipo', [path.join(bundle, 'Contents/MacOS/bizencore terminal'), '-verify_arch', arch]);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
}

export async function acknowledgeUpdate(bundle, argv) {
  const value = argv.find(arg => arg.startsWith('--bizencore-update='))?.split('=')[1];
  if (!value) return;
  if (!/^\.bizencore-update-[A-Za-z0-9]{6}$/.test(value)) throw Error('Invalid update acknowledgement');
  const parent = path.dirname(await realpath(bundle)), job = path.join(parent, value);
  const info = await lstat(job);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) throw Error('Invalid update directory');
  await writeFile(path.join(job, 'ready'), 'ready', { flag: 'wx', mode: 0o600 });
}

export function updateInstallMessage(error) {
  if (error?.code === 'ENOSPC') return '更新用の空き容量が不足しています。空きを確保して再試行してください。';
  if (['EACCES', 'EPERM', 'EROFS'].includes(error?.code)) return 'アプリの保存先に書き込めません。書き込み可能なApplicationsフォルダへ移動してください。';
  if (error?.message?.includes('Move the app')) return 'macOSの一時隔離場所から起動しているため更新できません。アプリを終了し、Applicationsの本体から開き直してください。';
  if (error?.message === 'Update is not ready') return '更新の準備状態が失われました。アプリを開き直して新版を取得してください。';
  if (error?.message === 'Update helper did not start') return '更新用ヘルパーを起動できませんでした。更新ログを確認してください。';
  return '更新処理を完了できませんでした。原因は更新ログ（desktop-update.log）に記録しました。';
}

export function quitForUpdate(app, canExit, onFallback = () => {}) {
  if (!canExit()) throw Error('Update shutdown is not approved');
  // Work has stopped and the renderer saved its inputs before this update was approved.
  const timer = setTimeout(() => {
    if (!canExit()) return;
    try { onFallback(); } finally { app.exit(0); }
  }, 1500);
  timer.unref?.();
  app.quit();
}

export function createDesktopInstaller({ bundle, arch, getRelease, fetchData, helperSource, onProgress = () => {}, onEvent = () => {}, run = execute }) {
  let pending, prepared, installing = false;
  const cleanup = async () => {
    if (prepared && !installing) { const current = prepared; prepared = undefined; await rm(current.directory, { recursive: true, force: true }); }
  };
  return {
    download() {
      if (pending) return pending;
      if (prepared) return Promise.resolve({ version: prepared.release.version });
      pending = (async () => {
        const release = await getRelease();
        if (!release?.downloadUrl) throw Error('Update is unavailable');
        const directory = await mkdtemp(path.join(tmpdir(), 'bizencore-update-'));
        try {
          const archive = path.join(directory, 'update.zip');
          await downloadUpdate(release, archive, fetchData, onProgress);
          await validateUpdateArchive(archive);
          const extracted = path.join(directory, 'extracted'); await mkdir(extracted);
          await run('/usr/bin/ditto', ['-xk', archive, extracted], { timeout: 120_000 });
          const next = path.join(extracted, 'bizencore terminal.app');
          await verifyUpdateBundle(next, release, arch, run);
          await rm(archive);
          prepared = { directory, next, release };
          onProgress(100);
          return { version: release.version };
        } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
      })().finally(() => { pending = undefined; });
      return pending;
    },
    async install({ requestQuit, quit, pid = process.pid }) {
      if (!prepared || installing) throw Error('Update is not ready');
      installing = true;
      let job, approved = false;
      try {
        onEvent({ stage: 'install-prepare', version: prepared.release.version });
        const info = await lstat(bundle), parent = path.dirname(bundle);
        if (!info.isDirectory() || info.isSymbolicLink() || /\/AppTranslocation\/|^\/Volumes\//.test(bundle)) throw Error('Move the app to a writable Applications folder');
        await access(parent, constants.W_OK);
        job = await mkdtemp(path.join(parent, '.bizencore-update-'));
        // Stage on the installation volume so both renames remain atomic.
        await run('/usr/bin/ditto', [prepared.next, path.join(job, 'new.app')], { timeout: 120_000 });
        await verifyUpdateBundle(path.join(job, 'new.app'), prepared.release, arch, run);
        const helper = path.join(job, 'helper.sh');
        await writeFile(helper, helperSource, { mode: 0o700 }); await chmod(job, 0o700);
        onEvent({ stage: 'install-staged', job: path.basename(job), version: prepared.release.version });
        approved = await requestQuit({ reason: 'update', onApproved: async () => {
          const worker = spawn('/bin/sh', [helper, job, bundle, String(pid), prepared.directory], { detached: true, stdio: 'ignore' });
          await new Promise((resolve, reject) => { worker.once('error', reject); worker.once('spawn', resolve); });
          worker.unref();
          const deadline = Date.now() + 5000;
          while (true) {
            try { await access(path.join(job, 'armed')); break; } catch { /* Wait for the external helper's preflight. */ }
            if (Date.now() >= deadline) throw Error('Update helper did not start');
            await wait(50);
          }
          onEvent({ stage: 'helper-armed', job: path.basename(job) });
          setImmediate(quit);
        } });
        if (!approved) { await writeFile(path.join(job, 'cancelled'), 'cancelled'); await rm(job, { recursive: true, force: true }); }
        onEvent({ stage: approved ? 'shutdown-approved' : 'shutdown-cancelled' });
        return approved;
      } catch (error) { onEvent({ stage: 'install-failed', code: String(error.code ?? error.message) }); if (job) await rm(job, { recursive: true, force: true }); throw error; }
      finally { if (!approved) installing = false; }
    },
    cleanup,
  };
}
