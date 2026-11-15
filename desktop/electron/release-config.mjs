export const profiles = Object.freeze({
  preview: Object.freeze({
    channel: 'preview', mode: 'production', scheme: 'bizencore-electron-preview',
    name: 'bizencore Electron Preview', packageName: 'bizencore-electron-preview',
    bundleId: 'com.bizencore.terminal.electron.preview',
    userData: 'bizencore-electron-preview', stage: '.electron-build', renderer: 'dist-electron',
    convexUrl: 'https://dazzling-setter-393.convex.cloud', clerkHost: 'grown-gorilla-52.clerk.accounts.dev',
  }),
  production: Object.freeze({
    channel: 'production', mode: 'desktop-production', scheme: 'bizencore-terminal',
    name: 'bizencore terminal', packageName: 'bizencore-terminal',
    bundleId: 'com.bizencore.terminal', userData: 'bizencore-terminal',
    stage: '.electron-build-production', renderer: 'dist-electron-production',
    convexUrl: 'https://good-chinchilla-15.convex.cloud', clerkHost: 'clerk.bizencore.com',
  }),
});

export function releaseProfile(channel = 'preview') {
  if (!Object.hasOwn(profiles, channel)) throw new Error('Invalid desktop release channel');
  return profiles[channel];
}

export function channelFromArgs(args) {
  if (args.includes('--production') && args.includes('--preview')) throw new Error('Choose one desktop release channel');
  if (args.includes('--release') && !args.includes('--production')) throw new Error('--release requires --production');
  return args.includes('--production') ? 'production' : 'preview';
}

export function releaseArchitecture(args, fallback = process.arch) {
  const values = args.filter(value => value.startsWith('--arch='));
  const arch = values[0]?.slice('--arch='.length) ?? fallback;
  if (values.length > 1 || !['arm64', 'x64'].includes(arch)) throw new Error('Desktop macOS architecture must be arm64 or x64');
  return arch;
}

export function releaseVersion(env, fallback) {
  const version = env.DESKTOP_RELEASE_VERSION ?? fallback;
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('DESKTOP_RELEASE_VERSION must be a stable major.minor.patch version');
  return version;
}

export function runtimeConfig(env, channel = 'preview') {
  const profile = releaseProfile(channel);
  const prefix = channel === 'production' ? 'pk_live_' : 'pk_test_';
  const key = env.VITE_CLERK_PUBLISHABLE_KEY;
  if (typeof key !== 'string' || !key.startsWith(prefix) || key.length > 1024) throw new Error(`Desktop ${channel} requires a ${prefix} Clerk publishable key`);
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(key.slice(prefix.length))) throw new Error('Invalid Clerk publishable key encoding');
  const host = Buffer.from(key.slice(prefix.length), 'base64').toString('utf8');
  if (host !== `${profile.clerkHost}$` || env.VITE_CONVEX_URL !== profile.convexUrl) throw new Error(`Desktop ${channel} Clerk and Convex deployment must match the pinned release profile`);
  return { channel, convexUrl: profile.convexUrl, clerkHost: profile.clerkHost };
}

export function checkedRuntimeConfig(value) {
  const profile = releaseProfile(value?.channel);
  if (!value || !Object.hasOwn(value, 'channel')) throw new Error('Missing desktop runtime channel; rebuild the runtime');
  if (value?.convexUrl !== profile.convexUrl || value?.clerkHost !== profile.clerkHost) throw new Error('Invalid desktop runtime deployment');
  return profile;
}

export function checkedRendererConfig(renderer, config) {
  if (!renderer || ['channel', 'convexUrl', 'clerkHost'].some(key => renderer[key] !== config[key])) throw new Error('Renderer and native build profiles differ; rebuild the matching Electron UI');
}

export function validAuthHost(host) {
  return typeof host === 'string' && host.length <= 253 && (host === profiles.production.clerkHost || /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+accounts\.dev$/.test(host));
}

export function desktopMcpSite(convexUrl) {
  const profile = Object.values(profiles).find(value => value.convexUrl === convexUrl);
  if (!profile) throw new Error('Invalid desktop MCP deployment');
  return profile.convexUrl.replace('.convex.cloud', '.convex.site');
}

export function manualSigningOptions() {
  // Seal the bundle without a certificate, account or Developer ID identity.
  return { identity: '-', identityValidation: false, preAutoEntitlements: false,
    optionsForFile: () => ({ hardenedRuntime: false, entitlements: [] }) };
}

export function releaseArtifacts({ version, arch, sha256, size, builtAt = new Date().toISOString() }) {
  releaseVersion({ DESKTOP_RELEASE_VERSION: version });
  releaseArchitecture([`--arch=${arch}`]);
  if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(size) || size <= 0 || !Number.isFinite(Date.parse(builtAt))) throw new Error('Invalid release artifact metadata');
  const filename = `${profiles.production.packageName}-${version}-darwin-${arch}.zip`;
  const directory = `production/darwin/${arch}`;
  return { filename, directory, manifest: { version, arch, filename, sha256, size, builtAt,
    adHocSigned: true, developerIdSigned: false, notarized: false, updateMethod: 'manual', published: false } };
}
