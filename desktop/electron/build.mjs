import { build } from 'esbuild';
import { loadEnv, build as buildVite } from 'vite';
import { mkdir, cp, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rebuild } from '@electron/rebuild';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { channelFromArgs, releaseProfile, runtimeConfig, checkedRendererConfig, releaseArchitecture, releaseVersion } from './release-config.mjs';
import { dependencyNotices } from './notices.mjs';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2);
const channel = channelFromArgs(args);
const profile = releaseProfile(channel);
const arch = releaseArchitecture(args);
const release = args.includes('--release');
const stage = path.join(root, profile.stage);
const config = runtimeConfig(loadEnv(profile.mode, root, 'VITE_'), channel);
const version = releaseVersion(process.env, require('../../package.json').version);
if (args.includes('--check')) {
  console.log(`Desktop ${channel} configuration valid (${arch}, ${version}, ${release ? 'manual-distribution archive' : 'local candidate'}). No Developer ID or notarization required. No build or publication performed.`);
  process.exit(0);
}
if (process.platform !== 'darwin') throw new Error('Desktop packaging currently supports macOS only');
if (release) {
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8' });
  if (dirty.trim()) throw new Error('Release builds require committed source in a clean checkout');
  config.sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{40}$/.test(config.sourceCommit)) throw new Error('Release source commit is invalid');
}
if (args.includes('--renderer')) {
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', path.join(root, 'tsconfig.electron.json')], { cwd: root, stdio: 'inherit' });
  await buildVite({ configFile: path.join(root, 'vite.electron.config.ts'), mode: profile.mode });
}
const rendererConfig = JSON.parse(await readFile(path.join(root, profile.renderer, 'desktop-build.json'), 'utf8'));
checkedRendererConfig(rendererConfig, config);
if (rendererConfig.version !== version || !/^[a-f0-9-]{36}$/.test(rendererConfig.buildId ?? '')) throw new Error('Renderer release metadata differs; rebuild the matching Electron UI');
Object.assign(config, { version, buildId: rendererConfig.buildId, arch, release });
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
const clerkPackage = JSON.parse(await readFile(path.join(root, 'node_modules/@clerk/electron/package.json'), 'utf8'));
if (clerkPackage.version !== '0.0.52') throw new Error('Review the native OAuth integration before changing the Clerk Electron SDK version.');
if (process.platform === 'darwin') {
  const helper = path.join(stage, 'auth-session.app/Contents');
  await mkdir(path.join(helper, 'MacOS'), { recursive: true });
  await writeFile(path.join(helper, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>auth-session</string><key>CFBundleIdentifier</key><string>${profile.bundleId}.auth-session</string><key>CFBundleName</key><string>${profile.name}</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleVersion</key><string>${version}</string><key>CFBundlePackageType</key><string>APPL</string><key>LSMinimumSystemVersion</key><string>11.0</string><key>LSUIElement</key><true/></dict></plist>`);
  execFileSync('/usr/bin/xcrun', ['swiftc', ...(channel === 'production' ? ['-D', 'DESKTOP_PRODUCTION'] : []), '-target', `${arch === 'x64' ? 'x86_64' : arch}-apple-macos11.0`, path.join(root, 'desktop/electron/auth-session.swift'), '-o', path.join(helper, 'MacOS/auth-session'), '-framework', 'AppKit', '-framework', 'AuthenticationServices'], { stdio: 'inherit' });
}
await cp(path.join(root, profile.renderer), path.join(stage, 'renderer'), { recursive: true });
await buildVite({ configFile: path.join(root, 'vite.mcp-app.config.ts'), mode: profile.mode, build: { outDir: path.join(stage, 'dist-mcp'), emptyOutDir: true } });
await cp(path.join(root, 'node_modules/node-pty'), path.join(stage, 'node_modules/node-pty'), { recursive: true });
await writeFile(path.join(stage, 'config.json'), JSON.stringify(config));
const notices = await dependencyNotices(root);
await writeFile(path.join(stage, 'THIRD_PARTY_NOTICES.txt'), notices.text);
await writeFile(path.join(stage, 'THIRD_PARTY_REVIEW.json'), JSON.stringify({ count: notices.count, needsReview: notices.missing }, null, 2));
await cp(path.join(root, 'desktop/INSTALL.ja.md'), path.join(stage, 'INSTALL.ja.md'));
await writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: profile.packageName, version, type: 'module', main: 'main.mjs', dependencies: { 'node-pty': require('node-pty/package.json').version } }));
for (const [entry, output] of [['main.mjs', 'main.mjs'], ['preload.cjs', 'preload.cjs'], ['storage-smoke.mjs', 'storage-smoke.mjs'], ['process-guard-worker.mjs', 'process-guard-worker.mjs']]) {
  await build({ entryPoints: [path.join(root, 'desktop/electron', entry)], outfile: path.join(stage, output), bundle: true, platform: 'node', format: output.endsWith('.mjs') ? 'esm' : 'cjs', target: 'node22', external: ['electron', 'node-pty'],
    ...(output.endsWith('.mjs') ? { banner: { js: "import { createRequire as createRuntimeRequire } from 'node:module'; const require = createRuntimeRequire(import.meta.url);" } } : {}),
  });
}
await rebuild({ buildPath: stage, arch, electronVersion: require('electron/package.json').version, force: true, onlyModules: ['node-pty'] });
console.log(`Electron ${channel} runtime built (isolated profile, encrypted authentication storage).`);
