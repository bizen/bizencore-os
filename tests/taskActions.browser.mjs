import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import { createRoot } from 'react-dom/client';
    import { useSyncExternalStore } from 'react';
    import { MemoryRouter, Route, Routes } from 'react-router-dom';
    import { TaskActionPage } from './src/pages/TaskActionPage';
    import { applyTheme } from './src/lib/theme';
    globalThis.listeners = new Set(); globalThis.revision = 0;
    globalThis.fixture = { auth: { isLoaded: true, isSignedIn: true, userId: 'alice' }, calls: [],
      remote: { request_id: 'request-1', task_id: 'task-1', user_id: 'alice', text: 'Chrome extension作成', count: 3,
        revision: 'reviewed-revision', status: 'pending', expires_at: Date.now() + 600000, client_name: 'CLI Agent',
        subtasks: [{ id: 'child-1', text: '権限とデータ利用を確認する' }, { id: 'child-2', text: 'ストアに提出する' }] } };
    globalThis.patch = value => { Object.assign(fixture, value); globalThis.revision++; listeners.forEach(fn => fn()); };
    globalThis.setTheme = applyTheme; applyTheme('black');
    function Fixture() {
      useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn); }, () => globalThis.revision);
      return <div className="app-shell"><header className="app-header"><span className="brand">bizencore terminal</span></header><main className="app-main"><MemoryRouter initialEntries={['/task-actions/request-1']}><Routes>
        <Route path="/task-actions/:requestId" element={<TaskActionPage />} /><Route path="/" element={<p>タスク一覧</p>} />
      </Routes></MemoryRouter></main></div>;
    }
    createRoot(document.getElementById('root')).render(<Fixture />);
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': JSON.stringify({ VITE_CONVEX_URL: 'https://fixture.convex.cloud', VITE_CLERK_PUBLISHABLE_KEY: 'fixture' }) },
  plugins: [{ name: 'fixture-auth-and-storage', setup(builder) {
    builder.onResolve({ filter: /^(@clerk\/clerk-react|convex\/react)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'jsx', resolveDir: process.cwd(), contents: `
      import { useSyncExternalStore } from 'react';
      const observe = () => useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn); }, () => globalThis.revision);
      ${args.path === 'convex/react' ? `
        export function useConvexAuth() { observe(); return fixture.convexAuth ?? { isLoading: false, isAuthenticated: true }; }
        export function useQuery() { observe(); return fixture.remote; }
        export function useMutation() { return args => { fixture.calls.push(args); return new Promise((resolve, reject) => { fixture.resolve = resolve; fixture.reject = reject; }); }; }
      ` : `
        export function useAuth() { observe(); return fixture.auth; }
        export const SignInButton = ({ children }) => children;
      `}
    ` }));
  } }],
});
const css = await readFile('src/index.css', 'utf8');
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROME_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHROME_CHANNEL } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  const errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    if (route.request().url() === 'https://task-action.test/') return route.fulfill({ contentType: 'text/html', body: `<style>${css}</style><div id="root"></div><script>${outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>` });
    external.push(route.request().url()); return route.abort();
  });
  const fresh = async () => { await page.goto('https://task-action.test/'); await page.getByRole('heading', { name: 'タスクの削除を確認' }).waitFor(); };
  const state = patch => page.evaluate(patch => globalThis.patch(patch), patch);
  const calls = () => page.evaluate(() => fixture.calls);
  const approve = () => page.getByRole('button', { name: 'タスクを削除', exact: true });

  await fresh();
  assert.equal(await page.getByRole('heading', { name: 'タスクの削除を確認' }).count(), 1);
  assert.equal((await calls()).length, 0, 'opening the link never authorizes or executes deletion');
  assert.equal(await page.locator('.task-action-subtasks li').count(), 2);
  for (const theme of ['black', 'white', 'original']) {
    await page.evaluate(theme => setTheme(theme), theme);
    for (const width of [1100, 320]) {
      await page.setViewportSize({ width, height: 850 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.locator('.task-action-page').screenshot({ path: `/private/tmp/bizencore-task-action-${theme}-${width}.png` });
    }
  }
  await approve().click();
  assert.equal((await calls()).length, 1);
  assert.deepEqual((await calls())[0], { requestId: 'request-1', expectedAccountId: 'alice', expectedRevision: 'reviewed-revision', decision: 'approve' });
  assert.equal(await approve().count(), 0, 'busy button cannot be clicked again under its old label');
  assert.equal(await page.getByRole('button', { name: '処理中…' }).isDisabled(), true);
  await page.evaluate(() => fixture.resolve({ ...fixture.remote, status: 'completed', deleted: 3 }));
  await page.getByRole('heading', { name: '削除しました' }).waitFor();
  assert.equal((await calls()).length, 1);

  await fresh();
  await page.getByRole('button', { name: 'キャンセル', exact: true }).click();
  assert.equal((await calls())[0].decision, 'cancel');
  await page.evaluate(() => fixture.resolve({ ...fixture.remote, status: 'cancelled' }));
  await page.getByText(/削除をキャンセルしました/).waitFor();
  assert.equal(await approve().count(), 0);

  await fresh();
  await approve().click();
  await page.evaluate(() => fixture.reject(new Error('fixture network error')));
  await page.getByRole('alert').waitFor(); assert.equal(await approve().isEnabled(), true);
  await approve().click(); assert.equal((await calls()).length, 2);
  await page.evaluate(() => fixture.resolve({ ...fixture.remote, status: 'changed' }));
  await page.getByText(/対象のタスクが変更されています/).waitFor();

  for (const status of ['expired', 'changed', 'completed', 'cancelled']) {
    await fresh();
    await page.evaluate(status => patch({ remote: { ...fixture.remote, status } }), status);
    assert.equal(await approve().count(), 0); assert.equal((await calls()).length, 0);
  }
  await fresh();
  await page.evaluate(() => patch({ remote: { ...fixture.remote, expires_at: Date.now() + 30 } }));
  await page.getByText(/確認の有効期限が切れました/).waitFor();
  assert.equal(await approve().count(), 0);

  await fresh();
  await state({ convexAuth: { isLoading: true, isAuthenticated: false } });
  await page.getByText('サインインを確認中…').waitFor();
  assert.equal(await approve().count(), 0);
  await state({ convexAuth: { isLoading: false, isAuthenticated: false } });
  await page.getByRole('heading', { name: 'サインインを確認できませんでした' }).waitFor();
  assert.equal(await approve().count(), 0);
  await state({ convexAuth: { isLoading: false, isAuthenticated: true } });
  await state({ auth: { isLoaded: true, isSignedIn: false, userId: null } });
  await page.getByRole('button', { name: 'サインイン', exact: true }).waitFor();
  assert.equal(await approve().count(), 0);
  await state({ auth: { isLoaded: true, isSignedIn: true, userId: 'bob' } });
  assert.equal(await approve().count(), 0, 'cached query data for another account never enables deletion');
  await state({ remote: null });
  await page.getByRole('heading', { name: '確認待ちの操作が見つかりません' }).waitFor();
  assert.equal((await calls()).length, 0);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log('Task confirmation Web UI passed: approval, cancellation, errors, account changes, expiry, and three themes at desktop/mobile widths.');
} finally { await browser.close(); }
