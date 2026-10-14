import assert from 'node:assert/strict';
import test from 'node:test';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { build } from 'esbuild';
import { loadConfigFromFile } from 'vite';
import { profiles, releaseProfile, channelFromArgs, runtimeConfig, checkedRuntimeConfig, checkedRendererConfig,
  releaseArchitecture, releaseVersion, validAuthHost, desktopMcpSite, releaseArtifacts, manualSigningOptions } from '../desktop/electron/release-config.mjs';
import { trustedRenderer } from '../desktop/electron/policy.mjs';

// Public key strings are synthetic fixtures; no Clerk or Convex request is made.
const fixtureEnv = channel => ({
  VITE_CLERK_PUBLISHABLE_KEY: `pk_${channel === 'production' ? 'live' : 'test'}_${Buffer.from(`${profiles[channel].clerkHost}$`).toString('base64')}`,
  VITE_CONVEX_URL: profiles[channel].convexUrl,
});

test('profiles isolate identity, schemes, storage and build outputs', () => {
  for (const field of ['scheme', 'name', 'packageName', 'bundleId', 'userData', 'stage', 'renderer', 'convexUrl', 'clerkHost']) {
    assert.notEqual(profiles.production[field], profiles.preview[field], field);
  }
  assert.equal(channelFromArgs([]), 'preview');
  assert.equal(channelFromArgs(['--production']), 'production');
  assert.throws(() => channelFromArgs(['--release']));
  assert.throws(() => channelFromArgs(['--production', '--preview']));
  assert.throws(() => releaseProfile('nightly'));
  assert.equal(releaseArchitecture(['--arch=x64']), 'x64');
  assert.throws(() => releaseArchitecture(['--arch=universal']));
  assert.throws(() => releaseArchitecture(['--arch=x64', '--arch=arm64']));
  assert.equal(releaseVersion({}, '0.1.0'), '0.1.0');
  for (const version of ['1.2', 'v1.2.3', '1.2.3-beta.1', '01.2.3', '../1.2.3']) assert.throws(() => releaseVersion({ DESKTOP_RELEASE_VERSION: version }));
});

test('both channels reject missing keys, opposite deployments and arbitrary destinations', () => {
  for (const channel of ['production', 'preview']) {
    const config = runtimeConfig(fixtureEnv(channel), channel);
    assert.equal(checkedRuntimeConfig(config), profiles[channel]);
    assert.ok(!JSON.stringify(config).includes('pk_'));
    const other = channel === 'production' ? 'preview' : 'production';
    assert.throws(() => runtimeConfig(fixtureEnv(other), channel));
    assert.throws(() => runtimeConfig({}, channel));
    assert.throws(() => runtimeConfig({ ...fixtureEnv(channel), VITE_CONVEX_URL: profiles[other].convexUrl }, channel));
    assert.throws(() => runtimeConfig({ ...fixtureEnv(channel), VITE_CLERK_PUBLISHABLE_KEY: `${fixtureEnv(channel).VITE_CLERK_PUBLISHABLE_KEY}!` }, channel));
    assert.throws(() => checkedRuntimeConfig({ ...config, clerkHost: profiles[other].clerkHost }));
    assert.throws(() => checkedRuntimeConfig({ ...config, convexUrl: 'https://attacker.convex.cloud' }));
    assert.throws(() => checkedRendererConfig(runtimeConfig(fixtureEnv(other), other), config));
    checkedRendererConfig(config, config);
  }
  assert.throws(() => checkedRuntimeConfig({ convexUrl: profiles.preview.convexUrl, clerkHost: profiles.preview.clerkHost }));
  assert.ok(validAuthHost(profiles.production.clerkHost));
  for (const host of ['../accounts.dev', '.accounts.dev', 'evil..accounts.dev', '-evil.accounts.dev', 'production.example.com']) assert.equal(validAuthHost(host), false);
  for (const url of ['https://unknown.convex.cloud', `${profiles.production.convexUrl}/`, 'https://good-chinchilla-15.convex.cloud.evil']) assert.throws(() => desktopMcpSite(url));
});

test('renderer trust never crosses a channel and production cannot use localhost', () => {
  for (const channel of ['production', 'preview']) {
    const other = channel === 'production' ? 'preview' : 'production';
    assert.ok(trustedRenderer(`${profiles[channel].scheme}://renderer/`, false, channel));
    assert.equal(trustedRenderer(`${profiles[other].scheme}://renderer/`, false, channel), false);
    assert.equal(trustedRenderer(`${profiles[channel].scheme}://renderer:444/`, false, channel), false);
  }
  assert.equal(trustedRenderer('http://127.0.0.1:5211/', true, 'production'), false);
  assert.ok(trustedRenderer('http://127.0.0.1:5211/', true, 'preview'));
});

test('manual distribution metadata requires no Apple account or signing credentials', () => {
  for (const channel of ['preview', 'production']) assert.equal(runtimeConfig(fixtureEnv(channel), channel).channel, channel);
  const release = releaseArtifacts({ version: '1.2.3', arch: 'arm64', sha256: 'a'.repeat(64), size: 123, builtAt: '2026-10-13T00:00:00.000Z' });
  const entry = release.manifest;
  assert.equal(release.filename, 'bizencore-terminal-1.2.3-darwin-arm64.zip');
  assert.equal(entry.filename, release.filename);
  assert.equal(entry.sha256, 'a'.repeat(64));
  assert.equal(entry.size, 123);
  assert.equal(entry.version, '1.2.3');
  assert.equal(entry.developerIdSigned, false);
  assert.equal(entry.adHocSigned, true);
  assert.equal(entry.notarized, false);
  assert.equal(entry.published, false);
  assert.equal(entry.updateMethod, 'manual');
  assert.ok(!Object.hasOwn(entry, 'url'));
  assert.throws(() => releaseArtifacts({ version: '1.2.3', arch: 'arm64', sha256: 'bad', size: 0 }));
});

