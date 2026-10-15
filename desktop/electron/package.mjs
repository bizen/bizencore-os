import { packager } from '@electron/packager';
import { fileURLToPath } from 'node:url';
import { readFile, access, mkdir, writeFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { channelFromArgs, releaseProfile, checkedRuntimeConfig, checkedRendererConfig, releaseArchitecture, releaseVersion, releaseArtifacts, manualSigningOptions } from './release-config.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2);
const profile = releaseProfile(channelFromArgs(args));
const arch = releaseArchitecture(args);
const config = JSON.parse(await readFile(path.join(root, profile.stage, 'config.json'), 'utf8'));
if (checkedRuntimeConfig(config).channel !== profile.channel) throw new Error('Packaging the wrong desktop build profile');
const release = args.includes('--release');
if (release && !/^[a-f0-9]{40}$/.test(config.sourceCommit ?? '')) throw new Error('Release must reference its source commit');
const version = releaseVersion(process.env, config.version);
if (config.arch !== arch || config.version !== version || config.release !== release) throw new Error('Packaging flags/version differ from the runtime build; rebuild it with matching flags');
const renderer = JSON.parse(await readFile(path.join(root, profile.stage, 'renderer/desktop-build.json'), 'utf8'));
checkedRendererConfig(renderer, config);
if (renderer.buildId !== config.buildId || renderer.version !== version) throw new Error('Staged renderer metadata differs from the runtime build');
const icon = process.env.DESKTOP_ICON_PATH ?? path.join(root, 'desktop/assets/icon.icns');
await access(icon);
if (process.platform !== 'darwin') throw new Error('Desktop packaging currently supports macOS only');
const releaseDirectory = path.join(root, 'out-electron', 'releases', 'production', 'darwin', arch, version);
if (release) {
  try {
    await access(releaseDirectory);
    throw new Error('Release version already has local artifacts; choose a new version or explicitly remove the failed local candidate');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const outputs = await packager({
  dir: path.join(root, profile.stage), out: `${root}/out-electron`,
  name: profile.name, appBundleId: profile.bundleId,
  platform: 'darwin', arch, overwrite: true, prune: false,
  appVersion: version, buildVersion: version, icon,
  extendInfo: { CFBundleDisplayName: `${profile.name} ${version}` },
  protocols: [{ name: profile.name, schemes: [profile.scheme] }],
  asar: { unpack: '**/node_modules/node-pty/**' },
  extraResource: [
    path.join(root, profile.stage, 'auth-session.app'),
    path.join(root, profile.stage, 'process-guard-worker.mjs'),
    path.join(root, profile.stage, 'THIRD_PARTY_NOTICES.txt'),
    path.join(root, 'node_modules/electron/dist/LICENSE'),
    path.join(root, 'node_modules/electron/dist/LICENSES.chromium.html'),
    path.join(root, 'desktop/INSTALL.ja.md'),
  ],
  ignore: [/^\/auth-session\.app/, /^\/process-guard-worker\.mjs$/],
  ...(profile.channel === 'production' ? { osxSign: manualSigningOptions() } : {}),
});
if (profile.channel === 'production') {
  for (const output of outputs) {
    for (const file of ['THIRD_PARTY_NOTICES.txt', 'LICENSE', 'LICENSES.chromium.html', 'INSTALL.ja.md']) {
      if ((await stat(path.join(output, `${profile.name}.app`, 'Contents/Resources', file))).size <= 0) {
        throw new Error(`Missing distribution notice: ${file}`);
      }
    }
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', path.join(output, `${profile.name}.app`)], { stdio: 'inherit' });
  }
}
if (release) {
  for (const output of outputs) {
    const bundle = path.join(output, `${profile.name}.app`);
    const directory = releaseDirectory;
    await mkdir(directory, { recursive: true });
    const filename = `${profile.packageName}-${version}-darwin-${arch}.zip`;
    const archive = path.join(directory, filename);
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', bundle, archive], { stdio: 'inherit' });
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    const sha256 = hash.digest('hex');
    const size = (await stat(archive)).size;
    const artifacts = releaseArtifacts({ version, arch, sha256, size, sourceCommit: config.sourceCommit });
    await writeFile(path.join(directory, 'artifact.json'), `${JSON.stringify(artifacts.manifest, null, 2)}\n`);
    await writeFile(path.join(directory, 'SHA256SUMS'), `${sha256}  ${filename}\n`);
    await writeFile(path.join(directory, 'INSTALL.md'), await readFile(new URL('./INSTALL.md', import.meta.url)));
    for (const file of ['INSTALL.ja.md', 'THIRD_PARTY_NOTICES.txt', 'THIRD_PARTY_REVIEW.json']) {
      await writeFile(path.join(directory, file), await readFile(path.join(root, profile.stage, file)));
    }
    console.log(`Manual-distribution ZIP and checksum prepared in ${directory}. No Developer ID signature or notarization. Nothing was published.`);
  }
}
if (profile.channel === 'production') console.log('No Developer ID signature or notarization. macOS may block opening downloaded copies. Updates are manual.');
console.log(outputs.join('\n'));
