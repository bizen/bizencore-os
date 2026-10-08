import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const known = [
  ['https://chatgpt.com/oauth/codex/client.json', 'Codex'],
  ['https://chatgpt.com/oauth/client.json', 'ChatGPT'],
  ['https://claude.ai/oauth/mcp-oauth-client-metadata', 'Claude'],
  ['https://claude.ai/oauth/claude-code-client-metadata', 'Claude Code'],
];
const rows = known.map(([clientId], index) => ({ clientId, lastUsedAt: 1791497700000 - index * 60000,
  ...(index === 1 ? { clientName: clientId } : index === 2 ? { clientName: '  ' } : {}) }));
rows.push({ clientId: 'https://example.test/client.json', clientName: 'Custom client', lastUsedAt: 1791497400000 });
rows.push({ clientId: 'https://claude.ai.example.test/oauth/mcp-oauth-client-metadata', lastUsedAt: 1791497300000 });
rows.push({ clientId: '__proto__', lastUsedAt: 1791497200000 });
const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import { createRoot } from 'react-dom/client';
    import { SettingsPanel } from './src/components/SettingsPanel';
    globalThis.fixtureRows = ${JSON.stringify(rows)};
    globalThis.fixtureRevision = 0; globalThis.fixtureListeners = new Set();
    globalThis.fixtureSetRows = rows => { globalThis.fixtureRows = rows; globalThis.fixtureRevision++; globalThis.fixtureListeners.forEach(fn => fn()); };
    createRoot(document.getElementById('root')).render(<SettingsPanel onClose={() => {}} theme="black" onThemeChange={() => {}} />);
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': JSON.stringify({ VITE_CONVEX_URL: 'https://fixture.convex.cloud', VITE_CLERK_PUBLISHABLE_KEY: 'fixture' }) },
  plugins: [{ name: 'isolated-connection-history', setup(builder) {
    builder.onResolve({ filter: /^(@clerk\/clerk-react|convex\/react)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'jsx', resolveDir: process.cwd(), contents: args.path === 'convex/react' ? `
      import { useSyncExternalStore } from 'react';
      import { getFunctionName } from 'convex/server';
      const subscribe = fn => { globalThis.fixtureListeners.add(fn); return () => globalThis.fixtureListeners.delete(fn); };
      export function useQuery(ref) {
        useSyncExternalStore(subscribe, () => globalThis.fixtureRevision);
        const name = getFunctionName(ref);
        if (name === 'sync:listMcpConnections') return globalThis.fixtureRows;
        if (name === 'sync:getTimeZone') return { timeZone: 'UTC' };
        return null;
      }
      export function useMutation() { return async () => { throw new Error('Mutations are not allowed in this fixture'); }; }
    ` : `
      export const SignedIn = ({ children }) => children;
      export const SignedOut = () => null;
      export const SignInButton = ({ children }) => children;
      export const useAuth = () => ({ isSignedIn: true, userId: 'fixture-user' });
    ` }));
  } }],
});
const css = await readFile('src/index.css', 'utf8');
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROME_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHROME_CHANNEL } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url() === 'https://mcp-history.test/'
    ? route.fulfill({ contentType: 'text/html', body: `<style>${css}</style><div id="root"></div><script>${outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>` }) : route.abort());
  await page.goto('https://mcp-history.test/');
  const history = page.locator('.settings-connections');
  await history.waitFor();
  const connections = history.locator('.settings-connection');
  for (const [index, [id, name]] of known.entries()) {
    assert.equal(await connections.nth(index).locator('strong').textContent(), name);
    assert.equal(await connections.nth(index).locator('code').textContent(), id);
    assert.equal(await connections.nth(index).locator('time').getAttribute('datetime'), new Date(rows[index].lastUsedAt).toISOString());
  }
  assert.equal(await connections.nth(4).locator('strong').textContent(), 'Custom client', 'server-supplied names are preserved');
  for (const index of [5, 6]) {
    assert.equal(await connections.nth(index).locator('strong').textContent(), rows[index].clientId, 'unknown IDs are not misclassified');
    assert.equal(await connections.nth(index).locator('code').count(), 0, 'unknown IDs are not repeated');
  }
  for (const theme of ['black', 'white', 'original']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await history.scrollIntoViewIfNeeded();
      assert.ok(await page.locator('.settings-panel').evaluate(el => el.scrollWidth <= el.clientWidth + 1), `${theme}/${width}: no panel overflow`);
      await page.screenshot({ path: `/private/tmp/bizencore-mcp-history-${theme}-${width}.png` });
    }
  }
  await page.evaluate(rows => globalThis.fixtureSetRows(rows.map((row, index) => index === 1 ? { ...row, clientName: 'ChatGPT Team' } : row)), rows);
  assert.equal(await connections.nth(1).locator('strong').textContent(), 'ChatGPT Team', 'a real supplied name takes precedence');
  for (const [value, message] of [[undefined, '読み込み中...'], [null, '表示するにはサインインしてください。'], [[], '記録されたMCPの利用はまだありません。']]) {
    await page.evaluate(value => globalThis.fixtureSetRows(value), value);
    assert.equal(await history.count(), 0);
    assert.ok(await page.locator('[aria-labelledby="settings-mcp-title"]').getByText(message, { exact: true }).isVisible());
  }
  assert.deepEqual(errors, []);
  console.log('Passed: real settings history, four client names and IDs, URL/blank name fallback, custom names, unknown IDs, original timestamps, loading/empty/signed-out states, three themes at desktop/mobile; no real accounts or network.');
} finally { await browser.close(); }