test('manual signing seals resources without certificates or added device entitlements', () => {
  const options = manualSigningOptions();
  assert.equal(options.identity, '-');
  assert.equal(options.identityValidation, false);
  assert.equal(options.preAutoEntitlements, false);
  assert.deepEqual(options.optionsForFile(), { hardenedRuntime: false, entitlements: [] });
});

test('production archive preflight needs only the public production profile', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['desktop/electron/build.mjs', '--production', '--release', '--check'], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, ...fixtureEnv('production'), DESKTOP_SIGNING_IDENTITY: '', DESKTOP_NOTARY_PROFILE: '', DESKTOP_UPDATE_BASE_URL: '' },
  });
  assert.match(stdout, /No Developer ID or notarization required/);
});

test('production preflight fails closed before building when credentials are absent', async () => {
  const env = { ...process.env, VITE_CLERK_PUBLISHABLE_KEY: '', VITE_CONVEX_URL: '' };
  await assert.rejects(promisify(execFile)(process.execPath, ['desktop/electron/build.mjs', '--production', '--check'], { cwd: new URL('..', import.meta.url), env }), error => {
    assert.match(error.stderr, /requires a pk_live_ Clerk publishable key/);
    return true;
  });
});

test('renderer build descriptors bind the selected deployment and version and production never serves localhost', async () => {
  const keys = ['VITE_CLERK_PUBLISHABLE_KEY', 'VITE_CONVEX_URL', 'DESKTOP_RELEASE_VERSION'];
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const file = new URL('../vite.electron.config.ts', import.meta.url).pathname;
  try {
    for (const channel of ['preview', 'production']) {
      Object.assign(process.env, fixtureEnv(channel), { DESKTOP_RELEASE_VERSION: '1.2.3' });
      const { config } = await loadConfigFromFile({ command: 'build', mode: profiles[channel].mode }, file, undefined, 'silent');
      const plugin = config.plugins.flat().find(plugin => plugin.name === 'desktop-build-profile');
      const html = plugin.transformIndexHtml('<html><head><title>fixture preview</title></head></html>');
      assert.ok(html.includes(`<title>${profiles[channel].name}</title>`));
      assert.ok(!html.includes('fixture preview'));
      let artifact;
      plugin.generateBundle.call({ emitFile: value => { artifact = value; } });
      const metadata = JSON.parse(artifact.source);
      assert.equal(metadata.channel, channel);
      assert.equal(metadata.version, '1.2.3');
      assert.match(metadata.buildId, /^[a-f0-9-]{36}$/);
      assert.ok(!artifact.source.includes('pk_'));
      assert.ok(config.build.outDir.endsWith(profiles[channel].renderer));
      assert.equal(JSON.parse(config.define['import.meta.env.VITE_CONVEX_URL']), profiles[channel].convexUrl);
      assert.equal(JSON.parse(config.define['import.meta.env.VITE_APP_BUILD_ID']), '', 'desktop must not consume the web renderer update feed');
    }
    await assert.rejects(loadConfigFromFile({ command: 'serve', mode: 'desktop-production' }, file, undefined, 'silent'), /bundled renderer/);
  } finally {
    for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
  }
});

test('production MCP sends only the refreshed account JWT to the pinned production site and fails closed on server refusal', async () => {
  const { outputFiles } = await build({ entryPoints: ['desktop/electron/dev-mcp.mjs'], bundle: true, platform: 'node', format: 'esm', write: false });
  const { createDesktopMcp } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
  let grant = { userId: 'fixture-user', generation: 1, token: 'fixture-jwt-1' };
  let refuse = false;
  const calls = [];
  const options = { convexUrl: profiles.production.convexUrl, access: () => grant, readApp: '/fixture-not-used', fetchData: async (url, options) => {
    calls.push({ url, options });
    return refuse ? Response.json({ error: 'Production MCP unavailable' }, { status: 401 }) : Response.json({ tasks: [] });
  } };
  await assert.rejects(createDesktopMcp({ ...options, convexUrl: 'https://attacker.convex.cloud' }));
  const local = await createDesktopMcp(options);
  const cap = local.issue('fixture-pane', 'codex');
  const rpc = (method, params) => fetch(cap.url, { method: 'POST', headers: { Authorization: `Bearer ${cap.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  try {
    await (await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } })).text();
    const list = () => rpc('tools/call', { name: 'list_tasks', arguments: {} });
    await (await list()).text();
    assert.equal(calls[0].url, 'https://good-chinchilla-15.convex.site/desktop-mcp/list');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer fixture-jwt-1');
    assert.ok(!calls[0].options.body.includes('fixture-user'));
    grant = { ...grant, token: 'fixture-jwt-2' };
    await (await list()).text();
    assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer fixture-jwt-2');
    refuse = true;
    assert.match(await (await list()).text(), /Production MCP unavailable/);
    grant = { userId: 'other-user', generation: 2, token: 'fixture-jwt-3' };
    assert.equal((await list()).status, 401);
  } finally { await local.close(); }
});
