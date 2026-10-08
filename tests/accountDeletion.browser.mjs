import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import { createRoot } from 'react-dom/client';
    import { SettingsPanel } from './src/components/SettingsPanel';
    import { AccountDeletionBoundary } from './src/components/AccountDeletionBoundary';
    import { lifeWorldStore } from './src/lib/lifeWorldStore';
    import { lifeStorageKey } from './src/lib/lifeWorldStore';
    globalThis.fixtureListeners = new Set(); globalThis.fixtureRevision = 0;
    globalThis.fixture = { auth: { isLoaded: true, isSignedIn: true, userId: 'alice', sessionId: 'session-a' }, status: { userId: 'alice', phase: 'active', available: true }, calls: [] };
    globalThis.fixtureNotify = () => { globalThis.fixtureRevision++; globalThis.fixtureListeners.forEach(fn => fn()); };
    globalThis.fixturePatch = patch => { Object.assign(globalThis.fixture, patch); globalThis.fixtureNotify(); };
    localStorage.setItem('chrct.tasks.v2', '[{"id":"guest-task","text":"Shared task"}]');
    localStorage.setItem('chrct.count.text', 'Shared text'); localStorage.setItem('chrct.count.stocks', '["Shared stock"]');
    localStorage.setItem('chrct.tasks.synced.alice', '{}'); localStorage.setItem('chrct.tasks.synced.bob', 'other-sync');
    lifeWorldStore.setAccount('alice'); const id = lifeWorldStore.add('2026-10-09'); lifeWorldStore.setText(id, 'Alice private');
    localStorage.setItem(lifeStorageKey('bob'), 'other-life');
    globalThis.fixtureLife = () => lifeWorldStore.getSnapshot();
    createRoot(document.getElementById('root')).render(<AccountDeletionBoundary>
      <div id="editable-app">Editing enabled</div><SettingsPanel onClose={() => {}} theme="black" onThemeChange={() => {}} />
    </AccountDeletionBoundary>);
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': JSON.stringify({ VITE_CONVEX_URL: 'https://fixture.convex.cloud', VITE_CLERK_PUBLISHABLE_KEY: 'fixture' }) },
  plugins: [{ name: 'isolated-deletion', setup(builder) {
    builder.onResolve({ filter: /^(@clerk\/clerk-react|convex\/react)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'jsx', resolveDir: process.cwd(), contents: args.path === 'convex/react' ? `
      import { useSyncExternalStore } from 'react'; import { getFunctionName } from 'convex/server';
      const subscribe = fn => { globalThis.fixtureListeners.add(fn); return () => globalThis.fixtureListeners.delete(fn); };
      export function useQuery(ref, args) {
        useSyncExternalStore(subscribe, () => globalThis.fixtureRevision);
        if (args === 'skip') return undefined;
        const name = getFunctionName(ref);
        if (name === 'accountDeletion:status') return globalThis.fixture.status;
        if (name === 'sync:getTimeZone') return { timeZone: 'UTC' };
        if (name === 'sync:listMcpConnections') return [];
        return null;
      }
      export function useMutation() { return async () => { throw new Error('unrelated mutation'); }; }
      export function useAction(ref) { return args => {
        const f = globalThis.fixture; f.calls.push({ name: getFunctionName(ref), args });
        return new Promise((resolve, reject) => { f.resolve = resolve; f.reject = reject; });
      }; }
    ` : `
      import { useSyncExternalStore } from 'react';
      export function useAuth() { useSyncExternalStore(fn => { globalThis.fixtureListeners.add(fn); return () => globalThis.fixtureListeners.delete(fn); }, () => globalThis.fixtureRevision); return globalThis.fixture.auth; }
      export const useClerk = () => ({ signOut: async args => { globalThis.fixture.signOut = args; if (globalThis.fixture.signOutFail) throw Error('sign out failed'); globalThis.fixturePatch({ auth: { isLoaded: true, isSignedIn: false, userId: null }, status: null }); } });
      export const SignedIn = ({ children }) => useAuth().isSignedIn ? children : null;
      export const SignedOut = ({ children }) => useAuth().isSignedIn ? null : children;
      export const SignInButton = ({ children }) => children;
    ` }));
  } }],
});
const css = await readFile('src/index.css', 'utf8');
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROME_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHROME_CHANNEL } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url() === 'https://deletion.test/' ? route.fulfill({
    contentType: 'text/html', body: `<style>${css}</style><div id="root"></div><script>${outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>`,
  }) : route.abort());
  await page.goto('https://deletion.test/');
  const section = page.locator('[aria-labelledby="settings-account-delete-title"]');
  await section.waitFor();
  assert.equal(await page.locator('.settings-section').last().getAttribute('aria-labelledby'), 'settings-account-delete-title');
  assert.ok(await section.getByText(/共通のタスク・保存テキストは残ります/).count());
  const open = section.getByRole('button', { name: 'アカウントを削除', exact: true });
  await page.evaluate(() => globalThis.fixturePatch({ status: { userId: 'alice', phase: 'active', available: false } }));
  assert.equal(await open.isDisabled(), true);
  await page.evaluate(() => globalThis.fixturePatch({ status: { userId: 'alice', phase: 'active', available: true } }));
  await open.click();
  const input = page.getByLabel('確認のため「削除」と入力してください。');
  const submit = page.getByRole('button', { name: '完全に削除する', exact: true });
  assert.equal(await submit.isDisabled(), true);
  await input.fill('delete'); assert.equal(await submit.isDisabled(), true);
  await input.fill('削除'); assert.equal(await submit.isDisabled(), false);
  await page.getByRole('button', { name: 'キャンセル', exact: true }).click();
  assert.equal(await input.count(), 0);
  assert.equal(await page.evaluate(() => globalThis.fixture.calls.length), 0);
  await open.click(); assert.equal(await input.inputValue(), ''); await input.fill('削除');
  await input.dispatchEvent('compositionstart'); await input.press('Enter');
  assert.equal(await page.evaluate(() => globalThis.fixture.calls.length), 0, 'IME confirmation is not deletion consent');
  await input.dispatchEvent('compositionend');
  for (const theme of ['black', 'white', 'original']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 }); await input.scrollIntoViewIfNeeded();
      assert.ok(await page.locator('.settings-panel').evaluate(el => el.scrollWidth <= el.clientWidth + 1), `${theme}/${width}: no overflow`);
      const bounds = await page.locator('.account-delete-actions button').evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; }));
      assert.ok(bounds[0].right <= bounds[1].left + 1 || bounds[0].bottom <= bounds[1].top + 1, 'buttons do not overlap');
      await page.screenshot({ path: `/private/tmp/bizencore-account-deletion-${theme}-${width}.png` });
    }
  }
  await submit.click(); assert.equal(await input.isDisabled(), true);
  await page.evaluate(() => document.querySelector('.account-delete-confirmation').requestSubmit());
  assert.equal(await page.evaluate(() => globalThis.fixture.calls.length), 1, 'double submission is blocked');
  await page.evaluate(() => globalThis.fixture.reject({ data: '認証設定エラー。データは削除していません。' }));
  await page.getByRole('alert').waitFor(); assert.match(await page.getByRole('alert').innerText(), /削除していません/);
  assert.equal(await page.evaluate(() => localStorage.getItem('bizencore.account-deletion.alice')), null);
  await submit.click();
  await page.evaluate(() => globalThis.fixture.resolve({ phase: 'data' }));
  await page.getByRole('heading', { name: 'アカウント削除を受け付けました' }).waitFor();
  assert.equal(await page.locator('#editable-app').count(), 0, 'editing and sync children are unmounted');
  assert.equal(await page.evaluate(() => localStorage.getItem('chrct.tasks.v2')), '[{"id":"guest-task","text":"Shared task"}]');
  assert.equal(await page.evaluate(() => localStorage.getItem('chrct.count.text')), 'Shared text');
  assert.equal(await page.evaluate(() => localStorage.getItem('chrct.count.stocks')), '["Shared stock"]');
  assert.equal(await page.evaluate(() => localStorage.getItem('chrct.tasks.synced.bob')), 'other-sync');
  assert.equal(await page.evaluate(() => localStorage.getItem('bizencore.life-world.account.bob.v1')), 'other-life');
  assert.equal(await page.evaluate(() => localStorage.getItem('chrct.tasks.synced.alice')), null);
  assert.equal(await page.evaluate(() => localStorage.getItem('bizencore.life-world.account.alice.v1')), null);
  assert.deepEqual(await page.evaluate(() => globalThis.fixtureLife().data.entries), {});
  await page.evaluate(() => globalThis.fixturePatch({ status: { userId: 'alice', phase: 'identity', retrying: true, available: true } }));
  assert.ok(await page.getByText('通信エラーのため自動で再試行しています。').isVisible());
  assert.equal(await page.getByRole('heading', { name: 'アカウントを削除しました' }).count(), 0, 'acceptance never reports completion');
  await page.evaluate(() => globalThis.fixturePatch({ status: { userId: 'alice', phase: 'complete', available: true } }));
  await page.getByRole('heading', { name: 'アカウントを削除しました' }).waitFor();
  await page.evaluate(() => { globalThis.fixture.signOutFail = true; });
  await page.getByRole('button', { name: 'サインアウト', exact: true }).click();
  assert.ok(await page.getByRole('alert').isVisible());
  await page.evaluate(() => { globalThis.fixture.signOutFail = false; });
  await page.getByRole('button', { name: 'サインアウト', exact: true }).click();
  await page.locator('#editable-app').waitFor();
  assert.equal(await section.getByRole('button', { name: 'アカウントを削除', exact: true }).count(), 0, 'signed-out accounts cannot delete');
  assert.equal((await page.evaluate(() => globalThis.fixture.signOut)).sessionId, 'session-a');
  // A late response for Alice must not delete Bob's cache or block Bob's UI.
  await page.evaluate(() => {
    localStorage.removeItem('bizencore.account-deletion.alice');
  });
  await page.reload();
  await open.click(); await input.fill('削除'); await submit.click();
  await page.evaluate(() => globalThis.fixturePatch({ auth: { isLoaded: true, isSignedIn: true, userId: 'bob' }, status: { userId: 'bob', phase: 'active', available: true } }));
  assert.equal(await input.count(), 0, 'account switching resets confirmation');
  await page.evaluate(() => globalThis.fixture.resolve({ phase: 'data' }));
  assert.equal(await page.locator('#editable-app').count(), 1, 'late Alice result does not block Bob');
  assert.equal(await page.evaluate(() => localStorage.getItem('bizencore.life-world.account.bob.v1')), 'other-life');
  assert.deepEqual(errors, []);
  console.log('Passed: last settings item, exact confirmation, IME, cancellation/error/double-submit, account switching, processing/completion, sync unmount, account-only cache cleanup, shared caches preserved, three themes at desktop/mobile; no real network or accounts.');
} finally { await browser.close(); }
