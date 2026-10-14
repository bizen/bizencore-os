import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
// @ts-expect-error The runtime profile module is shared with the Node build scripts.
import { runtimeConfig, releaseProfile, releaseVersion } from './desktop/electron/release-config.mjs';

export default defineConfig(({ mode, command }) => {
  const channel = mode === 'desktop-production' ? 'production' : 'preview';
  const profile = releaseProfile(channel);
  if (channel === 'production' && command === 'serve') throw new Error('Production desktop requires a bundled renderer');
  const root = fileURLToPath(new URL('.', import.meta.url));
  const env = loadEnv(mode, root, 'VITE_');
  const config = { ...runtimeConfig(env, channel), buildId: randomUUID(), version: releaseVersion(process.env, JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version) };
  return {
  root: fileURLToPath(new URL('./desktop/electron', import.meta.url)),
  envDir: root,
  publicDir: fileURLToPath(new URL('./public', import.meta.url)),
  plugins: [react(), { name: 'desktop-build-profile', transformIndexHtml(html) {
    return html.replace(/<title>[^<]*<\/title>/, `<title>${profile.name}</title>`);
  }, generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'desktop-build.json', source: JSON.stringify(config) });
  } }],
  resolve: { alias: [
    { find: /^@clerk\/clerk-react$/, replacement: fileURLToPath(new URL('./desktop/electron/clerk.tsx', import.meta.url)) },
    { find: './components/Mascot', replacement: fileURLToPath(new URL('./desktop/electron/Mascot.tsx', import.meta.url)) },
    { find: './components/SplashScreen', replacement: fileURLToPath(new URL('./desktop/electron/SplashScreen.tsx', import.meta.url)) },
  ] },
  server: { host: '127.0.0.1', port: 5211, strictPort: true },
  build: { outDir: fileURLToPath(new URL(`./${profile.renderer}`, import.meta.url)), emptyOutDir: true },
  define: {
    'import.meta.env.VITE_DESKTOP_SAFE_ASSETS': JSON.stringify('true'),
    'import.meta.env.VITE_APP_BUILD_ID': JSON.stringify(''),
    'import.meta.env.VITE_CLERK_PUBLISHABLE_KEY': JSON.stringify(env.VITE_CLERK_PUBLISHABLE_KEY),
    'import.meta.env.VITE_CONVEX_URL': JSON.stringify(config.convexUrl),
  },
  };
});
